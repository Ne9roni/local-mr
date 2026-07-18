import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
    frozenRealReviewArguments,
    hashVirtualReviewRuntimeFiles,
    localMrCommandIdentity,
    matchesVirtualReviewServer,
    resolveLocalMrCommandPath,
    virtualReviewRuntimeIdentity,
    virtualReviewRuntimeInventory,
    virtualReviewServerKey,
} from "../src/virtual-review-runtime.mjs";

test("Real review arguments are pinned to one committed Virtual source", () => {
    const source = {
        repository: {
            root: "/repo",
            targetRef: "origin/main",
            branchName: "feature/frozen",
            baseSha: "base-sha",
            headSha: "head-sha",
            targetSha: "target-sha",
        },
        endpoints: {
            from: { kind: "revision", sha: "base-sha" },
            to: { kind: "revision", sha: "head-sha" },
        },
    };
    assert.deepEqual(frozenRealReviewArguments(source), [
        "origin/main",
        "--no-open",
        "--frozen-base", "base-sha",
        "--frozen-head", "head-sha",
        "--frozen-target", "target-sha",
        "--frozen-branch", "feature/frozen",
    ]);
    assert.throws(
        () => frozenRealReviewArguments({
            ...source,
            endpoints: {
                ...source.endpoints,
                to: { kind: "worktree", sha: "head-sha" },
            },
        }),
        /legacy virtual review|frozen committed comparison/i,
    );
    assert.throws(
        () => frozenRealReviewArguments({
            ...source,
            repository: { ...source.repository, baseSha: "different-base" },
        }),
        /legacy virtual review|frozen committed comparison/i,
    );
});

test("runtime identity is deterministic and changes with runtime file content", async (context) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "local-mr-runtime-identity-"));
    context.after(() => fs.rm(directory, { recursive: true, force: true }));
    const server = path.join(directory, "server.mjs");
    const ui = path.join(directory, "ui.html");
    await fs.writeFile(server, "export const version = 1;\n");
    await fs.writeFile(ui, "<main>version one</main>\n");
    const entries = [
        { name: "server", path: server },
        { name: "ui", path: ui },
    ];
    const first = await hashVirtualReviewRuntimeFiles(entries);
    assert.equal(await hashVirtualReviewRuntimeFiles([...entries].reverse()), first);
    await fs.writeFile(ui, "<main>version two</main>\n");
    assert.notEqual(await hashVirtualReviewRuntimeFiles(entries), first);
});

test("default runtime identity covers the virtual server, UI, renderer, core, and store", async () => {
    const inventory = await virtualReviewRuntimeInventory();
    const names = new Set(inventory.map((entry) => entry.name));
    for (const required of [
        "src/virtual-review-server.mjs",
        "src/review-ui.html",
        "src/review-render.mjs",
        "src/virtual-review-core.mjs",
        "src/virtual-review-store.mjs",
        "vendor/diff2html-ui-slim.js",
        "vendor/mermaid.js",
    ]) {
        assert.ok(names.has(required), `${required} is fingerprinted`);
    }
    assert.match(await virtualReviewRuntimeIdentity(), /^[a-f0-9]{64}$/);
});

test("runtime identity binds the canonical local-mr command path and content", async (context) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "local-mr-command-identity-"));
    context.after(() => fs.rm(directory, { recursive: true, force: true }));
    const commandA = path.join(directory, "install-a", "local-mr");
    const commandB = path.join(directory, "install-b", "local-mr");
    const commandLink = path.join(directory, "linked-local-mr");
    await fs.mkdir(path.dirname(commandA), { recursive: true });
    await fs.mkdir(path.dirname(commandB), { recursive: true });
    await fs.writeFile(commandA, "#!/bin/sh\necho version-one\n", { mode: 0o755 });
    await fs.writeFile(commandB, "#!/bin/sh\necho version-one\n", { mode: 0o755 });
    await fs.symlink(commandA, commandLink);

    const canonicalA = await fs.realpath(commandA);
    assert.equal(await resolveLocalMrCommandPath(commandLink), canonicalA);
    assert.deepEqual(
        await localMrCommandIdentity(commandLink),
        await localMrCommandIdentity(commandA),
    );

    const runtimeA = await virtualReviewRuntimeIdentity({ commandPath: commandA });
    const runtimeLink = await virtualReviewRuntimeIdentity({ commandPath: commandLink });
    const runtimeB = await virtualReviewRuntimeIdentity({ commandPath: commandB });
    assert.equal(runtimeLink, runtimeA, "a symlink resolves to the same installed command");
    assert.notEqual(runtimeB, runtimeA, "the canonical install path participates in identity");

    const inventory = await virtualReviewRuntimeInventory({ commandPath: commandLink });
    const commandEntry = inventory.find((entry) => entry.name === "command/local-mr");
    assert.equal(commandEntry.path, canonicalA);
    assert.match(commandEntry.identity, new RegExp(`^${canonicalA.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\0[a-f0-9]{64}$`));

    await fs.writeFile(commandA, "#!/bin/sh\necho version-two\n", { mode: 0o755 });
    const runtimeAReplacement = await virtualReviewRuntimeIdentity({ commandPath: commandA });
    assert.notEqual(runtimeAReplacement, runtimeA, "same-path replacement changes identity");
});

test("command runtime identity participates in the server key and reuse matcher", () => {
    const shared = {
        reviewId: "review-a",
        revision: 3,
        revisionIdentity: "revision-current",
        stateRoot: "/tmp/local-mr-state",
    };
    const runtimeA = "runtime-command-a";
    const runtimeB = "runtime-command-b";
    assert.notEqual(
        virtualReviewServerKey({ ...shared, runtimeIdentity: runtimeA }),
        virtualReviewServerKey({ ...shared, runtimeIdentity: runtimeB }),
    );

    const ready = { ...shared, runtimeIdentity: runtimeA };
    const health = { ok: true, ...shared, runtimeIdentity: runtimeA };
    assert.equal(matchesVirtualReviewServer({
        ready,
        health,
        ...shared,
        runtimeIdentity: runtimeB,
    }), false);
});

test("server reuse rejects a ready or health record from another runtime", () => {
    const expected = {
        reviewId: "review-a",
        revision: 3,
        revisionIdentity: "revision-current",
        runtimeIdentity: "runtime-current",
    };
    const ready = { ...expected };
    const health = { ok: true, ...expected };
    assert.equal(matchesVirtualReviewServer({ ready, health, ...expected }), true);
    assert.equal(matchesVirtualReviewServer({
        ready: { ...ready, runtimeIdentity: "runtime-old" },
        health,
        ...expected,
    }), false);
    assert.equal(matchesVirtualReviewServer({
        ready,
        health: { ...health, runtimeIdentity: "runtime-old" },
        ...expected,
    }), false);
});
