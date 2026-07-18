import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const emptyTreeSha = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const maximumPreviewBytes = 2 * 1024 * 1024;
const comparisonDiffOptions = [
    "--binary",
    "--full-index",
    "--find-renames",
    "--no-ext-diff",
    "--no-textconv",
];

const hashParts = (...parts) => {
    const hash = crypto.createHash("sha256");
    parts.forEach((part) => hash.update(String(part)).update("\0"));
    return hash.digest("hex");
};

const runGit = async (repoRoot, args, options = {}) => execFileAsync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    timeout: 300_000,
    killSignal: "SIGTERM",
    env: { ...process.env, ...options.env },
});

const gitRaw = async (repoRoot, args, options = {}) => (
    await runGit(repoRoot, args, options)
).stdout;

const git = async (repoRoot, args, options = {}) => (
    await gitRaw(repoRoot, args, options)
).trimEnd();

const parseRecords = (text, fields) => text
    .split("\u001e")
    .map((record) => record.replace(/^\n+|\n+$/g, ""))
    .filter(Boolean)
    .map((record) => {
        const values = record.split("\0");
        return Object.fromEntries(fields.map((field, index) => [field, values[index] || ""]));
    });

const formatDate = (value) => {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    const parts = new Intl.DateTimeFormat("zh-CN", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    }).formatToParts(date);
    const part = (type) => parts.find((entry) => entry.type === type)?.value || "";
    return `${part("year")}.${part("month")}.${part("day")} ${part("hour")}:${part("minute")}`;
};

const statusPathRecords = (status) => {
    const records = status.split("\0").filter(Boolean);
    const paths = [];
    for (let index = 0; index < records.length; index += 1) {
        const record = records[index];
        if (record.startsWith("? ")) {
            paths.push(record.slice(2));
        } else if (record.startsWith("1 ")) {
            const filePath = record.match(/^1 (?:\S+ ){7}([\s\S]*)$/)?.[1];
            if (filePath) paths.push(filePath);
        } else if (record.startsWith("2 ")) {
            const filePath = record.match(/^2 (?:\S+ ){8}([\s\S]*)$/)?.[1];
            if (filePath) paths.push(filePath);
            index += 1;
        } else if (record.startsWith("u ")) {
            const filePath = record.match(/^u (?:\S+ ){9}([\s\S]*)$/)?.[1];
            if (filePath) paths.push(filePath);
        }
    }
    return paths;
};

const fileStateFingerprint = async (repoRoot, status) => {
    const hash = crypto.createHash("sha256").update(status);
    const filePaths = [...new Set(statusPathRecords(status))].sort();
    const batchSize = 128;
    for (let offset = 0; offset < filePaths.length; offset += batchSize) {
        const batch = filePaths.slice(offset, offset + batchSize);
        const states = await Promise.all(batch.map(async (filePath) => {
            try {
                const metadata = await fs.lstat(path.join(repoRoot, filePath), { bigint: true });
                return [
                    filePath,
                    metadata.mode,
                    metadata.size,
                    metadata.mtimeNs,
                    metadata.ctimeNs,
                ].join("\0");
            } catch (error) {
                if (error.code === "ENOENT") return `${filePath}\0deleted`;
                throw error;
            }
        }));
        states.forEach((state) => hash.update(state).update("\0"));
    }
    return hash.digest("hex");
};

