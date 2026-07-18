#!/usr/bin/env node

import crypto from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import Diff2Html from "diff2html";

import {
    injectReviewUi,
    renderDiffDocument,
    splitRenderedReview,
} from "./review-render.mjs";
import { decodeUtf8Text, materializeText } from "./virtual-diff.mjs";
import {
    buildVirtualComparisonPatch,
    inspectVirtualSourceFreshness,
} from "./virtual-review-core.mjs";
import {
    frozenRealReviewArguments,
    virtualReviewRuntimeIdentity,
} from "./virtual-review-runtime.mjs";
import {
    loadVirtualReviewProgress,
    loadVirtualReviewRevision,
    loadVirtualSource,
    readVirtualBlob,
    updateVirtualReviewProgress,
    virtualReviewRevisionIdentity,
    virtualSourceBranchCommit,
} from "./virtual-review-store.mjs";

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const execFileAsync = promisify(execFile);

const parseArguments = (values) => {
    const options = {};
    for (let index = 0; index < values.length; index += 2) {
        const key = values[index];
        const value = values[index + 1];
        if (!key?.startsWith("--") || value === undefined) throw new Error(`Invalid argument: ${key || "<missing>"}`);
        options[key.slice(2)] = value;
    }
    return options;
};

const options = parseArguments(process.argv.slice(2));
for (const required of ["review", "revision", "identity", "runtime-identity", "ready", "state-root", "command"]) {
    if (!options[required]) throw new Error(`Missing --${required}`);
}

const reviewId = options.review;
const initialRevision = Number(options.revision);
const readyPath = path.resolve(options.ready);
const stateRoot = path.resolve(options["state-root"]);
const expectedRevisionIdentity = options.identity;
const expectedRuntimeIdentity = options["runtime-identity"];
const initialState = await (async () => {
    const { record } = await loadVirtualReviewRevision({ reviewId, revision: initialRevision }, stateRoot);
    const source = await loadVirtualSource(record.sourceId, stateRoot);
    const revisionIdentity = virtualReviewRevisionIdentity({ record, source });
    if (revisionIdentity !== expectedRevisionIdentity) {
        throw new Error("Virtual review revision changed while starting the server");
    }
    const runtimeIdentity = await virtualReviewRuntimeIdentity();
    if (runtimeIdentity !== expectedRuntimeIdentity) {
        throw new Error("Virtual review runtime changed while starting the server");
    }
    return { revisionIdentity, runtimeIdentity };
})();
const token = crypto.randomBytes(18).toString("base64url");
const rootPath = `/${token}`;
const reviewFragment = await fs.readFile(path.join(moduleDirectory, "review-ui.html"), "utf8");
const packageRoot = await (async () => {
    for (const candidate of [moduleDirectory, path.resolve(moduleDirectory, "..")]) {
        try {
            await fs.access(path.join(candidate, "package.json"));
            return candidate;
        } catch {}
    }
    throw new Error("Could not locate local-mr package root");
})();
const stylesheet = await fs.readFile(
    path.join(packageRoot, "node_modules", "diff2html", "bundles", "css", "diff2html.min.css"),
    "utf8",
);
const assetFiles = new Map([
    [
        "syntax-highlight.js",
        path.join(
            packageRoot,
            "node_modules",
            "diff2html",
            "bundles",
            "js",
            "diff2html-ui-slim.min.js",
        ),
    ],
    ["marked.js", path.join(packageRoot, "node_modules", "marked", "lib", "marked.umd.js")],
    ["dompurify.js", path.join(packageRoot, "node_modules", "dompurify", "dist", "purify.min.js")],
    ["mermaid.js", path.join(packageRoot, "node_modules", "mermaid", "dist", "mermaid.min.js")],
]);
const assetCache = new Map();

const maximumCacheBytes = 64 * 1024 * 1024;
const maximumCacheEntries = 128;
const patchCache = new Map();
let patchCacheBytes = 0;
const cachePatch = (key, value) => {
    const bytes = Buffer.byteLength(value.shellHtml)
        + Buffer.byteLength(value.diffHtml)
        + [...value.fragments.values()].reduce((total, fragment) => total + Buffer.byteLength(fragment), 0);
    if (bytes > maximumCacheBytes) return;
    if (patchCache.has(key)) patchCacheBytes -= patchCache.get(key).bytes;
    patchCache.delete(key);
    patchCache.set(key, { value, bytes });
    patchCacheBytes += bytes;
    while (patchCache.size > maximumCacheEntries || patchCacheBytes > maximumCacheBytes) {
        const oldest = patchCache.keys().next().value;
        patchCacheBytes -= patchCache.get(oldest).bytes;
        patchCache.delete(oldest);
    }
};

const getCachedPatch = (key) => {
    const entry = patchCache.get(key);
    if (!entry) return null;
    patchCache.delete(key);
    patchCache.set(key, entry);
    return entry.value;
};

