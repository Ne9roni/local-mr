import crypto from "node:crypto";
import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { patchSummary } from "./review-render.mjs";
import {
    buildVersionModel,
    inspectRepositoryState,
    resolveComparisonEndpoints,
} from "./version-model.mjs";
import {
    decodeUtf8Text,
    materializeText,
    parseRawDiffZ,
    parseZeroContextDiff,
} from "./virtual-diff.mjs";
import { validateVirtualReviewManifest } from "./virtual-review-manifest.mjs";
import {
    loadVirtualReviewRevision,
    loadVirtualSource,
    readVirtualBlob,
    saveVirtualReviewRevision,
    saveVirtualSource,
    virtualReviewStateRoot,
    withVirtualReviewStoreTransaction,
    writeVirtualBlob,
} from "./virtual-review-store.mjs";

const execFileAsync = promisify(execFile);
const maximumTextFileBytes = 8 * 1024 * 1024;

const hashParts = (...parts) => {
    const hash = crypto.createHash("sha256");
    parts.forEach((part) => hash.update(String(part)).update("\0"));
    return hash.digest("hex");
};

const git = async (repoRoot, args, { env = {}, input, encoding = "utf8", allowExitCodeOne = false } = {}) => {
    if (input !== undefined) {
        const output = await new Promise((resolve, reject) => {
            const child = spawn("git", args, {
                cwd: repoRoot,
                env: { ...process.env, ...env },
                stdio: ["pipe", "pipe", "pipe"],
            });
            const stdout = [];
            const stderr = [];
            let outputBytes = 0;
            child.stdout.on("data", (chunk) => {
                outputBytes += chunk.length;
                if (outputBytes > 256 * 1024 * 1024) child.kill();
                else stdout.push(chunk);
            });
            child.stderr.on("data", (chunk) => stderr.push(chunk));
            child.once("error", reject);
            child.once("close", (code) => {
                const stdoutBuffer = Buffer.concat(stdout);
                if (code === 0 || (allowExitCodeOne && code === 1)) {
                    resolve(stdoutBuffer);
                    return;
                }
                const error = new Error(Buffer.concat(stderr).toString("utf8").trim() || `git exited with status ${code}`);
                error.code = code;
                reject(error);
            });
            child.stdin.end(input);
        });
        return encoding === "buffer" ? output : output.toString(encoding);
    }
    try {
        const result = await execFileAsync("git", args, {
            cwd: repoRoot,
            env: { ...process.env, ...env },
            encoding: encoding === "buffer" ? null : encoding,
            maxBuffer: 256 * 1024 * 1024,
        });
        return result.stdout;
    } catch (error) {
        if (allowExitCodeOne && error.code === 1) return error.stdout;
        throw error;
    }
};

const comparisonArtifacts = async ({ repoRoot, model, selection }) => {
    const committedChanges = model.commits.filter((commit) => !commit.virtual);
    if (committedChanges.length === 0) {
        const error = new Error(
            "Virtual commits require at least one committed change after the target branch point",
        );
        error.code = "VIRTUAL_SOURCE_REQUIRES_COMMIT";
        throw error;
    }
    const requestedSelection = selection || model.defaultSelection;
    const endpoints = resolveComparisonEndpoints(
        model,
        requestedSelection,
        { strict: true },
    );
    if (endpoints.from.sha !== model.base.sha || endpoints.to.kind !== "revision") {
        const error = new Error(
            "Virtual commits must compare the target branch point to a real commit; uncommitted changes and partial ranges are not allowed",
        );
        error.code = "INVALID_VIRTUAL_SOURCE_BOUNDARY";
        error.details = {
            expectedFrom: model.base.sha,
            actualFrom: endpoints.from.sha,
            actualToKind: endpoints.to.kind,
        };
        throw error;
    }
    if (selection === undefined && endpoints.to.sha !== model.headSha) {
        const error = new Error("The default virtual review source must end at the captured HEAD commit");
        error.code = "INVALID_VIRTUAL_SOURCE_BOUNDARY";
        throw error;
    }
    const common = ["--find-renames", "--no-ext-diff", "--no-textconv"];
    const [raw, patchText] = await Promise.all([
        git(repoRoot, [
            "diff", "--raw", "-z", "--no-abbrev", ...common,
            endpoints.from.sha, endpoints.to.sha, "--",
        ], { encoding: "buffer" }),
        git(repoRoot, [
            "diff", "--binary", "--full-index", ...common,
            endpoints.from.sha, endpoints.to.sha, "--",
        ]),
    ]);
    return { endpoints, patchText, raw, objectEnvironment: {}, cleanup: async () => {} };
};

