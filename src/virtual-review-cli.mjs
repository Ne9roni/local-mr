#!/usr/bin/env node

import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
    captureVirtualReviewSource,
    createVirtualReview,
    inspectVirtualSourceItem,
    virtualSourceCatalog,
} from "./virtual-review-core.mjs";
import { ManifestValidationError } from "./virtual-review-manifest.mjs";
import {
    matchesVirtualReviewServer,
    resolveLocalMrCommandPath,
    virtualReviewRuntimeIdentity,
    virtualReviewServerKey,
} from "./virtual-review-runtime.mjs";
import {
    deleteVirtualReview,
    listVirtualReviews,
    loadVirtualReviewRevision,
    loadVirtualSource,
    pruneVirtualReviewBlobs,
    virtualReviewRevisionIdentity,
    virtualReviewStateRoot,
} from "./virtual-review-store.mjs";

const execFileAsync = promisify(execFile);
const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const maximumInputBytes = 1024 * 1024;

const usage = () => `Usage: local-mr virtual-commit <command> [options]

Commands:
  snapshot [--target REF] [--mode MODE --from VALUE --to VALUE]
      Freeze a comparison and print its machine-readable change catalog.
  show SOURCE_ID [--file PATH | --block ID | --full]
      Read one source file/change block, or the full frozen patch.
  create SOURCE_ID [--manifest FILE] [--review ID] [--expected-revision N] [--no-open]
      Validate a manifest, save an immutable revision, and open its review page.
  open REVIEW_ID [--revision N] [--no-open]
      Open a saved virtual-commit review.
  list
      List saved reviews.
  delete REVIEW_ID [--revision N]
      Delete a review or one immutable revision.
  prune
      Remove unreferenced source snapshots and content-addressed blobs.
  install-skill codex [--force]
      Explicitly install the bundled official Codex Skill.

All successful commands write one JSON object to stdout. Errors are JSON on stderr.`;

const jsonOutput = (value) => process.stdout.write(`${JSON.stringify({ schemaVersion: 1, ...value }, null, 2)}\n`);

const fail = (error, exitCode = 1) => {
    const payload = {
        schemaVersion: 1,
        ok: false,
        error: {
            code: error.code || "VIRTUAL_REVIEW_ERROR",
            message: error.message,
            ...(error.details ? { details: error.details } : {}),
        },
    };
    process.stderr.write(`${JSON.stringify(payload, null, 2)}\n`);
    process.exitCode = exitCode;
};

const parseOptions = (values, { positionals = Infinity, allowed = [], allowEmpty = [] } = {}) => {
    const options = {};
    const positional = [];
    const allowedOptions = new Set(allowed);
    const emptyValueOptions = new Set(allowEmpty);
    for (let index = 0; index < values.length; index += 1) {
        const value = values[index];
        if (value === "--") {
            positional.push(...values.slice(index + 1));
            break;
        }
        if (!value.startsWith("--")) {
            positional.push(value);
            continue;
        }
        const [rawName, inlineValue] = value.slice(2).split(/=(.*)/s, 2);
        if (!allowedOptions.has(rawName)) throw new Error(`Unknown option: --${rawName}`);
        if (Object.hasOwn(options, rawName)) throw new Error(`Option may only be supplied once: --${rawName}`);
        if (["no-open", "full", "force"].includes(rawName)) {
            if (inlineValue !== undefined) throw new Error(`--${rawName} does not accept a value`);
            options[rawName] = true;
            continue;
        }
        const optionValue = inlineValue ?? values[index + 1];
        if (optionValue === undefined || (inlineValue === undefined && optionValue.startsWith("--"))) {
            throw new Error(`--${rawName} requires a value`);
        }
        if (optionValue.length === 0 && !emptyValueOptions.has(rawName)) {
            throw new Error(`--${rawName} requires a non-empty value`);
        }
        options[rawName] = optionValue;
        if (inlineValue === undefined) index += 1;
    }
    if (positional.length > positionals) throw new Error(`Unexpected argument: ${positional[positionals]}`);
    return { options, positional };
};