const realReviewLoads = new Map();
const startRealReview = async (source) => {
    const arguments_ = frozenRealReviewArguments(source);
    const key = [
        source.repository.root,
        source.repository.baseSha,
        source.repository.headSha,
        source.repository.targetSha,
    ].join("\0");
    if (realReviewLoads.has(key)) return realReviewLoads.get(key);
    const loading = execFileAsync(options.command, arguments_, {
        cwd: source.repository.root,
        encoding: "utf8",
        env: process.env,
        maxBuffer: 16 * 1024 * 1024,
        timeout: 120_000,
    }).then(({ stdout }) => {
        const reviewUrl = stdout.match(/^Review:\s+(\S+)\s*$/m)?.[1];
        if (!reviewUrl) throw new Error("The real review command did not return a review URL");
        const parsed = new URL(reviewUrl);
        if (
            parsed.protocol !== "http:"
            || parsed.hostname !== "127.0.0.1"
            || parsed.username
            || parsed.password
            || !/^\/[A-Za-z0-9_-]{24}\/review$/.test(parsed.pathname)
        ) {
            throw new Error("The real review command returned an invalid local URL");
        }
        return parsed;
    }).catch((error) => {
        const detail = error.stderr?.trim() || error.stdout?.trim() || error.message;
        throw new Error(`Could not open the real commit review: ${detail}`);
    }).finally(() => {
        realReviewLoads.delete(key);
    });
    realReviewLoads.set(key, loading);
    return loading;
};

const virtualReturnUrl = ({ candidate, origin, revision }) => {
    const fallback = new URL(`${origin}${rootPath}/review`);
    fallback.searchParams.set("revision", String(revision));
    if (!candidate || candidate.length > 4096) return fallback;
    try {
        const parsed = new URL(candidate);
        if (
            parsed.origin !== origin
            || parsed.username
            || parsed.password
            || parsed.pathname !== `${rootPath}/review`
            || parsed.searchParams.get("revision") !== String(revision)
        ) return fallback;
        return parsed;
    } catch {
        return fallback;
    }
};

const maximumLinkedReviewUrlLength = 4096;
const realReviewParameter = "real-review-url";

const liveRealReviewUrl = (candidate) => {
    if (!candidate || candidate.length > maximumLinkedReviewUrlLength) return null;
    try {
        const parsed = new URL(candidate);
        const loopback = parsed.hostname === "127.0.0.1"
            || parsed.hostname === "localhost"
            || parsed.hostname === "[::1]";
        if (
            !["http:", "https:"].includes(parsed.protocol)
            || !loopback
            || parsed.username
            || parsed.password
            || !/^\/[A-Za-z0-9_-]{24}\/review$/.test(parsed.pathname)
        ) return null;
        return parsed;
    } catch {
        return null;
    }
};

const preserveLiveRealReview = (url, realReviewUrl) => {
    if (realReviewUrl) url.searchParams.set(realReviewParameter, realReviewUrl.href);
    return url;
};

const normalizedDiffPath = (value) => value && value !== "/dev/null" ? value : "";

const renamedDisplayPath = (oldPath, newPath) => {
    const oldDirectory = path.posix.dirname(oldPath);
    const newDirectory = path.posix.dirname(newPath);
    if (oldDirectory === newDirectory) {
        const directory = oldDirectory === "." ? "" : `${oldDirectory}/`;
        return `${directory}{${path.posix.basename(oldPath)} → ${path.posix.basename(newPath)}}`;
    }
    return `${oldPath} → ${newPath}`;
};

const patchFileStatus = (file) => {
    if (file.isRename) return "renamed";
    if (file.isNew) return "added";
    if (file.isDeleted) return "deleted";
    return "modified";
};

const sourceFileForPatch = (sourceFiles, oldPath, newPath) => {
    const exact = sourceFiles.filter((file) => file.oldPath === oldPath && file.newPath === newPath);
    if (exact.length === 1) return exact[0];
    if (exact.length > 1) throw new Error(`Ambiguous virtual source path pair: ${oldPath} → ${newPath}`);
    const pathMatches = sourceFiles.filter((file) => (
        [file.oldPath, file.newPath]
            .filter(Boolean)
            .some((candidate) => candidate === oldPath || candidate === newPath)
    ));
    if (pathMatches.length <= 1) return pathMatches[0];
    throw new Error(`Ambiguous virtual source path: ${newPath || oldPath}`);
};

const virtualCommitIds = (context) => (
    context.record.manifest.virtualCommits.map((commit) => commit.id)
);

