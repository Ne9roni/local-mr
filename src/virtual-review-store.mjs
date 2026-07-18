import crypto from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const schemaVersion = 1;
const lockWaitMilliseconds = 50;
const lockAttempts = 200;
const incompleteLockStaleMilliseconds = 30_000;
const transactionContext = new AsyncLocalStorage();

const canonicalJson = (value) => {
    if (value === null || typeof value !== "object") return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
    return `{${Object.keys(value).sort().map((key) => (
        `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    )).join(",")}}`;
};

export const virtualReviewRevisionIdentity = ({ record, source }) => crypto.createHash("sha256")
    .update("local-mr-virtual-review-revision-v1\0")
    .update(canonicalJson({
        record,
        source: {
            schemaVersion: source?.schemaVersion,
            sourceId: source?.sourceId,
            diffHash: source?.diffHash,
            patchBlob: source?.patchBlob,
            selection: source?.selection,
        },
    }))
    .digest("hex");

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const assertIdentifier = (value, label) => {
    if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
        throw new Error(`Invalid ${label}`);
    }
    return value;
};

const atomicWrite = async (filePath, value) => {
    await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
    const temporary = `${filePath}.tmp-${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
    await fs.writeFile(temporary, value, { mode: 0o600 });
    await fs.rename(temporary, filePath);
};

const atomicWriteJson = (filePath, value) => atomicWrite(
    filePath,
    `${JSON.stringify(value, null, 2)}\n`,
);

const readJson = async (filePath) => JSON.parse(await fs.readFile(filePath, "utf8"));

const processStartIdentity = async (pid) => {
    try {
        const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8");
        const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
        return fields[19] || null;
    } catch {
        return null;
    }
};

const lockOwner = async () => ({
    schemaVersion,
    token: crypto.randomBytes(16).toString("hex"),
    pid: process.pid,
    hostname: os.hostname(),
    processStart: await processStartIdentity(process.pid),
    createdAt: new Date().toISOString(),
});

const tryCreateLockFile = async (lockPath, owner) => {
    const candidatePath = `${lockPath}.candidate-${process.pid}-${owner.token}`;
    try {
        const handle = await fs.open(candidatePath, "wx", 0o600);
        try {
            await handle.writeFile(`${JSON.stringify(owner)}\n`);
            await handle.sync();
        } finally {
            await handle.close();
        }
        try {
            // Publishing a fully-written inode with link(2) leaves no interval in
            // which another process can mistake an active, half-written lock for stale.
            await fs.link(candidatePath, lockPath);
            return true;
        } catch (error) {
            if (error.code === "EEXIST") return false;
            throw error;
        }
    } finally {
        await fs.rm(candidatePath, { force: true });
    }
};

const readLock = async (lockPath) => {
    const [content, stat] = await Promise.all([
        fs.readFile(lockPath, "utf8"),
        fs.stat(lockPath),
    ]);
    return {
        owner: JSON.parse(content),
        fingerprint: `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${content}`,
        ageMilliseconds: Date.now() - stat.mtimeMs,
    };
};

const lockIsActive = async ({ owner, ageMilliseconds }) => {
    if (
        !owner
        || typeof owner.pid !== "number"
        || !Number.isSafeInteger(owner.pid)
        || owner.pid < 1
        || typeof owner.hostname !== "string"
    ) {
        return ageMilliseconds < incompleteLockStaleMilliseconds;
    }
    // This state directory is local. A foreign-host lock cannot be proven dead, so
    // leave it alone instead of risking the deletion of active work on shared storage.
    if (owner.hostname !== os.hostname()) return true;
    try {
        process.kill(owner.pid, 0);
    } catch (error) {
        if (error.code === "ESRCH") return false;
        return true;
    }
    if (owner.processStart) {
        const actualStart = await processStartIdentity(owner.pid);
        if (actualStart && actualStart !== owner.processStart) return false;
    }
    return true;
};

