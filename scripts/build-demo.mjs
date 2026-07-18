import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { renderDiffDocument, splitRenderedReview } from "../src/review-render.mjs";
import { decodeUtf8Text } from "../src/virtual-diff.mjs";
import {
    buildVirtualComparisonPatch,
    captureVirtualReviewSource,
} from "../src/virtual-review-core.mjs";
import { validateVirtualReviewManifest } from "../src/virtual-review-manifest.mjs";
import {
    buildDeepReviewDemoManifest,
    buildOverviewDemoManifest,
    demoReviewSource,
} from "./demo-review-plan.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const demoRoot = path.join(projectRoot, "demo");
const checkOnly = process.argv.includes("--check");
const title = `Local MR: ${demoReviewSource.branchName} → ${demoReviewSource.targetRef}`;
const maximumEmbeddedContextBytes = 128 * 1024;
const maximumEmbeddedPreviewBytes = 512 * 1024;
const demoCommitMetadata = Object.freeze({
    author: "Ne9roni",
    subject: "feat(virtual-commits): let humans review AI-sized diffs in reading order",
    body: "Turn one AI-sized MR into a human review order without changing its final tree.",
});
const demoRevisionDefinitions = [
    {
        id: "overview",
        revision: 1,
        name: "Overview",
        buildManifest: buildOverviewDemoManifest,
        pageNames: {
            virtual: { side: "overview.html", line: "overview-line.html" },
            real: { side: "overview-real.html", line: "overview-real-line.html" },
        },
    },
    {
        id: "deep",
        revision: 2,
        name: "Deep review",
        buildManifest: buildDeepReviewDemoManifest,
        pageNames: {
            virtual: { side: "index.html", line: "line.html" },
            real: { side: "real.html", line: "real-line.html" },
        },
    },
];

const readProjectFile = (relativePath) => fs.readFile(path.join(projectRoot, relativePath));
const safeJson = (value) => JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026");
const stripTrailingWhitespace = (value) => value.replace(/[ \t]+$/gm, "");
const selectionKey = (selection) => `${selection.mode}/${selection.from}--${selection.to}`;