const virtualSelectionDescriptor = (context, input = {}, { allowDefault = true } = {}) => {
    const value = (name) => typeof input.get === "function" ? input.get(name) : input[name];
    const commitIds = virtualCommitIds(context);
    if (commitIds.length === 0) throw new Error("Virtual review has no commits");
    const requested = {
        mode: value("mode"),
        from: value("from"),
        to: value("to"),
    };
    const suppliedCount = Object.values(requested).filter((item) => item !== null && item !== undefined).length;
    if (suppliedCount === 0) {
        if (!allowDefault) throw new Error("Virtual comparison endpoints are required");
        return {
            selection: { mode: "single", from: commitIds[0], to: commitIds[0] },
            fromState: 0,
            toState: 1,
            currentCommitIndex: 0,
        };
    }
    if (suppliedCount !== 3 || Object.values(requested).some((item) => typeof item !== "string" || !item)) {
        throw new Error("Virtual comparison mode, from, and to must be provided together");
    }
    if (
        requested.mode === "single"
        || (requested.mode === "commits" && requested.from === requested.to)
    ) {
        if (requested.from !== requested.to) {
            throw new Error("Virtual Single commit mode accepts exactly one virtual commit");
        }
        const selectedIndex = commitIds.indexOf(requested.from);
        if (selectedIndex < 0) throw new Error(`Unknown virtual commit: ${requested.from}`);
        return {
            selection: {
                mode: "single",
                from: commitIds[selectedIndex],
                to: commitIds[selectedIndex],
            },
            fromState: selectedIndex,
            toState: selectedIndex + 1,
            currentCommitIndex: selectedIndex,
        };
    }

    if (requested.mode === "push") {
        const boundaries = ["base", ...commitIds];
        const fromBoundary = boundaries.indexOf(requested.from);
        const toBoundary = boundaries.indexOf(requested.to);
        if (fromBoundary < 0) throw new Error(`Unknown legacy virtual push from endpoint: ${requested.from}`);
        if (toBoundary < 0) throw new Error(`Unknown legacy virtual push to endpoint: ${requested.to}`);
        if (toBoundary <= fromBoundary) throw new Error("Legacy virtual push to endpoint must follow from endpoint");
        const fromIndex = fromBoundary;
        const toIndex = toBoundary - 1;
        const mode = fromIndex === toIndex ? "single" : "range";
        return {
            selection: { mode, from: commitIds[fromIndex], to: commitIds[toIndex] },
            fromState: fromIndex,
            toState: toIndex + 1,
            currentCommitIndex: mode === "single" ? fromIndex : null,
        };
    }

    const compatibleMode = requested.mode === "commits"
        ? requested.from === requested.to ? "single" : "range"
        : requested.mode;
    if (compatibleMode !== "range") {
        throw new Error(`Unsupported virtual comparison mode: ${requested.mode}`);
    }
    const fromIndex = commitIds.indexOf(requested.from);
    const toIndex = commitIds.indexOf(requested.to);
    if (fromIndex < 0) throw new Error(`Unknown virtual range from commit: ${requested.from}`);
    if (toIndex < 0) throw new Error(`Unknown virtual range to commit: ${requested.to}`);
    if (toIndex < fromIndex) throw new Error("Virtual range to commit must not precede from commit");
    return {
        selection: {
            mode: "range",
            from: commitIds[fromIndex],
            to: commitIds[toIndex],
        },
        fromState: fromIndex,
        toState: toIndex + 1,
        currentCommitIndex: null,
    };
};

const comparisonPatchText = async (context, descriptor) => {
    const commitCount = context.record.manifest.virtualCommits.length;
    if (descriptor.fromState === 0 && descriptor.toState === commitCount) {
        return (await readVirtualBlob(context.record.fullPatchBlob.hash, stateRoot)).toString("utf8");
    }
    if (descriptor.toState === descriptor.fromState + 1) {
        return (await readVirtualBlob(
            context.record.commitPatchBlobs[descriptor.fromState].hash,
            stateRoot,
        )).toString("utf8");
    }
    return buildVirtualComparisonPatch({
        source: context.source,
        manifest: context.record.manifest,
        fromState: descriptor.fromState,
        toState: descriptor.toState,
        stateRoot,
    });
};

const blocksInComparison = (context, descriptor) => new Set(
    context.record.manifest.virtualCommits
        .slice(descriptor.fromState, descriptor.toState)
        .flatMap((commit) => commit.blocks),
);

