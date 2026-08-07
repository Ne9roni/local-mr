import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createVirtualReview } from "../src/virtual-review-core.mjs";
import { localMr } from "./helpers/paths.mjs";

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "local-mr-virtual-materialize-"));
const repoRoot = path.join(temporaryRoot, "repo");
const stateRoot = path.join(temporaryRoot, "state");
const environment = {
    ...process.env,
    LOCAL_MR_VIRTUAL_STATE_DIR: stateRoot,
};

const run = (command, arguments_, options = {}) => {
    const result = spawnSync(command, arguments_, {
        cwd: repoRoot,
        env: environment,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
    });
    if (options.allowFailure) return result;
    if (result.status !== 0) {
        throw new Error(`${command} ${arguments_.join(" ")} failed:\n${result.stderr || result.stdout}`);
    }
    return result.stdout;
};

const git = (arguments_) => run("git", arguments_).trim();
const localVirtual = (arguments_, options) => run(localMr, ["virtual-commit", ...arguments_], options);
const assertFailure = (arguments_, code, pattern) => {
    const result = localVirtual(arguments_, { allowFailure: true });
    assert.equal(result.status, 1, result.stdout);
    const payload = JSON.parse(result.stderr);
    assert.equal(payload.error.code, code, payload.error.message);
    assert.match(payload.error.message, pattern);
};

const baseApp = [
    "function first() {",
    "    return 'base-first';",
    "}",
    "",
    "function middle() {",
    "    return 'stable';",
    "}",
    "",
    "function last() {",
    "    return 'base-last';",
    "}",
    "",
].join("\n");
const targetApp = baseApp
    .replace("'base-first'", "'target-first'")
    .replace("'base-last'", "'target-last'");

