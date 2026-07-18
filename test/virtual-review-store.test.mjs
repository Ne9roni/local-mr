import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildVirtualComparisonPatch } from "../src/virtual-review-core.mjs";
import {
    deleteVirtualReview,
    listVirtualReviews,
    loadVirtualReviewProgress,
    loadVirtualReviewRevision,
    pruneVirtualReviewBlobs,
    readVirtualBlob,
    saveVirtualReviewRevision,
    saveVirtualSource,
    updateVirtualReviewProgress,
    withVirtualReviewStoreTransaction,
    writeVirtualBlob,
} from "../src/virtual-review-store.mjs";

const deferred = () => {
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    return { promise, resolve };
};

const makeFixture = async (context) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "local-mr-virtual-store-test-"));
    context.after(() => fs.rm(root, { recursive: true, force: true }));
    const patchBlob = await writeVirtualBlob("diff --git a/a b/a\n", root);
    const base = await writeVirtualBlob("before\n", root);
    const target = await writeVirtualBlob("after\n", root);
    const source = {
        schemaVersion: 1,
        sourceId: "1".repeat(64),
        patchBlob,
        files: [{
            base: { blob: base.hash },
            target: { blob: target.hash },
            blocks: [{ id: "block-a" }],
        }],
    };
    await saveVirtualSource(source, root);
    return { root, source };
};

const manifest = (title) => ({
    title,
    strategy: "Core first",
    virtualCommits: [{ id: "commit-a", blocks: ["block-a"] }],
});

test("large virtual ranges finish reading their temporary object database before cleanup", async (context) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "local-mr-virtual-range-test-"));
    context.after(() => fs.rm(root, { recursive: true, force: true }));
    const files = [];
    for (let index = 0; index < 80; index += 1) {
        const filePath = `src/file-${String(index).padStart(3, "0")}.txt`;
        const [base, target] = await Promise.all([
            writeVirtualBlob(`base ${index}\n`, root),
            writeVirtualBlob(`target ${index}\n`, root),
        ]);
        files.push({
            id: `file-${index}`,
            kind: "special",
            status: "M",
            oldPath: filePath,
            newPath: filePath,
            displayPath: filePath,
            base: { path: filePath, mode: "100644", blob: base.hash },
            target: { path: filePath, mode: "100644", blob: target.hash },
            blocks: [{ id: `block-${index}`, kind: "file", path: filePath }],
        });
    }
    const source = {
        repository: { objectFormat: "sha1" },
        files,
    };
    const rangeManifest = {
        virtualCommits: [
            { blocks: files.slice(0, 40).map((file) => file.blocks[0].id) },
            { blocks: files.slice(40).map((file) => file.blocks[0].id) },
        ],
    };

    for (let attempt = 0; attempt < 3; attempt += 1) {
        const patch = await buildVirtualComparisonPatch({
            source,
            manifest: rangeManifest,
            fromState: 0,
            toState: 2,
            stateRoot: root,
        });
        assert.match(patch, /diff --git a\/src\/file-079\.txt b\/src\/file-079\.txt/);
        assert.match(patch, /^\+target 79$/m);
    }
});

test("virtual review store deduplicates blobs and preserves immutable revision history", async (context) => {
    const { root, source } = await makeFixture(context);
    const duplicate = await writeVirtualBlob("before\n", root);
    assert.equal((await readVirtualBlob(duplicate.hash, root)).toString(), "before\n");

    const first = await saveVirtualReviewRevision({
        sourceId: source.sourceId,
        manifest: manifest("First"),
        commitPatches: ["patch one"],
        fullPatch: "full patch",
    }, root);
    const second = await saveVirtualReviewRevision({
        reviewId: first.reviewId,
        expectedRevision: 1,
        sourceId: source.sourceId,
        manifest: manifest("Second"),
        commitPatches: ["patch two"],
        fullPatch: "full patch",
    }, root);
    assert.equal(second.revision, 2);
    assert.equal((await loadVirtualReviewRevision({ reviewId: first.reviewId, revision: 1 }, root)).record.manifest.title, "First");
    assert.equal((await loadVirtualReviewRevision({ reviewId: first.reviewId }, root)).record.manifest.title, "Second");
    assert.equal((await listVirtualReviews(root))[0].revisionCount, 2);
    await assert.rejects(
        saveVirtualReviewRevision({
            reviewId: first.reviewId,
            expectedRevision: 1,
            sourceId: source.sourceId,
            manifest: manifest("Conflict"),
            commitPatches: ["patch"],
            fullPatch: "full patch",
        }, root),
        (error) => error.code === "REVISION_CONFLICT",
    );
});

