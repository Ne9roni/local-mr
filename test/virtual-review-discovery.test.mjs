import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { discoverVirtualReview } from "../src/virtual-review-discovery.mjs";
import {
    saveVirtualReviewRevision,
    saveVirtualSource,
    writeVirtualBlob,
} from "../src/virtual-review-store.mjs";

const sha = (character) => character.repeat(40);

const manifest = (title) => ({
    title,
    strategy: "Definitions before behavior",
    virtualCommits: [{ id: "step-one", blocks: ["block-one"] }],
});

const fixture = async (context) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "local-mr-virtual-discovery-test-"));
    context.after(() => fs.rm(root, { recursive: true, force: true }));
    const repositoryRoot = path.join(root, "repository");
    const otherRepositoryRoot = path.join(root, "other-repository");
    const repositoryLink = path.join(root, "repository-link");
    await Promise.all([
        fs.mkdir(repositoryRoot),
        fs.mkdir(otherRepositoryRoot),
    ]);
    await fs.symlink(repositoryRoot, repositoryLink);
    return {
        root,
        stateRoot: path.join(root, "state"),
        repositoryRoot,
        otherRepositoryRoot,
        repositoryLink,
    };
};

let sourceNumber = 0;
const saveSource = async ({
    stateRoot,
    repositoryRoot,
    branchName = "feature/review",
    targetRef = "origin/main",
    baseSha = sha("a"),
    headSha = sha("b"),
    targetSha = sha("c"),
}) => {
    sourceNumber += 1;
    const sourceId = sourceNumber.toString(16).padStart(64, "0");
    const patchBlob = await writeVirtualBlob(`patch ${sourceNumber}\n`, stateRoot);
    const source = {
        schemaVersion: 1,
        sourceId,
        diffHash: sourceId,
        patchBlob,
        repository: {
            root: repositoryRoot,
            branchName,
            targetRef,
            baseSha,
            headSha,
            targetSha,
        },
        branchCommit: {
            sha: headSha,
            shortSha: headSha.slice(0, 7),
        },
        selection: { mode: "range", from: baseSha, to: headSha },
        endpoints: {
            from: { kind: "revision", sha: baseSha },
            to: { kind: "revision", sha: headSha },
        },
        files: [{ blocks: [{ id: "block-one" }] }],
    };
    await saveVirtualSource(source, stateRoot);
    return source;
};

const saveRevision = async ({
    stateRoot,
    source,
    reviewId,
    expectedRevision,
    title,
}) => saveVirtualReviewRevision({
    reviewId,
    expectedRevision,
    sourceId: source.sourceId,
    manifest: manifest(title),
    commitPatches: [`commit ${title}`],
    fullPatch: `full ${title}`,
}, stateRoot);

const setCreatedAt = async ({ stateRoot, reviewId, revision, createdAt }) => {
    const directory = path.join(stateRoot, "reviews", reviewId);
    const metaPath = path.join(directory, "meta.json");
    const revisionPath = path.join(
        directory,
        "revisions",
        `${String(revision).padStart(6, "0")}.json`,
    );
    const [meta, record] = await Promise.all([
        fs.readFile(metaPath, "utf8").then(JSON.parse),
        fs.readFile(revisionPath, "utf8").then(JSON.parse),
    ]);
    meta.revisions.find((item) => item.revision === revision).createdAt = createdAt;
    record.createdAt = createdAt;
    await Promise.all([
        fs.writeFile(metaPath, `${JSON.stringify(meta, null, 2)}\n`),
        fs.writeFile(revisionPath, `${JSON.stringify(record, null, 2)}\n`),
    ]);
};

test("discovery prefers an exact boundary match over a newer stale revision", async (context) => {
    const data = await fixture(context);
    const current = {
        baseSha: sha("a"),
        headSha: sha("b"),
        targetSha: sha("c"),
    };
    const exactSource = await saveSource({
        stateRoot: data.stateRoot,
        repositoryRoot: data.repositoryLink,
        ...current,
    });
    const exact = await saveRevision({
        stateRoot: data.stateRoot,
        source: exactSource,
        reviewId: "reading-plan",
        title: "Exact plan",
    });
    await setCreatedAt({
        stateRoot: data.stateRoot,
        reviewId: exact.reviewId,
        revision: exact.revision,
        createdAt: "2026-01-01T00:00:00.000Z",
    });

    const staleSource = await saveSource({
        stateRoot: data.stateRoot,
        repositoryRoot: data.repositoryRoot,
        ...current,
        headSha: sha("d"),
    });
    const stale = await saveRevision({
        stateRoot: data.stateRoot,
        source: staleSource,
        reviewId: exact.reviewId,
        expectedRevision: 1,
        title: "Newer stale plan",
    });
    await setCreatedAt({
        stateRoot: data.stateRoot,
        reviewId: stale.reviewId,
        revision: stale.revision,
        createdAt: "2026-02-01T00:00:00.000Z",
    });

    const discovered = await discoverVirtualReview({
        repositoryRoot: data.repositoryRoot,
        branchName: "feature/review",
        targetRef: "origin/main",
        ...current,
        stateRoot: data.stateRoot,
    });
    assert.deepEqual(discovered, {
        reviewId: "reading-plan",
        revision: 1,
        sourceId: exactSource.sourceId,
        state: "current",
        sourceSha: current.headSha,
        sourceShortSha: current.headSha.slice(0, 8),
        currentSha: current.headSha,
        currentShortSha: current.headSha.slice(0, 8),
        sourceBoundary: current,
        currentBoundary: current,
        createdAt: "2026-01-01T00:00:00.000Z",
        title: "Exact plan",
    });
});

