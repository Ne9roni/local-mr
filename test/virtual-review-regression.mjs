import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { inspectVirtualSourceFreshness } from "../src/virtual-review-core.mjs";
import { loadVirtualSource } from "../src/virtual-review-store.mjs";
import { localMr } from "./helpers/paths.mjs";

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "local-mr-virtual-regression-"));
const repoRoot = path.join(temporaryRoot, "repo");
const stateRoot = path.join(temporaryRoot, "state");
const runtimeRoot = path.join(temporaryRoot, "runtime");
const openerRoot = path.join(temporaryRoot, "opener-bin");
const openerLogPath = path.join(temporaryRoot, "opener.log");
const environment = {
    ...process.env,
    PATH: `${openerRoot}:${process.env.PATH}`,
    WSL_DISTRO_NAME: "Local-MR-Test",
    LOCAL_MR_OPEN_LOG: openerLogPath,
    LOCAL_MR_VIRTUAL_STATE_DIR: stateRoot,
    XDG_RUNTIME_DIR: runtimeRoot,
    LOCAL_MR_SERVER_IDLE_MINUTES: "1",
};
const reviewUrls = [];

const run = (command, arguments_, options = {}) => {
    const result = spawnSync(command, arguments_, {
        cwd: options.cwd || repoRoot,
        env: environment,
        encoding: "utf8",
        input: options.input,
        maxBuffer: 64 * 1024 * 1024,
    });
    if (options.allowFailure) return result;
    if (result.status !== 0) {
        throw new Error(`${command} ${arguments_.join(" ")} failed:\n${result.stderr || result.stdout}`);
    }
    return result.stdout;
};

const git = (arguments_) => run("git", arguments_);
const localVirtual = (arguments_, options) => run(localMr, ["virtual-commit", ...arguments_], options);
const fileHash = (filePath) => crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
const directoryInventoryHash = (directory) => {
    const entries = [];
    const visit = (current, relative = "") => {
        for (const item of fs.readdirSync(current, { withFileTypes: true }).sort((left, right) => (
            left.name.localeCompare(right.name)
        ))) {
            const itemRelative = relative ? path.join(relative, item.name) : item.name;
            const itemPath = path.join(current, item.name);
            if (item.isDirectory()) {
                entries.push(["directory", itemRelative]);
                visit(itemPath, itemRelative);
            } else if (item.isSymbolicLink()) {
                entries.push(["symlink", itemRelative, fs.readlinkSync(itemPath)]);
            } else {
                entries.push(["file", itemRelative, fileHash(itemPath)]);
            }
        }
    };
    visit(directory);
    return crypto.createHash("sha256").update(JSON.stringify(entries)).digest("hex");
};

const versionDataFromHtml = (html) => {
    const encoded = html.match(
        /<script id="local-mr-version-data" type="application\/json">([\s\S]*?)<\/script>/,
    )?.[1];
    assert.ok(encoded, "review page must include version data");
    return JSON.parse(encoded);
};

const assertInvalidSelection = (arguments_, pattern, code = "INVALID_SELECTION") => {
    const result = localVirtual(["snapshot", "--target", "main", ...arguments_], { allowFailure: true });
    assert.equal(result.status, 1);
    const payload = JSON.parse(result.stderr);
    assert.equal(payload.error.code, code, payload.error.message);
    assert.match(payload.error.message, pattern);
};

const manifestFor = (source, { title = "Guided behavior review", reverse = false } = {}) => {
    const blocks = source.files.flatMap((file) => file.blocks.map((block) => block.id));
    const groups = reverse
        ? [blocks.slice(1), blocks.slice(0, 1)]
        : [blocks.slice(0, 1), blocks.slice(1)];
    return {
        schemaVersion: 1,
        title,
        strategy: reverse ? "Coverage before core behavior" : "Core behavior before coverage",
        overview: {
            summary: "Review two production changes and their coverage in a deliberate order.",
            routeRationale: "Keep the highest-value behavior in a focused first step.",
            uncertainties: [],
        },
        virtualCommits: groups.map((group, index) => ({
            title: `${reverse ? "Alternative" : "Primary"} step ${index + 1}`,
            intent: index === 0 ? "Establish the first review concern." : "Complete the frozen comparison.",
            reviewFocus: [{
                text: "Check that this change matches the intended behavior.",
                targets: [`block:${group[0]}`],
            }],
            risk: {
                level: index === 0 ? "high" : "medium",
                reason: index === 0 ? "This is reviewed first." : "This completes the change.",
            },
            blocks: group,
        })),
    };
};