const git = async (repoRoot, args) => (await execFileAsync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
})).stdout.trim();

const tryGit = async (repoRoot, args) => {
    try { return await git(repoRoot, args); } catch { return ""; }
};

const repositoryContext = async (requestedTarget) => {
    const repoRoot = await git(process.cwd(), ["rev-parse", "--show-toplevel"]);
    const branchName = await tryGit(repoRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"])
        || await git(repoRoot, ["rev-parse", "--short", "HEAD"]);
    let targetRef = requestedTarget || process.env.LOCAL_MR_BASE || "";
    if (!targetRef) {
        const candidates = [
            await tryGit(repoRoot, ["config", "--get", `branch.${branchName}.local-mr-target`]),
            await tryGit(repoRoot, ["config", "--get", `branch.${branchName}.vscode-merge-base`]),
            await tryGit(repoRoot, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]),
            "origin/main",
            "origin/master",
            "main",
            "master",
        ];
        for (const candidate of candidates) {
            if (!candidate) continue;
            if (await tryGit(repoRoot, ["rev-parse", "--verify", "--quiet", `${candidate}^{commit}`])) {
                targetRef = candidate;
                break;
            }
        }
    }
    if (!targetRef) throw new Error("Cannot detect the target branch; pass --target REF");
    if (!await tryGit(repoRoot, ["rev-parse", "--verify", "--quiet", `${targetRef}^{commit}`])) {
        throw new Error(`Target ref does not exist: ${targetRef}`);
    }
    return { repoRoot, branchName, targetRef };
};

const readStdin = async () => {
    const chunks = [];
    let bytes = 0;
    for await (const chunk of process.stdin) {
        bytes += chunk.length;
        if (bytes > maximumInputBytes) throw new Error(`Manifest input exceeds ${maximumInputBytes} bytes`);
        chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString("utf8");
};

const readManifest = async (filePath) => {
    const text = filePath && filePath !== "-" ? await fs.readFile(path.resolve(filePath), "utf8") : await readStdin();
    if (!text.trim()) throw new Error("Manifest JSON is required on stdin or via --manifest FILE");
    try { return JSON.parse(text); } catch (error) {
        error.code = "INVALID_JSON";
        throw error;
    }
};

const integerOption = (value, name, minimum) => {
    if (value === undefined) return undefined;
    if (!/^\d+$/.test(value)) throw new Error(`--${name} must be an integer of at least ${minimum}`);
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number < minimum) {
        throw new Error(`--${name} must be an integer of at least ${minimum}`);
    }
    return number;
};

const runtimeDirectory = () => path.join(
    process.env.XDG_RUNTIME_DIR || os.tmpdir(),
    `local-mr-virtual-${process.getuid?.() ?? "user"}`,
);