const readGitEntry = async ({ repoRoot, mode, oid, entryPath, stateRoot, objectEnvironment }) => {
    if (!mode || /^0+$/.test(mode)) return null;
    if (mode === "160000") {
        return { path: entryPath, mode, oid, blob: null, bytes: 0 };
    }
    const content = await git(repoRoot, ["cat-file", "blob", oid], {
        encoding: "buffer",
        env: objectEnvironment,
    });
    const blob = await writeVirtualBlob(content, stateRoot);
    return { path: entryPath, mode, oid, blob: blob.hash, bytes: blob.bytes };
};

const zeroContextPatch = async ({ baseContent, targetContent }) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "local-mr-virtual-block-"));
    const basePath = path.join(directory, "base");
    const targetPath = path.join(directory, "target");
    try {
        await Promise.all([
            fs.writeFile(basePath, baseContent),
            fs.writeFile(targetPath, targetContent),
        ]);
        return await git(directory, [
            "diff", "--no-index", "--no-ext-diff", "--text", "--unified=0", "--",
            basePath, targetPath,
        ], { allowExitCodeOne: true });
    } finally {
        await fs.rm(directory, { recursive: true, force: true });
    }
};

const regularTextMode = (mode) => !mode || /^0+$/.test(mode) || mode === "100644" || mode === "100755";

const sourceFileFromRecord = async ({ record, repoRoot, stateRoot, objectEnvironment }) => {
    const fileId = hashParts(
        "virtual-file-v1",
        record.status,
        record.oldPath,
        record.newPath,
        record.oldMode,
        record.newMode,
        record.oldOid,
        record.newOid,
    );
    const [base, target] = await Promise.all([
        readGitEntry({
            repoRoot,
            mode: record.oldMode,
            oid: record.oldOid,
            entryPath: record.oldPath,
            stateRoot,
            objectEnvironment,
        }),
        readGitEntry({
            repoRoot,
            mode: record.newMode,
            oid: record.newOid,
            entryPath: record.newPath,
            stateRoot,
            objectEnvironment,
        }),
    ]);
    const displayPath = record.status === "R"
        ? `${record.oldPath} -> ${record.newPath}`
        : record.newPath || record.oldPath;
    const baseContent = base?.blob ? await readVirtualBlob(base.blob, stateRoot) : Buffer.alloc(0);
    const targetContent = target?.blob ? await readVirtualBlob(target.blob, stateRoot) : Buffer.alloc(0);
    const baseText = baseContent.length <= maximumTextFileBytes ? decodeUtf8Text(baseContent) : null;
    const targetText = targetContent.length <= maximumTextFileBytes ? decodeUtf8Text(targetContent) : null;
    const isOrdinaryText = ["A", "D", "M"].includes(record.status)
        && record.oldPath === record.newPath
        && regularTextMode(record.oldMode)
        && regularTextMode(record.newMode)
        && (!base || !target || base.mode === target.mode)
        && baseText
        && targetText;

    let blocks;
    let kind;
    if (isOrdinaryText) {
        const patchText = await zeroContextPatch({ baseContent, targetContent });
        blocks = parseZeroContextDiff({
            patchText,
            fileId,
            baseText: baseText.text,
            targetText: targetText.text,
        }).map((block) => ({ ...block, kind: "text", path: displayPath }));
        kind = "text";
    }
    if (!blocks?.length) {
        kind = "special";
        blocks = [{
            id: hashParts("virtual-special-v1", fileId, base?.blob || base?.oid || "", target?.blob || target?.oid || ""),
            fileId,
            kind: "file",
            path: displayPath,
            oldStart: 0,
            oldCount: baseText?.lines.length || 0,
            newStart: 0,
            newCount: targetText?.lines.length || 0,
        }];
    }
    return {
        id: fileId,
        kind,
        status: record.status,
        score: record.score,
        oldPath: record.oldPath,
        newPath: record.newPath,
        displayPath,
        base,
        target,
        blocks,
    };
};