export const inspectRepositoryState = async ({ repoRoot, targetRef, frozen = null }) => {
    if (frozen) {
        const values = [frozen.baseSha, frozen.headSha, frozen.targetSha, frozen.branchName];
        if (values.some((value) => typeof value !== "string" || value.length === 0)) {
            throw new Error("A frozen comparison requires base, head, target, and branch values");
        }
        const [baseSha, headSha, targetSha] = await Promise.all([
            git(repoRoot, ["rev-parse", `${frozen.baseSha}^{commit}`]),
            git(repoRoot, ["rev-parse", `${frozen.headSha}^{commit}`]),
            git(repoRoot, ["rev-parse", `${frozen.targetSha}^{commit}`]),
        ]);
        const mergeBaseSha = await git(repoRoot, ["merge-base", headSha, targetSha]);
        if (baseSha !== mergeBaseSha) {
            throw new Error("The frozen comparison base is not the merge base of its head and target");
        }
        return {
            branchName: frozen.branchName,
            headSha,
            targetSha,
            baseSha,
            dirty: false,
            modelKey: hashParts("frozen", frozen.branchName, baseSha, headSha, targetSha),
            worktreeKey: hashParts("frozen-worktree", baseSha, headSha, targetSha),
            frozen: true,
        };
    }

    const status = await gitRaw(repoRoot, [
        "status",
        "--porcelain=v2",
        "--branch",
        "-z",
        "--untracked-files=all",
    ], { env: { GIT_OPTIONAL_LOCKS: "0" } });
    const records = status.split("\0").filter(Boolean);
    const headerValue = (name) => records
        .find((record) => record.startsWith(`# ${name} `))
        ?.slice(name.length + 3) || "";
    const headSha = headerValue("branch.oid");
    const branchHead = headerValue("branch.head");
    const [targetSha, worktreeKey] = await Promise.all([
        git(repoRoot, ["rev-parse", `${targetRef}^{commit}`]),
        fileStateFingerprint(repoRoot, status),
    ]);
    const dirty = records.some((record) => !record.startsWith("# "));
    const branchName = branchHead && branchHead !== "(detached)"
        ? branchHead
        : headSha.slice(0, 7);
    return {
        branchName,
        headSha,
        targetSha,
        dirty,
        modelKey: hashParts(branchName, headSha, targetSha, dirty),
        worktreeKey,
    };
};

const collectCommits = async (repoRoot, baseSha, headSha) => {
    const output = await git(repoRoot, [
        "log",
        "--reverse",
        "--first-parent",
        "--format=%H%x00%P%x00%aI%x00%an%x00%s%x00%b%x1e",
        `${baseSha}..${headSha}`,
    ]);
    return parseRecords(output, ["sha", "parents", "authoredAt", "author", "subject", "body"])
        .map((commit) => ({
            ...commit,
            shortSha: commit.sha.slice(0, 8),
            parentSha: commit.parents.split(" ").filter(Boolean)[0] || emptyTreeSha,
            dateLabel: formatDate(commit.authoredAt),
        }));
};

export const buildVersionModel = async ({ repoRoot, targetRef, repositoryState }) => {
    const state = repositoryState || await inspectRepositoryState({ repoRoot, targetRef });
    const { branchName, headSha, dirty } = state;
    const baseSha = state.baseSha || await git(repoRoot, ["merge-base", headSha, state.targetSha]);
    const committedChanges = await collectCommits(repoRoot, baseSha, headSha);
    const commits = dirty ? [
        ...committedChanges,
        {
            kind: "worktree",
            virtual: true,
            sha: "worktree",
            shortSha: "worktree",
            parentSha: headSha,
            authoredAt: new Date().toISOString(),
            author: "Local worktree",
            subject: "Uncommitted changes",
            body: "Staged, unstaged, and untracked files",
            dateLabel: "Current worktree",
        },
    ] : committedChanges;

    const defaultSelection = committedChanges.length > 0 ? {
        mode: "range",
        from: committedChanges[0].sha,
        to: committedChanges.at(-1).sha,
    } : {
        mode: "range",
        from: "base",
        to: "base",
    };
    return {
        repoRoot,
        branchName,
        targetRef,
        headSha,
        dirty,
        base: { sha: baseSha, shortSha: baseSha.slice(0, 8), label: "Base version" },
        commits,
        defaultSelection,
    };
};

const invalidSelection = (message) => {
    const error = new Error(message);
    error.code = "INVALID_SELECTION";
    throw error;
};

const commitIndex = (model, value) => model.commits.findIndex((commit) => commit.sha === value);

const canonicalCommitSelection = (model, selection) => {
    if (selection.mode === "range" && selection.from === "base" && selection.to === "base") {
        if (model.commits.some((commit) => !commit.virtual)) {
            return invalidSelection("An empty range is only valid when there are no committed changes");
        }
        return { mode: "range", from: "base", to: "base" };
    }
    const fromIndex = commitIndex(model, selection.from);
    const toIndex = commitIndex(model, selection.to);
    if (fromIndex < 0) return invalidSelection(`Unknown commit --from endpoint: ${selection.from}`);
    if (toIndex < 0) return invalidSelection(`Unknown commit --to endpoint: ${selection.to}`);
    if (selection.mode === "single") {
        if (fromIndex !== toIndex) {
            return invalidSelection("Single commit mode requires identical --from and --to endpoints");
        }
        return {
            mode: "single",
            from: model.commits[fromIndex].sha,
            to: model.commits[fromIndex].sha,
        };
    }
    if (toIndex < fromIndex) return invalidSelection("Commit range --to must not precede --from");
    return {
        mode: "range",
        from: model.commits[fromIndex].sha,
        to: model.commits[toIndex].sha,
    };
};