const requestJson = async (url, options = {}) => {
    const response = await fetch(url, {
        ...options,
        signal: options.signal || AbortSignal.timeout(1500),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} from ${url}`);
    return response.json();
};

const openBrowser = (url) => {
    const command = process.env.WSL_DISTRO_NAME
        ? "explorer.exe"
        : process.platform === "darwin" ? "open" : "xdg-open";
    try {
        const child = spawn(command, [url], { detached: true, stdio: "ignore" });
        child.on("error", () => {});
        child.unref();
        return true;
    } catch {
        return false;
    }
};

const startReviewServer = async ({ reviewId, revision, noOpen = false }) => {
    const { record } = await loadVirtualReviewRevision({ reviewId, revision });
    const source = await loadVirtualSource(record.sourceId);
    const selectedRevision = record.revision;
    const revisionIdentity = virtualReviewRevisionIdentity({ record, source });
    const commandPath = await resolveLocalMrCommandPath();
    const runtimeIdentity = await virtualReviewRuntimeIdentity({ commandPath });
    const key = virtualReviewServerKey({
        reviewId,
        revision: selectedRevision,
        revisionIdentity,
        runtimeIdentity,
        stateRoot: virtualReviewStateRoot(),
    });
    const directory = path.join(runtimeDirectory(), key);
    const readyPath = path.join(directory, "ready.json");
    const logPath = path.join(directory, "server.log");
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    try { await fs.chmod(directory, 0o700); } catch {}
    try {
        const ready = JSON.parse(await fs.readFile(readyPath, "utf8"));
        const health = await requestJson(ready.healthUrl);
        if (matchesVirtualReviewServer({
            ready,
            health,
            reviewId,
            revision: selectedRevision,
            revisionIdentity,
            runtimeIdentity,
        })) {
            if (!noOpen) openBrowser(ready.reviewUrl);
            return ready;
        }
        await fs.rm(readyPath, { force: true });
    } catch {
        await fs.rm(readyPath, { force: true });
    }

    const logHandle = await fs.open(logPath, "a", 0o600);
    const child = spawn(process.execPath, [
        path.join(moduleDirectory, "virtual-review-server.mjs"),
        "--review", reviewId,
        "--revision", String(selectedRevision),
        "--identity", revisionIdentity,
        "--runtime-identity", runtimeIdentity,
        "--ready", readyPath,
        "--state-root", virtualReviewStateRoot(),
        "--command", commandPath,
    ], {
        detached: true,
        env: { ...process.env, LOCAL_MR_COMMAND: commandPath },
        stdio: ["ignore", logHandle.fd, logHandle.fd],
    });
    child.unref();
    await logHandle.close();
    for (let attempt = 0; attempt < 100; attempt += 1) {
        try {
            const ready = JSON.parse(await fs.readFile(readyPath, "utf8"));
            const health = await requestJson(ready.healthUrl);
            if (matchesVirtualReviewServer({
                ready,
                health,
                reviewId,
                revision: selectedRevision,
                revisionIdentity,
                runtimeIdentity,
            })) {
                if (!noOpen) openBrowser(ready.reviewUrl);
                return ready;
            }
        } catch {
            // The detached server has not published its validated ready record yet.
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const log = await fs.readFile(logPath, "utf8").catch(() => "");
    throw new Error(`Virtual review server did not start${log ? `: ${log.slice(-2000)}` : ""}`);
};

const copyDirectory = async (source, destination) => {
    await fs.cp(source, destination, {
        recursive: true,
        force: false,
        errorOnExist: true,
        preserveTimestamps: true,
    });
};

const installSkill = async ({ platform, force }) => {
    if (platform !== "codex") throw new Error("Only the codex Skill target is supported in version 1");
    const skillName = "local-mr-virtual-commits";
    const source = path.resolve(moduleDirectory, "..", "skills", skillName);
    const destinationRoot = path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "skills");
    const destination = path.join(destinationRoot, skillName);
    await fs.access(path.join(source, "SKILL.md"));
    await fs.mkdir(destinationRoot, { recursive: true, mode: 0o700 });
    try {
        await fs.access(destination);
        if (!force) {
            const error = new Error(`Skill already exists: ${destination}; pass --force to replace it`);
            error.code = "SKILL_EXISTS";
            throw error;
        }
        await fs.rm(destination, { recursive: true, force: true });
    } catch (error) {
        if (error.code !== "ENOENT" && error.code !== "SKILL_EXISTS") throw error;
        if (error.code === "SKILL_EXISTS") throw error;
    }
    await copyDirectory(source, destination);
    return { skill: skillName, destination };
};

const main = async () => {
    const [command, ...values] = process.argv.slice(2);
    if (!command || command === "help" || command === "--help" || command === "-h") {
        process.stdout.write(usage());
        return;
    }
    if (command === "snapshot") {
        const { options } = parseOptions(values, {
            positionals: 0,
            allowed: ["target", "mode", "from", "to"],
            allowEmpty: ["mode", "from", "to"],
        });
        const repository = await repositoryContext(options.target);
        const selectionOptionNames = ["mode", "from", "to"];
        const suppliedSelectionOptions = selectionOptionNames.filter((name) => Object.hasOwn(options, name));
        if (suppliedSelectionOptions.length > 0 && suppliedSelectionOptions.length < selectionOptionNames.length) {
            throw new Error("--mode, --from, and --to must be provided together");
        }
        const hasExplicitSelection = suppliedSelectionOptions.length === selectionOptionNames.length;
        const source = await captureVirtualReviewSource({
            repoRoot: repository.repoRoot,
            targetRef: repository.targetRef,
            selection: hasExplicitSelection
                ? { mode: options.mode, from: options.from, to: options.to }
                : undefined,
        });
        jsonOutput({ ok: true, source: virtualSourceCatalog(source) });
        return;
    }
    if (command === "show") {
        const { options, positional } = parseOptions(values, {
            positionals: 1,
            allowed: ["file", "block", "full"],
        });
        const sourceId = positional[0];
        if (!sourceId) throw new Error("show requires SOURCE_ID");
        if ([options.file, options.block, options.full].filter(Boolean).length > 1) {
            throw new Error("Use only one of --file, --block, or --full");
        }
        const source = await loadVirtualSource(sourceId);
        const item = await inspectVirtualSourceItem({
            source,
            filePath: options.file,
            blockId: options.block,
        });
        if (!options.full && !options.file && !options.block) delete item.patch;
        jsonOutput({ ok: true, item });
        return;
    }
    if (command === "create") {
        const { options, positional } = parseOptions(values, {
            positionals: 1,
            allowed: ["manifest", "review", "expected-revision", "no-open"],
        });
        const sourceId = positional[0];
        if (!sourceId) throw new Error("create requires SOURCE_ID");
        const manifest = await readManifest(options.manifest);
        const record = await createVirtualReview({
            sourceId,
            manifest,
            reviewId: options.review,
            expectedRevision: integerOption(options["expected-revision"], "expected-revision", 0),
        });
        const ready = await startReviewServer({
            reviewId: record.reviewId,
            revision: record.revision,
            noOpen: Boolean(options["no-open"]),
        });
        jsonOutput({
            ok: true,
            reviewId: record.reviewId,
            revision: record.revision,
            sourceId: record.sourceId,
            reviewUrl: ready.reviewUrl,
        });
        return;
    }
    if (command === "open") {
        const { options, positional } = parseOptions(values, {
            positionals: 1,
            allowed: ["revision", "no-open"],
        });
        const reviewId = positional[0];
        if (!reviewId) throw new Error("open requires REVIEW_ID");
        const ready = await startReviewServer({
            reviewId,
            revision: integerOption(options.revision, "revision", 1),
            noOpen: Boolean(options["no-open"]),
        });
        jsonOutput({ ok: true, reviewId, revision: ready.revision, reviewUrl: ready.reviewUrl });
        return;
    }
    if (command === "list") {
        parseOptions(values, { positionals: 0, allowed: [] });
        jsonOutput({ ok: true, reviews: await listVirtualReviews() });
        return;
    }
    if (command === "delete") {
        const { options, positional } = parseOptions(values, {
            positionals: 1,
            allowed: ["revision"],
        });
        const reviewId = positional[0];
        if (!reviewId) throw new Error("delete requires REVIEW_ID");
        const result = await deleteVirtualReview({
            reviewId,
            revision: integerOption(options.revision, "revision", 1),
        });
        jsonOutput({ ok: true, ...result });
        return;
    }
    if (command === "prune") {
        parseOptions(values, { positionals: 0, allowed: [] });
        jsonOutput({ ok: true, ...(await pruneVirtualReviewBlobs()) });
        return;
    }
    if (command === "install-skill") {
        const { options, positional } = parseOptions(values, {
            positionals: 1,
            allowed: ["force"],
        });
        if (!positional[0]) throw new Error("install-skill requires a target, currently: codex");
        jsonOutput({ ok: true, ...(await installSkill({ platform: positional[0], force: Boolean(options.force) })) });
        return;
    }
    const error = new Error(`Unknown virtual-commit command: ${command}`);
    error.code = "UNKNOWN_COMMAND";
    throw error;
};

try {
    await main();
} catch (error) {
    fail(error, error instanceof ManifestValidationError ? 2 : 1);
}