export const captureVirtualReviewSource = async ({
    repoRoot,
    targetRef,
    selection,
    stateRoot = virtualReviewStateRoot(),
}) => {
    const repositoryState = await inspectRepositoryState({ repoRoot, targetRef });
    const model = await buildVersionModel({ repoRoot, targetRef, repositoryState });
    const artifacts = await comparisonArtifacts({ repoRoot, model, selection });
    try {
        return await withVirtualReviewStoreTransaction(stateRoot, async () => {
            if (!artifacts.patchText.trim()) throw new Error("There are no changes in the selected comparison");
            const rawRecords = parseRawDiffZ(artifacts.raw);
            const files = [];
            for (const record of rawRecords) {
                files.push(await sourceFileFromRecord({
                    record,
                    repoRoot,
                    stateRoot,
                    objectEnvironment: artifacts.objectEnvironment,
                }));
            }
            const diffHash = crypto.createHash("sha256").update(artifacts.patchText).digest("hex");
            const objectFormat = await git(repoRoot, ["rev-parse", "--show-object-format"]);
            const normalizedSelection = artifacts.endpoints.selection;
            const branchCommit = model.commits.find((commit) => (
                commit.kind !== "worktree" && commit.sha === artifacts.endpoints.to.sha
            ));
            if (!branchCommit) {
                throw new Error("The frozen Virtual review branch commit is unavailable");
            }
            const sourceId = hashParts(
                "local-mr-virtual-source-v1",
                path.resolve(repoRoot),
                model.branchName,
                model.targetRef,
                JSON.stringify(normalizedSelection),
                diffHash,
            );
            const patchBlob = await writeVirtualBlob(artifacts.patchText, stateRoot);
            const source = {
                schemaVersion: 1,
                sourceId,
                diffHash,
                createdAt: new Date().toISOString(),
                repository: {
                    root: path.resolve(repoRoot),
                    name: path.basename(repoRoot),
                    branchName: model.branchName,
                    targetRef: model.targetRef,
                    targetSha: repositoryState.targetSha,
                    baseSha: model.base.sha,
                    headSha: artifacts.endpoints.to.sha,
                    objectFormat: objectFormat.trim(),
                },
                branchCommit: {
                    sha: branchCommit.sha,
                    shortSha: branchCommit.shortSha,
                    subject: branchCommit.subject,
                    author: branchCommit.author,
                    authoredAt: branchCommit.authoredAt,
                    dateLabel: branchCommit.dateLabel,
                },
                selection: normalizedSelection,
                endpoints: artifacts.endpoints,
                summary: patchSummary(artifacts.patchText),
                patchBlob,
                files,
                blockOrder: files.flatMap((file) => file.blocks.map((block) => block.id)),
            };
            return saveVirtualSource(source, stateRoot);
        });
    } finally {
        await artifacts.cleanup();
    }
};

export const virtualSourceCatalog = (source) => ({
    schemaVersion: 1,
    sourceId: source.sourceId,
    diffHash: source.diffHash,
    createdAt: source.createdAt,
    repository: source.repository,
    branchCommit: source.branchCommit,
    selection: source.selection,
    summary: source.summary,
    files: source.files.map((file) => ({
        id: file.id,
        kind: file.kind,
        status: file.status,
        oldPath: file.oldPath,
        newPath: file.newPath,
        displayPath: file.displayPath,
        baseBytes: file.base?.bytes || 0,
        targetBytes: file.target?.bytes || 0,
        blocks: file.blocks.map((block) => ({
            id: block.id,
            kind: block.kind,
            oldStart: block.oldStart,
            oldCount: block.oldCount,
            newStart: block.newStart,
            newCount: block.newCount,
        })),
    })),
});

