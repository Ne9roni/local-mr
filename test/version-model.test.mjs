import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
    buildComparisonPatch,
    buildFileContext,
    buildFilePreview,
    buildVersionModel,
    inspectRepositoryState,
    resolveComparisonEndpoints,
    validateSelection,
} from "../src/version-model.mjs";

const git = (repoRoot, args, options = {}) => execFileSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, ...options.env },
}).trim();

const commitFile = (repoRoot, content, message, date) => {
    fs.writeFileSync(path.join(repoRoot, "example.txt"), content);
    git(repoRoot, ["add", "example.txt"]);
    git(repoRoot, ["commit", "-m", message], {
        env: { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
    });
    return git(repoRoot, ["rev-parse", "HEAD"]);
};

const fileHash = (filePath) => crypto.createHash("sha256")
    .update(fs.readFileSync(filePath))
    .digest("hex");

const fixture = () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "local-mr-version-model-"));
    git(repoRoot, ["init", "--initial-branch=main"]);
    git(repoRoot, ["config", "user.name", "Local MR Test"]);
    git(repoRoot, ["config", "user.email", "local-mr@example.invalid"]);
    const base = commitFile(repoRoot, "base\n", "base", "2026-01-01T08:00:00+08:00");
    git(repoRoot, ["switch", "-c", "feature/version-picker"]);
    fs.mkdirSync(path.join(repoRoot, "docs"), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, "docs", "design.md"), [
        "# Pushed design",
        "",
        "```mermaid",
        "flowchart LR",
        "    Client --> Server",
        "```",
        "",
    ].join("\n"));
    git(repoRoot, ["add", "docs/design.md"]);
    const first = commitFile(
        repoRoot,
        "base\none\n",
        "first change\n\nExplain the first review checkpoint.\nKeep the body formatting intact.",
        "2026-01-02T08:00:00+08:00",
    );
    git(repoRoot, ["update-ref", "--create-reflog", "-m", "update by push", "refs/remotes/origin/feature/version-picker", first]);
    const second = commitFile(repoRoot, "base\none\ntwo\n", "second change", "2026-01-03T08:00:00+08:00");
    git(repoRoot, ["update-ref", "--create-reflog", "-m", "update by push", "refs/remotes/origin/feature/version-picker", second, first]);
    const fetchedOnly = git(repoRoot, ["commit-tree", `${second}^{tree}`, "-p", second, "-m", "fetched only"]);
    git(repoRoot, ["update-ref", "-m", "fetch origin", "refs/remotes/origin/feature/version-picker", fetchedOnly, second]);
    git(repoRoot, ["update-ref", "-m", "sync remote-tracking ref", "refs/remotes/origin/feature/version-picker", second, fetchedOnly]);
    git(repoRoot, ["config", "remote.origin.url", "https://example.invalid/repo.git"]);
    git(repoRoot, ["config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"]);
    git(repoRoot, ["config", "branch.feature/version-picker.remote", "origin"]);
    git(repoRoot, ["config", "branch.feature/version-picker.merge", "refs/heads/feature/version-picker"]);
    fs.writeFileSync(path.join(repoRoot, "working-tree.txt"), "not committed\n");
    fs.writeFileSync(path.join(repoRoot, "docs", "design.md"), [
        "# Message flow",
        "",
        "```mermaid",
        "flowchart LR",
        "    Producer --> Consumer",
        "```",
        "",
    ].join("\n"));
    return { repoRoot, base, first, second, fetchedOnly };
};