const run = async (command, arguments_, {
    cwd = projectRoot,
    input,
    encoding = "utf8",
    maximumBytes = 256 * 1024 * 1024,
} = {}) => new Promise((resolve, reject) => {
    const child = spawn(command, arguments_, {
        cwd,
        env: process.env,
        stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let outputBytes = 0;
    child.stdout.on("data", (chunk) => {
        outputBytes += chunk.length;
        if (outputBytes > maximumBytes) {
            child.kill();
            return;
        }
        stdout.push(chunk);
    });
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => {
        if (code !== 0) {
            reject(new Error(
                Buffer.concat(stderr).toString("utf8").trim()
                || `${command} exited with status ${code}`,
            ));
            return;
        }
        const output = Buffer.concat(stdout);
        resolve(encoding === "buffer" ? output : output.toString(encoding));
    });
    child.stdin.end(input);
});

const git = (arguments_, options) => run("git", arguments_, options);

const ensureDemoHistory = async () => {
    for (const [label, revision] of [
        ["base", demoReviewSource.baseSha],
        ["head", demoReviewSource.headSha],
    ]) {
        try {
            await git(["cat-file", "-e", `${revision}^{commit}`]);
        } catch {
            throw new Error(
                `The pinned Demo ${label} commit is unavailable (${revision}). Fetch the full Git history before building the Demo.`,
            );
        }
    }
};

const commitMetadata = async (revision) => {
    const output = await git([
        "show",
        "-s",
        "--format=%H%x00%h%x00%aI%x00%cs",
        revision,
    ]);
    const [sha, shortSha, authoredAt, dateLabel] = output.trimEnd().split("\0");
    return {
        sha,
        shortSha,
        ...demoCommitMetadata,
        authoredAt,
        dateLabel,
    };
};

const createDemoModel = async ({ temporaryRoot }) => {
    await ensureDemoHistory();
    const stateRoot = path.join(temporaryRoot, "virtual-state");
    const source = await captureVirtualReviewSource({
        repoRoot: projectRoot,
        targetRef: demoReviewSource.baseSha,
        selection: {
            mode: "range",
            from: demoReviewSource.headSha,
            to: demoReviewSource.headSha,
        },
        stateRoot,
    });
    source.sourceId = demoReviewSource.reviewId;
    source.repository = {
        ...source.repository,
        branchName: demoReviewSource.branchName,
        targetRef: demoReviewSource.targetRef,
        targetSha: demoReviewSource.baseSha,
        baseSha: demoReviewSource.baseSha,
        headSha: demoReviewSource.headSha,
    };
    const manifests = Object.fromEntries(demoRevisionDefinitions.map((definition) => [
        definition.id,
        validateVirtualReviewManifest({
            source,
            manifest: definition.buildManifest(source),
        }),
    ]));

    const stateRepository = path.join(temporaryRoot, "state-repository");
    await git(["clone", "--quiet", "--shared", "--no-checkout", projectRoot, stateRepository], {
        cwd: temporaryRoot,
    });
    await git(["read-tree", demoReviewSource.baseSha], { cwd: stateRepository });
    const stateTrees = new Map();
    const baseTree = (await git(["write-tree"], { cwd: stateRepository })).trim();
    const expectedBaseTree = (await git([
        "rev-parse",
        `${demoReviewSource.baseSha}^{tree}`,
    ], { cwd: stateRepository })).trim();
    if (baseTree !== expectedBaseTree) throw new Error("The Demo base tree was not materialized exactly");
    stateTrees.set("base", baseTree);

    const headTree = (await git([
        "rev-parse",
        `${demoReviewSource.headSha}^{tree}`,
    ], { cwd: stateRepository })).trim();
    for (const definition of demoRevisionDefinitions) {
        const manifest = manifests[definition.id];
        await git(["read-tree", demoReviewSource.baseSha], { cwd: stateRepository });
        for (let index = 0; index < manifest.virtualCommits.length; index += 1) {
            const patchText = await buildVirtualComparisonPatch({
                source,
                manifest,
                fromState: index,
                toState: index + 1,
                stateRoot,
            });
            await git(["apply", "--cached", "--binary", "--whitespace=nowarn", "-"], {
                cwd: stateRepository,
                input: patchText,
            });
            stateTrees.set(`${definition.id}-virtual-${index + 1}`, (await git([
                "write-tree",
            ], { cwd: stateRepository })).trim());
        }
        if (stateTrees.get(`${definition.id}-virtual-${manifest.virtualCommits.length}`) !== headTree) {
            throw new Error(`The complete ${definition.name} Demo revision does not reproduce the pinned MR tree`);
        }
    }
    stateTrees.set("real-head", headTree);

    const realCommit = {
        kind: "commit",
        virtual: false,
        ...await commitMetadata(demoReviewSource.headSha),
        snapshot: "real-head",
        parentSnapshot: "base",
    };
    const realSelection = {
        mode: "range",
        from: realCommit.sha,
        to: realCommit.sha,
    };
    const branchCommit = {
        sha: realCommit.sha,
        shortSha: realCommit.shortSha,
        subject: realCommit.subject,
        author: realCommit.author,
        authoredAt: realCommit.authoredAt,
        dateLabel: realCommit.dateLabel,
        branchName: demoReviewSource.branchName,
    };
    const reviewSources = demoRevisionDefinitions.flatMap((definition) => {
        const manifest = manifests[definition.id];
        const virtualStages = manifest.virtualCommits.map((commit, index) => ({
            id: commit.id,
            kind: "commit",
            virtual: false,
            sha: commit.id,
            shortSha: `V${index + 1}`,
            subject: commit.title,
            body: commit.intent,
            description: commit.intent,
            intent: commit.intent,
            author: "Human review order",
            dateLabel: `${index + 1} of ${manifest.virtualCommits.length}`,
            reviewFocus: commit.reviewFocus,
            risk: commit.risk,
            snapshot: `${definition.id}-virtual-${index + 1}`,
            parentSnapshot: index === 0 ? "base" : `${definition.id}-virtual-${index}`,
        }));
        const virtualSelection = {
            mode: "range",
            from: virtualStages[0].sha,
            to: virtualStages.at(-1).sha,
        };
        return [
            {
                id: `real-r${definition.revision}`,
                kind: "real",
                revision: definition.revision,
                revisionName: definition.name,
                active: "real",
                stages: [realCommit],
                defaultSelection: realSelection,
                committedRange: realSelection,
                dirty: false,
                dataPath: `real/revision-${definition.revision}`,
                pageNames: definition.pageNames.real,
                branchCommit,
            },
            {
                id: `virtual-r${definition.revision}`,
                kind: "virtual",
                revision: definition.revision,
                revisionName: definition.name,
                active: "virtual",
                stages: virtualStages,
                defaultSelection: {
                    mode: "single",
                    from: virtualStages[0].sha,
                    to: virtualStages[0].sha,
                },
                committedRange: virtualSelection,
                dirty: false,
                dataPath: `virtual/revision-${definition.revision}`,
                pageNames: definition.pageNames.virtual,
                branchCommit,
                strategy: manifest.strategy,
            },
        ];
    });
    return {
        source,
        manifests,
        reviewSources,
        stateRepository,
        stateTrees,
    };
};

const comparisonDefinitions = (source) => {
    const comparisons = [];
    for (let fromIndex = 0; fromIndex < source.stages.length; fromIndex += 1) {
        comparisons.push({
            source,
            selection: {
                mode: "single",
                from: source.stages[fromIndex].sha,
                to: source.stages[fromIndex].sha,
            },
            fromSnapshot: source.stages[fromIndex].parentSnapshot,
            toSnapshot: source.stages[fromIndex].snapshot,
        });
        for (let toIndex = fromIndex; toIndex < source.stages.length; toIndex += 1) {
            comparisons.push({
                source,
                selection: {
                    mode: "range",
                    from: source.stages[fromIndex].sha,
                    to: source.stages[toIndex].sha,
                },
                fromSnapshot: source.stages[fromIndex].parentSnapshot,
                toSnapshot: source.stages[toIndex].snapshot,
            });
        }
    }
    return comparisons;
};

const buildTreePatch = ({ fromTree, toTree, stateRepository }) => git([
    "diff-tree",
    "-p",
    "--binary",
    "--full-index",
    "--find-renames",
    "--no-ext-diff",
    "--no-textconv",
    "--no-commit-id",
    fromTree,
    toTree,
    "--",
], { cwd: stateRepository });

const decodeGitPath = (value) => {
    if (!value.startsWith('"') || !value.endsWith('"')) return value;
    const input = value.slice(1, -1);
    const chunks = [];
    for (let index = 0; index < input.length; index += 1) {
        if (input[index] !== "\\") {
            chunks.push(Buffer.from(input[index]));
            continue;
        }
        const octal = input.slice(index + 1).match(/^[0-7]{3}/)?.[0];
        if (octal) {
            chunks.push(Buffer.from([Number.parseInt(octal, 8)]));
            index += 3;
            continue;
        }
        index += 1;
        const escaped = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f" }[input[index]]
            || input[index];
        chunks.push(Buffer.from(escaped));
    }
    return Buffer.concat(chunks).toString("utf8");
};

const patchPath = (section, prefix, stripPrefix = false) => {
    const line = section.match(new RegExp(`^${prefix} (.+)$`, "m"))?.[1] || "";
    const decoded = decodeGitPath(line.trim());
    if (decoded === "/dev/null") return "";
    return stripPrefix ? decoded.replace(/^[ab]\//, "") : decoded;
};

const renamedDisplayPath = (oldPath, newPath) => {
    const oldDirectory = path.posix.dirname(oldPath);
    const newDirectory = path.posix.dirname(newPath);
    if (oldDirectory === newDirectory) {
        const directory = oldDirectory === "." ? "" : `${oldDirectory}/`;
        return `${directory}{${path.posix.basename(oldPath)} → ${path.posix.basename(newPath)}}`;
    }
    return `${oldPath} → ${newPath}`;
};

const readTreeBlob = async ({ stateRepository, tree, filePath }) => {
    if (!filePath) return null;
    try {
        return await git(["cat-file", "blob", `${tree}:${filePath}`], {
            cwd: stateRepository,
            encoding: "buffer",
        });
    } catch {
        return null;
    }
};

const buildFilePatchData = async ({ patchText, fromTree, toTree, stateRepository }) => {
    const sections = patchText
        .split(/(?=^diff --git )/m)
        .filter((section) => section.startsWith("diff --git "));
    const records = await Promise.all(sections.map(async (section) => {
        const renamedFrom = patchPath(section, "rename from");
        const renamedTo = patchPath(section, "rename to");
        const oldPath = renamedFrom || patchPath(section, "---", true);
        const newPath = renamedTo || patchPath(section, "\\+\\+\\+", true);
        const patchId = crypto.createHash("sha256").update(section).digest("hex");
        const status = renamedTo ? "renamed" : !newPath ? "deleted" : !oldPath ? "added" : "modified";
        const [baseContent, targetContent] = await Promise.all([
            status === "modified" || status === "renamed"
                ? readTreeBlob({ stateRepository, tree: fromTree, filePath: oldPath })
                : null,
            newPath.endsWith(".md")
                ? readTreeBlob({ stateRepository, tree: toTree, filePath: newPath })
                : null,
        ]);
        const context = baseContent && baseContent.length <= maximumEmbeddedContextBytes
            ? decodeUtf8Text(baseContent)?.lines || null
            : null;
        const preview = targetContent && targetContent.length <= maximumEmbeddedPreviewBytes
            ? decodeUtf8Text(targetContent)?.text || ""
            : null;
        return {
            file: {
                oldPath,
                newPath,
                status,
                patchId,
                displayPath: status === "renamed"
                    ? renamedDisplayPath(oldPath, newPath)
                    : newPath || oldPath,
            },
            context,
            preview,
        };
    }));
    return {
        files: records.map((record) => record.file),
        filePatchIds: Object.fromEntries(records.flatMap(({ file }) => [
            ...(file.oldPath ? [[file.oldPath, file.patchId]] : []),
            ...(file.newPath ? [[file.newPath, file.patchId]] : []),
        ])),
        embeddedContext: Object.fromEntries(records
            .filter((record) => Array.isArray(record.context))
            .map((record) => [record.file.patchId, record.context])),
        embeddedPreviews: Object.fromEntries(records
            .filter((record) => typeof record.preview === "string")
            .map((record) => [record.file.newPath, record.preview])),
    };
};

const injectDemoUi = ({ html, reviewFragment, versionData }) => {
    const injection = [
        '<meta name="description" content="Interactive local-mr review of a real AI-sized GitHub MR, with Overview and Deep review Virtual Commit routes">',
        `<script id="local-mr-version-data" type="application/json">${safeJson(versionData)}</script>`,
        reviewFragment,
    ].join("\n");
    return html.replace("</head>", `${injection}\n</head>`);
};

const publicCommits = (source) => source.stages.map(({ snapshot, parentSnapshot, ...commit }) => commit);

const focusedCommitForComparison = (comparison) => {
    const { source } = comparison;
    const fromIndex = source.stages.findIndex((commit) => commit.sha === comparison.selection.from);
    const toIndex = source.stages.findIndex((commit) => commit.sha === comparison.selection.to);
    const selected = toIndex >= fromIndex ? source.stages.slice(fromIndex, toIndex + 1) : [];
    if (source.kind === "virtual" && selected.length > 1) {
        return {
            kind: "virtual",
            label: "Human review index",
            orderLabel: fromIndex === 0 && toIndex === source.stages.length - 1
                ? `${source.stages.length} virtual commits`
                : `V${fromIndex + 1}–V${toIndex + 1}`,
            title: "Review the MR in human order",
            description: source.strategy,
            meta: `${selected.length} steps in reading order`,
            reviewFocus: selected.map((commit, offset) => (
                `V${fromIndex + offset + 1} · ${commit.subject}`
            )),
        };
    }
    if (selected.length !== 1) return null;
    const [commit] = selected;
    if (source.kind === "virtual") {
        return {
            kind: "virtual",
            label: "Human review index",
            orderLabel: `${commit.shortSha} of ${source.stages.length}`,
            title: commit.subject,
            description: commit.intent,
            meta: `${commit.risk.level} risk`,
            risk: commit.risk,
            reviewFocus: commit.reviewFocus,
            commitId: commit.id,
        };
    }
    return {
        kind: "real",
        label: "Git commit message",
        orderLabel: commit.shortSha,
        title: commit.subject,
        description: commit.body,
        meta: [commit.author, commit.dateLabel].filter(Boolean).join(" / "),
        reviewFocus: [],
    };
};

const buildVersionData = ({
    comparison,
    contextUrls,
    fileData,
    fragmentUrls,
    layout,
    previewUrls,
    reviewSources,
    sourceSummary,
}) => {
    const { source } = comparison;
    const pageName = source.pageNames[layout];
    const selectedCommit = comparison.selection.mode === "single"
        ? source.stages.find((commit) => commit.sha === comparison.selection.from)
        : null;
    const layoutUrls = Object.fromEntries(reviewSources
        .filter((candidate) => candidate.revision === source.revision)
        .map((candidate) => [
            candidate.kind,
            `./${candidate.pageNames[layout]}`,
        ]));
    const virtualRevisions = reviewSources
        .filter((candidate) => candidate.kind === "virtual")
        .sort((left, right) => left.revision - right.revision);
    return {
        reviewUrl: `./${pageName}`,
        reviewDataPattern: `./review-data/${source.dataPath}/${layout}/{mode}/{from}--{to}.json`,
        defaultSelection: source.defaultSelection,
        assets: {
            syntaxHighlight: "./assets/syntax-highlight.js",
            marked: "./assets/marked.js",
            dompurify: "./assets/dompurify.js",
            mermaid: "./assets/mermaid.js",
        },
        patchId: crypto.createHash("sha256").update(comparison.patchText).digest("hex").slice(0, 16),
        filePatchIds: fileData.filePatchIds,
        files: fileData.files,
        fragmentUrls,
        contextUrls,
        previewUrls,
        mode: comparison.selection.mode,
        selection: comparison.selection,
        modeDefaults: {
            single: { mode: "single", from: source.stages[0].sha, to: source.stages[0].sha },
            range: { ...source.committedRange },
        },
        branchName: demoReviewSource.branchName,
        targetRef: demoReviewSource.targetRef,
        dirty: false,
        reviewKind: source.kind,
        focusedCommit: focusedCommitForComparison(comparison),
        commits: publicCommits(source),
        reviewNavigation: {
            active: source.active,
            realUrl: layoutUrls.real,
            virtualUrl: layoutUrls.virtual,
        },
        ...(source.kind === "virtual" ? {
            virtualSession: {
                reviewId: demoReviewSource.reviewId,
                revision: source.revision,
                revisions: virtualRevisions.map((candidate) => ({
                    revision: candidate.revision,
                    label: `Revision ${candidate.revision} · ${candidate.revisionName}`,
                    title: candidate.revisionName,
                    createdAt: "",
                    current: candidate.revision === source.revision,
                    url: `./${candidate.pageNames[layout]}?revision=${candidate.revision}`,
                    branchCommit: candidate.branchCommit,
                })),
                currentCommitId: selectedCommit?.id || "",
                currentIndex: selectedCommit
                    ? source.stages.findIndex((commit) => commit.id === selectedCommit.id) + 1
                    : null,
                reviewedCommitIds: [],
                reviewedCount: 0,
                total: source.stages.length,
                sourceStale: false,
                repositoryAvailable: true,
            },
        } : {}),
        demo: {
            label: source.kind === "virtual" ? "VIRTUAL COMMIT DEMO" : "REAL COMMIT DEMO",
            hint: source.kind === "virtual"
                ? `${source.revisionName} · V1 docs → V${source.stages.length} release metadata · complete range = Real`
                : `${source.revisionName} revision · 1 AI-sized commit · switch to Virtual for human order`,
            repositoryUrl: demoReviewSource.repositoryUrl,
            repositoryLabel: "Star on GitHub ↗",
            source: {
                kind: "github-commit",
                label: demoReviewSource.commitLabel,
                url: demoReviewSource.commitUrl,
                baseSha: demoReviewSource.baseSha,
                headSha: demoReviewSource.headSha,
                diffHash: sourceSummary.diffHash,
                files: sourceSummary.files,
                insertions: sourceSummary.insertions,
                deletions: sourceSummary.deletions,
            },
            layouts: [
                { label: "Side-by-side", url: `./${source.pageNames.side}`, selected: layout === "side" },
                { label: "Line-by-line", url: `./${source.pageNames.line}`, selected: layout === "line" },
            ],
        },
    };
};

const renderedPatchCache = new Map();
const fragmentArtifacts = new Map();
const staticDataArtifacts = new Map();

const contentAddressedData = ({ directory, payload }) => {
    const content = `${JSON.stringify(payload)}\n`;
    const hash = crypto.createHash("sha256").update(content).digest("hex");
    const artifactPath = `${directory}/${hash}.json`;
    staticDataArtifacts.set(artifactPath, content);
    return `./${artifactPath}`;
};

const renderComparison = async ({
    comparison,
    layout,
    stylesheet,
    reviewFragment,
    reviewSources,
    stateRepository,
    stateTrees,
    sourceSummary,
}) => {
    const fromTree = stateTrees.get(comparison.fromSnapshot);
    const toTree = stateTrees.get(comparison.toSnapshot);
    const fileData = await buildFilePatchData({
        patchText: comparison.patchText,
        fromTree,
        toTree,
        stateRepository,
    });
    const patchId = crypto.createHash("sha256").update(comparison.patchText).digest("hex").slice(0, 16);
    const cacheKey = `${layout}:${patchId}`;
    let rendered = renderedPatchCache.get(cacheKey);
    if (!rendered) {
        const html = renderDiffDocument({
            patchText: comparison.patchText,
            style: layout,
            color: "auto",
            title,
            stylesheet,
        });
        const split = splitRenderedReview(html);
        rendered = {
            shellHtml: split.shellHtml,
            diffHtml: split.diffHtml,
            fragments: split.fragments,
            wrapperIds: split.wrapperIds,
        };
        renderedPatchCache.set(cacheKey, rendered);
    }
    if (rendered.wrapperIds.length !== fileData.files.length) {
        throw new Error(
            `diff2html rendered ${rendered.wrapperIds.length} files for ${fileData.files.length} Demo patch sections`,
        );
    }
    const fragmentUrls = {};
    rendered.fragments.forEach((fragment, wrapperId) => {
        const normalizedFragment = stripTrailingWhitespace(fragment);
        const fragmentHash = crypto.createHash("sha256").update(normalizedFragment).digest("hex");
        const fragmentPath = `review-fragments/${fragmentHash}.html`;
        fragmentArtifacts.set(fragmentPath, normalizedFragment);
        fragmentUrls[wrapperId] = `./${fragmentPath}`;
    });
    const contextUrls = Object.fromEntries(Object.entries(fileData.embeddedContext)
        .map(([patchIdForFile, lines]) => [
            patchIdForFile,
            contentAddressedData({ directory: "review-context", payload: { lines } }),
        ]));
    const previewUrls = Object.fromEntries(Object.entries(fileData.embeddedPreviews)
        .map(([filePath, content]) => [
            filePath,
            contentAddressedData({ directory: "review-previews", payload: { content } }),
        ]));
    const versionData = buildVersionData({
        comparison,
        contextUrls,
        fileData,
        fragmentUrls,
        layout,
        previewUrls,
        reviewSources,
        sourceSummary,
    });
    return {
        document: stripTrailingWhitespace(injectDemoUi({
            html: rendered.shellHtml,
            reviewFragment,
            versionData,
        })),
        diffHtml: rendered.diffHtml,
        versionData,
    };
};

const expectedReviewArtifacts = new Set();
const expectedFragmentArtifacts = new Set();
const expectedStaticDataArtifacts = new Set();
const expectedArtifacts = new Set();
const writeOrCheck = async (relativePath, content) => {
    const destination = path.join(demoRoot, relativePath);
    const next = Buffer.isBuffer(content) ? content : Buffer.from(content);
    expectedArtifacts.add(relativePath);
    if (relativePath.startsWith("review-data/")) expectedReviewArtifacts.add(relativePath);
    if (relativePath.startsWith("review-fragments/")) expectedFragmentArtifacts.add(relativePath);
    if (relativePath.startsWith("review-context/") || relativePath.startsWith("review-previews/")) {
        expectedStaticDataArtifacts.add(relativePath);
    }
    if (checkOnly) {
        let current;
        try {
            current = await fs.readFile(destination);
        } catch {
            throw new Error(`Demo artifact is missing: demo/${relativePath}`);
        }
        if (!current.equals(next)) throw new Error(`Demo artifact is stale: demo/${relativePath}`);
        return;
    }
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, next);
};

const listFiles = async (directory, prefix = "") => {
    let entries;
    try {
        entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
        if (error.code === "ENOENT") return [];
        throw error;
    }
    return (await Promise.all(entries.map(async (entry) => {
        const relativePath = path.posix.join(prefix, entry.name);
        const entryPath = path.join(directory, entry.name);
        return entry.isDirectory() ? listFiles(entryPath, relativePath) : [relativePath];
    }))).flat();
};

const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "local-mr-real-demo-"));
try {
    const {
        source,
        manifests,
        reviewSources,
        stateRepository,
        stateTrees,
    } = await createDemoModel({ temporaryRoot });
    const comparisons = [];
    const treePatchCache = new Map();
    for (const sourceDefinition of reviewSources) {
        for (const comparison of comparisonDefinitions(sourceDefinition)) {
            const fromTree = stateTrees.get(comparison.fromSnapshot);
            const toTree = stateTrees.get(comparison.toSnapshot);
            const treePair = `${fromTree}:${toTree}`;
            let patchText = treePatchCache.get(treePair);
            if (patchText === undefined) {
                patchText = await buildTreePatch({
                    fromTree,
                    toTree,
                    stateRepository,
                });
                treePatchCache.set(treePair, patchText);
            }
            comparisons.push({
                ...comparison,
                patchText,
            });
        }
    }
    const completePatches = Object.fromEntries(reviewSources.map((reviewSource) => {
        const comparison = comparisons.find((candidate) => (
            candidate.source.id === reviewSource.id
            && candidate.selection.mode === reviewSource.committedRange.mode
            && candidate.selection.from === reviewSource.committedRange.from
            && candidate.selection.to === reviewSource.committedRange.to
        ));
        if (!comparison) throw new Error(`Complete ${reviewSource.id} Demo comparison is missing`);
        return [reviewSource.id, comparison.patchText];
    }));
    const canonicalCompletePatch = completePatches["real-r2"];
    for (const [sourceId, patchText] of Object.entries(completePatches)) {
        if (patchText !== canonicalCompletePatch) {
            throw new Error(`Complete ${sourceId} Demo range does not match the canonical Real patch`);
        }
    }
    const completeDiffHash = crypto.createHash("sha256").update(canonicalCompletePatch).digest("hex");
    const stylesheet = await readProjectFile("node_modules/diff2html/bundles/css/diff2html.min.css");
    const reviewFragment = await readProjectFile("src/review-ui.html");
    const demoNotices = (await readProjectFile("THIRD_PARTY_NOTICES.md"))
        .toString("utf8")
        .replace(
            "complete license texts are distributed with their packages under `node_modules/<package>/LICENSE*`.",
            "license texts for assets bundled by this static demo are available under `licenses/`.",
        );
    if (!checkOnly) {
        await fs.rm(demoRoot, { recursive: true, force: true });
    }

    const sourceSummary = {
        ...source.summary,
        diffHash: completeDiffHash,
    };
    for (const layout of ["side", "line"]) {
        for (const comparison of comparisons) {
            const rendered = await renderComparison({
                comparison,
                layout,
                stylesheet,
                reviewFragment,
                reviewSources,
                stateRepository,
                stateTrees,
                sourceSummary,
            });
            const reviewPath = `review-data/${comparison.source.dataPath}/${layout}/${selectionKey(comparison.selection)}.json`;
            await writeOrCheck(reviewPath, `${JSON.stringify({
                diffHtml: rendered.diffHtml,
                heading: title,
                title,
                versionData: rendered.versionData,
            })}\n`);
            if (
                comparison.selection.mode === comparison.source.defaultSelection.mode
                && comparison.selection.from === comparison.source.defaultSelection.from
                && comparison.selection.to === comparison.source.defaultSelection.to
            ) {
                await writeOrCheck(comparison.source.pageNames[layout], rendered.document);
            }
        }
    }
    await Promise.all([...fragmentArtifacts].map(([fragmentPath, fragment]) => (
        writeOrCheck(fragmentPath, fragment)
    )));
    await Promise.all([...staticDataArtifacts].map(([artifactPath, content]) => (
        writeOrCheck(artifactPath, content)
    )));
    await Promise.all([
        writeOrCheck(".nojekyll", ""),
        writeOrCheck(
            "assets/syntax-highlight.js",
            await readProjectFile("node_modules/diff2html/bundles/js/diff2html-ui-slim.min.js"),
        ),
        writeOrCheck("assets/marked.js", await readProjectFile("node_modules/marked/lib/marked.umd.js")),
        writeOrCheck("assets/dompurify.js", await readProjectFile("node_modules/dompurify/dist/purify.min.js")),
        writeOrCheck("assets/mermaid.js", await readProjectFile("node_modules/mermaid/dist/mermaid.min.js")),
        writeOrCheck("licenses/local-mr-MIT.txt", stripTrailingWhitespace(
            (await readProjectFile("LICENSE")).toString("utf8"),
        )),
        writeOrCheck("licenses/diff2html.txt", stripTrailingWhitespace(
            (await readProjectFile("node_modules/diff2html/LICENSE.md")).toString("utf8"),
        )),
        writeOrCheck("licenses/highlight.js-BSD-3-Clause.txt", stripTrailingWhitespace(
            (await readProjectFile("node_modules/highlight.js/LICENSE")).toString("utf8"),
        )),
        writeOrCheck("licenses/marked.txt", stripTrailingWhitespace(
            (await readProjectFile("node_modules/marked/LICENSE")).toString("utf8"),
        )),
        writeOrCheck("licenses/dompurify-Apache-2.0.txt", stripTrailingWhitespace(
            (await readProjectFile("node_modules/dompurify/LICENSE")).toString("utf8"),
        )),
        writeOrCheck("licenses/dompurify-MPL-2.0.txt", stripTrailingWhitespace(
            (await readProjectFile("node_modules/dompurify/LICENSE-MPL")).toString("utf8"),
        )),
        writeOrCheck("licenses/mermaid.txt", stripTrailingWhitespace(
            (await readProjectFile("node_modules/mermaid/LICENSE")).toString("utf8"),
        )),
        writeOrCheck("THIRD_PARTY_NOTICES.md", demoNotices),
    ]);

    const actualReviewArtifacts = (await listFiles(path.join(demoRoot, "review-data"), "review-data"))
        .map((relativePath) => relativePath.replaceAll(path.sep, "/"));
    const unexpected = actualReviewArtifacts.filter((artifact) => !expectedReviewArtifacts.has(artifact));
    if (unexpected.length > 0) {
        throw new Error(`Unexpected Demo artifacts: ${unexpected.join(", ")}`);
    }
    const actualFragmentArtifacts = (await listFiles(
        path.join(demoRoot, "review-fragments"),
        "review-fragments",
    )).map((relativePath) => relativePath.replaceAll(path.sep, "/"));
    const unexpectedFragments = actualFragmentArtifacts.filter(
        (artifact) => !expectedFragmentArtifacts.has(artifact),
    );
    if (unexpectedFragments.length > 0) {
        throw new Error(`Unexpected Demo fragments: ${unexpectedFragments.join(", ")}`);
    }
    const actualStaticDataArtifacts = (await Promise.all([
        listFiles(path.join(demoRoot, "review-context"), "review-context"),
        listFiles(path.join(demoRoot, "review-previews"), "review-previews"),
    ])).flat().map((relativePath) => relativePath.replaceAll(path.sep, "/"));
    const unexpectedStaticData = actualStaticDataArtifacts.filter(
        (artifact) => !expectedStaticDataArtifacts.has(artifact),
    );
    if (unexpectedStaticData.length > 0) {
        throw new Error(`Unexpected Demo static data: ${unexpectedStaticData.join(", ")}`);
    }
    const actualArtifacts = (await listFiles(demoRoot))
        .map((relativePath) => relativePath.replaceAll(path.sep, "/"));
    const unexpectedArtifacts = actualArtifacts.filter(
        (artifact) => !expectedArtifacts.has(artifact),
    );
    if (unexpectedArtifacts.length > 0) {
        throw new Error(`Unexpected Demo artifacts outside the generated manifest: ${unexpectedArtifacts.join(", ")}`);
    }
    console.log(JSON.stringify({
        status: checkOnly ? "current" : "built",
        source: demoReviewSource.commitLabel,
        realCommits: 1,
        virtualRevisions: demoRevisionDefinitions.map((definition) => ({
            revision: definition.revision,
            name: definition.name,
            commits: manifests[definition.id].virtualCommits.length,
        })),
        files: source.summary.files,
        insertions: source.summary.insertions,
        deletions: source.summary.deletions,
        diffHash: completeDiffHash,
        comparisons: expectedReviewArtifacts.size,
        fragments: expectedFragmentArtifacts.size,
        staticData: expectedStaticDataArtifacts.size,
    }));
} finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
}