const sourceFileContent = async (entry, stateRoot) => {
    if (!entry) return Buffer.alloc(0);
    if (entry.mode === "160000") return null;
    return readVirtualBlob(entry.blob, stateRoot);
};

export const inspectVirtualSourceItem = async ({
    source,
    filePath,
    blockId,
    stateRoot = virtualReviewStateRoot(),
}) => {
    if (!filePath && !blockId) {
        return {
            ...virtualSourceCatalog(source),
            patch: (await readVirtualBlob(source.patchBlob.hash, stateRoot)).toString("utf8"),
        };
    }
    const file = source.files.find((candidate) => (
        candidate.id === filePath
        || candidate.oldPath === filePath
        || candidate.newPath === filePath
        || candidate.blocks.some((block) => block.id === blockId)
    ));
    if (!file) throw new Error(filePath ? `Source file not found: ${filePath}` : `Source block not found: ${blockId}`);
    const blocks = blockId ? file.blocks.filter((block) => block.id === blockId) : file.blocks;
    if (blockId && blocks.length === 0) throw new Error(`Source block not found: ${blockId}`);
    const item = {
        sourceId: source.sourceId,
        file: {
            id: file.id,
            kind: file.kind,
            status: file.status,
            oldPath: file.oldPath,
            newPath: file.newPath,
            displayPath: file.displayPath,
            base: file.base,
            target: file.target,
        },
        blocks,
    };
    if (blockId && file.kind === "text") return item;

    const [baseContent, targetContent] = await Promise.all([
        sourceFileContent(file.base, stateRoot),
        sourceFileContent(file.target, stateRoot),
    ]);
    return {
        ...item,
        baseText: baseContent === null ? null : decodeUtf8Text(baseContent)?.text ?? null,
        targetText: targetContent === null ? null : decodeUtf8Text(targetContent)?.text ?? null,
    };
};

const entryFromStored = async (entry, stateRoot) => {
    if (!entry) return null;
    return {
        path: entry.path,
        mode: entry.mode,
        oid: entry.mode === "160000" ? entry.oid : null,
        content: entry.mode === "160000" ? null : await readVirtualBlob(entry.blob, stateRoot),
    };
};

const buildState = async ({ source, selectedBlocks, stateRoot }) => {
    const entries = new Map();
    for (const file of source.files) {
        const selected = file.blocks.filter((block) => selectedBlocks.has(block.id));
        if (file.kind === "special") {
            const stored = selected.length > 0 ? file.target : file.base;
            const entry = await entryFromStored(stored, stateRoot);
            if (entry) entries.set(entry.path, entry);
            continue;
        }

        if (selected.length === 0) {
            const entry = await entryFromStored(file.base, stateRoot);
            if (entry) entries.set(entry.path, entry);
            continue;
        }
        if (selected.length === file.blocks.length) {
            const entry = await entryFromStored(file.target, stateRoot);
            if (entry) entries.set(entry.path, entry);
            continue;
        }
        const [baseContent, targetContent] = await Promise.all([
            sourceFileContent(file.base, stateRoot),
            sourceFileContent(file.target, stateRoot),
        ]);
        const baseText = decodeUtf8Text(baseContent)?.text;
        const targetText = decodeUtf8Text(targetContent)?.text;
        if (baseText === undefined || targetText === undefined) {
            throw new Error(`Cannot materialize text blocks for ${file.displayPath}`);
        }
        const content = materializeText({
            baseText,
            targetText,
            blocks: file.blocks,
            selectedBlockIds: selected.map((block) => block.id),
        });
        const template = file.target || file.base;
        if (template) {
            entries.set(template.path, {
                path: template.path,
                mode: template.mode,
                oid: null,
                content: Buffer.from(content),
            });
        }
    }
    return entries;
};