const renderVirtualComparison = async (context, descriptor) => {
    const cacheKey = [
        context.revisionIdentity,
        initialState.runtimeIdentity,
        context.source.sourceId,
        descriptor.fromState,
        descriptor.toState,
    ].join(":");
    const cached = getCachedPatch(cacheKey);
    if (cached) return cached;
    const patchText = await comparisonPatchText(context, descriptor);
    const patchId = crypto.createHash("sha256").update(patchText).digest("hex").slice(0, 16);
    const rendered = renderDiffDocument({
        patchText,
        style: "side",
        color: "auto",
        title: `Local MR: ${context.source.repository.branchName} → ${context.source.repository.targetRef}`,
        stylesheet,
    });
    const { shellHtml, diffHtml, fragments, wrapperIds } = splitRenderedReview(rendered);
    const parsedFiles = Diff2Html.parse(patchText);
    if (wrapperIds.length !== parsedFiles.length) {
        throw new Error(
            `diff2html rendered ${wrapperIds.length} files for ${parsedFiles.length} patch sections`,
        );
    }
    const selectedBlocks = blocksInComparison(context, descriptor);
    const files = parsedFiles.map((file, fileIndex) => {
        const oldPath = normalizedDiffPath(file.oldName);
        const newPath = normalizedDiffPath(file.newName);
        const status = patchFileStatus(file);
        const sourceFile = sourceFileForPatch(context.source.files, oldPath, newPath);
        const treePath = newPath || oldPath;
        const id = crypto.createHash("sha256")
            .update(patchId)
            .update("\0")
            .update(oldPath)
            .update("\0")
            .update(newPath)
            .digest("hex");
        return {
            id,
            patchId: id,
            wrapperId: wrapperIds[fileIndex],
            treePath,
            path: treePath,
            displayPath: status === "renamed" ? renamedDisplayPath(oldPath, newPath) : treePath,
            oldPath,
            newPath,
            status,
            additions: Number(file.addedLines) || 0,
            deletions: Number(file.deletedLines) || 0,
            blockIds: sourceFile?.blocks
                .filter((block) => selectedBlocks.has(block.id))
                .map((block) => block.id) || [],
        };
    });
    const result = {
        shellHtml,
        diffHtml,
        fragments,
        patchId,
        files,
    };
    cachePatch(cacheKey, result);
    return result;
};

const selectedCommitBlocks = (context, endExclusive) => new Set(
    context.record.manifest.virtualCommits
        .slice(0, endExclusive)
        .flatMap((commit) => commit.blocks),
);

const storedEntryContent = async (entry) => {
    if (!entry) return null;
    if (entry.mode === "160000" || !entry.blob) return null;
    return readVirtualBlob(entry.blob, stateRoot);
};

const materializedVirtualFile = async ({ context, sourceFile, stateIndex }) => {
    const selectedBlocks = selectedCommitBlocks(context, stateIndex);
    const selectedInFile = sourceFile.blocks.filter((block) => selectedBlocks.has(block.id));
    if (sourceFile.kind === "special") {
        return storedEntryContent(selectedInFile.length > 0 ? sourceFile.target : sourceFile.base);
    }
    const [baseContent, targetContent] = await Promise.all([
        storedEntryContent(sourceFile.base),
        storedEntryContent(sourceFile.target),
    ]);
    const baseText = decodeUtf8Text(baseContent || Buffer.alloc(0));
    const targetText = decodeUtf8Text(targetContent || Buffer.alloc(0));
    if (!baseText || !targetText) return null;
    return Buffer.from(materializeText({
        baseText: baseText.text,
        targetText: targetText.text,
        blocks: sourceFile.blocks,
        selectedBlockIds: selectedInFile.map((block) => block.id),
    }));
};

const sourceFileForRendered = (context, renderedFile) => sourceFileForPatch(
    context.source.files,
    renderedFile.oldPath,
    renderedFile.newPath,
);