test("discovery scans every revision and returns the newest matching stale source", async (context) => {
    const data = await fixture(context);
    const current = {
        baseSha: sha("a"),
        headSha: sha("f"),
        targetSha: sha("c"),
    };
    const olderMatchingSource = await saveSource({
        stateRoot: data.stateRoot,
        repositoryRoot: data.repositoryRoot,
        headSha: sha("b"),
    });
    const older = await saveRevision({
        stateRoot: data.stateRoot,
        source: olderMatchingSource,
        reviewId: "mixed-target-review",
        title: "Older matching target",
    });
    await setCreatedAt({
        stateRoot: data.stateRoot,
        reviewId: older.reviewId,
        revision: older.revision,
        createdAt: "2026-03-01T00:00:00.000Z",
    });

    const wrongTargetSource = await saveSource({
        stateRoot: data.stateRoot,
        repositoryRoot: data.repositoryRoot,
        targetRef: "origin/release",
        headSha: sha("e"),
    });
    const wrongTarget = await saveRevision({
        stateRoot: data.stateRoot,
        source: wrongTargetSource,
        reviewId: older.reviewId,
        expectedRevision: 1,
        title: "Latest revision but another target",
    });
    await setCreatedAt({
        stateRoot: data.stateRoot,
        reviewId: wrongTarget.reviewId,
        revision: wrongTarget.revision,
        createdAt: "2026-05-01T00:00:00.000Z",
    });

    const newerMatchingSource = await saveSource({
        stateRoot: data.stateRoot,
        repositoryRoot: data.repositoryRoot,
        headSha: sha("d"),
    });
    const newer = await saveRevision({
        stateRoot: data.stateRoot,
        source: newerMatchingSource,
        reviewId: "newer-matching-review",
        title: "Newest matching stale plan",
    });
    await setCreatedAt({
        stateRoot: data.stateRoot,
        reviewId: newer.reviewId,
        revision: newer.revision,
        createdAt: "2026-04-01T00:00:00.000Z",
    });

    const discovered = await discoverVirtualReview({
        repoRoot: data.repositoryLink,
        branchName: "feature/review",
        targetRef: "origin/main",
        ...current,
        stateRoot: data.stateRoot,
    });
    assert.equal(discovered.reviewId, newer.reviewId);
    assert.equal(discovered.revision, 1);
    assert.equal(discovered.sourceId, newerMatchingSource.sourceId);
    assert.equal(discovered.state, "stale");
    assert.equal(discovered.sourceSha, sha("d"));
    assert.equal(discovered.sourceShortSha, sha("d").slice(0, 8));
    assert.equal(discovered.currentSha, current.headSha);
    assert.equal(discovered.currentShortSha, current.headSha.slice(0, 8));
    assert.equal(discovered.createdAt, "2026-04-01T00:00:00.000Z");
    assert.equal(discovered.title, "Newest matching stale plan");
});

test("discovery strictly scopes identity and skips corrupt records", async (context) => {
    const data = await fixture(context);
    const current = {
        baseSha: sha("a"),
        headSha: sha("b"),
        targetSha: sha("c"),
    };
    const sources = await Promise.all([
        saveSource({
            stateRoot: data.stateRoot,
            repositoryRoot: data.otherRepositoryRoot,
            ...current,
        }),
        saveSource({
            stateRoot: data.stateRoot,
            repositoryRoot: data.repositoryRoot,
            branchName: "feature/other",
            ...current,
        }),
        saveSource({
            stateRoot: data.stateRoot,
            repositoryRoot: data.repositoryRoot,
            targetRef: "origin/release",
            ...current,
        }),
        saveSource({
            stateRoot: data.stateRoot,
            repositoryRoot: data.repositoryRoot,
            ...current,
        }),
        saveSource({
            stateRoot: data.stateRoot,
            repositoryRoot: data.repositoryRoot,
            ...current,
            headSha: sha("d"),
        }),
    ]);
    for (const [index, source] of sources.entries()) {
        await saveRevision({
            stateRoot: data.stateRoot,
            source,
            reviewId: `identity-${index}`,
            title: `Identity ${index}`,
        });
    }
    await fs.writeFile(
        path.join(data.stateRoot, "sources", `${sources[3].sourceId}.json`),
        "{broken json",
    );
    await fs.writeFile(
        path.join(data.stateRoot, "reviews", "identity-0", "meta.json"),
        "{broken json",
    );

    const discovered = await discoverVirtualReview({
        repoRoot: data.repositoryRoot,
        branchName: "feature/review",
        targetRef: "origin/main",
        ...current,
        stateRoot: data.stateRoot,
    });
    assert.equal(discovered.reviewId, "identity-4");
    assert.equal(discovered.state, "stale");

    assert.equal(await discoverVirtualReview({
        repoRoot: data.repositoryRoot,
        branchName: "feature/missing",
        targetRef: "origin/main",
        ...current,
        stateRoot: data.stateRoot,
    }), null);
});