try {
    fs.mkdirSync(openerRoot, { recursive: true });
    ["explorer.exe", "wslview", "xdg-open"].forEach((name) => {
        fs.writeFileSync(path.join(openerRoot, name), [
            "#!/usr/bin/env bash",
            `printf '${name}\\t%s\\n' "$1" >> "$LOCAL_MR_OPEN_LOG"`,
            `exit ${name === "explorer.exe" ? 23 : 0}`,
            "",
        ].join("\n"), { mode: 0o700 });
    });
    fs.mkdirSync(path.join(repoRoot, "src"), { recursive: true });
    fs.mkdirSync(path.join(repoRoot, "test"), { recursive: true });
    git(["init", "-q", "-b", "main"]);
    git(["config", "user.name", "Local MR Test"]);
    git(["config", "user.email", "local-mr@example.test"]);
    fs.writeFileSync(path.join(repoRoot, "src", "app.mjs"), [
        "export function primary() {",
        "    return 1;",
        "}",
        "",
        "export function secondary() {",
        "    return 'old';",
        "}",
        "",
    ].join("\n"));
    git(["add", "."]);
    git(["commit", "-qm", "base"]);
    git(["switch", "-qc", "feature/virtual-review"]);
    fs.writeFileSync(path.join(repoRoot, "src", "app.mjs"), [
        "export function primary() {",
        "    return 2;",
        "}",
        "",
        "export function secondary() {",
        "    return 'new';",
        "}",
        "",
    ].join("\n"));
    const dirtyOnlySnapshot = localVirtual(["snapshot", "--target", "main"], { allowFailure: true });
    assert.equal(dirtyOnlySnapshot.status, 1);
    assert.equal(JSON.parse(dirtyOnlySnapshot.stderr).error.code, "VIRTUAL_SOURCE_REQUIRES_COMMIT");
    git(["add", "src/app.mjs"]);
    git(["commit", "-qm", "implement virtual review behavior"]);
    const firstFeatureCommit = git(["rev-parse", "HEAD"]).trim();
    fs.writeFileSync(path.join(repoRoot, "test", "app.test.mjs"), [
        "import assert from 'node:assert/strict';",
        "import { primary } from '../src/app.mjs';",
        "assert.equal(primary(), 2);",
        "",
    ].join("\n"));
    git(["add", "test/app.test.mjs"]);
    git(["commit", "-qm", "cover virtual review behavior"]);
    const featureHead = git(["rev-parse", "HEAD"]).trim();
    fs.writeFileSync(path.join(repoRoot, "dirty-only.txt"), "staged but excluded\n");
    git(["add", "dirty-only.txt"]);
    fs.appendFileSync(path.join(repoRoot, "src", "app.mjs"), "// DIRTY_TRACKED_SENTINEL\n");
    fs.writeFileSync(path.join(repoRoot, "untracked-only.txt"), "untracked but excluded\n");

    const indexPath = path.join(repoRoot, ".git", "index");
    const objectDirectory = git(["rev-parse", "--path-format=absolute", "--git-path", "objects"]).trim();
    const indexBefore = fileHash(indexPath);
    const objectsBefore = directoryInventoryHash(objectDirectory);
    const snapshot = JSON.parse(localVirtual(["snapshot", "--target", "main"]));
    assert.equal(snapshot.schemaVersion, 1);
    assert.equal(snapshot.ok, true);
    assert.deepEqual(snapshot.source.selection, {
        mode: "range",
        from: firstFeatureCommit,
        to: featureHead,
    });
    assert.equal(snapshot.source.summary.files, 2);
    assert.equal(snapshot.source.files.some((file) => file.displayPath === "dirty-only.txt"), false);
    assert.equal(snapshot.source.files.some((file) => file.displayPath === "untracked-only.txt"), false);
    assert.equal(snapshot.source.files[0].blocks.length, 2);
    assert.equal(snapshot.source.repository.headSha, featureHead);
    assert.equal(snapshot.source.branchCommit.sha, featureHead);
    assert.equal(snapshot.source.branchCommit.subject, "cover virtual review behavior");
    assert.equal(fileHash(indexPath), indexBefore);
    assert.equal(directoryInventoryHash(objectDirectory), objectsBefore);

    assertInvalidSelection(["--mode", "unknown", "--from", "base", "--to", "worktree"], /Unsupported comparison mode/);
    assertInvalidSelection(["--mode=", "--from=", "--to="], /Unsupported comparison mode/);
    assertInvalidSelection(["--mode", "range", "--from", "missing", "--to", "worktree"], /Unknown commit --from endpoint/);
    assertInvalidSelection(["--mode", "range", "--from", firstFeatureCommit, "--to", "missing"], /Unknown commit --to endpoint/);
    assertInvalidSelection(
        ["--mode", "push", "--from", "base", "--to", "worktree"],
        /real commit|uncommitted changes/i,
        "INVALID_VIRTUAL_SOURCE_BOUNDARY",
    );
    assertInvalidSelection(
        ["--mode", "range", "--from", firstFeatureCommit, "--to", "worktree"],
        /real commit|uncommitted changes/i,
        "INVALID_VIRTUAL_SOURCE_BOUNDARY",
    );
    assertInvalidSelection(
        ["--mode", "commits", "--from", featureHead, "--to", featureHead],
        /target branch point|partial ranges/i,
        "INVALID_VIRTUAL_SOURCE_BOUNDARY",
    );

    fs.writeFileSync(path.join(repoRoot, "dirty-only.txt"), "staged and unstaged but still excluded\n");
    fs.appendFileSync(path.join(repoRoot, "src", "app.mjs"), "// ANOTHER_DIRTY_TRACKED_SENTINEL\n");
    const afterDirtyMutation = JSON.parse(localVirtual(["snapshot", "--target", "main"]));
    assert.equal(afterDirtyMutation.source.sourceId, snapshot.source.sourceId);
    assert.equal(afterDirtyMutation.source.diffHash, snapshot.source.diffHash);

    const explicitSnapshot = JSON.parse(localVirtual([
        "snapshot",
        "--target", "main",
        "--mode", "push",
        "--from", "base",
        "--to", `local:${featureHead}`,
    ]));
    assert.equal(explicitSnapshot.source.sourceId, snapshot.source.sourceId);
    const equivalentCommitSnapshot = JSON.parse(localVirtual([
        "snapshot",
        "--target", "main",
        "--mode", "commits",
        "--from", firstFeatureCommit,
        "--to", featureHead,
    ]));
    assert.equal(equivalentCommitSnapshot.source.diffHash, snapshot.source.diffHash);
    assert.deepEqual(
        equivalentCommitSnapshot.source.files.map((file) => file.displayPath),
        snapshot.source.files.map((file) => file.displayPath),
    );
    const previousCommitSnapshot = JSON.parse(localVirtual([
        "snapshot",
        "--target", "main",
        "--mode", "range",
        "--from", firstFeatureCommit,
        "--to", firstFeatureCommit,
    ]));
    assert.equal(previousCommitSnapshot.source.repository.headSha, firstFeatureCommit);
    assert.equal(previousCommitSnapshot.source.selection.to, firstFeatureCommit);
    assert.equal(previousCommitSnapshot.source.branchCommit.sha, firstFeatureCommit);
    assert.equal(previousCommitSnapshot.source.branchCommit.subject, "implement virtual review behavior");
    assert.equal(directoryInventoryHash(objectDirectory), objectsBefore);

    const sha256RepoRoot = path.join(temporaryRoot, "sha256-repo");
    fs.mkdirSync(sha256RepoRoot, { recursive: true });
    const sha256Init = run("git", ["init", "-q", "-b", "main", "--object-format=sha256"], {
        cwd: sha256RepoRoot,
        allowFailure: true,
    });
    if (sha256Init.status === 0) {
        const shaGit = (arguments_) => run("git", arguments_, { cwd: sha256RepoRoot });
        shaGit(["config", "user.name", "Local MR Test"]);
        shaGit(["config", "user.email", "local-mr@example.test"]);
        fs.writeFileSync(path.join(sha256RepoRoot, "app.txt"), "base\n");

        const dependencyRoot = path.join(sha256RepoRoot, "dependency");
        fs.mkdirSync(dependencyRoot);
        const dependencyGit = (arguments_) => run("git", arguments_, { cwd: dependencyRoot });
        dependencyGit(["init", "-q", "-b", "main", "--object-format=sha256"]);
        dependencyGit(["config", "user.name", "Local MR Test"]);
        dependencyGit(["config", "user.email", "local-mr@example.test"]);
        fs.writeFileSync(path.join(dependencyRoot, "version.txt"), "one\n");
        dependencyGit(["add", "."]);
        dependencyGit(["commit", "-qm", "dependency one"]);

        shaGit(["add", "."]);
        shaGit(["commit", "-qm", "base with dependency"]);
        shaGit(["switch", "-qc", "feature/sha256-snapshot"]);
        fs.writeFileSync(path.join(sha256RepoRoot, "app.txt"), "changed\n");
        fs.writeFileSync(path.join(dependencyRoot, "version.txt"), "two\n");
        dependencyGit(["add", "."]);
        dependencyGit(["commit", "-qm", "dependency two"]);
        shaGit(["add", "app.txt", "dependency"]);
        shaGit(["commit", "-qm", "change app and dependency"]);
        fs.writeFileSync(path.join(sha256RepoRoot, "dirty-only.txt"), "not snapshotted\n");

        const shaObjectDirectory = shaGit([
            "rev-parse", "--path-format=absolute", "--git-path", "objects",
        ]).trim();
        const dependencyObjectDirectory = dependencyGit([
            "rev-parse", "--path-format=absolute", "--git-path", "objects",
        ]).trim();
        const shaObjectsBefore = directoryInventoryHash(shaObjectDirectory);
        const dependencyObjectsBefore = directoryInventoryHash(dependencyObjectDirectory);
        const shaSnapshot = JSON.parse(localVirtual(["snapshot", "--target", "main"], {
            cwd: sha256RepoRoot,
        }));
        assert.equal(shaSnapshot.source.repository.objectFormat, "sha256");
        assert.equal(shaSnapshot.source.summary.files, 2);
        assert.notEqual(shaSnapshot.source.selection.to, "worktree");
        assert.equal(shaSnapshot.source.files.some((file) => file.displayPath === "dirty-only.txt"), false);
        assert.equal(directoryInventoryHash(shaObjectDirectory), shaObjectsBefore);
        assert.equal(directoryInventoryHash(dependencyObjectDirectory), dependencyObjectsBefore);
        const dependencyItem = JSON.parse(localVirtual([
            "show", shaSnapshot.source.sourceId, "--file", "dependency",
        ], { cwd: sha256RepoRoot })).item;
        assert.equal(dependencyItem.file.kind, "special");
        assert.equal(dependencyItem.file.target.mode, "160000");
    }

    const firstFile = snapshot.source.files[0];
    const firstBlock = JSON.parse(localVirtual([
        "show",
        snapshot.source.sourceId,
        "--block",
        firstFile.blocks[0].id,
    ])).item;
    assert.equal(firstBlock.blocks.length, 1);
    assert.ok(firstBlock.blocks[0].oldLines.length > 0);
    assert.ok(firstBlock.blocks[0].newLines.length > 0);
    assert.equal(Object.hasOwn(firstBlock, "baseText"), false);
    assert.equal(Object.hasOwn(firstBlock, "targetText"), false);
    const completeFile = JSON.parse(localVirtual([
        "show",
        snapshot.source.sourceId,
        "--file",
        firstFile.newPath,
    ])).item;
    assert.match(completeFile.baseText, /return 1/);
    assert.match(completeFile.targetText, /return 2/);
    assert.doesNotMatch(completeFile.targetText, /DIRTY_TRACKED_SENTINEL/);
    const unknownOption = localVirtual(["list", "--surprise"], { allowFailure: true });
    assert.equal(unknownOption.status, 1);
    assert.match(JSON.parse(unknownOption.stderr).error.message, /Unknown option/);

    const invalid = manifestFor(snapshot.source);
    invalid.virtualCommits[1].blocks.pop();
    const invalidResult = localVirtual(["create", snapshot.source.sourceId, "--no-open"], {
        input: JSON.stringify(invalid),
        allowFailure: true,
    });
    assert.equal(invalidResult.status, 2);
    const invalidError = JSON.parse(invalidResult.stderr);
    assert.equal(invalidError.error.code, "INVALID_MANIFEST");
    assert.ok(invalidError.error.details.some((item) => item.code === "MISSING_BLOCK"));

    const created = JSON.parse(localVirtual([
        "create",
        snapshot.source.sourceId,
        "--no-open",
    ], { input: JSON.stringify(manifestFor(snapshot.source)) }));
    reviewUrls.push(created.reviewUrl);
    assert.equal(created.revision, 1);
    assert.match(created.reviewUrl, /^http:\/\/127\.0\.0\.1:/);
    const opened = JSON.parse(localVirtual([
        "open",
        created.reviewId,
        "--revision",
        "1",
    ]));
    reviewUrls.push(opened.reviewUrl);
    for (let attempt = 0; attempt < 50 && !fs.existsSync(openerLogPath); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const openerCalls = fs.readFileSync(openerLogPath, "utf8").trim().split("\n");
    assert.deepEqual(openerCalls, [`explorer.exe\t${opened.reviewUrl}`]);
    const misspelledDelete = localVirtual([
        "delete",
        created.reviewId,
        "--revison",
        "1",
    ], { allowFailure: true });
    assert.equal(misspelledDelete.status, 1);
    assert.match(JSON.parse(misspelledDelete.stderr).error.message, /Unknown option/);
    assert.equal(JSON.parse(localVirtual(["list"])).reviews[0].reviewId, created.reviewId);
    const page = await fetch(created.reviewUrl).then((response) => response.text());
    assert.match(page, /Guided behavior review/);
    assert.match(page, /Primary step 1/);
    const rootUrl = created.reviewUrl.replace(/\/review\?revision=1$/, "");
    const pageVersionData = versionDataFromHtml(page);
    const [firstCommitId, secondCommitId] = pageVersionData.commits.map((commit) => commit.sha);
    assert.ok(firstCommitId);
    assert.ok(secondCommitId);
    const singleCommitReviewData = async (serverRoot, revision, commitId) => {
        const reviewDataUrl = new URL(`${serverRoot}/review-data`);
        reviewDataUrl.searchParams.set("revision", String(revision));
        reviewDataUrl.searchParams.set("mode", "single");
        reviewDataUrl.searchParams.set("from", commitId);
        reviewDataUrl.searchParams.set("to", commitId);
        const response = await fetch(reviewDataUrl);
        assert.equal(response.status, 200);
        return response.json();
    };
    assert.equal(pageVersionData.reviewNavigation.virtualState, "current");
    assert.equal(pageVersionData.reviewNavigation.virtualReview.reviewId, created.reviewId);
    assert.equal(pageVersionData.reviewNavigation.virtualReview.revision, 1);
    assert.equal(pageVersionData.reviewNavigation.virtualReview.sourceCommit.sha, featureHead);
    assert.equal(pageVersionData.reviewNavigation.virtualReview.currentCommit.sha, featureHead);
    assert.equal(pageVersionData.virtualSession.currentHeadSha, featureHead);
    assert.equal(pageVersionData.virtualSession.currentTargetSha, snapshot.source.repository.targetSha);
    assert.equal(pageVersionData.virtualSession.currentBaseSha, snapshot.source.repository.baseSha);

    const liveRealUrl = new URL(`https://localhost:9443/${"R".repeat(24)}/review`);
    liveRealUrl.searchParams.set("mode", "range");
    liveRealUrl.searchParams.set("from", "live-from");
    liveRealUrl.searchParams.set("to", "live-to");
    liveRealUrl.hash = "d2h-live-file";
    const linkedReviewUrl = new URL(created.reviewUrl);
    linkedReviewUrl.searchParams.set("real-review-url", liveRealUrl.href);
    const linkedResponse = await fetch(linkedReviewUrl);
    const linkedPageVersionData = versionDataFromHtml(await linkedResponse.text());
    assert.equal(new URL(linkedResponse.url).searchParams.get("real-review-url"), liveRealUrl.href);
    assert.equal(linkedPageVersionData.reviewNavigation.realUrl, liveRealUrl.href);
    assert.equal(linkedPageVersionData.reviewNavigation.virtualState, "current");
    assert.equal(linkedPageVersionData.reviewNavigation.virtualReview.currentCommit.sha, featureHead);
    const linkedBaseUrls = [
        linkedPageVersionData.reviewUrl,
        linkedPageVersionData.reviewDataUrl,
        linkedPageVersionData.fragmentUrl,
        linkedPageVersionData.contextUrl,
        linkedPageVersionData.previewUrl,
        linkedPageVersionData.reviewNavigation.virtualUrl,
        ...linkedPageVersionData.virtualSession.revisions.map((item) => item.url),
    ];
    linkedBaseUrls.forEach((candidate) => {
        assert.equal(new URL(candidate).searchParams.get("real-review-url"), liveRealUrl.href);
    });

    const linkedReviewDataUrl = new URL(linkedPageVersionData.reviewDataUrl);
    linkedReviewDataUrl.searchParams.set("mode", "single");
    linkedReviewDataUrl.searchParams.set("from", firstCommitId);
    linkedReviewDataUrl.searchParams.set("to", firstCommitId);
    const linkedReviewData = await fetch(linkedReviewDataUrl).then((response) => response.json());
    assert.equal(linkedReviewData.versionData.reviewNavigation.realUrl, liveRealUrl.href);
    assert.equal(
        new URL(linkedReviewData.versionData.reviewUrl).searchParams.get("real-review-url"),
        liveRealUrl.href,
    );

    const invalidRealReviewUrls = [
        `https://example.com/${"R".repeat(24)}/review`,
        `http://user:secret@localhost/${"R".repeat(24)}/review`,
        `http://127.0.0.1/${"R".repeat(24)}/health`,
        `ftp://localhost/${"R".repeat(24)}/review`,
        `http://localhost/${"R".repeat(24)}/review?padding=${"x".repeat(4096)}`,
    ];
    for (const candidate of invalidRealReviewUrls) {
        const invalidUrl = new URL(created.reviewUrl);
        invalidUrl.searchParams.set("real-review-url", candidate);
        const invalidResponse = await fetch(invalidUrl, { redirect: "manual" });
        assert.equal(invalidResponse.status, 302, candidate);
        const location = new URL(invalidResponse.headers.get("location"), rootUrl);
        assert.equal(location.searchParams.has("real-review-url"), false, candidate);
    }

    const legacyRangeRedirect = await fetch(
        `${rootUrl}/review?${new URLSearchParams({
            revision: "1",
            mode: "push",
            from: "base",
            to: secondCommitId,
        })}`,
        { redirect: "manual" },
    );
    assert.equal(legacyRangeRedirect.status, 302);
    assert.equal(
        legacyRangeRedirect.headers.get("location"),
        `${new URL(rootUrl).pathname}/review?${new URLSearchParams({
            revision: "1",
            mode: "range",
            from: firstCommitId,
            to: secondCommitId,
        })}`,
    );
    const invalidHttpSelections = [
        new URLSearchParams({ revision: "1", mode: "push" }),
        new URLSearchParams({
            revision: "1", mode: "unknown", from: "base", to: secondCommitId,
        }),
        new URLSearchParams({
            revision: "1", mode: "push", from: "base", to: "missing",
        }),
        new URLSearchParams({
            revision: "1", mode: "single", from: firstCommitId, to: secondCommitId,
        }),
        new URLSearchParams({
            revision: "1", mode: "range", from: secondCommitId, to: firstCommitId,
        }),
    ];
    for (const query of invalidHttpSelections) {
        const response = await fetch(`${rootUrl}/review?${query}`);
        assert.equal(response.status, 400, query.toString());
    }
    const firstCommitData = await singleCommitReviewData(rootUrl, 1, firstCommitId);
    const secondCommitData = await singleCommitReviewData(rootUrl, 1, secondCommitId);
    assert.match(firstCommitData.diffHtml, /primary/);
    assert.equal(firstCommitData.versionData.files.some((file) => file.path === "test/app.test.mjs"), false);
    assert.match(secondCommitData.diffHtml, /secondary/);
    assert.equal(secondCommitData.versionData.files.some((file) => file.path === "test/app.test.mjs"), true);
    const initialHealth = await fetch(`${rootUrl}/health`).then((response) => response.json());
    assert.match(initialHealth.revisionIdentity, /^[a-f0-9]{64}$/);

    // Revision files are immutable through the CLI, but a restore or external state
    // replacement can put different content at the same review/revision path. A live
    // server must neither return its cached old patch nor be reused for that identity.
    const replacementPatch = [
        "diff --git a/src/app.mjs b/src/app.mjs",
        "--- a/src/app.mjs",
        "+++ b/src/app.mjs",
        "@@ -1 +1 @@",
        "-old-cache-identity",
        "+replacement-cache-identity",
        "",
    ].join("\n");
    const replacementHash = crypto.createHash("sha256").update(replacementPatch).digest("hex");
    fs.writeFileSync(path.join(stateRoot, "blobs", replacementHash), replacementPatch, { mode: 0o600 });
    const revisionPath = path.join(
        stateRoot,
        "reviews",
        created.reviewId,
        "revisions",
        "000001.json",
    );
    const replacementRecord = JSON.parse(fs.readFileSync(revisionPath, "utf8"));
    replacementRecord.commitPatchBlobs[0] = {
        hash: replacementHash,
        bytes: Buffer.byteLength(replacementPatch),
    };
    fs.writeFileSync(revisionPath, `${JSON.stringify(replacementRecord, null, 2)}\n`, { mode: 0o600 });

    const replacementFromLiveServer = await singleCommitReviewData(rootUrl, 1, firstCommitId);
    assert.match(replacementFromLiveServer.diffHtml, /replacement<\/ins>-cache-identity/);
    assert.doesNotMatch(replacementFromLiveServer.diffHtml, /return 2/);
    const reopened = JSON.parse(localVirtual([
        "open",
        created.reviewId,
        "--revision",
        "1",
        "--no-open",
    ]));
    reviewUrls.push(reopened.reviewUrl);
    assert.notEqual(reopened.reviewUrl, created.reviewUrl);
    const reopenedRoot = reopened.reviewUrl.replace(/\/review\?revision=1$/, "");
    const replacementHealth = await fetch(`${reopenedRoot}/health`).then((response) => response.json());
    assert.match(replacementHealth.revisionIdentity, /^[a-f0-9]{64}$/);
    assert.notEqual(replacementHealth.revisionIdentity, initialHealth.revisionIdentity);
    const replacementFromReopenedServer = await singleCommitReviewData(reopenedRoot, 1, firstCommitId);
    assert.match(replacementFromReopenedServer.diffHtml, /replacement<\/ins>-cache-identity/);

    await fetch(`${rootUrl}/progress?revision=1`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ commitId: firstCommitId, kind: "reviewed", value: true }),
    }).then((response) => assert.equal(response.status, 204));

    const revised = JSON.parse(localVirtual([
        "create",
        snapshot.source.sourceId,
        "--review",
        created.reviewId,
        "--expected-revision",
        "1",
        "--no-open",
    ], { input: JSON.stringify(manifestFor(snapshot.source, { title: "Alternative review", reverse: true })) }));
    reviewUrls.push(revised.reviewUrl);
    assert.equal(revised.revision, 2);
    const revisedRoot = revised.reviewUrl.replace(/\/review\?revision=2$/, "");
    const revisionTwoProgress = await fetch(`${revisedRoot}/progress?revision=2`).then((response) => response.json());
    assert.deepEqual(revisionTwoProgress, { viewedCommitIds: [], reviewedCommitIds: [] });
    const reviews = JSON.parse(localVirtual(["list"]));
    assert.equal(reviews.reviews[0].revisionCount, 2);
    assert.equal(reviews.reviews[0].revisions.length, 2);
    assert.ok(reviews.reviews[0].revisions.every((item) => (
        item.branchCommit.sha === featureHead
        && item.branchCommit.subject === "cover virtual review behavior"
    )));

    const deletedTip = JSON.parse(localVirtual([
        "delete",
        created.reviewId,
        "--revision",
        "2",
    ]));
    assert.equal(deletedTip.revision, 2);
    const recreated = JSON.parse(localVirtual([
        "create",
        snapshot.source.sourceId,
        "--review",
        created.reviewId,
        "--expected-revision",
        "1",
        "--no-open",
    ], { input: JSON.stringify(manifestFor(snapshot.source, { title: "Review after deletion" })) }));
    reviewUrls.push(recreated.reviewUrl);
    assert.equal(recreated.revision, 3, "a deleted tip revision must never be allocated again");
    const afterRecreate = JSON.parse(localVirtual(["list"]));
    assert.deepEqual(afterRecreate.reviews[0].revisions.map((item) => item.revision), [1, 3]);
    const recreatedRoot = recreated.reviewUrl.replace(/\/review\?revision=3$/, "");

    const storedSource = await loadVirtualSource(snapshot.source.sourceId, stateRoot);
    const currentFreshness = await inspectVirtualSourceFreshness(storedSource);
    assert.equal(currentFreshness.stale, false);
    assert.equal(currentFreshness.currentHeadSha, featureHead);
    assert.equal(currentFreshness.currentTargetSha, snapshot.source.repository.targetSha);
    assert.equal(currentFreshness.currentBaseSha, snapshot.source.repository.baseSha);
    git(["commit", "-qm", "advance live repository after virtual review"]);
    const advancedHead = git(["rev-parse", "HEAD"]).trim();
    const staleFreshness = await inspectVirtualSourceFreshness(storedSource);
    assert.equal(staleFreshness.stale, true);
    assert.equal(staleFreshness.currentHeadSha, advancedHead);
    assert.equal(staleFreshness.currentTargetSha, snapshot.source.repository.targetSha);
    assert.equal(staleFreshness.currentBaseSha, snapshot.source.repository.baseSha);

    fs.rmSync(repoRoot, { recursive: true, force: true });
    const selfContainedPage = await fetch(recreated.reviewUrl).then((response) => response.text());
    assert.match(selfContainedPage, /id="local-mr-version-data"/);
    assert.match(selfContainedPage, /id="diff"/);
    assert.match(selfContainedPage, /id="local-mr-review-behaviour"/);
    const selfContainedPayload = await fetch(`${recreatedRoot}/review-data?revision=3`)
        .then((response) => response.json());
    assert.equal(selfContainedPayload.versionData.reviewNavigation.active, "virtual");
    assert.equal(selfContainedPayload.versionData.reviewNavigation.virtualReview.currentCommit, null);
    assert.equal(selfContainedPayload.versionData.virtualSession.currentHeadSha, null);
    assert.equal(selfContainedPayload.versionData.virtualSession.currentTargetSha, null);
    assert.equal(selfContainedPayload.versionData.virtualSession.currentBaseSha, null);
    assert.ok(selfContainedPayload.versionData.files.length > 0);
    assert.match(selfContainedPayload.diffHtml, /d2h-file-wrapper/);

    console.log(JSON.stringify({
        sourceId: snapshot.source.sourceId,
        reviewId: created.reviewId,
        revisions: afterRecreate.reviews[0].revisionCount,
        checks: {
            strictValidation: true,
            strictCliOptions: true,
            indexUntouched: true,
            objectDatabaseUntouched: true,
            cumulativePatches: true,
            lazyBlockReads: true,
            progressReset: true,
            monotonicRevisions: true,
            selfContained: true,
            revisionIdentity: true,
            singleWslOpener: true,
            linkedLiveRealReturn: true,
            freshnessCommitMetadata: true,
        },
    }, null, 2));
} finally {
    await Promise.all(reviewUrls.map(async (reviewUrl) => {
        try {
            const shutdown = new URL(reviewUrl);
            shutdown.pathname = shutdown.pathname.replace(/\/review$/, "/shutdown");
            shutdown.search = "";
            await fetch(shutdown, { method: "POST" });
        } catch {}
    }));
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
}