const writeTree = async ({ repository, entries, indexNumber }) => {
    const indexPath = path.join(repository, `index-${indexNumber}`);
    const env = { GIT_INDEX_FILE: indexPath };
    await fs.rm(indexPath, { force: true });
    await git(repository, ["read-tree", "--empty"], { env });
    for (const entry of [...entries.values()].sort((left, right) => left.path.localeCompare(right.path))) {
        const oid = entry.mode === "160000"
            ? entry.oid
            : (await git(repository, ["hash-object", "-w", "--stdin"], { input: entry.content })).trim();
        const args = ["update-index", "--add"];
        if (entry.mode === "160000") args.push("--info-only");
        args.push("--cacheinfo", entry.mode, oid, entry.path);
        await git(repository, args, { env });
    }
    return (await git(repository, ["write-tree"], { env })).trim();
};

const blocksThroughVirtualCommit = (manifest, stateIndex) => new Set(
    manifest.virtualCommits
        .slice(0, stateIndex)
        .flatMap((commit) => commit.blocks),
);

export const buildVirtualComparisonPatch = async ({
    source,
    manifest,
    fromState,
    toState,
    stateRoot = virtualReviewStateRoot(),
}) => {
    const stateCount = manifest.virtualCommits.length;
    if (
        !Number.isSafeInteger(fromState)
        || !Number.isSafeInteger(toState)
        || fromState < 0
        || toState <= fromState
        || toState > stateCount
    ) {
        throw new Error(`Invalid virtual comparison range: ${fromState}..${toState}`);
    }
    const repository = await fs.mkdtemp(path.join(os.tmpdir(), "local-mr-virtual-range-"));
    try {
        await git(repository, ["init", "-q", `--object-format=${source.repository.objectFormat || "sha1"}`]);
        const [fromEntries, toEntries] = await Promise.all([
            buildState({
                source,
                selectedBlocks: blocksThroughVirtualCommit(manifest, fromState),
                stateRoot,
            }),
            buildState({
                source,
                selectedBlocks: blocksThroughVirtualCommit(manifest, toState),
                stateRoot,
            }),
        ]);
        const [fromTree, toTree] = await Promise.all([
            writeTree({ repository, entries: fromEntries, indexNumber: 0 }),
            writeTree({ repository, entries: toEntries, indexNumber: 1 }),
        ]);
        // Await the Git child before the finally block removes its object database.
        return await git(repository, [
            "diff-tree", "-p", "--binary", "--full-index", "--find-renames",
            "--no-ext-diff", "--no-textconv", "--no-commit-id",
            fromTree, toTree, "--",
        ]);
    } finally {
        await fs.rm(repository, { recursive: true, force: true });
    }
};

const buildVirtualCommitPatches = async ({ source, manifest, stateRoot }) => {
    const repository = await fs.mkdtemp(path.join(os.tmpdir(), "local-mr-virtual-trees-"));
    try {
        await git(repository, ["init", "-q", `--object-format=${source.repository.objectFormat || "sha1"}`]);
        const selectedBlocks = new Set();
        const initialState = await buildState({ source, selectedBlocks, stateRoot });
        let previousTree = await writeTree({ repository, entries: initialState, indexNumber: 0 });
        const patches = [];
        for (let index = 0; index < manifest.virtualCommits.length; index += 1) {
            manifest.virtualCommits[index].blocks.forEach((blockId) => selectedBlocks.add(blockId));
            const state = await buildState({ source, selectedBlocks, stateRoot });
            const nextTree = await writeTree({ repository, entries: state, indexNumber: index + 1 });
            const patchText = await git(repository, [
                "diff-tree", "-p", "--binary", "--full-index", "--find-renames",
                "--no-ext-diff", "--no-textconv", "--no-commit-id",
                previousTree, nextTree, "--",
            ]);
            if (!patchText.trim()) throw new Error(`Virtual commit ${index + 1} produced an empty patch`);
            patches.push(patchText);
            previousTree = nextTree;
        }
        const targetState = await buildState({
            source,
            selectedBlocks: new Set(source.blockOrder),
            stateRoot,
        });
        const targetTree = await writeTree({
            repository,
            entries: targetState,
            indexNumber: manifest.virtualCommits.length + 1,
        });
        if (previousTree !== targetTree) {
            throw new Error("Virtual commit sequence does not reproduce the source target tree");
        }
        return patches;
    } finally {
        await fs.rm(repository, { recursive: true, force: true });
    }
};