const mergedTargetFixture = () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "local-mr-version-merged-target-"));
    git(repoRoot, ["init", "--initial-branch=main"]);
    git(repoRoot, ["config", "user.name", "Local MR Test"]);
    git(repoRoot, ["config", "user.email", "local-mr@example.invalid"]);
    fs.writeFileSync(path.join(repoRoot, "base.txt"), "shared base\n");
    git(repoRoot, ["add", "base.txt"]);
    git(repoRoot, ["commit", "-m", "shared base"]);

    git(repoRoot, ["switch", "-c", "feature/merged-target"]);
    fs.writeFileSync(path.join(repoRoot, "feature.txt"), "feature one\n");
    git(repoRoot, ["add", "feature.txt"]);
    git(repoRoot, ["commit", "-m", "feature one"]);
    const first = git(repoRoot, ["rev-parse", "HEAD"]);
    fs.appendFileSync(path.join(repoRoot, "feature.txt"), "feature two\n");
    git(repoRoot, ["add", "feature.txt"]);
    git(repoRoot, ["commit", "-m", "feature two"]);
    const second = git(repoRoot, ["rev-parse", "HEAD"]);

    git(repoRoot, ["switch", "main"]);
    fs.writeFileSync(path.join(repoRoot, "already-on-target.txt"), "target-only history\n");
    git(repoRoot, ["add", "already-on-target.txt"]);
    git(repoRoot, ["commit", "-m", "advance target"]);
    const target = git(repoRoot, ["rev-parse", "HEAD"]);

    git(repoRoot, ["switch", "feature/merged-target"]);
    git(repoRoot, ["merge", "--no-ff", "main", "-m", "merge target into feature"]);
    const merge = git(repoRoot, ["rev-parse", "HEAD"]);
    fs.appendFileSync(path.join(repoRoot, "feature.txt"), "feature three\n");
    git(repoRoot, ["add", "feature.txt"]);
    git(repoRoot, ["commit", "-m", "feature three"]);
    const head = git(repoRoot, ["rev-parse", "HEAD"]);
    return { repoRoot, first, second, target, merge, head };
};

test("buildVersionModel exposes one ordered commit list and a committed range default", async (context) => {
    const data = fixture();
    context.after(() => fs.rmSync(data.repoRoot, { recursive: true, force: true }));

    const model = await buildVersionModel({ repoRoot: data.repoRoot, targetRef: "main" });

    assert.equal(model.base.sha, data.base);
    assert.deepEqual(model.commits.map((commit) => commit.sha), [
        data.first,
        data.second,
        "worktree",
    ]);
    assert.equal(model.commits.at(-1).virtual, true);
    assert.equal(model.commits.at(-1).subject, "Uncommitted changes");
    assert.equal(
        model.commits[0].body,
        "Explain the first review checkpoint.\nKeep the body formatting intact.",
    );
    assert.equal(model.commits.at(-1).body, "Staged, unstaged, and untracked files");
    assert.equal(model.commits.some((commit) => commit.sha === data.fetchedOnly), false);
    assert.deepEqual(model.defaultSelection, {
        mode: "range",
        from: data.first,
        to: data.second,
    });
});

test("frozen repository state stays pinned after HEAD and the worktree move", async (context) => {
    const data = fixture();
    context.after(() => fs.rmSync(data.repoRoot, { recursive: true, force: true }));
    const frozen = {
        baseSha: data.base,
        headSha: data.second,
        targetSha: data.base,
        branchName: "feature/version-picker",
    };
    const later = commitFile(
        data.repoRoot,
        "base\none\ntwo\nLIVE_DRIFT_SENTINEL\n",
        "later live change",
        "2026-01-04T08:00:00+08:00",
    );
    assert.notEqual(later, frozen.headSha);

    const repositoryState = await inspectRepositoryState({
        repoRoot: data.repoRoot,
        targetRef: "main",
        frozen,
    });
    const model = await buildVersionModel({
        repoRoot: data.repoRoot,
        targetRef: "main",
        repositoryState,
    });
    const patch = await buildComparisonPatch({
        repoRoot: data.repoRoot,
        model,
        selection: model.defaultSelection,
    });

    assert.equal(repositoryState.frozen, true);
    assert.equal(model.headSha, data.second);
    assert.equal(model.dirty, false);
    assert.deepEqual(model.commits.map((commit) => commit.sha), [data.first, data.second]);
    assert.doesNotMatch(patch, /LIVE_DRIFT_SENTINEL/);
    await assert.rejects(
        inspectRepositoryState({
            repoRoot: data.repoRoot,
            targetRef: "main",
            frozen: { ...frozen, baseSha: data.first },
        }),
        /not the merge base/i,
    );
});