try {
    fs.mkdirSync(path.join(repoRoot, "src"), { recursive: true });
    git(["init", "-q", "-b", "main"]);
    git(["config", "user.name", "Local MR Test"]);
    git(["config", "user.email", "local-mr@example.test"]);
    fs.writeFileSync(path.join(repoRoot, "src", "app.txt"), baseApp);
    fs.writeFileSync(path.join(repoRoot, "src", "old.txt"), "retired behavior\n");
    git(["add", "."]);
    git(["commit", "-qm", "base"]);
    const baseSha = git(["rev-parse", "HEAD"]);
    git(["switch", "-qc", "feature/materialize"]);
    fs.writeFileSync(path.join(repoRoot, "src", "app.txt"), targetApp);
    fs.writeFileSync(path.join(repoRoot, "src", "new.txt"), "added behavior\n");
    fs.rmSync(path.join(repoRoot, "src", "old.txt"));
    git(["add", "."]);
    git(["commit", "-qm", "implement everything at once"]);
    const featureHead = git(["rev-parse", "HEAD"]);

    const snapshot = JSON.parse(localVirtual(["snapshot", "--target", "main"]));
    assert.equal(snapshot.ok, true);
    const blocksByPath = new Map(snapshot.source.files.map((file) => (
        [file.displayPath, file.blocks.map((block) => block.id)]
    )));
    const appBlocks = blocksByPath.get("src/app.txt");
    const newBlocks = blocksByPath.get("src/new.txt");
    const oldBlocks = blocksByPath.get("src/old.txt");
    assert.equal(appBlocks.length, 2, "the modified file must split into two blocks");
    const virtualCommitPlan = [
        { title: "Change the first behavior", blocks: [appBlocks[0]] },
        { title: "Change the last behavior and add coverage", blocks: [appBlocks[1], ...newBlocks] },
        { title: "Retire the old behavior", blocks: oldBlocks },
    ];
    const manifest = {
        schemaVersion: 1,
        title: "Materialize regression review",
        strategy: "Dependency-aware core/risk-first",
        overview: {
            summary: "Review the behavior change before the retirement.",
            routeRationale: "Read the risky edit first, then coverage, then cleanup.",
            uncertainties: [],
        },
        virtualCommits: virtualCommitPlan.map((step, index) => ({
            title: step.title,
            intent: `Understand step ${index + 1} of the reading order.`,
            reviewFocus: [{
                text: "Check that this step matches its stated intent.",
                targets: [`block:${step.blocks[0]}`],
            }],
            risk: { level: "medium", reason: "The step rewrites reviewed behavior." },
            blocks: step.blocks,
        })),
    };
    const created = await createVirtualReview({
        sourceId: snapshot.source.sourceId,
        manifest,
        stateRoot,
    });
    assert.equal(created.revision, 1);

    const shortSha = snapshot.source.branchCommit.shortSha;
    const backupBranch = `backup/feature/materialize/${shortSha}`;

    assertFailure(
        ["materialize", created.reviewId, "--backup", "bad..name"],
        "INVALID_BACKUP_NAME",
        /Invalid backup branch name/,
    );

    git(["branch", backupBranch, baseSha]);
    assertFailure(
        ["materialize", created.reviewId],
        "BACKUP_EXISTS",
        /already exists and points to a different commit/,
    );
    assert.equal(git(["rev-parse", "feature/materialize"]), featureHead, "a refused materialize must not move the branch");
    git(["branch", "-qD", backupBranch]);

    fs.appendFileSync(path.join(repoRoot, "src", "app.txt"), "// DIRTY_SENTINEL\n");
    fs.writeFileSync(path.join(repoRoot, "untracked.txt"), "untracked\n");

    const materialized = JSON.parse(localVirtual(["materialize", created.reviewId, "--revision", "1"]));
    assert.equal(materialized.ok, true);
    assert.equal(materialized.branch, "feature/materialize");
    assert.equal(materialized.previousHead, featureHead);
    assert.equal(materialized.backupBranch, backupBranch);
    assert.equal(materialized.backupCreated, true);
    assert.equal(materialized.commits.length, 3);
    assert.equal(git(["rev-parse", `refs/heads/${backupBranch}`]), featureHead);
    assert.equal(git(["rev-parse", "feature/materialize"]), materialized.newHead);
    assert.equal(run("git", ["diff", featureHead, materialized.newHead]), "");
    assert.equal(git(["rev-list", "--count", `${baseSha}..${materialized.newHead}`]), "3");
    assert.deepEqual(
        git(["log", "--reverse", "--format=%s", `${baseSha}..${materialized.newHead}`]).split("\n"),
        virtualCommitPlan.map((step) => step.title),
    );
    const headMessage = run("git", ["show", "-s", "--format=%B", materialized.newHead]);
    assert.match(headMessage, /Intent: Understand step 3 of the reading order\./);
    assert.match(headMessage, /Review focus:\n- Check that this step matches its stated intent\./);
    assert.match(headMessage, /Risk \(medium\): The step rewrites reviewed behavior\./);
    assert.match(headMessage, new RegExp(`Local-MR-Virtual-Commit: ${created.reviewId}@r1 3/3`));

    const [firstCommit, secondCommit] = materialized.commits.map((commit) => commit.sha);
    const firstApp = run("git", ["show", `${firstCommit}:src/app.txt`]);
    assert.notEqual(firstApp, baseApp, "the first virtual state must apply its block");
    assert.notEqual(firstApp, targetApp, "the first virtual state must stay partial");
    assert.match(firstApp, /'target-first'/);
    assert.match(firstApp, /'base-last'/);
    run("git", ["show", `${firstCommit}:src/old.txt`]);
    assert.equal(run("git", ["show", `${firstCommit}:src/new.txt`], { allowFailure: true }).status, 128);
    run("git", ["show", `${secondCommit}:src/new.txt`]);
    assert.equal(run("git", ["show", `${materialized.newHead}:src/old.txt`], { allowFailure: true }).status, 128);

    const status = run("git", ["status", "--porcelain"]).split("\n").filter(Boolean).sort();
    assert.deepEqual(status, [" M src/app.txt", "?? untracked.txt"], "the dirty worktree must survive unchanged");
    assert.match(fs.readFileSync(path.join(repoRoot, "src", "app.txt"), "utf8"), /DIRTY_SENTINEL/);

    assertFailure(
        ["materialize", created.reviewId],
        "STALE_SOURCE",
        /branch moved after the source was frozen/,
    );

    console.log(JSON.stringify({
        ok: true,
        reviewId: created.reviewId,
        newHead: materialized.newHead,
        checks: {
            backupBranchCreated: true,
            branchReplacedAtomically: true,
            treeEqualsFrozenHead: true,
            readingOrderSubjects: true,
            reviewContextMessages: true,
            partialIntermediateState: true,
            dirtyWorktreeUntouched: true,
            backupConflictRefused: true,
            invalidBackupNameRefused: true,
            staleSourceRefused: true,
        },
    }, null, 2));
} finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
}
