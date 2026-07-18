import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { localMr } from "./helpers/paths.mjs";

const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "local-mr-context-browser-"));
const repoRoot = path.join(tempDirectory, "repo");
const profile = path.join(tempDirectory, "chrome");
const runtimeDirectory = path.join(tempDirectory, "runtime");
const stateDirectory = path.join(tempDirectory, "state");
const port = 9338;
const layout = process.argv.includes("--line") ? "line" : "side";
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
let chrome;
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
    const baseLines = Array.from({ length: 100 }, (_, index) => `base line ${index + 1}`);
    fs.writeFileSync(path.join(repoRoot, "example.txt"), `${baseLines.join("\n")}\n`);
    fs.writeFileSync(path.join(repoRoot, "end.txt"), `${baseLines.join("\n")}\n`);
    fs.writeFileSync(path.join(repoRoot, "empty.txt"), "");
    fs.writeFileSync(path.join(repoRoot, "deleted.txt"), "deleted\n");
    git(["add", "example.txt", "end.txt", "empty.txt", "deleted.txt"]);
    git(["commit", "-m", "base"]);
    git(["switch", "-c", "feature/context-expansion"]);
    const changedLines = [...baseLines];
    changedLines[4] = "changed line 5";
    changedLines[49] = "changed line 50";
    fs.writeFileSync(path.join(repoRoot, "example.txt"), `${changedLines.join("\n")}\n`);
    const endLines = [...baseLines];
    endLines[99] = "changed line 100";
    fs.writeFileSync(path.join(repoRoot, "end.txt"), `${endLines.join("\n")}\n`);
    fs.writeFileSync(path.join(repoRoot, "empty.txt"), "first line\n");
    fs.writeFileSync(path.join(repoRoot, "added.txt"), "added\n");
    fs.rmSync(path.join(repoRoot, "deleted.txt"));
    git(["add", "-A"]);
    git(["commit", "-m", "change context expansion fixture"]);

    const output = execFileSync(localMr, ["main", "--no-open", "--light", `--${layout}`], {
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

    chrome = spawn("google-chrome", [
        "--headless=new",
        "--disable-gpu",
        "--no-sandbox",
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${profile}`,
        reviewUrl,
    ], { stdio: "ignore" });
    let pages;
    for (let attempt = 0; attempt < 80; attempt += 1) {
        try {
            pages = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
            if (pages.some((page) => page.type === "page" && page.url.startsWith(reviewUrl))) break;
        } catch {}
        await delay(100);
    }
    const page = pages?.find((entry) => entry.type === "page" && entry.url.startsWith(reviewUrl));
    if (!page) throw new Error("Chrome did not open the review URL");

    const socket = new WebSocket(page.webSocketDebuggerUrl);
    const pending = new Map();
    let nextId = 1;
    await new Promise((resolve, reject) => {
        socket.addEventListener("open", resolve, { once: true });
        socket.addEventListener("error", reject, { once: true });
    });
    socket.addEventListener("message", (event) => {
        const message = JSON.parse(event.data);
        if (!message.id || !pending.has(message.id)) return;
        const { resolve, reject } = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) reject(new Error(JSON.stringify(message.error)));
        else resolve(message.result);
    });
    const command = (method, params = {}) => {
        const id = nextId++;
        socket.send(JSON.stringify({ id, method, params }));
        return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    };
    const evaluate = async (expression) => {
        const result = await command("Runtime.evaluate", {
            expression,
            returnByValue: true,
            awaitPromise: true,
        });
        if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
        return result.result.value;
    };
    const waitFor = async (expression, label) => {
        for (let attempt = 0; attempt < 160; attempt += 1) {
            try {
                if (await evaluate(expression)) return;
            } catch {}
            await delay(100);
        }
        throw new Error(`Timed out waiting for ${label}`);
    };

    await command("Runtime.enable");
    await waitFor(
        "document.readyState === 'complete' && document.documentElement.classList.contains('local-mr-ready')",
        "review UI",
    );
    const exampleId = await evaluate(String.raw`(() => {
        const link = [...document.querySelectorAll(".d2h-file-list-line .d2h-file-name")]
            .find((candidate) => candidate.title === "example.txt");
        if (!link) throw new Error("example fixture is missing");
        link.click();
        return link.hash.slice(1);
    })()`);
    await waitFor(
        `document.querySelector('.d2h-file-wrapper:not([hidden])')?.id === ${JSON.stringify(exampleId)}
            && document.querySelectorAll('.d2h-file-wrapper:not([hidden]) .local-mr-context-button').length === 5`,
        "context expansion controls",
    );
    const initial = await evaluate(String.raw`(() => {
        const wrapper = document.querySelector(".d2h-file-wrapper:not([hidden])");
        const secondHunk = [...wrapper.querySelectorAll("tr")]
            .find((row) => row.textContent.includes("@@ -47,7 +47,7 @@"));
        const contextRows = [...wrapper.querySelectorAll(".local-mr-context-decoration")];
        return {
            hasContextUrl: Boolean(JSON.parse(
                document.getElementById("local-mr-version-data").textContent,
            ).contextUrl),
            titles: [...wrapper.querySelectorAll(".local-mr-context-button")]
                .map((button) => button.title),
            secondHunkDirections: [...secondHunk.querySelectorAll(".local-mr-context-button")]
                .map((button) => button.dataset.direction),
            hunkMetrics: contextRows.map((row) => ({
                height: Math.round(row.getBoundingClientRect().height),
                display: getComputedStyle(row).display,
                gutterHeight: Math.round(row.cells[0].getBoundingClientRect().height),
                gutterDisplay: getComputedStyle(row.cells[0]).display,
                controlsHeight: Math.round(row.querySelector(".local-mr-context-controls").getBoundingClientRect().height),
                cellPadding: getComputedStyle(row.cells[1]).padding,
                cellDisplay: getComputedStyle(row.cells[1]).display,
                contentHeight: Math.round(row.cells[1].firstElementChild.getBoundingClientRect().height),
                buttonHeights: [...row.querySelectorAll(".local-mr-context-controls .local-mr-context-button")]
                    .map((button) => Math.round(button.getBoundingClientRect().height)),
            })),
        };
    })()`);
    if (process.env.LOCAL_MR_CONTEXT_SCREENSHOT) {
        await command("Page.enable");
        await command("Emulation.setDeviceMetricsOverride", {
            width: 1600,
            height: 1000,
            deviceScaleFactor: 1,
            mobile: false,
        });
        await delay(120);
        const screenshot = await command("Page.captureScreenshot", {
            format: "png",
            captureBeyondViewport: false,
        });
        fs.writeFileSync(
            process.env.LOCAL_MR_CONTEXT_SCREENSHOT,
            Buffer.from(screenshot.data, "base64"),
        );
    }
    await evaluate(String.raw`(() => {
        const wrapper = document.querySelector(".d2h-file-wrapper:not([hidden])");
        const secondHunk = [...wrapper.querySelectorAll("tr")]
            .find((row) => row.textContent.includes("@@ -47,7 +47,7 @@"));
        secondHunk.querySelector('.local-mr-context-button[data-direction="all"]').click();
    })()`);
    await waitFor(
        "Boolean(document.querySelector('.d2h-file-wrapper:not([hidden]) .local-mr-expanded-context[data-old-line=" + '"9"' + "]'))"
            + " && Boolean(document.querySelector('.d2h-file-wrapper:not([hidden]) .local-mr-expanded-context[data-old-line=" + '"46"' + "]'))",
        "whole internal context region",
    );
    await evaluate(String.raw`(() => {
        const wrapper = document.querySelector(".d2h-file-wrapper:not([hidden])");
        const firstHunk = [...wrapper.querySelectorAll("tr")]
            .find((row) => row.textContent.includes("@@ -2,7 +2,7 @@"));
        firstHunk.querySelector('.local-mr-context-button[data-direction="all"]').click();
    })()`);
    await waitFor(
        "Boolean(document.querySelector('.d2h-file-wrapper:not([hidden]) .local-mr-expanded-context[data-old-line=" + '"1"' + "]'))",
        "leading context region",
    );
    for (let click = 0; click < 3; click += 1) {
        await evaluate(String.raw`document.querySelector(
            ".d2h-file-wrapper:not([hidden]) .local-mr-context-footer .local-mr-context-button",
        ).click()`);
        await delay(120);
    }
    await waitFor(
        "!document.querySelector('.d2h-file-wrapper:not([hidden]) .local-mr-context-footer')",
        "end of file context",
    );
    const expanded = await evaluate(String.raw`(() => {
        const wrapper = document.querySelector(".d2h-file-wrapper:not([hidden])");
        const expandedRows = [...wrapper.querySelectorAll(".local-mr-expanded-context")];
        const resources = performance.getEntriesByType("resource")
            .filter((entry) => entry.name.includes("/diff-context"));
        return {
            expandedCount: expandedRows.length,
            firstText: wrapper.querySelector('[data-old-line="1"] .d2h-code-line-ctn')?.textContent,
            middleText: wrapper.querySelector('[data-old-line="30"] .d2h-code-line-ctn')?.textContent,
            lastText: wrapper.querySelector('[data-old-line="100"] .d2h-code-line-ctn')?.textContent,
            contextRequestCount: resources.length,
            hunkLabels: [...wrapper.querySelectorAll(
                ".d2h-info .d2h-code-side-line, .d2h-info .d2h-code-line",
            )].map((line) => line.textContent.trim()).filter((line) => line.includes("@@")),
        };
    })()`);
    const controlsFor = async (fileName) => {
        const id = await evaluate(`(() => {
            const link = [...document.querySelectorAll('.d2h-file-list-line .d2h-file-name')]
                .find((candidate) => candidate.title === ${JSON.stringify(fileName)});
            link.click();
            return link.hash.slice(1);
        })()`);
        await waitFor(
            `document.querySelector('.d2h-file-wrapper:not([hidden])')?.id === ${JSON.stringify(id)}`,
            `${fileName} diff`,
        );
        return evaluate("document.querySelectorAll('.d2h-file-wrapper:not([hidden]) .local-mr-context-button').length");
    };
    const addedControls = await controlsFor("added.txt");
    const deletedControls = await controlsFor("deleted.txt");
    const emptyControls = await controlsFor("empty.txt");
    await delay(300);
    const emptyHasFooter = await evaluate(
        "Boolean(document.querySelector('.d2h-file-wrapper:not([hidden]) .local-mr-context-footer'))",
    );
    const endControls = await controlsFor("end.txt");
    await delay(300);
    const endHasFooter = await evaluate(
        "Boolean(document.querySelector('.d2h-file-wrapper:not([hidden]) .local-mr-context-footer'))",
    );
    socket.close();

    const checks = {
        "context endpoint is advertised": initial.hasContextUrl,
        "small, large, and trailing gaps expose context controls": initial.titles.length === 5
            && initial.titles.filter((title) => title === "Expand this section").length === 2
            && initial.titles.filter((title) => title === "Expand 20 lines downward").length === 2
            && initial.titles.filter((title) => title === "Expand 20 lines upward").length === 1,
        "large internal gaps offer down, up, and all actions": initial.secondHunkDirections.join(",")
            === "down,up,all",
        "context controls remain compact": initial.hunkMetrics.every((metric) => metric.height <= 32),
        "expanded lines preserve content and cover the whole file": expanded.expandedCount === 86
            && expanded.firstText === "base line 1"
            && expanded.middleText === "base line 30"
            && expanded.lastText === "base line 100"
            && expanded.hunkLabels.some((label) => label.startsWith("@@ -1,8 +1,8 @@"))
            && expanded.hunkLabels.some((label) => label.startsWith("@@ -9,92 +9,92 @@")),
        "each expansion fetches only its requested range": expanded.contextRequestCount === 5,
        "added and deleted files do not expose expansion": addedControls === 0 && deletedControls === 0,
        "modified files with an empty base have no invalid expansion": emptyControls === 0
            && !emptyHasFooter,
        "files whose last hunk reaches EOF have no trailing control": endControls === 1 && !endHasFooter,
    };
    console.log(JSON.stringify({
        layout,
        initial,
        expanded,
        addedControls,
        deletedControls,
        emptyControls,
        emptyHasFooter,
        endControls,
        endHasFooter,
        checks,
    }, null, 2));
    if (Object.values(checks).some((passed) => !passed)) process.exitCode = 1;
} finally {
    chrome?.kill("SIGTERM");
    await delay(150);
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