test("the full commit range stays anchored to the review base after merging the target", async (context) => {
    const data = mergedTargetFixture();
    context.after(() => fs.rmSync(data.repoRoot, { recursive: true, force: true }));
    const model = await buildVersionModel({ repoRoot: data.repoRoot, targetRef: "main" });

    assert.equal(model.base.sha, data.target);
    assert.deepEqual(model.commits.map((commit) => commit.sha), [
        data.first,
        data.second,
        data.merge,
        data.head,
    ]);
    const endpoints = resolveComparisonEndpoints(model, model.defaultSelection, { strict: true });
    assert.equal(endpoints.from.sha, data.target);
    assert.equal(endpoints.to.sha, data.head);

    const patch = await buildComparisonPatch({
        repoRoot: data.repoRoot,
        model,
        selection: model.defaultSelection,
    });
    const exactFrozenPatch = execFileSync("git", [
        "diff",
        "--binary",
        "--full-index",
        "--find-renames",
        "--no-ext-diff",
        "--no-textconv",
        data.target,
        data.head,
        "--",
    ], {
        cwd: data.repoRoot,
        encoding: "utf8",
        env: process.env,
    });
    assert.equal(patch, exactFrozenPatch);
    assert.match(patch, /^\+feature one$/m);
    assert.match(patch, /^\+feature three$/m);
    assert.doesNotMatch(patch, /already-on-target\.txt/);

    const firstCommitPatch = await buildComparisonPatch({
        repoRoot: data.repoRoot,
        model,
        selection: { mode: "single", from: data.first, to: data.first },
    });
    assert.match(firstCommitPatch, /^\+feature one$/m);
    assert.doesNotMatch(firstCommitPatch, /already-on-target\.txt/);
});

test("local commits and worktree changes stay separate without inferred push metadata", async (context) => {
    const data = fixture();
    context.after(() => fs.rmSync(data.repoRoot, { recursive: true, force: true }));
    const third = commitFile(
        data.repoRoot,
        "base\none\ntwo\nthree\n",
        "third unpushed change",
        "2026-01-04T08:00:00+08:00",
    );

    const model = await buildVersionModel({ repoRoot: data.repoRoot, targetRef: "main" });

    assert.deepEqual(model.commits.map((commit) => commit.sha), [
        data.first,
        data.second,
        third,
        "worktree",
    ]);
    assert.deepEqual(model.defaultSelection, { mode: "range", from: data.first, to: third });
    assert.equal(model.commits.at(-1).kind, "worktree");
    assert.equal(model.commits.at(-1).body, "Staged, unstaged, and untracked files");

    const committedPatch = await buildComparisonPatch({
        repoRoot: data.repoRoot,
        model,
        selection: { mode: "range", from: data.first, to: third },
    });
    assert.match(committedPatch, /^\+three$/m);
    assert.doesNotMatch(committedPatch, /working-tree\.txt/);
    assert.doesNotMatch(committedPatch, /Producer --> Consumer/);

    const worktreeOnlyPatch = await buildComparisonPatch({
        repoRoot: data.repoRoot,
        model,
        selection: { mode: "single", from: "worktree", to: "worktree" },
    });
    assert.match(worktreeOnlyPatch, /working-tree\.txt/);
    assert.match(worktreeOnlyPatch, /Producer --> Consumer/);
    assert.doesNotMatch(worktreeOnlyPatch, /^\+three$/m);
});

test("clean worktrees do not get a worktree commit", async (context) => {
    const data = fixture();
    context.after(() => fs.rmSync(data.repoRoot, { recursive: true, force: true }));
    fs.rmSync(path.join(data.repoRoot, "working-tree.txt"));
    fs.writeFileSync(path.join(data.repoRoot, "docs", "design.md"), [
        "# Pushed design",
        "",
        "```mermaid",
        "flowchart LR",
        "    Client --> Server",
        "```",
        "",
    ].join("\n"));

    const model = await buildVersionModel({ repoRoot: data.repoRoot, targetRef: "main" });

    assert.equal(model.dirty, false);
    assert.equal(model.commits.some((commit) => commit.virtual), false);
    assert.deepEqual(model.defaultSelection, {
        mode: "range",
        from: data.first,
        to: data.second,
    });
});

test("dirty worktree without branch commits defaults to an empty committed comparison", async (context) => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "local-mr-version-empty-"));
    context.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
    git(repoRoot, ["init", "--initial-branch=main"]);
    git(repoRoot, ["config", "user.name", "Local MR Test"]);
    git(repoRoot, ["config", "user.email", "local-mr@example.invalid"]);
    fs.writeFileSync(path.join(repoRoot, "tracked.txt"), "base\n");
    git(repoRoot, ["add", "tracked.txt"]);
    git(repoRoot, ["commit", "-m", "base"]);
    git(repoRoot, ["switch", "-c", "feature/dirty-only"]);
    fs.writeFileSync(path.join(repoRoot, "tracked.txt"), "dirty\n");
    fs.writeFileSync(path.join(repoRoot, "untracked.txt"), "untracked\n");

    const model = await buildVersionModel({ repoRoot, targetRef: "main" });
    assert.deepEqual(model.commits.map((commit) => commit.sha), ["worktree"]);
    assert.deepEqual(model.defaultSelection, {
        mode: "range",
        from: "base",
        to: "base",
    });

    const defaultPatch = await buildComparisonPatch({
        repoRoot,
        model,
        selection: model.defaultSelection,
    });
    assert.equal(defaultPatch, "");

    const manualWorktreePatch = await buildComparisonPatch({
        repoRoot,
        model,
        selection: { mode: "single", from: "worktree", to: "worktree" },
    });
    assert.match(manualWorktreePatch, /^\+dirty$/m);
    assert.match(manualWorktreePatch, /untracked\.txt/);
    assert.match(manualWorktreePatch, /^\+untracked$/m);
});

