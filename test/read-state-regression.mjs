import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { localMr } from "./helpers/paths.mjs";

const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "local-mr-read-state-test-"));
const repoRoot = path.join(tempDirectory, "repo");
const servers = [];
let stateFile = "";

const git = (args) => execFileSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
}).trim();

const runLocalMr = (color, outputName) => {
    const output = execFileSync(localMr, ["main", "--no-open", color, "-o", path.join(tempDirectory, outputName)], {
        cwd: repoRoot,
        encoding: "utf8",
        env: { ...process.env, LOCAL_MR_SERVER_IDLE_MINUTES: "1" },
    });
    const reviewUrl = output.match(/^Review: (.+)$/m)?.[1] || "";
    if (!reviewUrl) throw new Error(`local-mr did not print a review URL:\n${output}`);
    servers.push(reviewUrl);
    return reviewUrl;
};

const readReview = async (reviewUrl) => {
    const response = await fetch(reviewUrl);
    const html = await response.text();
    const payload = html.match(/<script id="local-mr-version-data" type="application\/json">([\s\S]*?)<\/script>/)?.[1];
    if (!payload) throw new Error("review page has no version model");
    return {
        html,
        model: JSON.parse(payload),
        pageCache: response.headers.get("x-local-mr-page-cache") || "",
    };
};

try {
    fs.mkdirSync(repoRoot, { recursive: true });
    git(["init", "--initial-branch=main"]);
    git(["config", "user.name", "Local MR Test"]);
    git(["config", "user.email", "local-mr@example.invalid"]);
    fs.writeFileSync(path.join(repoRoot, "README.md"), "# Fixture\n");
    git(["add", "README.md"]);
    git(["commit", "-m", "base"]);
    git(["switch", "-c", "feature/read-state"]);
    fs.writeFileSync(path.join(repoRoot, "README.md"), "# Fixture\n\nChanged.\n");

    const firstUrl = runLocalMr("--dark", "dark.html");
    const firstReview = await readReview(firstUrl);
    const firstModel = firstReview.model;
    const token = "README.md\u0000fixture-diff-id";
    const saved = await fetch(firstModel.readStateUrl, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tokens: [token] }),
    });
    if (!saved.ok) throw new Error(`could not save read state: ${saved.status}`);
    const firstStateResponse = await fetch(firstModel.readStateUrl);
    if (!firstStateResponse.ok) {
        throw new Error(`could not read saved state: ${firstStateResponse.status}`);
    }
    const firstState = await firstStateResponse.json();
    const reviewAfterReadUpdate = await readReview(firstUrl);

    const secondUrl = runLocalMr("--light", "light.html");
    const secondReview = await readReview(secondUrl);
    const secondModel = secondReview.model;
    const secondStateResponse = await fetch(secondModel.readStateUrl);
    if (!secondStateResponse.ok) {
        throw new Error(`could not read state from second server: ${secondStateResponse.status}`);
    }
    const secondState = await secondStateResponse.json();
    const stateId = new URL(firstModel.readStateUrl).pathname.split("/").at(-1);
    stateFile = path.join(
        process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"),
        "local-mr",
        "read-state",
        `${stateId}.json`,
    );
    const concurrentTokens = ["README.md\u0000second", "README.md\u0000third"];
    const updates = await Promise.all(concurrentTokens.map((nextToken, index) => fetch(
        index === 0 ? firstModel.readStateUrl : secondModel.readStateUrl,
        {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                token: nextToken,
                tokenPrefix: `${index}.md\u0000`,
                read: true,
            }),
        },
    )));
    if (updates.some((response) => !response.ok)) throw new Error("concurrent read state update failed");
    const persistedTokens = JSON.parse(fs.readFileSync(stateFile, "utf8")).tokens;
    const checks = {
        "separate local-mr servers use different browser origins": new URL(firstUrl).origin !== new URL(secondUrl).origin,
        "read state identity is stable across color/server instances": firstModel.readStateUrl.split("/").at(-1)
            === secondModel.readStateUrl.split("/").at(-1),
        "read marker is loaded through its dedicated endpoint": firstState.tokens.includes(token)
            && secondState.tokens.includes(token),
        "read state is not embedded in cached review HTML": !("readTokens" in firstModel)
            && !("readTokens" in secondModel),
        "read updates do not invalidate rendered review pages": firstReview.pageCache === "hit"
            && reviewAfterReadUpdate.pageCache === "hit",
        "per-file patch ids are strong and layout independent": JSON.stringify(firstModel.filePatchIds)
            === JSON.stringify(secondModel.filePatchIds)
            && Object.values(firstModel.filePatchIds).every((id) => /^[a-f0-9]{64}$/.test(id)),
        "concurrent servers merge incremental marker updates": concurrentTokens.every((nextToken) => (
            persistedTokens.includes(nextToken)
        )),
    };
    console.log(JSON.stringify({ checks }, null, 2));
    if (Object.values(checks).some((passed) => !passed)) process.exitCode = 1;
} finally {
    for (const reviewUrl of servers) {
        try {
            const healthUrl = new URL(reviewUrl);
            healthUrl.pathname = healthUrl.pathname.replace(/\/review$/, "/health");
            const health = await fetch(healthUrl).then((response) => response.json());
            process.kill(health.pid, "SIGTERM");
        } catch {}
    }
    if (stateFile) fs.rmSync(stateFile, { force: true });
    fs.rmSync(tempDirectory, { recursive: true, force: true });
}