export const createVirtualReview = async ({
    sourceId,
    manifest: inputManifest,
    reviewId,
    expectedRevision,
    stateRoot = virtualReviewStateRoot(),
}) => withVirtualReviewStoreTransaction(stateRoot, async () => {
    const source = await loadVirtualSource(sourceId, stateRoot);
    const manifest = validateVirtualReviewManifest({ source, manifest: inputManifest });
    const commitPatches = await buildVirtualCommitPatches({ source, manifest, stateRoot });
    const fullPatch = await readVirtualBlob(source.patchBlob.hash, stateRoot);
    return saveVirtualReviewRevision({
        reviewId,
        expectedRevision,
        sourceId,
        manifest,
        commitPatches,
        fullPatch,
    }, stateRoot);
});

const materializeError = (code, message, details) => {
    const error = new Error(message);
    error.code = code;
    if (details) error.details = details;
    return error;
};

const virtualCommitMessage = ({ virtualCommit, reviewId, revision, position, total }) => {
    const lines = [
        virtualCommit.title,
        "",
        `Intent: ${virtualCommit.intent}`,
        "",
        "Review focus:",
        ...virtualCommit.reviewFocus.map((focus) => `- ${focus.text}`),
        "",
        `Risk (${virtualCommit.risk.level}): ${virtualCommit.risk.reason}`,
        "",
        `Local-MR-Virtual-Commit: ${reviewId}@r${revision} ${position}/${total}`,
    ];
    return `${lines.join("\n")}\n`;
};

const resolveOptionalCommit = async (repoRoot, reference) => (await git(
    repoRoot,
    ["rev-parse", "--verify", "--quiet", `${reference}^{commit}`],
    { allowExitCodeOne: true },
)).trim();

const assertFreshMaterializeSource = async ({ source, repoRoot, branchName }) => {
    const frozenHead = source.repository.headSha;
    let currentHead;
    try {
        currentHead = await resolveOptionalCommit(repoRoot, `refs/heads/${branchName}`);
    } catch (error) {
        throw materializeError(
            "REPOSITORY_UNAVAILABLE",
            `Cannot read the source repository at ${repoRoot}: ${error.message}`,
        );
    }
    if (!currentHead) {
        throw materializeError("BRANCH_NOT_FOUND", `The frozen source branch does not exist: ${branchName}`);
    }
    if (currentHead !== frozenHead) {
        throw materializeError(
            "STALE_SOURCE",
            "The branch moved after the source was frozen; create a new snapshot and revision before materializing",
            { branch: branchName, frozenHead, currentHead },
        );
    }
    const currentTarget = await resolveOptionalCommit(repoRoot, source.repository.targetRef);
    if (!currentTarget) {
        throw materializeError(
            "STALE_SOURCE",
            `The frozen target ref no longer exists: ${source.repository.targetRef}`,
        );
    }
    const currentBase = (await git(
        repoRoot,
        ["merge-base", currentHead, currentTarget],
        { allowExitCodeOne: true },
    )).trim();
    if (currentBase !== source.repository.baseSha) {
        throw materializeError(
            "STALE_SOURCE",
            "The merge base changed after the source was frozen; create a new snapshot and revision before materializing",
            { frozenBase: source.repository.baseSha, currentBase },
        );
    }
    const patchText = await git(repoRoot, [
        "diff", "--binary", "--full-index", "--find-renames", "--no-ext-diff", "--no-textconv",
        source.repository.baseSha, frozenHead, "--",
    ]);
    const currentDiffHash = crypto.createHash("sha256").update(patchText).digest("hex");
    if (currentDiffHash !== source.diffHash) {
        throw materializeError(
            "STALE_SOURCE",
            "The frozen comparison no longer matches the repository content",
            { frozenDiffHash: source.diffHash, currentDiffHash },
        );
    }
};