const virtualComparisonClientModel = async ({
    context,
    rendered,
    descriptor,
    origin,
    realReviewUrl,
}) => {
    const baseUrl = `${origin}${rootPath}`;
    const revision = context.record.revision;
    const commitCount = context.record.manifest.virtualCommits.length;
    const reviewUrl = new URL(`${baseUrl}/review`);
    reviewUrl.searchParams.set("revision", String(revision));
    reviewUrl.searchParams.set("mode", descriptor.selection.mode);
    reviewUrl.searchParams.set("from", descriptor.selection.from);
    reviewUrl.searchParams.set("to", descriptor.selection.to);
    preserveLiveRealReview(reviewUrl, realReviewUrl);
    const realUrl = realReviewUrl || new URL(`${baseUrl}/real`);
    if (!realReviewUrl) {
        realUrl.searchParams.set("revision", String(revision));
        realUrl.searchParams.set("return", reviewUrl.href);
    }
    const reviewDataUrl = new URL(`${baseUrl}/review-data`);
    reviewDataUrl.searchParams.set("revision", String(revision));
    preserveLiveRealReview(reviewDataUrl, realReviewUrl);
    const fragmentUrl = new URL(`${baseUrl}/diff-file`);
    fragmentUrl.searchParams.set("revision", String(revision));
    preserveLiveRealReview(fragmentUrl, realReviewUrl);
    const contextUrl = new URL(`${baseUrl}/diff-context`);
    contextUrl.searchParams.set("revision", String(revision));
    preserveLiveRealReview(contextUrl, realReviewUrl);
    const previewUrl = new URL(`${baseUrl}/file`);
    previewUrl.searchParams.set("revision", String(revision));
    preserveLiveRealReview(previewUrl, realReviewUrl);
    const progress = await loadVirtualReviewProgress({ reviewId, revision }, stateRoot);
    const reviewed = new Set(progress.reviewedCommitIds);
    const commits = context.record.manifest.virtualCommits.map((item, commitIndex) => ({
        id: item.id,
        sha: item.id,
        shortSha: `V${commitIndex + 1}`,
        subject: item.title,
        author: "AI review order",
        dateLabel: `${commitIndex + 1} of ${commitCount}`,
        body: item.intent,
        description: item.intent,
        virtual: false,
        index: commitIndex + 1,
        title: item.title,
        intent: item.intent,
        reviewFocus: item.reviewFocus,
        risk: item.risk,
        reviewed: reviewed.has(item.id),
    }));
    const filePatchIds = Object.fromEntries(rendered.files.flatMap((file) => (
        [file.oldPath, file.newPath, file.path]
            .filter(Boolean)
            .map((filePath) => [filePath, file.patchId])
    )));
    const selectedCommits = context.record.manifest.virtualCommits.slice(
        descriptor.fromState,
        descriptor.toState,
    );
    const selectedCommit = descriptor.currentCommitIndex === null
        ? null
        : context.record.manifest.virtualCommits[descriptor.currentCommitIndex];
    const focusedCommit = selectedCommit ? {
        kind: "virtual",
        label: "AI review index",
        orderLabel: `V${descriptor.currentCommitIndex + 1} of ${commitCount}`,
        title: selectedCommit.title,
        description: selectedCommit.intent,
        meta: `${selectedCommit.risk?.level || "Unrated"} risk`,
        risk: selectedCommit.risk,
        reviewFocus: selectedCommit.reviewFocus,
        commitId: selectedCommit.id,
    } : {
        kind: "virtual",
        label: "AI review index",
        orderLabel: descriptor.fromState === 0 && descriptor.toState === commitCount
            ? `${commitCount} virtual commits`
            : `V${descriptor.fromState + 1}–V${descriptor.toState}`,
        title: context.record.manifest.title,
        description: context.record.manifest.strategy,
        meta: `${selectedCommits.length} step${selectedCommits.length === 1 ? "" : "s"} in reading order`,
        reviewFocus: selectedCommits.map((commit, offset) => (
            `V${descriptor.fromState + offset + 1} · ${commit.title}`
        )),
    };
    const revisionSourceLoads = new Map([[context.source.sourceId, Promise.resolve(context.source)]]);
    const sourceForRevision = (item) => {
        if (!revisionSourceLoads.has(item.sourceId)) {
            revisionSourceLoads.set(item.sourceId, loadVirtualSource(item.sourceId, stateRoot));
        }
        return revisionSourceLoads.get(item.sourceId);
    };
    const revisions = await Promise.all(context.meta.revisions.map(async (item) => {
        let branchCommit = null;
        try {
            branchCommit = virtualSourceBranchCommit(await sourceForRevision(item));
        } catch {
            // A missing historical source should not hide an otherwise readable revision.
        }
        const revisionUrl = new URL(`${baseUrl}/review`);
        revisionUrl.searchParams.set("revision", String(item.revision));
        preserveLiveRealReview(revisionUrl, realReviewUrl);
        return {
            ...item,
            label: `Revision ${item.revision} · ${item.title}`,
            current: item.revision === revision,
            url: revisionUrl.href,
            branchCommit,
        };
    }));
    const sourceCommit = virtualSourceBranchCommit(context.source);
    const currentHeadSha = context.freshness?.currentHeadSha || null;
    const currentCommit = currentHeadSha ? {
        sha: currentHeadSha,
        shortSha: currentHeadSha.slice(0, 8),
    } : null;
    return {
        reviewUrl: reviewUrl.href,
        reviewDataUrl: reviewDataUrl.href,
        fragmentUrl: fragmentUrl.href,
        contextUrl: contextUrl.href,
        previewUrl: previewUrl.href,
        assets: {
            syntaxHighlight: `${baseUrl}/assets/syntax-highlight.js`,
            marked: `${baseUrl}/assets/marked.js`,
            dompurify: `${baseUrl}/assets/dompurify.js`,
            mermaid: `${baseUrl}/assets/mermaid.js`,
        },
        patchId: rendered.patchId,
        filePatchIds,
        files: rendered.files,
        mode: descriptor.selection.mode,
        selection: descriptor.selection,
        defaultSelection: { mode: "single", from: commits[0].id, to: commits[0].id },
        modeDefaults: {
            single: { mode: "single", from: commits[0].id, to: commits[0].id },
            range: { mode: "range", from: commits[0].id, to: commits.at(-1).id },
        },
        reviewKind: "virtual",
        branchName: context.source.repository.branchName,
        targetRef: context.source.repository.targetRef,
        dirty: false,
        focusedCommit,
        commits,
        reviewNavigation: {
            active: "virtual",
            realUrl: realUrl.href,
            virtualUrl: reviewUrl.href,
            virtualState: context.freshness?.stale === true ? "stale" : "current",
            virtualReview: {
                reviewId,
                revision,
                sourceCommit,
                currentCommit,
            },
        },
        virtualSession: {
            reviewId,
            revision,
            revisions,
            progressUrl: `${baseUrl}/progress?revision=${revision}`,
            currentCommitId: selectedCommit?.id || "",
            currentIndex: descriptor.currentCommitIndex === null
                ? null
                : descriptor.currentCommitIndex + 1,
            reviewedCommitIds: [...reviewed],
            reviewedCount: reviewed.size,
            total: commitCount,
            sourceStale: context.freshness?.stale ?? null,
            repositoryAvailable: context.freshness?.repositoryAvailable ?? null,
            currentHeadSha: context.freshness?.currentHeadSha ?? null,
            currentTargetSha: context.freshness?.currentTargetSha ?? null,
            currentBaseSha: context.freshness?.currentBaseSha ?? null,
            previousSelection: descriptor.currentCommitIndex > 0
                ? commits[descriptor.currentCommitIndex - 1].id
                : null,
            nextSelection: descriptor.currentCommitIndex !== null
                && descriptor.currentCommitIndex + 1 < commitCount
                ? commits[descriptor.currentCommitIndex + 1].id
                : null,
        },
    };
};