test("single and continuous range modes produce the expected patches", async (context) => {
    const data = fixture();
    context.after(() => fs.rmSync(data.repoRoot, { recursive: true, force: true }));
    const model = await buildVersionModel({ repoRoot: data.repoRoot, targetRef: "main" });

    const single = await buildComparisonPatch({
        repoRoot: data.repoRoot,
        model,
        selection: { mode: "single", from: data.second, to: data.second },
    });
    assert.match(single, /^\+two$/m);
    assert.doesNotMatch(single, /^\+one$/m);

    const range = await buildComparisonPatch({
        repoRoot: data.repoRoot,
        model,
        selection: { mode: "range", from: data.first, to: data.second },
    });
    assert.match(range, /^\+one$/m);
    assert.match(range, /^\+two$/m);

    const uncommitted = await buildComparisonPatch({
        repoRoot: data.repoRoot,
        model,
        selection: { mode: "single", from: "worktree", to: "worktree" },
    });
    assert.match(uncommitted, /diff --git a\/working-tree\.txt b\/working-tree\.txt/);
    assert.match(uncommitted, /^\+not committed$/m);
    assert.doesNotMatch(uncommitted, /^\+one$/m);
    assert.doesNotMatch(uncommitted, /^\+two$/m);

    const throughWorktree = await buildComparisonPatch({
        repoRoot: data.repoRoot,
        model,
        selection: { mode: "range", from: data.second, to: "worktree" },
    });
    assert.match(throughWorktree, /^\+two$/m);
    assert.match(throughWorktree, /^\+not committed$/m);

    assert.deepEqual(
        validateSelection(model, { mode: "commits", from: data.second, to: data.second }),
        { mode: "single", from: data.second, to: data.second },
    );
    assert.deepEqual(
        validateSelection(model, { mode: "push", from: "base", to: `push:${data.second}` }),
        { mode: "range", from: data.first, to: data.second },
    );
    assert.deepEqual(
        validateSelection(model, { mode: "range", from: data.second, to: data.second }),
        { mode: "range", from: data.second, to: data.second },
    );
});

test("default comparison excludes the dirty worktree while manual worktree selection remains available", async (context) => {
    const data = fixture();
    context.after(() => fs.rmSync(data.repoRoot, { recursive: true, force: true }));
    const model = await buildVersionModel({ repoRoot: data.repoRoot, targetRef: "main" });

    const defaultPatch = await buildComparisonPatch({
        repoRoot: data.repoRoot,
        model,
        selection: model.defaultSelection,
    });
    assert.match(defaultPatch, /^\+one$/m);
    assert.match(defaultPatch, /^\+two$/m);
    assert.doesNotMatch(defaultPatch, /working-tree\.txt/);
    assert.doesNotMatch(defaultPatch, /Producer --> Consumer/);

    const manualWorktreePatch = await buildComparisonPatch({
        repoRoot: data.repoRoot,
        model,
        selection: { mode: "range", from: data.first, to: "worktree" },
    });
    assert.match(manualWorktreePatch, /^\+one$/m);
    assert.match(manualWorktreePatch, /^\+two$/m);
    assert.match(manualWorktreePatch, /diff --git a\/working-tree\.txt b\/working-tree\.txt/);
    assert.match(manualWorktreePatch, /^\+not committed$/m);
});

test("model and worktree comparisons never refresh the real Git index", async (context) => {
    const data = fixture();
    context.after(() => fs.rmSync(data.repoRoot, { recursive: true, force: true }));
    const indexPath = path.join(data.repoRoot, ".git", "index");
    const trackedPath = path.join(data.repoRoot, "example.txt");
    const future = new Date("2030-01-01T00:00:00Z");
    fs.utimesSync(trackedPath, future, future);
    const before = fileHash(indexPath);

    const model = await buildVersionModel({ repoRoot: data.repoRoot, targetRef: "main" });
    await buildComparisonPatch({
        repoRoot: data.repoRoot,
        model,
        selection: model.defaultSelection,
    });

    assert.equal(fileHash(indexPath), before);
});