test("an unpublished revision is recovered after a publication crash", async (context) => {
    const { root, source } = await makeFixture(context);
    const first = await saveVirtualReviewRevision({
        reviewId: "recovery-review",
        sourceId: source.sourceId,
        manifest: manifest("First"),
        commitPatches: ["patch one"],
        fullPatch: "full patch",
    }, root);
    const recoveredRecord = {
        ...first,
        revision: 2,
        createdAt: new Date(Date.now() + 1_000).toISOString(),
        manifest: manifest("Recovered"),
    };
    await fs.writeFile(
        path.join(root, "reviews", first.reviewId, "revisions", "000002.json"),
        `${JSON.stringify(recoveredRecord, null, 2)}\n`,
        { mode: 0o600 },
    );

    await assert.rejects(
        saveVirtualReviewRevision({
            reviewId: first.reviewId,
            expectedRevision: 1,
            sourceId: source.sourceId,
            manifest: manifest("Stale retry"),
            commitPatches: ["stale patch"],
            fullPatch: "stale full patch",
        }, root),
        (error) => (
            error.code === "REVISION_CONFLICT"
            && error.details.expectedRevision === 1
            && error.details.currentRevision === 2
        ),
    );
    const recovered = await loadVirtualReviewRevision({ reviewId: first.reviewId }, root);
    assert.equal(recovered.record.revision, 2);
    assert.equal(recovered.record.manifest.title, "Recovered");
    assert.equal((await listVirtualReviews(root))[0].revisionCount, 2);

    const third = await saveVirtualReviewRevision({
        reviewId: first.reviewId,
        expectedRevision: 2,
        sourceId: source.sourceId,
        manifest: manifest("Third"),
        commitPatches: ["patch three"],
        fullPatch: "full patch",
    }, root);
    assert.equal(third.revision, 3);
});

test("revision recovery fails closed for noncanonical or unexpected candidates", async (context) => {
    await context.test("noncanonical file name", async (subcontext) => {
        const { root, source } = await makeFixture(subcontext);
        const first = await saveVirtualReviewRevision({
            reviewId: "noncanonical-recovery",
            sourceId: source.sourceId,
            manifest: manifest("First"),
            commitPatches: ["patch one"],
            fullPatch: "full patch",
        }, root);
        await fs.writeFile(
            path.join(root, "reviews", first.reviewId, "revisions", "2.json"),
            `${JSON.stringify({ ...first, revision: 2 })}\n`,
            { mode: 0o600 },
        );
        await assert.rejects(
            saveVirtualReviewRevision({
                reviewId: first.reviewId,
                expectedRevision: 1,
                sourceId: source.sourceId,
                manifest: manifest("Second"),
                commitPatches: ["patch two"],
                fullPatch: "full patch",
            }, root),
            (error) => error.code === "CORRUPT_VIRTUAL_REVIEW_STATE" && /not canonical/.test(error.message),
        );
    });

    await context.test("future revision", async (subcontext) => {
        const { root, source } = await makeFixture(subcontext);
        const first = await saveVirtualReviewRevision({
            reviewId: "future-recovery",
            sourceId: source.sourceId,
            manifest: manifest("First"),
            commitPatches: ["patch one"],
            fullPatch: "full patch",
        }, root);
        await fs.writeFile(
            path.join(root, "reviews", first.reviewId, "revisions", "000003.json"),
            `${JSON.stringify({ ...first, revision: 3 })}\n`,
            { mode: 0o600 },
        );
        await assert.rejects(
            saveVirtualReviewRevision({
                reviewId: first.reviewId,
                expectedRevision: 1,
                sourceId: source.sourceId,
                manifest: manifest("Second"),
                commitPatches: ["patch two"],
                fullPatch: "full patch",
            }, root),
            (error) => error.code === "CORRUPT_VIRTUAL_REVIEW_STATE" && /unpublished revision 2/.test(error.message),
        );
    });
});

