import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { localMr } from "./helpers/paths.mjs";

const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "local-mr-context-endpoint-"));
const repoRoot = path.join(tempDirectory, "repo");
const runtimeDirectory = path.join(tempDirectory, "runtime");
const stateDirectory = path.join(tempDirectory, "state");
let reviewUrl = "";

const git = (args) => execFileSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
}).trim();

try {
    fs.mkdirSync(repoRoot, { recursive: true });
    git(["init", "--initial-branch=main"]);
    git(["config", "user.name", "Local MR Test"]);
    git(["config", "user.email", "local-mr@example.invalid"]);
    const baseLines = Array.from({ length: 60 }, (_, index) => `base line ${index + 1}`);
    fs.writeFileSync(path.join(repoRoot, "example.txt"), `${baseLines.join("\n")}\n`);
    fs.writeFileSync(path.join(repoRoot, "deleted.txt"), "deleted\n");
    git(["add", "example.txt", "deleted.txt"]);
    git(["commit", "-m", "base"]);
    git(["switch", "-c", "feature/context-endpoint"]);
    const changedLines = [...baseLines];
    changedLines[29] = "changed line 30";
    fs.writeFileSync(path.join(repoRoot, "example.txt"), `${changedLines.join("\n")}\n`);
    fs.writeFileSync(path.join(repoRoot, "added.txt"), "added\n");
    fs.rmSync(path.join(repoRoot, "deleted.txt"));

    const output = execFileSync(localMr, ["main", "--no-open", "--light"], {
        cwd: repoRoot,
        encoding: "utf8",
        env: {
            ...process.env,
            XDG_RUNTIME_DIR: runtimeDirectory,
            XDG_STATE_HOME: stateDirectory,
            LOCAL_MR_SERVER_IDLE_MINUTES: "1",
        },
    });
    reviewUrl = output.match(/^Review: (.+)$/m)?.[1] || "";
    if (!reviewUrl) throw new Error(`local-mr did not print a review URL:\n${output}`);

    const reviewResponse = await fetch(reviewUrl);
    reviewUrl = reviewResponse.url;
    const html = await reviewResponse.text();
    const encodedData = html.match(
        /<script id="local-mr-version-data" type="application\/json">([\s\S]*?)<\/script>/,
    )?.[1];
    if (!encodedData) throw new Error("review page does not contain version data");
    const versionData = JSON.parse(encodedData);
    const modified = versionData.files.find((file) => file.displayPath === "example.txt");
    const added = versionData.files.find((file) => file.displayPath === "added.txt");
    const deleted = versionData.files.find((file) => file.displayPath === "deleted.txt");
    const requestContext = async (file, patch = versionData.patchId) => {
        const url = new URL(versionData.contextUrl);
        url.searchParams.set("mode", versionData.selection.mode);
        url.searchParams.set("from", versionData.selection.from);
        url.searchParams.set("to", versionData.selection.to);
        url.searchParams.set("patch", patch);
        url.searchParams.set("file", file.patchId);
        url.searchParams.set("start", "9");
        url.searchParams.set("end", "12");
        const response = await fetch(url);
        return { response, payload: await response.json() };
    };

    const context = await requestContext(modified);
    const addedContext = await requestContext(added);
    const deletedContext = await requestContext(deleted);
    const staleContext = await requestContext(modified, "0000000000000000");
    const checks = {
        "review advertises the context endpoint": typeof versionData.contextUrl === "string",
        "modified files expose left-side context lines": context.response.status === 200
            && context.payload.start === 9
            && context.payload.end === 12
            && context.payload.totalLines === 60
            && context.payload.lines.join("|") === "base line 9|base line 10|base line 11|base line 12",
        "added files cannot request context": addedContext.response.status === 400,
        "deleted files cannot request context": deletedContext.response.status === 400,
        "stale patches are rejected": staleContext.response.status === 409,
    };
    console.log(JSON.stringify({
        statuses: {
            context: context.response.status,
            added: addedContext.response.status,
            deleted: deletedContext.response.status,
            stale: staleContext.response.status,
        },
        checks,
    }, null, 2));
    if (Object.values(checks).some((passed) => !passed)) process.exitCode = 1;
} finally {
    if (reviewUrl) {
        try {
            const healthUrl = new URL(reviewUrl);
            healthUrl.pathname = healthUrl.pathname.replace(/\/review$/, "/health");
            const health = await fetch(healthUrl).then((response) => response.json());
            process.kill(health.pid, "SIGTERM");
        } catch {}
    }
    fs.rmSync(tempDirectory, { recursive: true, force: true });
}