test("Markdown preview reads the selected right-side version safely", async (context) => {
    const data = fixture();
    context.after(() => fs.rmSync(data.repoRoot, { recursive: true, force: true }));
    const model = await buildVersionModel({ repoRoot: data.repoRoot, targetRef: "main" });

    const preview = await buildFilePreview({
        repoRoot: data.repoRoot,
        model,
        selection: model.defaultSelection,
        filePath: "docs/design.md",
    });

    assert.equal(preview.path, "docs/design.md");
    assert.equal(preview.markdown, true);
    assert.match(preview.content, /```mermaid\nflowchart LR/);
    assert.match(preview.content, /Client --> Server/);
    assert.doesNotMatch(preview.content, /Producer --> Consumer/);
    const legacyPushPreview = await buildFilePreview({
        repoRoot: data.repoRoot,
        model,
        selection: { mode: "push", from: "base", to: `push:${data.first}` },
        filePath: "docs/design.md",
    });
    assert.match(legacyPushPreview.content, /Client --> Server/);
    assert.doesNotMatch(legacyPushPreview.content, /Producer --> Consumer/);
    assert.equal(legacyPushPreview.content.endsWith("\n"), true);
    const commitPreview = await buildFilePreview({
        repoRoot: data.repoRoot,
        model,
        selection: { mode: "single", from: data.first, to: data.first },
        filePath: "docs/design.md",
    });
    assert.match(commitPreview.content, /Client --> Server/);
    assert.equal(commitPreview.content.endsWith("\n"), true);
    const uncommittedPreview = await buildFilePreview({
        repoRoot: data.repoRoot,
        model,
        selection: { mode: "single", from: "worktree", to: "worktree" },
        filePath: "docs/design.md",
    });
    assert.match(uncommittedPreview.content, /Producer --> Consumer/);
    await assert.rejects(
        buildFilePreview({
            repoRoot: data.repoRoot,
            model,
            selection: model.defaultSelection,
            filePath: "../outside.md",
        }),
        /invalid preview path/i,
    );
});

test("diff context reads bounded lines from the selected left-side version", async (context) => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "local-mr-context-model-"));
    context.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
    git(repoRoot, ["init", "--initial-branch=main"]);
    git(repoRoot, ["config", "user.name", "Local MR Test"]);
    git(repoRoot, ["config", "user.email", "local-mr@example.invalid"]);
    const baseLines = Array.from({ length: 60 }, (_, index) => `base line ${index + 1}`);
    fs.writeFileSync(path.join(repoRoot, "example.txt"), `${baseLines.join("\n")}\n`);
    git(repoRoot, ["add", "example.txt"]);
    git(repoRoot, ["commit", "-m", "base"]);
    git(repoRoot, ["switch", "-c", "feature/context"]);
    const changedLines = [...baseLines];
    changedLines[29] = "changed line 30";
    fs.writeFileSync(path.join(repoRoot, "example.txt"), `${changedLines.join("\n")}\n`);
    git(repoRoot, ["add", "example.txt"]);
    git(repoRoot, ["commit", "-m", "change middle line"]);
    const featureSha = git(repoRoot, ["rev-parse", "HEAD"]);
    const model = await buildVersionModel({ repoRoot, targetRef: "main" });

    const middle = await buildFileContext({
        repoRoot,
        model,
        selection: { mode: "single", from: featureSha, to: featureSha },
        filePath: "example.txt",
        start: 9,
        end: 12,
    });
    assert.deepEqual(middle, {
        path: "example.txt",
        start: 9,
        end: 12,
        totalLines: 60,
        hasMore: true,
        lines: ["base line 9", "base line 10", "base line 11", "base line 12"],
    });

    const tail = await buildFileContext({
        repoRoot,
        model,
        selection: { mode: "single", from: featureSha, to: featureSha },
        filePath: "example.txt",
        start: 58,
        end: 80,
    });
    assert.deepEqual(tail, {
        path: "example.txt",
        start: 58,
        end: 60,
        totalLines: 60,
        hasMore: false,
        lines: ["base line 58", "base line 59", "base line 60"],
    });
    await assert.rejects(
        buildFileContext({
            repoRoot,
            model,
            selection: model.defaultSelection,
            filePath: "../outside.txt",
            start: 1,
            end: 20,
        }),
        /invalid repository path/i,
    );
});