test("progress is revision-local and review deletion leaves reusable blobs for pruning", async (context) => {
    const { root, source } = await makeFixture(context);
    const record = await saveVirtualReviewRevision({
        sourceId: source.sourceId,
        manifest: manifest("Review"),
        commitPatches: ["orphanable patch"],
        fullPatch: "orphanable full patch",
    }, root);
    await updateVirtualReviewProgress({
        reviewId: record.reviewId,
        revision: 1,
        commitId: "commit-a",
        kind: "reviewed",
        value: true,
    }, root);
    assert.deepEqual(await loadVirtualReviewProgress({ reviewId: record.reviewId, revision: 1 }, root), {
        viewedCommitIds: [],
        reviewedCommitIds: ["commit-a"],
    });
    await deleteVirtualReview({ reviewId: record.reviewId }, root);
    assert.deepEqual(await listVirtualReviews(root), []);
    const pruned = await pruneVirtualReviewBlobs(root);
    assert.ok(pruned.deletedBlobs >= 2);
});

test("deleted revision numbers are never allocated again", async (context) => {
    const { root, source } = await makeFixture(context);
    const first = await saveVirtualReviewRevision({
        reviewId: "monotonic-review",
        sourceId: source.sourceId,
        manifest: manifest("First"),
        commitPatches: ["patch one"],
        fullPatch: "full patch",
    }, root);
    const second = await saveVirtualReviewRevision({
        reviewId: first.reviewId,
        expectedRevision: 1,
        sourceId: source.sourceId,
        manifest: manifest("Second"),
        commitPatches: ["patch two"],
        fullPatch: "full patch",
    }, root);
    assert.equal(second.revision, 2);

    await deleteVirtualReview({ reviewId: first.reviewId, revision: 2 }, root);
    const third = await saveVirtualReviewRevision({
        reviewId: first.reviewId,
        expectedRevision: 1,
        sourceId: source.sourceId,
        manifest: manifest("Third"),
        commitPatches: ["patch three"],
        fullPatch: "full patch",
    }, root);
    assert.equal(third.revision, 3);

    await deleteVirtualReview({ reviewId: first.reviewId, revision: 1 }, root);
    await deleteVirtualReview({ reviewId: first.reviewId, revision: 3 }, root);
    assert.deepEqual(await listVirtualReviews(root), []);
    const fourth = await saveVirtualReviewRevision({
        reviewId: first.reviewId,
        expectedRevision: 0,
        sourceId: source.sourceId,
        manifest: manifest("Fourth"),
        commitPatches: ["patch four"],
        fullPatch: "full patch",
    }, root);
    assert.equal(fourth.revision, 4);
});

test("prune waits for an active publication transaction", async (context) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "local-mr-virtual-store-transaction-test-"));
    context.after(() => fs.rm(root, { recursive: true, force: true }));
    const entered = deferred();
    const release = deferred();
    let publishedBlob;
    const publishing = withVirtualReviewStoreTransaction(root, async () => {
        publishedBlob = await writeVirtualBlob("published atomically\n", root);
        entered.resolve();
        await release.promise;
        const source = {
            schemaVersion: 1,
            sourceId: "2".repeat(64),
            patchBlob: publishedBlob,
            files: [{ blocks: [{ id: "block-a" }] }],
        };
        await saveVirtualSource(source, root);
        await saveVirtualReviewRevision({
            reviewId: "coordinated-review",
            sourceId: source.sourceId,
            manifest: manifest("Coordinated"),
            commitPatches: ["commit patch"],
            fullPatch: "full patch",
        }, root);
    });
    await entered.promise;

    let pruneFinished = false;
    const pruning = pruneVirtualReviewBlobs(root).then((result) => {
        pruneFinished = true;
        return result;
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(pruneFinished, false, "prune must not enter while publication owns the store transaction");
    release.resolve();
    await publishing;
    const result = await pruning;
    assert.equal(result.deletedSources, 0);
    assert.equal((await readVirtualBlob(publishedBlob.hash, root)).toString(), "published atomically\n");
});