const freshnessCache = new Map();
const cachedSourceFreshness = async (source) => {
    const cached = freshnessCache.get(source.sourceId);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    const value = await inspectVirtualSourceFreshness(source);
    freshnessCache.set(source.sourceId, { value, expiresAt: Date.now() + 10_000 });
    return value;
};

const revisionContext = async (revisionValue, origin, { includeFreshness = false } = {}) => {
    const revision = Number(revisionValue || initialRevision);
    const { meta, record } = await loadVirtualReviewRevision({ reviewId, revision }, stateRoot);
    const source = await loadVirtualSource(record.sourceId, stateRoot);
    const revisionIdentity = virtualReviewRevisionIdentity({ record, source });
    const freshness = includeFreshness ? await cachedSourceFreshness(source) : null;
    return {
        meta,
        record,
        source,
        revisionIdentity,
        freshness,
    };
};

const readJsonBody = async (request) => {
    const chunks = [];
    let bytes = 0;
    for await (const chunk of request) {
        bytes += chunk.length;
        if (bytes > 64 * 1024) throw new Error("Request body is too large");
        chunks.push(chunk);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch {
        throw new Error("Request body must be valid JSON");
    }
};

const idleMilliseconds = Math.max(1, Number(process.env.LOCAL_MR_SERVER_IDLE_MINUTES || 480)) * 60 * 1000;
let idleTimer;
const resetIdleTimer = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => server.close(), idleMilliseconds);
    idleTimer.unref();
};