const legacyEndpointSha = (value) => {
    if (value === "base" || value === "worktree") return value;
    return value?.replace(/^(?:push|local):/, "") || "";
};

const canonicalLegacyPushSelection = (model, selection) => {
    const fromValue = legacyEndpointSha(selection.from);
    const toValue = legacyEndpointSha(selection.to);
    const fromIndex = fromValue === "base" ? 0 : commitIndex(model, fromValue) + 1;
    const toIndex = toValue === "base" ? -1 : commitIndex(model, toValue);
    if (fromIndex < 0 || (fromValue !== "base" && fromIndex === 0)) {
        return invalidSelection(`Unknown legacy push --from endpoint: ${selection.from}`);
    }
    if (toIndex < 0) return invalidSelection(`Unknown legacy push --to endpoint: ${selection.to}`);
    if (toIndex < fromIndex) return invalidSelection("Legacy push --to must follow --from");
    return canonicalCommitSelection(model, {
        mode: "range",
        from: model.commits[fromIndex].sha,
        to: model.commits[toIndex].sha,
    });
};

export const validateSelection = (model, selection) => {
    if (!selection || typeof selection !== "object" || Array.isArray(selection)) {
        return invalidSelection("An explicit comparison selection must be an object");
    }
    if (!["single", "range", "commits", "push"].includes(selection.mode)) {
        return invalidSelection(`Unsupported comparison mode: ${selection.mode || "(empty)"}`);
    }
    if (typeof selection.from !== "string" || selection.from.length === 0) {
        return invalidSelection("The comparison --from endpoint must be a non-empty string");
    }
    if (typeof selection.to !== "string" || selection.to.length === 0) {
        return invalidSelection("The comparison --to endpoint must be a non-empty string");
    }

    if (selection.mode === "push") return canonicalLegacyPushSelection(model, selection);
    const mode = selection.mode === "commits"
        ? selection.from === selection.to ? "single" : "range"
        : selection.mode;
    return canonicalCommitSelection(model, { ...selection, mode });
};

export const normalizeSelection = (model, selection = {}) => {
    try {
        return validateSelection(model, selection);
    } catch {
        return { ...model.defaultSelection };
    }
};

const comparisonBaseRevision = (model, selection) => {
    const normalizedSelection = normalizeSelection(model, selection);
    if (normalizedSelection.from === "base") return model.base.sha;
    const fromIndex = commitIndex(model, normalizedSelection.from);
    const commit = model.commits[fromIndex];
    if (!commit?.parentSha) throw new Error("Selected comparison base is unavailable");
    if (normalizedSelection.mode === "range" && fromIndex === 0) return model.base.sha;
    return commit.parentSha;
};

export const resolveComparisonEndpoints = (model, selection = {}, { strict = false } = {}) => {
    const normalized = strict ? validateSelection(model, selection) : normalizeSelection(model, selection);
    if (normalized.from === "base" && normalized.to === "base") {
        return {
            selection: normalized,
            from: { kind: "revision", sha: model.base.sha },
            to: { kind: "revision", sha: model.base.sha },
        };
    }
    const toCommit = model.commits.find((commit) => commit.sha === normalized.to);
    if (!toCommit) {
        throw new Error("Selected comparison endpoints are unavailable");
    }
    return {
        selection: normalized,
        from: { kind: "revision", sha: comparisonBaseRevision(model, normalized) },
        to: toCommit.kind === "worktree"
            ? { kind: "worktree", sha: model.headSha }
            : { kind: "revision", sha: toCommit.sha },
    };
};

const snapshotWorktreePatch = async (repoRoot, fromSha) => {
    const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "local-mr-worktree-"));
    const indexPath = path.join(tempDirectory, "index");
    const env = { GIT_INDEX_FILE: indexPath };
    try {
        await git(repoRoot, ["read-tree", "HEAD"], { env });
        await git(repoRoot, ["add", "-A", "--", "."], { env });
        return await gitRaw(repoRoot, [
            "diff",
            "--cached",
            ...comparisonDiffOptions,
            fromSha,
            "--",
        ], { env });
    } finally {
        await fs.rm(tempDirectory, { recursive: true, force: true });
    }
};