test("prune fails closed on corrupt source or revision metadata", async (context) => {
    await context.test("source JSON", async (subcontext) => {
        const { root, source } = await makeFixture(subcontext);
        const orphan = await writeVirtualBlob("must survive failed prune", root);
        await fs.writeFile(path.join(root, "sources", `${source.sourceId}.json`), "{not json", { mode: 0o600 });
        await assert.rejects(
            pruneVirtualReviewBlobs(root),
            (error) => error.code === "CORRUPT_VIRTUAL_REVIEW_STATE" && /source metadata/.test(error.message),
        );
        assert.equal((await readVirtualBlob(orphan.hash, root)).toString(), "must survive failed prune");
    });

    await context.test("revision JSON", async (subcontext) => {
        const { root, source } = await makeFixture(subcontext);
        const record = await saveVirtualReviewRevision({
            reviewId: "corrupt-review",
            sourceId: source.sourceId,
            manifest: manifest("Corrupt"),
            commitPatches: ["commit patch"],
            fullPatch: "full patch",
        }, root);
        const orphan = await writeVirtualBlob("also survives failed prune", root);
        await fs.writeFile(
            path.join(root, "reviews", record.reviewId, "revisions", "000001.json"),
            "{not json",
            { mode: 0o600 },
        );
        await assert.rejects(
            pruneVirtualReviewBlobs(root),
            (error) => error.code === "CORRUPT_VIRTUAL_REVIEW_STATE" && /revision metadata/.test(error.message),
        );
        assert.equal((await readVirtualBlob(orphan.hash, root)).toString(), "also survives failed prune");
    });
});

test("store locks recover dead owners without stealing active owners", async (context) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "local-mr-virtual-store-lock-test-"));
    context.after(() => fs.rm(root, { recursive: true, force: true }));
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(root, ".store.lock"), `${JSON.stringify({
        schemaVersion: 1,
        token: "dead-owner",
        pid: 2_147_483_647,
        hostname: os.hostname(),
        processStart: "1",
        createdAt: new Date(0).toISOString(),
    })}\n`, { mode: 0o600 });
    const recovered = await writeVirtualBlob("recovered\n", root);
    assert.equal((await readVirtualBlob(recovered.hash, root)).toString(), "recovered\n");
    await fs.writeFile(path.join(root, ".store.lock"), `${JSON.stringify({
        schemaVersion: 1,
        token: "reused-pid-owner",
        pid: process.pid,
        hostname: os.hostname(),
        processStart: "not-this-process",
        createdAt: new Date(0).toISOString(),
    })}\n`, { mode: 0o600 });
    const reusedPidRecovered = await writeVirtualBlob("pid identity recovered\n", root);
    assert.equal(
        (await readVirtualBlob(reusedPidRecovered.hash, root)).toString(),
        "pid identity recovered\n",
    );

    const entered = deferred();
    const release = deferred();
    const holder = withVirtualReviewStoreTransaction(root, async () => {
        entered.resolve();
        await release.promise;
    });
    await entered.promise;
    await fs.utimes(path.join(root, ".store.lock"), new Date(0), new Date(0));
    let contenderEntered = false;
    const contender = withVirtualReviewStoreTransaction(root, async () => {
        contenderEntered = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(contenderEntered, false, "a live owner must retain its lock regardless of elapsed time");
    release.resolve();
    await Promise.all([holder, contender]);
    assert.equal(contenderEntered, true);
});