const lockFingerprint = async (lockPath) => {
    try {
        return (await readLock(lockPath)).fingerprint;
    } catch (error) {
        if (error.code === "ENOENT") return null;
        try {
            const stat = await fs.stat(lockPath);
            return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:unreadable`;
        } catch (statError) {
            if (statError.code === "ENOENT") return null;
            throw statError;
        }
    }
};

const activeRecoveryClaim = async (lockPath) => {
    const directory = path.dirname(lockPath);
    const prefix = `${path.basename(lockPath)}.recover-`;
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch((error) => {
        if (error.code === "ENOENT") return [];
        throw error;
    });
    for (const entry of entries) {
        if (!entry.isFile() || !entry.name.startsWith(prefix)) continue;
        const claimPath = path.join(directory, entry.name);
        try {
            const claim = await readLock(claimPath);
            if (await lockIsActive(claim)) return true;
            const currentFingerprint = await lockFingerprint(claimPath);
            if (currentFingerprint === claim.fingerprint) await fs.rm(claimPath, { force: true });
        } catch (error) {
            if (error.code === "ENOENT") continue;
            const stat = await fs.stat(claimPath).catch(() => null);
            if (!stat || Date.now() - stat.mtimeMs < incompleteLockStaleMilliseconds) return true;
            await fs.rm(claimPath, { force: true });
        }
    }
    return false;
};

const recoverDeadLock = async (lockPath, observed) => {
    if (await lockIsActive(observed)) return false;
    const ownerToken = typeof observed.owner?.token === "string"
        ? observed.owner.token
        : crypto.createHash("sha256").update(observed.fingerprint).digest("hex").slice(0, 32);
    const claimPath = `${lockPath}.recover-${ownerToken}`;
    let claimOwner;
    claimOwner = await lockOwner();
    if (!await tryCreateLockFile(claimPath, claimOwner)) return false;
    try {
        let current;
        try {
            current = await readLock(lockPath);
        } catch (error) {
            if (error.code === "ENOENT") return true;
            const fingerprint = await lockFingerprint(lockPath);
            if (fingerprint !== observed.fingerprint) return false;
            await fs.rm(lockPath, { force: true });
            return true;
        }
        if (current.fingerprint !== observed.fingerprint || await lockIsActive(current)) return false;
        await fs.rm(lockPath, { force: true });
        return true;
    } finally {
        const currentClaim = await readLock(claimPath).catch(() => null);
        if (currentClaim?.owner?.token === claimOwner.token) await fs.rm(claimPath, { force: true });
    }
};

const withLock = async (lockPath, action) => {
    await fs.mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 });
    let owner;
    let acquired = false;
    for (let attempt = 0; attempt < lockAttempts; attempt += 1) {
        if (await activeRecoveryClaim(lockPath)) {
            if (attempt === lockAttempts - 1) break;
            await sleep(lockWaitMilliseconds);
            continue;
        }
        try {
            owner = await lockOwner();
            acquired = await tryCreateLockFile(lockPath, owner);
            if (acquired) break;
            const existing = new Error("Lock already exists");
            existing.code = "EEXIST";
            throw existing;
        } catch (error) {
            if (error.code !== "EEXIST") throw error;
            let observed;
            try {
                observed = await readLock(lockPath);
            } catch (readError) {
                if (readError.code === "ENOENT") continue;
                const stat = await fs.stat(lockPath).catch(() => null);
                if (stat && Date.now() - stat.mtimeMs >= incompleteLockStaleMilliseconds) {
                    observed = {
                        owner: null,
                        fingerprint: await lockFingerprint(lockPath),
                        ageMilliseconds: Date.now() - stat.mtimeMs,
                    };
                }
            }
            if (observed) await recoverDeadLock(lockPath, observed);
            if (attempt < lockAttempts - 1) await sleep(lockWaitMilliseconds);
        }
    }
    if (!acquired) {
        const error = new Error(`Timed out waiting for state lock: ${lockPath}`);
        error.code = "STATE_LOCK_TIMEOUT";
        throw error;
    }
    try {
        return await action();
    } finally {
        const current = await readLock(lockPath).catch(() => null);
        if (current?.owner?.token === owner.token) await fs.rm(lockPath, { force: true });
    }
};

export const virtualReviewStateRoot = () => path.resolve(
    process.env.LOCAL_MR_VIRTUAL_STATE_DIR
        || path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"), "local-mr", "virtual-reviews"),
);

const pathsFor = (root = virtualReviewStateRoot()) => ({
    root,
    blobs: path.join(root, "blobs"),
    sources: path.join(root, "sources"),
    reviews: path.join(root, "reviews"),
});

export const withVirtualReviewStoreTransaction = async (root, action) => {
    const resolvedRoot = path.resolve(root || virtualReviewStateRoot());
    if (typeof action !== "function") throw new Error("Virtual review store transaction requires an action");
    const activeRoots = transactionContext.getStore();
    if (activeRoots?.has(resolvedRoot)) return action();
    await fs.mkdir(resolvedRoot, { recursive: true, mode: 0o700 });
    return withLock(path.join(resolvedRoot, ".store.lock"), () => transactionContext.run(
        new Set([...(activeRoots || []), resolvedRoot]),
        action,
    ));
};

const initializeVirtualReviewStore = async (root = virtualReviewStateRoot()) => {
    const locations = pathsFor(root);
    await Promise.all([
        fs.mkdir(locations.blobs, { recursive: true, mode: 0o700 }),
        fs.mkdir(locations.sources, { recursive: true, mode: 0o700 }),
        fs.mkdir(locations.reviews, { recursive: true, mode: 0o700 }),
    ]);
    await Promise.all(Object.values(locations).map(async (directory) => {
        try { await fs.chmod(directory, 0o700); } catch {}
    }));
    return locations;
};

const writeVirtualBlobUnlocked = async (content, root) => {
    const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content);
    const hash = crypto.createHash("sha256").update(buffer).digest("hex");
    const locations = await initializeVirtualReviewStore(root);
    const blobPath = path.join(locations.blobs, hash);
    try {
        const existing = await fs.readFile(blobPath);
        const existingHash = crypto.createHash("sha256").update(existing).digest("hex");
        if (existingHash !== hash) throw new Error(`Corrupt virtual review blob: ${hash}`);
    } catch (error) {
        if (error.code !== "ENOENT") throw error;
        await atomicWrite(blobPath, buffer);
    }
    return { hash, bytes: buffer.length };
};

export const writeVirtualBlob = async (content, root = virtualReviewStateRoot()) => (
    withVirtualReviewStoreTransaction(root, () => writeVirtualBlobUnlocked(content, root))
);

export const readVirtualBlob = async (hash, root = virtualReviewStateRoot()) => {
    if (!/^[a-f0-9]{64}$/.test(hash || "")) throw new Error("Invalid blob hash");
    const blobPath = path.join(pathsFor(root).blobs, hash);
    const content = await fs.readFile(blobPath);
    const actual = crypto.createHash("sha256").update(content).digest("hex");
    if (actual !== hash) throw new Error(`Corrupt virtual review blob: ${hash}`);
    return content;
};

const saveVirtualSourceUnlocked = async (source, root) => {
    if (source?.schemaVersion !== schemaVersion || !/^[a-f0-9]{64}$/.test(source.sourceId || "")) {
        throw new Error("Invalid virtual review source");
    }
    const locations = await initializeVirtualReviewStore(root);
    const sourcePath = path.join(locations.sources, `${source.sourceId}.json`);
    try {
        const existing = await readJson(sourcePath);
        if (
            existing.diffHash !== source.diffHash
            || existing.repository?.root !== source.repository?.root
            || JSON.stringify(existing.selection) !== JSON.stringify(source.selection)
        ) {
            throw new Error(`Virtual review source collision: ${source.sourceId}`);
        }
        return existing;
    } catch (error) {
        if (error.code !== "ENOENT") throw error;
        await atomicWriteJson(sourcePath, source);
    }
    return source;
};

export const saveVirtualSource = async (source, root = virtualReviewStateRoot()) => (
    withVirtualReviewStoreTransaction(root, () => saveVirtualSourceUnlocked(source, root))
);

export const loadVirtualSource = async (sourceId, root = virtualReviewStateRoot()) => {
    if (!/^[a-f0-9]{64}$/.test(sourceId || "")) throw new Error("Invalid source ID");
    return readJson(path.join(pathsFor(root).sources, `${sourceId}.json`));
};

export const virtualSourceBranchCommit = (source) => {
    const sha = source?.branchCommit?.sha
        || source?.endpoints?.to?.sha
        || source?.repository?.headSha;
    if (typeof sha !== "string" || sha.length === 0) return null;
    return {
        sha,
        shortSha: source?.branchCommit?.shortSha || sha.slice(0, 8),
        subject: source?.branchCommit?.subject || "",
        author: source?.branchCommit?.author || "",
        authoredAt: source?.branchCommit?.authoredAt || "",
        dateLabel: source?.branchCommit?.dateLabel || "",
        branchName: source?.repository?.branchName || "",
    };
};

const reviewDirectory = (root, reviewId) => path.join(
    pathsFor(root).reviews,
    assertIdentifier(reviewId, "review ID"),
);

const revisionFileName = (revision) => {
    if (!Number.isSafeInteger(revision) || revision < 1) throw new Error("Invalid review revision");
    return `${String(revision).padStart(6, "0")}.json`;
};

const revisionRecoveryError = (filePath, message, cause) => {
    const error = new Error(`Cannot recover unpublished review revision at ${filePath}: ${message}`);
    error.code = "CORRUPT_VIRTUAL_REVIEW_STATE";
    error.cause = cause;
    return error;
};

const verifyRevisionBlob = async (blob, label, filePath, root) => {
    if (
        !blob
        || typeof blob.hash !== "string"
        || !/^[a-f0-9]{64}$/.test(blob.hash)
        || !Number.isSafeInteger(blob.bytes)
        || blob.bytes < 0
    ) {
        throw revisionRecoveryError(filePath, `invalid ${label} blob reference`);
    }
    try {
        const content = await readVirtualBlob(blob.hash, root);
        if (content.length !== blob.bytes) {
            throw new Error(`Expected ${blob.bytes} bytes, found ${content.length}`);
        }
    } catch (error) {
        throw revisionRecoveryError(filePath, `${label} blob is unavailable or corrupt`, error);
    }
};

const recoverUnpublishedRevisions = async ({ meta, reviewId, revisionsDirectory, root }) => {
    const metaPath = path.join(path.dirname(revisionsDirectory), "meta.json");
    if (
        meta?.schemaVersion !== schemaVersion
        || meta.reviewId !== reviewId
        || !Array.isArray(meta.revisions)
    ) {
        throw revisionRecoveryError(metaPath, "metadata does not match the review");
    }
    const known = new Set();
    let highestKnownRevision = 0;
    for (const item of meta.revisions) {
        if (!Number.isSafeInteger(item?.revision) || item.revision < 1 || known.has(item.revision)) {
            throw revisionRecoveryError(metaPath, "invalid revision index");
        }
        known.add(item.revision);
        highestKnownRevision = Math.max(highestKnownRevision, item.revision);
    }
    const nextRevision = meta.nextRevision === undefined
        ? highestKnownRevision + 1
        : meta.nextRevision;
    if (!Number.isSafeInteger(nextRevision) || nextRevision <= highestKnownRevision) {
        throw revisionRecoveryError(metaPath, "invalid next revision index");
    }

    const candidates = [];
    const entries = (await fs.readdir(revisionsDirectory, { withFileTypes: true }))
        .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
        if (!entry.isFile() || !/^\d+\.json$/.test(entry.name)) continue;
        const revision = Number.parseInt(entry.name.slice(0, -".json".length), 10);
        const filePath = path.join(revisionsDirectory, entry.name);
        if (
            !Number.isSafeInteger(revision)
            || revision < 1
            || entry.name !== revisionFileName(revision)
        ) {
            throw revisionRecoveryError(filePath, "revision file name is not canonical");
        }
        if (known.has(revision)) continue;
        candidates.push({ revision, filePath });
    }
    if (candidates.length === 0) return 0;
    if (candidates.length !== 1 || candidates[0].revision !== nextRevision) {
        throw revisionRecoveryError(
            candidates.map((candidate) => candidate.filePath).join(", "),
            `expected only unpublished revision ${nextRevision}`,
        );
    }

    const [{ revision, filePath }] = candidates;
    let record;
    try {
        record = await readJson(filePath);
    } catch (error) {
        throw revisionRecoveryError(filePath, "record is not valid JSON", error);
    }
    if (
        record?.schemaVersion !== schemaVersion
        || record.reviewId !== reviewId
        || record.revision !== revision
        || typeof record.createdAt !== "string"
        || record.createdAt.length === 0
        || typeof record.sourceId !== "string"
        || !/^[a-f0-9]{64}$/.test(record.sourceId)
        || !record.manifest
        || typeof record.manifest.title !== "string"
        || typeof record.manifest.strategy !== "string"
        || !Array.isArray(record.manifest.virtualCommits)
        || record.manifest.virtualCommits.length === 0
        || !Array.isArray(record.commitPatchBlobs)
        || record.commitPatchBlobs.length !== record.manifest.virtualCommits.length
    ) {
        throw revisionRecoveryError(filePath, "record fields do not match its review and revision");
    }
    let source;
    try {
        source = await loadVirtualSource(record.sourceId, root);
    } catch (error) {
        throw revisionRecoveryError(filePath, "source snapshot is unavailable", error);
    }
    if (source?.schemaVersion !== schemaVersion || source.sourceId !== record.sourceId) {
        throw revisionRecoveryError(filePath, "source snapshot does not match its identifier");
    }
    await verifyRevisionBlob(record.fullPatchBlob, "full patch", filePath, root);
    for (const [index, blob] of record.commitPatchBlobs.entries()) {
        await verifyRevisionBlob(blob, `virtual commit ${index + 1}`, filePath, root);
    }
    meta.revisions.push({
        revision,
        createdAt: record.createdAt,
        sourceId: record.sourceId,
        title: record.manifest.title,
        strategy: record.manifest.strategy,
    });
    meta.revisions.sort((left, right) => left.revision - right.revision);
    meta.title = record.manifest.title;
    meta.nextRevision = revision + 1;
    return 1;
};

export const saveVirtualReviewRevision = async ({
    reviewId: requestedReviewId,
    expectedRevision,
    sourceId,
    manifest,
    commitPatches,
    fullPatch,
}, root = virtualReviewStateRoot()) => {
    const reviewId = requestedReviewId
        ? assertIdentifier(requestedReviewId, "review ID")
        : crypto.randomUUID();
    if (!/^[a-f0-9]{64}$/.test(sourceId || "")) throw new Error("Invalid source ID");
    return withVirtualReviewStoreTransaction(root, async () => {
        await loadVirtualSource(sourceId, root);
        const directory = reviewDirectory(root, reviewId);
        const revisionsDirectory = path.join(directory, "revisions");
        await fs.mkdir(revisionsDirectory, { recursive: true, mode: 0o700 });

        return withLock(path.join(directory, ".lock"), async () => {
            const metaPath = path.join(directory, "meta.json");
            let meta;
            try {
                meta = await readJson(metaPath);
            } catch (error) {
                if (error.code !== "ENOENT") throw error;
                meta = {
                    schemaVersion,
                    reviewId,
                    createdAt: new Date().toISOString(),
                    title: manifest.title,
                    nextRevision: 1,
                    revisions: [],
                };
            }
            if (!Array.isArray(meta.revisions)) throw new Error(`Invalid review metadata: ${reviewId}`);
            if (await recoverUnpublishedRevisions({ meta, reviewId, revisionsDirectory, root })) {
                await atomicWriteJson(metaPath, meta);
            }
            const revisionNumbers = meta.revisions.map((item) => item?.revision);
            if (revisionNumbers.some((item) => !Number.isSafeInteger(item) || item < 1)) {
                throw new Error(`Invalid review metadata: ${reviewId}`);
            }
            const currentRevision = revisionNumbers.length ? Math.max(...revisionNumbers) : 0;
            const nextRevision = meta.nextRevision === undefined ? currentRevision + 1 : meta.nextRevision;
            if (!Number.isSafeInteger(nextRevision) || nextRevision <= currentRevision) {
                throw new Error(`Invalid next review revision: ${reviewId}`);
            }
            if (expectedRevision !== undefined && expectedRevision !== currentRevision) {
                const error = new Error(`Review changed: expected revision ${expectedRevision}, found ${currentRevision}`);
                error.code = "REVISION_CONFLICT";
                error.details = { expectedRevision, currentRevision };
                throw error;
            }

            const revision = nextRevision;
            const revisionPath = path.join(revisionsDirectory, revisionFileName(revision));
            try {
                await fs.access(revisionPath);
                const error = new Error(`Review revision already exists: ${reviewId}@${revision}`);
                error.code = "REVISION_COLLISION";
                throw error;
            } catch (error) {
                if (error.code !== "ENOENT") throw error;
            }
            const [fullPatchBlob, ...commitPatchBlobs] = await Promise.all([
                writeVirtualBlob(fullPatch, root),
                ...commitPatches.map((patch) => writeVirtualBlob(patch, root)),
            ]);
            const createdAt = new Date().toISOString();
            const record = {
                schemaVersion,
                reviewId,
                revision,
                createdAt,
                sourceId,
                manifest,
                fullPatchBlob,
                commitPatchBlobs,
            };
            await atomicWriteJson(revisionPath, record);
            meta.title = manifest.title;
            meta.nextRevision = revision + 1;
            meta.revisions.push({
                revision,
                createdAt,
                sourceId,
                title: manifest.title,
                strategy: manifest.strategy,
            });
            meta.revisions.sort((left, right) => left.revision - right.revision);
            await atomicWriteJson(metaPath, meta);
            return record;
        });
    });
};

const loadVirtualReviewMeta = async (reviewId, root = virtualReviewStateRoot()) => readJson(
    path.join(reviewDirectory(root, reviewId), "meta.json"),
);

export const loadVirtualReviewRevision = async ({ reviewId, revision }, root = virtualReviewStateRoot()) => {
    const meta = await loadVirtualReviewMeta(reviewId, root);
    const selectedRevision = revision === undefined ? meta.revisions.at(-1)?.revision : Number(revision);
    if (!selectedRevision) throw new Error(`Virtual review has no revisions: ${reviewId}`);
    const record = await readJson(path.join(
        reviewDirectory(root, reviewId),
        "revisions",
        revisionFileName(selectedRevision),
    ));
    return { meta, record };
};

export const listVirtualReviews = async (root = virtualReviewStateRoot()) => {
    const locations = await initializeVirtualReviewStore(root);
    const entries = await fs.readdir(locations.reviews, { withFileTypes: true });
    const reviews = await Promise.all(entries.filter((entry) => entry.isDirectory()).map(async (entry) => {
        try {
            const meta = await readJson(path.join(locations.reviews, entry.name, "meta.json"));
            const revisions = await Promise.all(meta.revisions.map(async (revision) => {
                let branchCommit = null;
                try {
                    branchCommit = virtualSourceBranchCommit(
                        await loadVirtualSource(revision.sourceId, root),
                    );
                } catch {
                    // Keep the review discoverable even if one historical source is missing.
                }
                return { ...revision, branchCommit };
            }));
            return {
                reviewId: meta.reviewId,
                title: meta.title,
                createdAt: meta.createdAt,
                revisionCount: revisions.length,
                revisions,
                latest: revisions.at(-1) || null,
            };
        } catch {
            return null;
        }
    }));
    return reviews.filter((review) => review?.revisionCount > 0).sort((left, right) => (
        String(right.latest?.createdAt || right.createdAt).localeCompare(String(left.latest?.createdAt || left.createdAt))
    ));
};

const normalizeProgress = (value = {}) => ({
    viewedCommitIds: [...new Set(Array.isArray(value.viewedCommitIds) ? value.viewedCommitIds : [])]
        .filter((item) => typeof item === "string" && item.length <= 128),
    reviewedCommitIds: [...new Set(Array.isArray(value.reviewedCommitIds) ? value.reviewedCommitIds : [])]
        .filter((item) => typeof item === "string" && item.length <= 128),
});

export const loadVirtualReviewProgress = async ({ reviewId, revision }, root = virtualReviewStateRoot()) => {
    const progressPath = path.join(reviewDirectory(root, reviewId), "progress", revisionFileName(Number(revision)));
    try {
        return normalizeProgress(await readJson(progressPath));
    } catch (error) {
        if (error.code === "ENOENT") return normalizeProgress();
        throw error;
    }
};

export const updateVirtualReviewProgress = async ({
    reviewId,
    revision,
    commitId,
    kind,
    value,
}, root = virtualReviewStateRoot()) => {
    if (typeof commitId !== "string" || commitId.length < 1 || commitId.length > 128) {
        throw new Error("Invalid virtual commit ID");
    }
    if (kind !== "viewed" && kind !== "reviewed") throw new Error("Invalid progress kind");
    if (typeof value !== "boolean") throw new Error("Invalid progress value");
    const directory = reviewDirectory(root, reviewId);
    const progressPath = path.join(directory, "progress", revisionFileName(Number(revision)));
    return withVirtualReviewStoreTransaction(root, () => (
        withLock(`${progressPath}.lock`, async () => {
            await loadVirtualReviewRevision({ reviewId, revision }, root);
            const progress = await loadVirtualReviewProgress({ reviewId, revision }, root);
            const key = kind === "viewed" ? "viewedCommitIds" : "reviewedCommitIds";
            const values = new Set(progress[key]);
            if (value) values.add(commitId);
            else values.delete(commitId);
            progress[key] = [...values].sort();
            await atomicWriteJson(progressPath, progress);
            return progress;
        })
    ));
};

export const deleteVirtualReview = async ({ reviewId, revision }, root = virtualReviewStateRoot()) => {
    const directory = reviewDirectory(root, reviewId);
    return withVirtualReviewStoreTransaction(root, async () => {
        if (revision === undefined) {
            await fs.rm(directory, { recursive: true, force: true });
            return { reviewId, deleted: "review" };
        }
        return withLock(path.join(directory, ".lock"), async () => {
            const metaPath = path.join(directory, "meta.json");
            const meta = await readJson(metaPath);
            if (!Array.isArray(meta.revisions)) throw new Error(`Invalid review metadata: ${reviewId}`);
            const numericRevision = Number(revision);
            if (!meta.revisions.some((item) => item.revision === numericRevision)) {
                throw new Error(`Review revision not found: ${reviewId}@${numericRevision}`);
            }
            const highestAllocated = Math.max(0, ...meta.revisions.map((item) => item.revision));
            const compatibleNextRevision = highestAllocated + 1;
            if (meta.nextRevision === undefined) meta.nextRevision = compatibleNextRevision;
            if (!Number.isSafeInteger(meta.nextRevision) || meta.nextRevision < compatibleNextRevision) {
                throw new Error(`Invalid next review revision: ${reviewId}`);
            }
            await fs.rm(path.join(directory, "revisions", revisionFileName(numericRevision)), { force: true });
            await fs.rm(path.join(directory, "progress", revisionFileName(numericRevision)), { force: true });
            meta.revisions = meta.revisions.filter((item) => item.revision !== numericRevision);
            if (meta.revisions.length > 0) meta.title = meta.revisions.at(-1).title;
            await atomicWriteJson(metaPath, meta);
            return { reviewId, revision: numericRevision, deleted: "revision" };
        });
    });
};

const corruptState = (kind, filePath, cause) => {
    const error = new Error(`Cannot prune virtual reviews: unreadable ${kind} metadata at ${filePath}`);
    error.code = "CORRUPT_VIRTUAL_REVIEW_STATE";
    error.cause = cause;
    return error;
};

const readStateJson = async (kind, filePath) => {
    try {
        return await readJson(filePath);
    } catch (error) {
        throw corruptState(kind, filePath, error);
    }
};

const addBlobReference = (references, hash, kind, filePath) => {
    if (typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash)) {
        throw corruptState(kind, filePath, new Error("Invalid blob reference"));
    }
    references.add(hash);
};

const scanStoreReferences = async (locations) => {
    const sourceBlobs = new Map();
    const sourcePaths = new Map();
    const sourceEntries = await fs.readdir(locations.sources, { withFileTypes: true });
    for (const entry of sourceEntries) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
        const filePath = path.join(locations.sources, entry.name);
        const source = await readStateJson("source", filePath);
        const sourceId = entry.name.slice(0, -".json".length);
        if (source.sourceId !== sourceId || !Array.isArray(source.files)) {
            throw corruptState("source", filePath, new Error("Invalid source record"));
        }
        const blobs = new Set();
        addBlobReference(blobs, source.patchBlob?.hash, "source", filePath);
        for (const file of source.files) {
            if (file.base?.blob) addBlobReference(blobs, file.base.blob, "source", filePath);
            if (file.target?.blob) addBlobReference(blobs, file.target.blob, "source", filePath);
        }
        sourceBlobs.set(sourceId, blobs);
        sourcePaths.set(sourceId, filePath);
    }

    const referencedSources = new Set();
    const referenced = new Set();
    const reviewEntries = await fs.readdir(locations.reviews, { withFileTypes: true });
    for (const entry of reviewEntries) {
        if (!entry.isDirectory()) continue;
        const revisionsPath = path.join(locations.reviews, entry.name, "revisions");
        let revisions;
        try {
            revisions = await fs.readdir(revisionsPath, { withFileTypes: true });
        } catch (error) {
            if (error.code === "ENOENT") continue;
            throw error;
        }
        for (const revision of revisions) {
            if (!revision.isFile() || !revision.name.endsWith(".json")) continue;
            const filePath = path.join(revisionsPath, revision.name);
            const record = await readStateJson("revision", filePath);
            if (typeof record.sourceId !== "string" || !/^[a-f0-9]{64}$/.test(record.sourceId)) {
                throw corruptState("revision", filePath, new Error("Invalid source reference"));
            }
            referencedSources.add(record.sourceId);
            addBlobReference(referenced, record.fullPatchBlob?.hash, "revision", filePath);
            if (!Array.isArray(record.commitPatchBlobs)) {
                throw corruptState("revision", filePath, new Error("Invalid commit patch references"));
            }
            for (const blob of record.commitPatchBlobs) {
                addBlobReference(referenced, blob?.hash, "revision", filePath);
            }
        }
    }
    for (const sourceId of referencedSources) {
        const blobs = sourceBlobs.get(sourceId);
        if (!blobs) {
            throw corruptState("revision", sourceId, new Error("Referenced source is missing"));
        }
        blobs.forEach((hash) => referenced.add(hash));
    }
    return { referenced, referencedSources, sourcePaths };
};

export const pruneVirtualReviewBlobs = async (root = virtualReviewStateRoot()) => (
    withVirtualReviewStoreTransaction(root, async () => {
        const locations = await initializeVirtualReviewStore(root);
        // Complete the entire metadata scan before deleting anything. Any unreadable
        // source or revision makes the operation fail closed.
        const { referenced, referencedSources, sourcePaths } = await scanStoreReferences(locations);
        let deletedSources = 0;
        for (const [sourceId, sourcePath] of sourcePaths) {
            if (referencedSources.has(sourceId)) continue;
            await fs.rm(sourcePath, { force: true });
            deletedSources += 1;
        }
        const entries = await fs.readdir(locations.blobs, { withFileTypes: true });
        let deletedBlobs = 0;
        let deletedBytes = 0;
        for (const entry of entries) {
            if (!entry.isFile() || referenced.has(entry.name)) continue;
            const blobPath = path.join(locations.blobs, entry.name);
            const stat = await fs.stat(blobPath);
            await fs.rm(blobPath, { force: true });
            deletedBlobs += 1;
            deletedBytes += stat.size;
        }
        return {
            deletedSources,
            deletedBlobs,
            deletedBytes,
            referencedSources: referencedSources.size,
            referencedBlobs: referenced.size,
        };
    })
);