const server = http.createServer(async (request, response) => {
    resetIdleTimer();
    const address = server.address();
    const origin = `http://127.0.0.1:${address.port}`;
    const url = new URL(request.url || "/", origin);
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader(
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
    );

    try {
        if (url.pathname === `${rootPath}/health`) {
            response.setHeader("Content-Type", "application/json; charset=utf-8");
            response.end(JSON.stringify({
                ok: true,
                reviewId,
                revision: initialRevision,
                revisionIdentity: initialState.revisionIdentity,
                runtimeIdentity: initialState.runtimeIdentity,
                pid: process.pid,
            }));
            return;
        }
        if (url.pathname === `${rootPath}/shutdown`) {
            if (request.method !== "POST") {
                response.statusCode = 405;
                response.setHeader("Allow", "POST");
                response.end("Method not allowed");
                return;
            }
            response.statusCode = 204;
            response.end();
            setImmediate(() => server.close());
            return;
        }
        if (url.pathname === rootPath || url.pathname === `${rootPath}/`) {
            response.statusCode = 302;
            response.setHeader("Location", `${rootPath}/review?revision=${initialRevision}`);
            response.end();
            return;
        }
        if (url.pathname === `${rootPath}/real`) {
            if (request.method !== "GET") {
                response.statusCode = 405;
                response.setHeader("Allow", "GET");
                response.end("Method not allowed");
                return;
            }
            const context = await revisionContext(url.searchParams.get("revision"), origin);
            const realUrl = new URL(await startRealReview(context.source));
            realUrl.searchParams.set("virtual-review-url", virtualReturnUrl({
                candidate: url.searchParams.get("return"),
                origin,
                revision: context.record.revision,
            }).href);
            response.statusCode = 302;
            response.setHeader("Location", realUrl.href);
            response.end();
            return;
        }
        if (url.pathname.startsWith(`${rootPath}/assets/`)) {
            const name = url.pathname.slice(`${rootPath}/assets/`.length);
            if (!assetFiles.has(name)) {
                response.statusCode = 404;
                response.end("Not found");
                return;
            }
            let content = assetCache.get(name);
            if (!content) {
                content = await fs.readFile(assetFiles.get(name));
                assetCache.set(name, content);
            }
            response.setHeader("Cache-Control", "private, max-age=3600");
            response.setHeader("Content-Type", "text/javascript; charset=utf-8");
            response.end(content);
            return;
        }
        if (url.pathname === `${rootPath}/review`) {
            const realReviewUrl = liveRealReviewUrl(url.searchParams.get(realReviewParameter));
            const context = await revisionContext(
                url.searchParams.get("revision"),
                origin,
                { includeFreshness: true },
            );
            const descriptor = virtualSelectionDescriptor(context, url.searchParams);
            const canonical = new URL(`${origin}${rootPath}/review`);
            canonical.searchParams.set("revision", String(context.record.revision));
            canonical.searchParams.set("mode", descriptor.selection.mode);
            canonical.searchParams.set("from", descriptor.selection.from);
            canonical.searchParams.set("to", descriptor.selection.to);
            const target = url.searchParams.get("target");
            if (target && target.length <= 4096) canonical.searchParams.set("target", target);
            preserveLiveRealReview(canonical, realReviewUrl);
            if (`${url.pathname}${url.search}` !== `${canonical.pathname}${canonical.search}`) {
                response.statusCode = 302;
                response.setHeader("Location", `${canonical.pathname}${canonical.search}`);
                response.end();
                return;
            }
            const rendered = await renderVirtualComparison(context, descriptor);
            const versionData = await virtualComparisonClientModel({
                context,
                rendered,
                descriptor,
                origin,
                realReviewUrl,
            });
            response.setHeader("Content-Type", "text/html; charset=utf-8");
            response.end(injectReviewUi({
                html: rendered.shellHtml,
                fragment: reviewFragment,
                versionData,
            }));
            return;
        }
        if (url.pathname === `${rootPath}/review-data`) {
            const realReviewUrl = liveRealReviewUrl(url.searchParams.get(realReviewParameter));
            const context = await revisionContext(
                url.searchParams.get("revision"),
                origin,
                { includeFreshness: true },
            );
            const descriptor = virtualSelectionDescriptor(context, url.searchParams);
            const rendered = await renderVirtualComparison(context, descriptor);
            const versionData = await virtualComparisonClientModel({
                context,
                rendered,
                descriptor,
                origin,
                realReviewUrl,
            });
            const title = `Local MR: ${context.source.repository.branchName} → ${context.source.repository.targetRef}`;
            response.setHeader("Content-Type", "application/json; charset=utf-8");
            response.end(JSON.stringify({
                title,
                heading: title,
                diffHtml: rendered.diffHtml,
                versionData,
            }));
            return;
        }
        if (url.pathname === `${rootPath}/diff-file`) {
            const context = await revisionContext(url.searchParams.get("revision"), origin);
            const descriptor = virtualSelectionDescriptor(
                context,
                url.searchParams,
                { allowDefault: false },
            );
            const rendered = await renderVirtualComparison(context, descriptor);
            if (url.searchParams.get("patch") !== rendered.patchId) {
                response.statusCode = 409;
                response.end("The virtual comparison changed; reload this review");
                return;
            }
            const fragment = rendered.fragments.get(url.searchParams.get("id") || "");
            if (!fragment) {
                response.statusCode = 404;
                response.end("Diff fragment not found");
                return;
            }
            response.setHeader("Content-Type", "text/html; charset=utf-8");
            response.end(fragment);
            return;
        }
        if (url.pathname === `${rootPath}/diff-context`) {
            const start = Number(url.searchParams.get("start"));
            const end = Number(url.searchParams.get("end"));
            if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start) {
                throw new Error("Invalid context line range");
            }
            const context = await revisionContext(url.searchParams.get("revision"), origin);
            const descriptor = virtualSelectionDescriptor(
                context,
                url.searchParams,
                { allowDefault: false },
            );
            const rendered = await renderVirtualComparison(context, descriptor);
            if (url.searchParams.get("patch") !== rendered.patchId) {
                response.statusCode = 409;
                response.setHeader("Content-Type", "application/json; charset=utf-8");
                response.end(JSON.stringify({ error: "The virtual comparison changed; reload this review" }));
                return;
            }
            const renderedFile = rendered.files.find((file) => file.patchId === url.searchParams.get("file"));
            const sourceFile = renderedFile && sourceFileForRendered(context, renderedFile);
            if (!renderedFile || !sourceFile) throw new Error("Virtual comparison file not found");
            if (renderedFile.status === "added" || renderedFile.status === "deleted" || !renderedFile.oldPath) {
                throw new Error("Diff context is unavailable for this file");
            }
            const content = await materializedVirtualFile({
                context,
                sourceFile,
                stateIndex: descriptor.fromState,
            });
            const decoded = content && decodeUtf8Text(content);
            if (!decoded) throw new Error("Diff context is unavailable for this file");
            const lines = decoded.lines.map((line) => line.replace(/\r$/, ""));
            const boundedEnd = Math.min(end, lines.length);
            response.setHeader("Content-Type", "application/json; charset=utf-8");
            response.end(JSON.stringify({
                path: renderedFile.oldPath || renderedFile.path,
                start,
                end: boundedEnd,
                totalLines: lines.length,
                hasMore: boundedEnd < lines.length,
                lines: start <= boundedEnd ? lines.slice(start - 1, boundedEnd) : [],
            }));
            return;
        }
        if (url.pathname === `${rootPath}/file`) {
            const requestedPath = url.searchParams.get("path") || "";
            if (!/\.(?:md|markdown|mdown|mkd)$/i.test(requestedPath)) {
                throw new Error("Preview is only available for Markdown files");
            }
            const context = await revisionContext(url.searchParams.get("revision"), origin);
            const descriptor = virtualSelectionDescriptor(
                context,
                url.searchParams,
                { allowDefault: false },
            );
            const rendered = await renderVirtualComparison(context, descriptor);
            if (url.searchParams.get("patch") !== rendered.patchId) {
                response.statusCode = 409;
                response.setHeader("Content-Type", "application/json; charset=utf-8");
                response.end(JSON.stringify({ error: "The virtual comparison changed; reload this review" }));
                return;
            }
            const renderedFile = rendered.files.find((file) => (
                file.newPath === requestedPath || file.path === requestedPath
            ));
            const sourceFile = renderedFile && sourceFileForRendered(context, renderedFile);
            if (!renderedFile || !sourceFile || renderedFile.status === "deleted") {
                throw new Error("Markdown file is unavailable in this virtual comparison");
            }
            const content = await materializedVirtualFile({
                context,
                sourceFile,
                stateIndex: descriptor.toState,
            });
            if (!content || content.length > 2 * 1024 * 1024) {
                throw new Error("Markdown preview is larger than 2 MiB or unavailable");
            }
            const decoded = decodeUtf8Text(content);
            if (!decoded) throw new Error("Markdown preview requires a UTF-8 text file");
            response.setHeader("Content-Type", "application/json; charset=utf-8");
            response.end(JSON.stringify({ path: requestedPath, markdown: true, content: decoded.text }));
            return;
        }
        if (url.pathname === `${rootPath}/progress`) {
            const revision = Number(url.searchParams.get("revision"));
            const { record } = await loadVirtualReviewRevision({ reviewId, revision }, stateRoot);
            if (request.method === "GET") {
                response.setHeader("Content-Type", "application/json; charset=utf-8");
                response.end(JSON.stringify(await loadVirtualReviewProgress({ reviewId, revision }, stateRoot)));
                return;
            }
            if (request.method === "PATCH") {
                const payload = await readJsonBody(request);
                if (!record.manifest.virtualCommits.some((commit) => commit.id === payload.commitId)) {
                    throw new Error("Virtual commit does not exist in this revision");
                }
                await updateVirtualReviewProgress({
                    reviewId,
                    revision,
                    commitId: payload.commitId,
                    kind: payload.kind,
                    value: payload.value,
                }, stateRoot);
                response.statusCode = 204;
                response.end();
                return;
            }
            response.statusCode = 405;
            response.setHeader("Allow", "GET, PATCH");
            response.end("Method not allowed");
            return;
        }
        response.statusCode = 404;
        response.end("Not found");
    } catch (error) {
        response.statusCode = 400;
        response.setHeader("Content-Type", "application/json; charset=utf-8");
        response.end(JSON.stringify({ error: error.message }));
    }
});

await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
});
const address = server.address();
const reviewUrl = `http://127.0.0.1:${address.port}${rootPath}/review?revision=${initialRevision}`;
const healthUrl = `http://127.0.0.1:${address.port}${rootPath}/health`;
await fs.mkdir(path.dirname(readyPath), { recursive: true, mode: 0o700 });
await fs.writeFile(readyPath, JSON.stringify({
    pid: process.pid,
    reviewId,
    revision: initialRevision,
    revisionIdentity: initialState.revisionIdentity,
    runtimeIdentity: initialState.runtimeIdentity,
    reviewUrl,
    healthUrl,
    token,
}), { mode: 0o600 });
resetIdleTimer();

const shutdown = () => server.close();
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
server.on("close", async () => {
    try {
        const ready = JSON.parse(await fs.readFile(readyPath, "utf8"));
        if (ready.pid === process.pid) await fs.rm(readyPath, { force: true });
    } catch {}
});
