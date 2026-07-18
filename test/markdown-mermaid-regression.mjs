import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { openChromePage } from "./helpers/chrome.mjs";
import { localMr } from "./helpers/paths.mjs";

const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "local-mr-markdown-test-"));
const repoRoot = path.join(tempDirectory, "repo");
const outputFile = path.join(tempDirectory, "review.html");
const profile = path.join(tempDirectory, "chrome");
const port = 9336;
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
let browser;
let reviewUrl = "";

const git = (args, options = {}) => execFileSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, ...options.env },
}).trim();

try {
    fs.mkdirSync(repoRoot, { recursive: true });
    git(["init", "--initial-branch=main"]);
    git(["config", "user.name", "Local MR Test"]);
    git(["config", "user.email", "local-mr@example.invalid"]);
    fs.writeFileSync(path.join(repoRoot, "README.md"), "# Fixture\n");
    fs.mkdirSync(path.join(repoRoot, "docs"), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, "docs", "old-design.md"), [
        "# Message flow",
        "",
        "| Stage | Owner |",
        "| --- | --- |",
        "| Send | Producer |",
        "",
        "```mermaid",
        "flowchart LR",
        "    Producer --> Consumer",
        "```",
        "",
        "```mermaid",
        "this is not valid mermaid",
        "```",
        "",
        "<script>window.__localMrPreviewXss = true</script>",
        "",
    ].join("\n"));
    fs.writeFileSync(path.join(repoRoot, "docs", "deleted.md"), "# Deleted document\n");
    git(["add", "README.md", "docs/old-design.md", "docs/deleted.md"]);
    git(["commit", "-m", "base"]);
    git(["switch", "-c", "feature/markdown-preview"]);
    git(["mv", "docs/old-design.md", "docs/design.md"]);
    git(["rm", "docs/deleted.md"]);
    fs.writeFileSync(path.join(repoRoot, "docs", "architecture → v2.md"), "# Literal arrow filename\n");
    const output = execFileSync(localMr, ["main", "--no-open", "--dark", "--line", "-o", outputFile], {
        cwd: repoRoot,
        encoding: "utf8",
        env: {
            ...process.env,
            LOCAL_MR_SERVER_IDLE_MINUTES: "1",
            XDG_STATE_HOME: path.join(tempDirectory, "state"),
        },
    });
    reviewUrl = output.match(/^Review: (.+)$/m)?.[1] || "";
    if (!reviewUrl) throw new Error(`local-mr did not print a review URL:\n${output}`);

    browser = await openChromePage({
        url: reviewUrl,
        profile,
        debuggingPort: port,
    });
    const { command, evaluate, waitFor } = browser;
    await waitFor("document.readyState === 'complete' && document.documentElement.classList.contains('local-mr-ready')", "review UI");
    const markdownId = await evaluate(String.raw`(() => {
        const link = [...document.querySelectorAll(".d2h-file-list-line .d2h-file-name")]
            .find((candidate) => candidate.title.includes("design.md"));
        if (!link) throw new Error("Markdown fixture is missing from the changed file tree");
        link.click();
        return link.hash.slice(1);
    })()`);
    await waitFor(
        `document.querySelector('.d2h-file-wrapper:not([hidden])')?.id === ${JSON.stringify(markdownId)}`,
        "Markdown diff fragment",
    );
    await evaluate("document.querySelector('.d2h-file-wrapper:not([hidden]) .local-mr-preview-toggle').click()");
    await waitFor("Boolean(document.querySelector('.local-mr-markdown-body, .local-mr-preview-error'))", "Markdown preview");
    await waitFor(String.raw`(() => {
        const diagrams = [...document.querySelectorAll('.local-mr-mermaid')];
        return diagrams.length === 2
            && diagrams.every((diagram) => diagram.querySelector('svg')
                || diagram.classList.contains('local-mr-preview-error'));
    })()`, "Mermaid rendering");
    const result = await evaluate(String.raw`(() => {
        const wrapper = document.querySelector(".d2h-file-wrapper:not([hidden])");
        const article = wrapper.querySelector(".local-mr-markdown-body");
        return {
            hasHeading: Boolean(article?.querySelector("h1")),
            hasTable: Boolean(article?.querySelector("table")),
            hasMermaidSvg: Boolean(article?.querySelector(".local-mr-mermaid svg")),
            mermaidText: [...(article?.querySelectorAll(".local-mr-mermaid .nodeLabel") || [])]
                .map((label) => label.textContent)
                .join(" "),
            mermaidErrorCount: wrapper.querySelectorAll(".local-mr-mermaid.local-mr-preview-error").length,
            hasPagePreviewError: Boolean(wrapper.querySelector(".local-mr-markdown-preview > .local-mr-preview-error")),
            hasInjectedScript: Boolean(article?.querySelector("script")),
            xssExecuted: window.__localMrPreviewXss === true,
            darkMode: document.body.classList.contains("local-mr-dark"),
            renamedPath: [...document.querySelectorAll(".d2h-file-list-line .d2h-file-name")]
                .find((link) => link.title.includes("old-design.md"))?.title || "",
        };
    })()`);
    const literalArrowSetup = await evaluate(String.raw`(() => {
        const links = [...document.querySelectorAll(".d2h-file-list-line .d2h-file-name")];
        const link = links
            .find((candidate) => candidate.title === "docs/architecture → v2.md");
        if (!link) return { found: false, titles: links.map((candidate) => candidate.title) };
        link.click();
        return { found: true, targetId: link.hash.slice(1), titles: links.map((candidate) => candidate.title) };
    })()`);
    if (!literalArrowSetup.found) {
        throw new Error(`literal arrow fixture failed: ${JSON.stringify(literalArrowSetup)}`);
    }
    await waitFor(
        `document.querySelector('.d2h-file-wrapper:not([hidden])')?.id === ${JSON.stringify(literalArrowSetup.targetId)}`,
        "literal arrow diff fragment",
    );
    const literalHasToggle = await evaluate(String.raw`(() => {
        const toggle = document.querySelector(".d2h-file-wrapper:not([hidden]) .local-mr-preview-toggle");
        toggle?.click();
        return Boolean(toggle);
    })()`);
    if (!literalHasToggle) throw new Error("literal arrow Markdown preview toggle is missing");
    await waitFor(
        "Boolean(document.querySelector('.d2h-file-wrapper:not([hidden]) .local-mr-markdown-body, .d2h-file-wrapper:not([hidden]) .local-mr-preview-error'))",
        "literal arrow Markdown preview",
    );
    const literalArrowResult = await evaluate(String.raw`(() => {
        const wrapper = document.querySelector(".d2h-file-wrapper:not([hidden])");
        return {
            heading: wrapper.querySelector(".local-mr-markdown-body h1")?.textContent || "",
            error: wrapper.querySelector(".local-mr-preview-error")?.textContent || "",
        };
    })()`);
    const deletedId = await evaluate(String.raw`(() => {
        const link = [...document.querySelectorAll(".d2h-file-list-line .d2h-file-name")]
            .find((candidate) => candidate.title === "docs/deleted.md");
        if (!link) throw new Error("deleted Markdown fixture is missing");
        link.click();
        return link.hash.slice(1);
    })()`);
    await waitFor(
        `document.querySelector('.d2h-file-wrapper:not([hidden])')?.id === ${JSON.stringify(deletedId)}`,
        "deleted Markdown diff fragment",
    );
    const deletedResult = await evaluate(String.raw`(() => {
        const wrapper = document.querySelector(".d2h-file-wrapper:not([hidden])");
        return { hasPreviewToggle: Boolean(wrapper.querySelector(".local-mr-preview-toggle")) };
    })()`);
    if (process.env.LOCAL_MR_MERMAID_SCREENSHOT) {
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
            process.env.LOCAL_MR_MERMAID_SCREENSHOT,
            Buffer.from(screenshot.data, "base64"),
        );
    }
    const checks = {
        "Markdown headings and tables render": result.hasHeading && result.hasTable,
        "Mermaid code fences render as SVG": result.hasMermaidSvg
            && result.mermaidText.includes("Producer")
            && result.mermaidText.includes("Consumer"),
        "Markdown HTML is sanitized before insertion": !result.hasInjectedScript && !result.xssExecuted,
        "one invalid Mermaid diagram does not break the document": result.mermaidErrorCount === 1
            && !result.hasPagePreviewError,
        "Mermaid preview follows dark mode": result.darkMode,
        "renamed Markdown previews the selected right-side path": result.renamedPath.includes("old-design.md")
            && result.renamedPath.includes("design.md")
            && result.hasHeading,
        "literal arrow filenames are not mistaken for renames": literalArrowResult.heading === "Literal arrow filename"
            && literalArrowResult.error === "",
        "deleted Markdown does not expose a broken right-side preview": !deletedResult.hasPreviewToggle,
    };
    console.log(JSON.stringify({ reviewUrl, result, literalArrowResult, deletedResult, checks }, null, 2));
    if (Object.values(checks).some((passed) => !passed)) process.exitCode = 1;
} finally {
    browser?.close();
    if (reviewUrl) {
        try {
            const healthUrl = new URL(reviewUrl);
            healthUrl.pathname = healthUrl.pathname.replace(/\/review$/, "/health");
            const health = await fetch(healthUrl).then((response) => response.json());
            process.kill(health.pid, "SIGTERM");
        } catch {}
    }
    await delay(150);
    fs.rmSync(tempDirectory, { recursive: true, force: true });
}