const resolveBackupBranch = async ({ source, repoRoot, branchName, backupName }) => {
    const backupBranch = backupName ?? `backup/${branchName}/${source.branchCommit.shortSha}`;
    if (backupBranch === branchName) {
        throw materializeError("INVALID_BACKUP_NAME", "The backup branch cannot be the reviewed branch itself");
    }
    try {
        await git(repoRoot, ["check-ref-format", "--branch", backupBranch]);
    } catch {
        throw materializeError("INVALID_BACKUP_NAME", `Invalid backup branch name: ${backupBranch}`);
    }
    const existingBackup = await resolveOptionalCommit(repoRoot, `refs/heads/${backupBranch}`);
    if (existingBackup && existingBackup !== source.repository.headSha) {
        throw materializeError(
            "BACKUP_EXISTS",
            `The backup branch already exists and points to a different commit: ${backupBranch}`,
            { backupBranch, existingBackup, frozenHead: source.repository.headSha },
        );
    }
    return { backupBranch, existingBackup };
};

const materializeStateTrees = async ({ source, manifest, repoRoot, stateRoot, zeroOid }) => {
    const affectedPaths = new Set();
    for (const file of source.files) {
        if (file.base?.path) affectedPaths.add(file.base.path);
        if (file.target?.path) affectedPaths.add(file.target.path);
    }
    const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "local-mr-virtual-materialize-"));
    const oidByContentHash = new Map();
    const blobOid = async (content) => {
        const key = crypto.createHash("sha256").update(content).digest("hex");
        if (!oidByContentHash.has(key)) {
            oidByContentHash.set(
                key,
                (await git(repoRoot, ["hash-object", "-w", "--stdin"], { input: content })).trim(),
            );
        }
        return oidByContentHash.get(key);
    };
    try {
        const trees = [];
        for (let state = 1; state <= manifest.virtualCommits.length; state += 1) {
            const entries = await buildState({
                source,
                selectedBlocks: blocksThroughVirtualCommit(manifest, state),
                stateRoot,
            });
            const env = { GIT_INDEX_FILE: path.join(temporaryDirectory, `index-${state}`) };
            await git(repoRoot, ["read-tree", source.repository.baseSha], { env });
            const indexInfo = [...affectedPaths].map((affectedPath) => `0 ${zeroOid}\t${affectedPath}`);
            for (const entry of entries.values()) {
                const oid = entry.mode === "160000" ? entry.oid : await blobOid(entry.content);
                indexInfo.push(`${entry.mode} ${oid}\t${entry.path}`);
            }
            await git(repoRoot, ["update-index", "--index-info"], { env, input: `${indexInfo.join("\n")}\n` });
            trees.push((await git(repoRoot, ["write-tree"], { env })).trim());
        }
        return trees;
    } finally {
        await fs.rm(temporaryDirectory, { recursive: true, force: true });
    }
};

