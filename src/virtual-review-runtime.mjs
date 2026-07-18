import crypto from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));

const findPackageRoot = async () => {
    for (const candidate of [moduleDirectory, path.resolve(moduleDirectory, "..")]) {
        try {
            await fs.access(path.join(candidate, "package.json"));
            return candidate;
        } catch {}
    }
    throw new Error("Could not locate local-mr package root");
};

const findCommandIdentityFile = async (packageRoot) => {
    for (const candidate of [
        path.join(packageRoot, ".command-sha256"),
        path.join(packageRoot, "bin", "local-mr"),
    ]) {
        try {
            await fs.access(candidate);
            return candidate;
        } catch {}
    }
    throw new Error("Could not locate the local-mr command identity");
};

const executableCandidates = (command) => {
    if (path.isAbsolute(command) || command.includes(path.sep) || command.includes("/")) {
        return [path.resolve(command)];
    }
    const extensions = process.platform === "win32" && !path.extname(command)
        ? (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
        : [""];
    return (process.env.PATH || "")
        .split(path.delimiter)
        .flatMap((directory) => extensions.map((extension) => (
            path.resolve(directory || ".", `${command}${extension}`)
        )));
};

export const resolveLocalMrCommandPath = async (requestedCommand) => {
    const packageRoot = await findPackageRoot();
    const explicitCommand = requestedCommand || process.env.LOCAL_MR_COMMAND;
    const commands = explicitCommand
        ? [explicitCommand]
        : [path.join(packageRoot, "bin", "local-mr"), "local-mr"];
    for (const command of commands) {
        for (const candidate of executableCandidates(command)) {
            try {
                await fs.access(candidate, fsConstants.X_OK);
                return await fs.realpath(candidate);
            } catch {}
        }
    }
    const error = new Error(`Could not resolve the local-mr command: ${commands.join(", ")}`);
    error.code = "LOCAL_MR_COMMAND_NOT_FOUND";
    throw error;
};

export const localMrCommandIdentity = async (requestedCommand) => {
    const canonicalPath = await resolveLocalMrCommandPath(requestedCommand);
    const contentIdentity = crypto.createHash("sha256")
        .update(await fs.readFile(canonicalPath))
        .digest("hex");
    return { canonicalPath, contentIdentity };
};

export const frozenRealReviewArguments = (source) => {
    const from = source?.endpoints?.from;
    const to = source?.endpoints?.to;
    const repository = source?.repository || {};
    if (
        from?.kind !== "revision"
        || to?.kind !== "revision"
        || !repository.baseSha
        || !repository.headSha
        || !repository.targetSha
        || !repository.root
        || !repository.targetRef
        || !repository.branchName
        || from.sha !== repository.baseSha
        || to.sha !== repository.headSha
    ) {
        throw new Error(
            "This legacy virtual review is not backed by one frozen committed comparison; recreate it before opening Real commits",
        );
    }
    return [
        repository.targetRef,
        "--no-open",
        "--frozen-base", repository.baseSha,
        "--frozen-head", repository.headSha,
        "--frozen-target", repository.targetSha,
        "--frozen-branch", repository.branchName,
    ];
};

export const hashVirtualReviewRuntimeFiles = async (entries) => {
    const normalized = [...entries].map((entry) => ({
        name: String(entry.name),
        path: path.resolve(entry.path),
        identity: entry.identity === undefined ? "" : String(entry.identity),
    })).sort((left, right) => left.name.localeCompare(right.name));
    if (normalized.length === 0) throw new Error("Virtual review runtime inventory is empty");
    if (new Set(normalized.map((entry) => entry.name)).size !== normalized.length) {
        throw new Error("Virtual review runtime inventory has duplicate names");
    }
    const hash = crypto.createHash("sha256").update("local-mr-virtual-review-runtime-v2\0");
    for (const entry of normalized) {
        const content = await fs.readFile(entry.path);
        const identity = Buffer.from(entry.identity);
        hash.update(entry.name).update("\0");
        hash.update(String(identity.length)).update("\0");
        hash.update(identity).update("\0");
        hash.update(String(content.length)).update("\0");
        hash.update(content).update("\0");
    }
    return hash.digest("hex");
};

export const virtualReviewRuntimeInventory = async ({ commandPath } = {}) => {
    const packageRoot = await findPackageRoot();
    const commandIdentity = await localMrCommandIdentity(commandPath).catch(async (error) => {
        if (commandPath || process.env.LOCAL_MR_COMMAND) throw error;
        const identityFile = await findCommandIdentityFile(packageRoot);
        const canonicalPath = await fs.realpath(identityFile);
        const contentIdentity = crypto.createHash("sha256")
            .update(await fs.readFile(canonicalPath))
            .digest("hex");
        return { canonicalPath, contentIdentity };
    });
    return [
        [
            "command/local-mr",
            commandIdentity.canonicalPath,
            `${commandIdentity.canonicalPath}\0${commandIdentity.contentIdentity}`,
        ],
        ["package.json", path.join(packageRoot, "package.json")],
        ["src/review-render.mjs", path.join(moduleDirectory, "review-render.mjs")],
        ["src/review-ui.html", path.join(moduleDirectory, "review-ui.html")],
        ["src/version-model.mjs", path.join(moduleDirectory, "version-model.mjs")],
        ["src/virtual-diff.mjs", path.join(moduleDirectory, "virtual-diff.mjs")],
        ["src/virtual-review-cli.mjs", path.join(moduleDirectory, "virtual-review-cli.mjs")],
        ["src/virtual-review-core.mjs", path.join(moduleDirectory, "virtual-review-core.mjs")],
        ["src/virtual-review-manifest.mjs", path.join(moduleDirectory, "virtual-review-manifest.mjs")],
        ["src/virtual-review-runtime.mjs", fileURLToPath(import.meta.url)],
        ["src/virtual-review-server.mjs", path.join(moduleDirectory, "virtual-review-server.mjs")],
        ["src/virtual-review-store.mjs", path.join(moduleDirectory, "virtual-review-store.mjs")],
        [
            "vendor/diff2html.css",
            path.join(packageRoot, "node_modules", "diff2html", "bundles", "css", "diff2html.min.css"),
        ],
        [
            "vendor/diff2html.js",
            fileURLToPath(import.meta.resolve("diff2html")),
        ],
        [
            "vendor/diff2html-ui-slim.js",
            path.join(
                packageRoot,
                "node_modules",
                "diff2html",
                "bundles",
                "js",
                "diff2html-ui-slim.min.js",
            ),
        ],
        [
            "vendor/dompurify.js",
            path.join(packageRoot, "node_modules", "dompurify", "dist", "purify.min.js"),
        ],
        [
            "vendor/marked.js",
            path.join(packageRoot, "node_modules", "marked", "lib", "marked.umd.js"),
        ],
        [
            "vendor/mermaid.js",
            path.join(packageRoot, "node_modules", "mermaid", "dist", "mermaid.min.js"),
        ],
    ].map(([name, filePath, identity]) => ({ name, path: filePath, ...(identity ? { identity } : {}) }));
};

export const virtualReviewRuntimeIdentity = async (options) => hashVirtualReviewRuntimeFiles(
    await virtualReviewRuntimeInventory(options),
);

export const virtualReviewServerKey = ({
    reviewId,
    revision,
    revisionIdentity,
    runtimeIdentity,
    stateRoot,
}) => crypto.createHash("sha256")
    .update(reviewId)
    .update("\0")
    .update(String(revision))
    .update("\0")
    .update(revisionIdentity)
    .update("\0")
    .update(runtimeIdentity)
    .update("\0")
    .update(stateRoot)
    .digest("hex")
    .slice(0, 20);

export const matchesVirtualReviewServer = ({
    ready,
    health,
    reviewId,
    revision,
    revisionIdentity,
    runtimeIdentity,
}) => Boolean(
    ready
    && health?.ok
    && ready.reviewId === reviewId
    && health.reviewId === reviewId
    && ready.revision === revision
    && health.revision === revision
    && ready.revisionIdentity === revisionIdentity
    && health.revisionIdentity === revisionIdentity
    && ready.runtimeIdentity === runtimeIdentity
    && health.runtimeIdentity === runtimeIdentity
);