export const buildComparisonPatch = async ({ repoRoot, model, selection }) => {
    const normalized = normalizeSelection(model, selection);
    if (normalized.from === "base" && normalized.to === "base") return "";
    const toCommit = model.commits.find((commit) => commit.sha === normalized.to);
    const fromSha = comparisonBaseRevision(model, normalized);
    if (toCommit.kind === "worktree") {
        return snapshotWorktreePatch(repoRoot, fromSha);
    }
    return gitRaw(repoRoot, [
        "diff",
        ...comparisonDiffOptions,
        fromSha,
        toCommit.sha,
        "--",
    ]);
};

const normalizeRepositoryPath = (filePath, label = "repository") => {
    if (typeof filePath !== "string" || filePath.includes("\0") || filePath.includes("\\")) {
        throw new Error(`Invalid ${label} path`);
    }
    const normalized = path.posix.normalize(filePath);
    if (
        normalized !== filePath
        || normalized === "."
        || normalized.startsWith("../")
        || path.posix.isAbsolute(normalized)
    ) {
        throw new Error(`Invalid ${label} path`);
    }
    return normalized;
};

export const buildFileContext = async ({ repoRoot, model, selection, filePath, start, end }) => {
    const normalizedPath = normalizeRepositoryPath(filePath);
    if (
        !Number.isSafeInteger(start)
        || !Number.isSafeInteger(end)
        || start < 1
        || end < start
    ) {
        throw new Error("Invalid context line range");
    }
    const revision = comparisonBaseRevision(model, selection);
    const content = await gitRaw(repoRoot, ["cat-file", "blob", `${revision}:${normalizedPath}`]);
    if (content.includes("\0")) throw new Error("Diff context is unavailable for binary files");
    const lines = content.split("\n");
    if (lines.at(-1) === "") lines.pop();
    const normalizedLines = lines.map((line) => line.replace(/\r$/, ""));
    const totalLines = normalizedLines.length;
    const boundedEnd = Math.min(end, totalLines);
    return {
        path: normalizedPath,
        start,
        end: boundedEnd,
        totalLines,
        hasMore: boundedEnd < totalLines,
        lines: start <= boundedEnd ? normalizedLines.slice(start - 1, boundedEnd) : [],
    };
};

const normalizePreviewPath = (filePath) => {
    const normalized = normalizeRepositoryPath(filePath, "preview");
    if (!/\.(?:md|markdown|mdown|mkd)$/i.test(normalized)) {
        throw new Error("Preview is only available for Markdown files");
    }
    return normalized;
};

const assertPreviewSize = (content) => {
    if (Buffer.byteLength(content) > maximumPreviewBytes) {
        throw new Error("Markdown preview is larger than 2 MiB");
    }
    return content;
};

const readGitBlob = async (repoRoot, revision, filePath) => {
    const objectName = `${revision}:${filePath}`;
    const size = Number.parseInt(await git(repoRoot, ["cat-file", "-s", objectName]), 10);
    if (!Number.isFinite(size) || size > maximumPreviewBytes) {
        throw new Error("Markdown preview is larger than 2 MiB");
    }
    return gitRaw(repoRoot, ["cat-file", "blob", objectName]);
};

const readWorktreeFile = async (repoRoot, normalizedPath) => {
    const absolutePath = path.resolve(repoRoot, normalizedPath);
    const relativePath = path.relative(repoRoot, absolutePath);
    if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
        throw new Error("Invalid preview path");
    }
    const file = await fs.lstat(absolutePath);
    if (!file.isFile() || file.isSymbolicLink()) {
        throw new Error("Markdown preview requires a regular file");
    }
    if (file.size > maximumPreviewBytes) {
        throw new Error("Markdown preview is larger than 2 MiB");
    }
    return fs.readFile(absolutePath, "utf8");
};

export const buildFilePreview = async ({ repoRoot, model, selection, filePath }) => {
    const normalizedPath = normalizePreviewPath(filePath);
    const normalizedSelection = normalizeSelection(model, selection);
    const commit = model.commits.find((candidate) => candidate.sha === normalizedSelection.to);
    if (!commit) throw new Error("Selected comparison target is unavailable");
    const content = commit.kind === "worktree"
        ? await readWorktreeFile(repoRoot, normalizedPath)
        : await readGitBlob(repoRoot, commit.sha, normalizedPath);

    return {
        path: normalizedPath,
        markdown: true,
        content: assertPreviewSize(content),
    };
};