export const materializeVirtualReview = async ({
    reviewId,
    revision,
    backupName,
    stateRoot = virtualReviewStateRoot(),
}) => {
    const { record } = await loadVirtualReviewRevision({ reviewId, revision }, stateRoot);
    const source = await loadVirtualSource(record.sourceId, stateRoot);
    const { manifest } = record;
    const repoRoot = source.repository.root;
    const branchName = source.repository.branchName;
    const frozenHead = source.repository.headSha;
    const zeroOid = "0".repeat(source.repository.objectFormat === "sha256" ? 64 : 40);

    await assertFreshMaterializeSource({ source, repoRoot, branchName });
    const { backupBranch, existingBackup } = await resolveBackupBranch({
        source,
        repoRoot,
        branchName,
        backupName,
    });

    const trees = await materializeStateTrees({ source, manifest, repoRoot, stateRoot, zeroOid });
    const frozenHeadTree = (await git(repoRoot, ["rev-parse", `${frozenHead}^{tree}`])).trim();
    if (trees.at(-1) !== frozenHeadTree) {
        throw materializeError(
            "MATERIALIZE_TREE_MISMATCH",
            "The materialized virtual commits do not reproduce the frozen branch tree; no reference was changed",
        );
    }

    const commits = [];
    let parent = source.repository.baseSha;
    for (let index = 0; index < manifest.virtualCommits.length; index += 1) {
        const virtualCommit = manifest.virtualCommits[index];
        const message = virtualCommitMessage({
            virtualCommit,
            reviewId: record.reviewId,
            revision: record.revision,
            position: index + 1,
            total: manifest.virtualCommits.length,
        });
        parent = (await git(repoRoot, ["commit-tree", trees[index], "-p", parent], { input: message })).trim();
        commits.push({ sha: parent, title: virtualCommit.title });
    }

    if (!existingBackup) {
        await git(repoRoot, ["update-ref", `refs/heads/${backupBranch}`, frozenHead, zeroOid]);
    }
    await git(repoRoot, [
        "update-ref",
        "-m", `local-mr virtual-commit materialize: ${record.reviewId}@r${record.revision}`,
        `refs/heads/${branchName}`, parent, frozenHead,
    ]);
    return {
        reviewId: record.reviewId,
        revision: record.revision,
        sourceId: record.sourceId,
        repositoryRoot: repoRoot,
        branch: branchName,
        previousHead: frozenHead,
        newHead: parent,
        backupBranch,
        backupCreated: !existingBackup,
        commits,
    };
};

export const inspectVirtualSourceFreshness = async (source) => {
    try {
        const [headSha, targetSha] = await Promise.all([
            git(source.repository.root, ["rev-parse", "HEAD^{commit}"]),
            git(source.repository.root, [
                "rev-parse",
                `${source.repository.targetRef}^{commit}`,
            ]),
        ]);
        const currentHeadSha = headSha.trim();
        const currentTargetSha = targetSha.trim();
        const baseSha = (await git(source.repository.root, [
            "merge-base",
            currentHeadSha,
            currentTargetSha,
        ])).trim();
        const currentBaseSha = baseSha;
        if (source.endpoints?.to?.kind !== "revision") {
            return {
                stale: true,
                currentDiffHash: null,
                currentHeadSha,
                currentTargetSha,
                currentBaseSha,
                repositoryAvailable: true,
                error: "This virtual review was captured from uncommitted changes and no longer satisfies the source boundary",
            };
        }
        const patchText = await git(source.repository.root, [
            "diff", "--binary", "--full-index", "--find-renames", "--no-ext-diff", "--no-textconv",
            source.endpoints.from.sha, source.endpoints.to.sha, "--",
        ]);
        const currentDiffHash = crypto.createHash("sha256").update(patchText).digest("hex");
        const capturedHeadSha = source.repository.headSha || source.endpoints.to.sha;
        const capturedTargetSha = source.repository.targetSha || currentTargetSha;
        return {
            stale: currentDiffHash !== source.diffHash
                || currentBaseSha !== source.endpoints.from.sha
                || currentHeadSha !== capturedHeadSha
                || currentTargetSha !== capturedTargetSha,
            currentDiffHash,
            currentHeadSha,
            currentTargetSha,
            currentBaseSha,
            repositoryAvailable: true,
        };
    } catch (error) {
        return {
            stale: null,
            currentDiffHash: null,
            currentHeadSha: null,
            currentTargetSha: null,
            currentBaseSha: null,
            repositoryAvailable: false,
            error: error.message,
        };
    }
};
