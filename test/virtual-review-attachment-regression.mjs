import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { localMr } from "./helpers/paths.mjs";
import { printPublicTestReport } from "./helpers/public-report.mjs";

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "local-mr-virtual-attachment-"));
const repoRoot = path.join(temporaryRoot, "repo");
const stateRoot = path.join(temporaryRoot, "state");
const runtimeRoot = path.join(temporaryRoot, "runtime");
const snapshotPath = path.join(temporaryRoot, "real-review.html");
const environment = {
    ...process.env,
    LOCAL_MR_VIRTUAL_STATE_DIR: stateRoot,
    XDG_RUNTIME_DIR: runtimeRoot,
    LOCAL_MR_SERVER_IDLE_MINUTES: "1",
};
const serverUrls = [];

const run = (command, arguments_, { input } = {}) => {
    const result = spawnSync(command, arguments_, {
        cwd: repoRoot,
        env: environment,
        encoding: "utf8",
        input,
        maxBuffer: 64 * 1024 * 1024,
    });
    if (result.status !== 0) {
        throw new Error(`${command} ${arguments_.join(" ")} failed:\n${result.stderr || result.stdout}`);
    }
    return result.stdout;
};

const git = (...arguments_) => run("git", arguments_).trim();
const localVirtual = (arguments_, input) => JSON.parse(run(
    localMr,
    ["virtual-commit", ...arguments_],
    { input },
));
const versionDataFrom = async (url) => {
    const response = await fetch(url);
    assert.equal(response.ok, true, `${response.status} ${response.url}`);
    const html = await response.text();
    const encoded = html.match(
        /<script id="local-mr-version-data" type="application\/json">([\s\S]*?)<\/script>/,
    )?.[1];
    assert.ok(encoded, "Review page must contain version data");
    return { responseUrl: response.url, value: JSON.parse(encoded) };
};

try {
    fs.mkdirSync(repoRoot, { recursive: true });
    git("init", "-q", "-b", "main");
    git("config", "user.name", "Local MR Attachment Test");
    git("config", "user.email", "local-mr@example.invalid");
    fs.writeFileSync(path.join(repoRoot, "app.txt"), "base\n");
    git("add", "app.txt");
    git("commit", "-qm", "base");
    git("switch", "-qc", "feature/stable-review-page");
    fs.writeFileSync(path.join(repoRoot, "app.txt"), "virtual source\n");
    git("add", "app.txt");
    git("commit", "-qm", "capture review source");
    const sourceHead = git("rev-parse", "HEAD");

    const captured = localVirtual(["snapshot", "--target", "main"]);
    const blocks = captured.source.files.flatMap((file) => file.blocks.map((block) => block.id));
    assert.ok(blocks.length > 0);
    const manifest = {
        schemaVersion: 1,
        title: "Stable attachment fixture",
        strategy: "Keep the frozen reading plan attached after HEAD advances.",
        overview: {
            summary: "A saved Virtual Review for one stable Real Review page.",
            routeRationale: "The plan is immutable while repository state is live.",
            uncertainties: [],
        },
        virtualCommits: [{
            title: "Review the captured change",
            intent: "Read the original branch change without later commits.",
            reviewFocus: [{
                text: "Confirm the captured behavior.",
                targets: [`block:${blocks[0]}`],
            }],
            risk: { level: "medium", reason: "This is the frozen source boundary." },
            blocks,
        }],
    };
    const created = localVirtual(
        ["create", captured.source.sourceId, "--no-open"],
        JSON.stringify(manifest),
    );
    serverUrls.push(created.reviewUrl);

    const realOutput = run(localMr, ["main", "--no-open", "-o", snapshotPath]);
    const realReviewUrl = realOutput.match(/^Review: (.+)$/m)?.[1];
    assert.ok(realReviewUrl, realOutput);
    serverUrls.push(realReviewUrl);

    const initial = await versionDataFrom(realReviewUrl);
    assert.equal(initial.value.reviewNavigation.virtualState, "current");
    assert.equal(initial.value.reviewNavigation.virtualReview.reviewId, created.reviewId);
    assert.equal(initial.value.reviewNavigation.virtualReview.revision, created.revision);
    assert.equal(initial.value.reviewNavigation.virtualReview.sourceCommit.sha, sourceHead);
    assert.equal(initial.value.reviewNavigation.virtualReview.currentCommit.sha, sourceHead);
    const bridgeUrl = initial.value.reviewNavigation.virtualUrl;
    assert.equal(new URL(bridgeUrl).origin, new URL(realReviewUrl).origin);

    fs.writeFileSync(path.join(repoRoot, "later.txt"), "not in the frozen review\n");
    git("add", "later.txt");
    git("commit", "-qm", "advance branch after virtual review");
    const currentHead = git("rev-parse", "HEAD");

    const afterCommit = await versionDataFrom(realReviewUrl);
    assert.equal(afterCommit.value.reviewNavigation.virtualState, "stale");
    assert.equal(afterCommit.value.reviewNavigation.virtualUrl, bridgeUrl);
    assert.equal(afterCommit.value.reviewNavigation.virtualReview.sourceCommit.sha, sourceHead);
    assert.equal(afterCommit.value.reviewNavigation.virtualReview.currentCommit.sha, currentHead);
    assert.ok(afterCommit.value.files.some((file) => file.displayPath === "later.txt"));

    const bridgeWithReturn = new URL(bridgeUrl);
    bridgeWithReturn.searchParams.set("return", realReviewUrl);
    const bridgeResponse = await fetch(bridgeWithReturn, { redirect: "manual" });
    assert.equal(bridgeResponse.status, 302);
    const linkedVirtualUrl = bridgeResponse.headers.get("location");
    assert.ok(linkedVirtualUrl);
    serverUrls.push(linkedVirtualUrl);
    assert.equal(new URL(linkedVirtualUrl).searchParams.get("real-review-url"), realReviewUrl);

    const frozen = await versionDataFrom(linkedVirtualUrl);
    assert.equal(frozen.value.reviewNavigation.virtualState, "stale");
    assert.equal(frozen.value.reviewNavigation.realUrl, realReviewUrl);
    assert.equal(frozen.value.reviewNavigation.virtualReview.sourceCommit.sha, sourceHead);
    assert.equal(frozen.value.reviewNavigation.virtualReview.currentCommit.sha, currentHead);
    assert.equal(frozen.value.virtualSession.sourceStale, true);
    assert.equal(frozen.value.files.some((file) => file.displayPath === "later.txt"), false);

    printPublicTestReport({
        reviewId: created.reviewId,
        realReviewUrl,
        sourceHead,
        currentHead,
        checks: {
            sameBareUrl: true,
            staleAttachmentRetained: true,
            frozenSourcePreserved: true,
            liveRealReturnPreserved: true,
        },
    });
} finally {
    await Promise.all(serverUrls.map(async (reviewUrl) => {
        try {
            const shutdown = new URL(reviewUrl);
            shutdown.pathname = shutdown.pathname.replace(/\/review$/, "/shutdown");
            shutdown.search = "";
            shutdown.hash = "";
            await fetch(shutdown, { method: "POST" });
        } catch {}
    }));
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
}
