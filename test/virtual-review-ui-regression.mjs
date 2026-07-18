import { execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { openChromePage } from "./helpers/chrome.mjs";
import { localMr } from "./helpers/paths.mjs";
import { printPublicTestReport } from "./helpers/public-report.mjs";

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "local-mr-virtual-browser-"));
const repoRoot = path.join(temporaryRoot, "repo");
const profile = path.join(temporaryRoot, "chrome");
const stateRoot = path.join(temporaryRoot, "state");
const runtimeRoot = path.join(temporaryRoot, "runtime");
const environment = {
    ...process.env,
    LOCAL_MR_VIRTUAL_STATE_DIR: stateRoot,
    XDG_RUNTIME_DIR: runtimeRoot,
    LOCAL_MR_SERVER_IDLE_MINUTES: "1",
};
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const realCommitSubject = "Implement shared review fixture";
const realCommitBody = "Exercise the real commit message body in the shared Diff workspace.";
const reviewUrls = [];
let browser;
let realReviewUrl = "";
let liveRealReviewUrl = "";

const git = (arguments_) => execFileSync("git", arguments_, {
    cwd: repoRoot,
    env: environment,
    encoding: "utf8",
}).trim();

const localVirtual = (arguments_, input) => JSON.parse(execFileSync(
    localMr,
    ["virtual-commit", ...arguments_],
    {
        cwd: repoRoot,
        env: environment,
        encoding: "utf8",
        input,
        maxBuffer: 64 * 1024 * 1024,
    },
));

const localReal = (arguments_) => execFileSync(localMr, arguments_, {
    cwd: repoRoot,
    env: environment,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
});

const availablePort = () => new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
        const { port } = server.address();
        server.close((error) => error ? reject(error) : resolve(port));
    });
});

const manifestFor = (source, { title, prefix }) => {
    const production = source.files.find((file) => file.displayPath === "src/app.mjs");
    const coverage = source.files.find((file) => file.displayPath === "test/app.test.mjs");
    const markdown = source.files.find((file) => file.displayPath === "README.md");
    if (
        !production
        || production.blocks.length !== 2
        || !coverage
        || coverage.blocks.length !== 1
        || !markdown
        || markdown.blocks.length === 0
    ) {
        throw new Error(`Unexpected virtual source catalog: ${JSON.stringify(source.files)}`);
    }
    const first = [production.blocks[0].id];
    const second = [
        production.blocks[1].id,
        coverage.blocks[0].id,
        ...markdown.blocks.map((block) => block.id),
    ];
    return {
        schemaVersion: 1,
        title,
        strategy: "Review the primary behavior before the secondary path and coverage.",
        overview: {
            summary: "A frozen, browser-tested virtual review route.",
            routeRationale: "The behavior with the highest review value is isolated first.",
            uncertainties: [],
        },
        virtualCommits: [first, second].map((blocks, index) => ({
            title: `${prefix} ${index + 1}`,
            intent: index === 0
                ? "Review the primary behavior in isolation."
                : "Review the secondary behavior together with coverage and documentation.",
            reviewFocus: [{
                text: "Confirm that this focused change matches the intended behavior.",
                targets: [`block:${blocks[0]}`],
            }],
            risk: {
                level: index === 0 ? "high" : "medium",
                reason: index === 0
                    ? "This production behavior is the first review checkpoint."
                    : "This completes the frozen comparison.",
            },
            blocks,
        })),
    };
};

const workspaceReady = (mode) => String.raw`(() => {
    const node = document.getElementById("local-mr-version-data");
    if (!node?.textContent.trim()) return false;
    const data = JSON.parse(node.textContent);
    const visible = [...document.querySelectorAll("#diff > .d2h-wrapper .d2h-file-wrapper")]
        .filter((wrapper) => !wrapper.hidden && getComputedStyle(wrapper).display !== "none");
    return data.mode === ${JSON.stringify(mode)}
        && data.selection?.mode === ${JSON.stringify(mode)}
        && data.reviewNavigation?.active === "virtual"
        && document.documentElement.dataset.localMrDiffWorkspace === "review-ui-v1"
        && document.documentElement.classList.contains("local-mr-ready")
        && document.getElementById("diff")?.hasAttribute("data-local-mr-diff-workspace")
        && document.querySelector("[data-local-mr-file-tree]")
        && document.querySelector("[data-local-mr-file-detail]")
        && document.querySelector(".local-mr-version-bar")
        && visible.length === 1;
})()`;

try {
    fs.mkdirSync(path.join(repoRoot, "src"), { recursive: true });
    fs.mkdirSync(path.join(repoRoot, "test"), { recursive: true });
    git(["init", "-q", "-b", "main"]);
    git(["config", "user.name", "Local MR Browser Test"]);
    git(["config", "user.email", "local-mr@example.invalid"]);
    fs.writeFileSync(path.join(repoRoot, "README.md"), "# Old preview\nOld documentation.\n");
    fs.writeFileSync(path.join(repoRoot, "src", "app.mjs"), [
        "export function primary() {",
        "    return 'CORE_OLD';",
        "}",
        "",
        "const spacer1 = 1;",
        "const spacer2 = 2;",
        "const spacer3 = 3;",
        "const spacer4 = 4;",
        "const spacer5 = 5;",
        "const spacer6 = 6;",
        "const spacer7 = 7;",
        "",
        "export function secondary() {",
        "    return 'SECONDARY_OLD';",
        "}",
        "",
    ].join("\n"));
    git(["add", "."]);
    git(["commit", "-qm", "base"]);
    git(["switch", "-qc", "feature/virtual-browser"]);
    fs.writeFileSync(path.join(repoRoot, "README.md"), "# Shared preview\nPreview **works**.\n");
    fs.writeFileSync(path.join(repoRoot, "src", "app.mjs"), [
        "export function primary() {",
        "    return 'CORE_NEW';",
        "}",
        "",
        "const spacer1 = 1;",
        "const spacer2 = 2;",
        "const spacer3 = 3;",
        "const spacer4 = 4;",
        "const spacer5 = 5;",
        "const spacer6 = 6;",
        "const spacer7 = 7;",
        "",
        "export function secondary() {",
        "    return 'SECONDARY_NEW';",
        "}",
        "",
    ].join("\n"));
    fs.writeFileSync(path.join(repoRoot, "test", "app.test.mjs"), [
        "import assert from 'node:assert/strict';",
        "import { primary } from '../src/app.mjs';",
        "assert.equal(primary(), 'CORE_NEW'); // COVERAGE_SENTINEL",
        "",
    ].join("\n"));
    git(["add", "."]);
    git(["commit", "-q", "-m", realCommitSubject, "-m", realCommitBody]);
    const reviewCommitSha = git(["rev-parse", "HEAD"]);
    git(["commit", "--allow-empty", "-qm", "advance branch after the initial review source"]);
    const newerBranchCommitSha = git(["rev-parse", "HEAD"]);

    const initialSnapshot = localVirtual(["snapshot", "--target", "main"]);
    const snapshot = localVirtual([
        "snapshot",
        "--target", "main",
        "--mode", "range",
        "--from", reviewCommitSha,
        "--to", reviewCommitSha,
    ]);
    const revisionOne = localVirtual([
        "create",
        initialSnapshot.source.sourceId,
        "--no-open",
    ], JSON.stringify(manifestFor(initialSnapshot.source, {
        title: "Initial virtual route",
        prefix: "Initial checkpoint",
    })));
    reviewUrls.push(revisionOne.reviewUrl);
    const revisionTwo = localVirtual([
        "create",
        snapshot.source.sourceId,
        "--review",
        revisionOne.reviewId,
        "--expected-revision",
        "1",
        "--no-open",
    ], JSON.stringify(manifestFor(snapshot.source, {
        title: "Revised virtual route",
        prefix: "Revised checkpoint",
    })));
    reviewUrls.push(revisionTwo.reviewUrl);

    fs.appendFileSync(
        path.join(repoRoot, "test", "app.test.mjs"),
        "// LIVE_REPOSITORY_DRIFT_MUST_NOT_ENTER_FROZEN_REAL\n",
    );
    fs.mkdirSync(path.join(repoRoot, "fixtures", "live-branch"), { recursive: true });
    fs.writeFileSync(
        path.join(repoRoot, "fixtures", "live-branch", "live_only_fixture.txt"),
        "LIVE_ONLY_FIXTURE_SENTINEL\n",
    );
    git(["add", "."]);
    git(["commit", "-qm", "advance live repository after frozen virtual source"]);
    const liveBranchCommitSha = git(["rev-parse", "HEAD"]);

    const liveRealOutput = localReal([
        "main",
        "--no-open",
        "--output",
        path.join(temporaryRoot, "live-real.html"),
    ]);
    liveRealReviewUrl = liveRealOutput.match(/^Review: (.+)$/m)?.[1] || "";
    if (!liveRealReviewUrl) throw new Error(`Live Real review URL is missing:\n${liveRealOutput}`);

    browser = await openChromePage({
        url: revisionTwo.reviewUrl,
        profile,
        debuggingPort: await availablePort(),
    });
    const { command, evaluate, waitFor } = browser;
    await waitFor(workspaceReady("single"), "Virtual V1 workspace on /review");

    const panel = () => evaluate(String.raw`(() => {
        const data = JSON.parse(document.getElementById("local-mr-version-data").textContent);
        const links = [...document.querySelectorAll(".d2h-file-list-line .d2h-file-name")];
        const wrappers = [...document.querySelectorAll("#diff > .d2h-wrapper .d2h-file-wrapper")];
        const visible = wrappers.filter((wrapper) => !wrapper.hidden && getComputedStyle(wrapper).display !== "none");
        const visibleWrapper = visible[0];
        return {
            mode: data.mode,
            selection: data.selection,
            paths: data.files.map((file) => file.displayPath || file.path).sort(),
            treePaths: links.map((link) => link.title).sort(),
            commitCount: data.commits.length,
            selectedCommitSubject: data.commits.find((commit) => (
                commit.sha === data.selection.from && commit.sha === data.selection.to
            ))?.subject || "",
            wrapperCount: wrappers.length,
            visibleWrapperCount: visible.length,
            activePath: document.querySelector(
                ".d2h-file-list-line.local-mr-active .d2h-file-name",
            )?.title || "",
            visibleText: visibleWrapper?.textContent || "",
            syntaxLanguage: visibleWrapper?.dataset.lang || "",
            syntaxLineCount: visibleWrapper?.querySelectorAll(".d2h-code-line-ctn.hljs").length || 0,
            syntaxKeywordCount: visibleWrapper?.querySelectorAll(".hljs-keyword").length || 0,
            syntaxFunctionCount: visibleWrapper?.querySelectorAll(".hljs-title.function_, .hljs-title").length || 0,
            workspace: document.documentElement.dataset.localMrDiffWorkspace || "",
            hasRevisionControl: Boolean(document.querySelector(".local-mr-virtual-revision")),
            hasVirtualProgress: Boolean(document.querySelector(".local-mr-virtual-progress")),
            virtualActions: [...document.querySelectorAll("[data-virtual-action]")]
                .map((element) => element.dataset.virtualAction).sort(),
        };
    })()`);

    const selectFile = async (filePath, presentMarkers, absentMarkers, label) => {
        await evaluate(`(() => {
            const link = [...document.querySelectorAll('.d2h-file-list-line .d2h-file-name')]
                .find((candidate) => candidate.title === ${JSON.stringify(filePath)});
            if (!link) throw new Error(${JSON.stringify(`${filePath} is missing from the changed-file tree`)});
            link.click();
        })()`);
        await waitFor(`(() => {
            const active = document.querySelector('.d2h-file-list-line.local-mr-active .d2h-file-name');
            const visible = [...document.querySelectorAll('#diff > .d2h-wrapper .d2h-file-wrapper')]
                .filter((wrapper) => !wrapper.hidden && getComputedStyle(wrapper).display !== 'none');
            const text = visible[0]?.textContent || '';
            return active?.title === ${JSON.stringify(filePath)}
                && visible.length === 1
                && ${JSON.stringify(presentMarkers)}.every((marker) => text.includes(marker))
                && ${JSON.stringify(absentMarkers)}.every((marker) => !text.includes(marker))
                && !document.querySelector('#diff > .d2h-wrapper')?.classList.contains('local-mr-fragment-loading');
        })()`, label);
        return panel();
    };

    const switchMode = async (label, mode) => {
        await evaluate(`(() => {
            const control = document.querySelector('.local-mr-version-mode');
            control.querySelector('.local-mr-version-trigger').click();
            const option = [...control.querySelectorAll('.local-mr-version-option')]
                .find((candidate) => candidate.textContent.trim() === ${JSON.stringify(label)});
            if (!option) throw new Error(${JSON.stringify(`${label} mode is missing`)});
            option.click();
        })()`);
        await waitFor(workspaceReady(mode), `${label} mode`);
    };

    const selectCommit = async (subject) => {
        const sha = await evaluate(`(() => {
            const data = JSON.parse(document.getElementById('local-mr-version-data').textContent);
            const commit = data.commits.find((candidate) => candidate.subject === ${JSON.stringify(subject)});
            if (!commit) throw new Error(${JSON.stringify(`${subject} is missing`)});
            const range = document.querySelector('.local-mr-commit-range');
            range.querySelector('.local-mr-version-trigger').click();
            const option = [...range.querySelectorAll('.local-mr-commit-option')]
                .find((candidate) => candidate.textContent.includes(${JSON.stringify(subject)}));
            if (!option) throw new Error(${JSON.stringify(`${subject} option is missing`)});
            option.click();
            return commit.sha;
        })()`);
        await waitFor(`(() => {
            const node = document.getElementById('local-mr-version-data');
            if (!node?.textContent.trim()) return false;
            const data = JSON.parse(node.textContent);
            return data.mode === 'single'
                && data.selection.from === ${JSON.stringify(sha)}
                && data.selection.to === ${JSON.stringify(sha)}
                && document.documentElement.classList.contains('local-mr-ready');
        })()`, subject);
        return sha;
    };

    const landing = await evaluate(String.raw`(() => {
        const data = JSON.parse(document.getElementById("local-mr-version-data").textContent);
        const mode = document.querySelector(".local-mr-version-mode");
        mode.querySelector(".local-mr-version-trigger").click();
        const modeOptions = [...mode.querySelectorAll(".local-mr-version-option")]
            .map((option) => option.textContent.trim());
        mode.querySelector(".local-mr-version-trigger").click();
        const sourceWarning = document.querySelector("[data-review-source-warning]");
        const virtualSource = document.querySelector('[data-review-source="virtual"]');
        return {
            pathname: location.pathname,
            revisionParameter: new URL(location.href).searchParams.get("revision"),
            mode: data.mode,
            selection: data.selection,
            navigation: data.reviewNavigation,
            commits: data.commits.map((commit) => ({ sha: commit.sha, subject: commit.subject })),
            revision: data.virtualSession?.revision || null,
            revisions: (data.virtualSession?.revisions || []).map((item) => ({
                revision: item.revision,
                label: item.label,
                branchCommit: item.branchCommit,
            })),
            revisionTrigger: document.querySelector(
                '.local-mr-virtual-revision .local-mr-version-trigger-label'
            )?.textContent || '',
            revisionOptions: [...document.querySelectorAll(
                '.local-mr-virtual-revision .local-mr-version-option'
            )].map((option) => ({
                revision: option.dataset.revision || '',
                branchCommit: option.dataset.branchCommit || '',
                text: option.textContent.trim(),
            })),
            sourceWarning: sourceWarning ? {
                text: sourceWarning.textContent.trim(),
                state: sourceWarning.dataset.reviewSourceState || "",
                sourceCommit: sourceWarning.dataset.sourceCommit || "",
                currentCommit: sourceWarning.dataset.currentCommit || "",
                display: getComputedStyle(sourceWarning).display,
            } : null,
            virtualSource: virtualSource ? {
                tag: virtualSource.tagName,
                state: virtualSource.dataset.reviewSourceState || "",
                available: virtualSource.dataset.reviewSourceAvailable || "",
                text: virtualSource.textContent.trim(),
                hasHref: virtualSource.hasAttribute("href"),
            } : null,
            modeOptions,
        };
    })()`);

    const firstCommitSha = landing.commits.find((commit) => (
        commit.subject === "Revised checkpoint 1"
    ))?.sha;
    if (!firstCommitSha) throw new Error("Revised checkpoint 1 is missing from the landing page");
    const firstCommit = await selectFile(
        "src/app.mjs",
        ["CORE_NEW"],
        ["SECONDARY_NEW", "COVERAGE_SENTINEL"],
        "default single virtual commit V1",
    );

    await switchMode("Commit range", "range");
    const aggregateInitial = await panel();
    const aggregateProduction = await selectFile(
        "src/app.mjs",
        ["CORE_NEW", "SECONDARY_NEW"],
        [],
        "aggregate production diff",
    );
    await selectFile("test/app.test.mjs", ["COVERAGE_SENTINEL"], [], "aggregate coverage diff");
    await selectFile("README.md", ["Shared preview"], [], "aggregate Markdown diff");

    await switchMode("Single commit", "single");
    const secondCommitSha = await selectCommit("Revised checkpoint 2");
    const secondCommitInitial = await panel();
    const secondProduction = await selectFile(
        "src/app.mjs",
        ["SECONDARY_NEW"],
        ["CORE_NEW", "COVERAGE_SENTINEL"],
        "single virtual commit V2 production",
    );
    await selectFile("README.md", ["Shared preview"], ["CORE_NEW"], "single virtual commit V2 Markdown");
    const secondCoverage = await selectFile(
        "test/app.test.mjs",
        ["COVERAGE_SENTINEL"],
        ["SECONDARY_NEW"],
        "single virtual commit V2 coverage",
    );

    await switchMode("Commit range", "range");
    const aggregateRestored = await selectFile(
        "src/app.mjs",
        ["CORE_NEW", "SECONDARY_NEW"],
        [],
        "aggregate diff restored",
    );

    await switchMode("Single commit", "single");
    await selectCommit("Revised checkpoint 2");
    await selectFile(
        "test/app.test.mjs",
        ["COVERAGE_SENTINEL"],
        ["SECONDARY_NEW"],
        "V2 coverage restored",
    );

    const sharedWorkspaceSnapshot = () => evaluate(String.raw`(() => {
        const visible = [...document.querySelectorAll("#diff > .d2h-wrapper .d2h-file-wrapper")]
            .find((wrapper) => !wrapper.hidden && getComputedStyle(wrapper).display !== "none");
        const normalizeText = (value) => value.replace(/\s+/g, " ").trim();
        const normalizeNode = (node) => {
            if (node.nodeType === Node.TEXT_NODE) {
                const text = normalizeText(node.textContent || "");
                return text ? ["#text", text] : null;
            }
            if (node.nodeType !== Node.ELEMENT_NODE) return null;
            const attributes = {};
            ["colspan", "rowspan", "role"].forEach((name) => {
                if (node.hasAttribute(name)) attributes[name] = node.getAttribute(name);
            });
            if (node.hidden) attributes.hidden = true;
            return [
                node.tagName.toLowerCase(),
                [...node.classList].sort(),
                attributes,
                [...node.childNodes].map(normalizeNode).filter(Boolean),
            ];
        };
        const fingerprint = (value) => {
            let hash = 2166136261;
            for (let index = 0; index < value.length; index += 1) {
                hash ^= value.charCodeAt(index);
                hash = Math.imul(hash, 16777619);
            }
            return (hash >>> 0).toString(16).padStart(8, "0");
        };
        const styleNode = document.getElementById("local-mr-review-ui");
        const scriptNode = document.getElementById("local-mr-review-behaviour");
        const styleFor = (selector) => {
            const element = visible?.querySelector(selector);
            if (!element) return null;
            const style = getComputedStyle(element);
            return {
                display: style.display,
                fontFamily: style.fontFamily,
                fontSize: style.fontSize,
                lineHeight: style.lineHeight,
                whiteSpace: style.whiteSpace,
                color: style.color,
                backgroundColor: style.backgroundColor,
                borderColor: style.borderColor,
            };
        };
        return {
            workspace: document.documentElement.dataset.localMrDiffWorkspace || "",
            activePath: document.querySelector(
                ".d2h-file-list-line.local-mr-active .d2h-file-name",
            )?.title || "",
            styleAsset: [styleNode?.textContent.length || 0, fingerprint(styleNode?.textContent || "")],
            scriptAsset: [scriptNode?.textContent.length || 0, fingerprint(scriptNode?.textContent || "")],
            wrapperClasses: [...visible?.classList || []].sort(),
            splitClasses: [...visible?.querySelector(".local-mr-split-diff")?.classList || []].sort(),
            tableClasses: [...visible?.querySelector(".local-mr-split-table")?.classList || []].sort(),
            splitCount: visible?.querySelectorAll(".local-mr-split-diff").length || 0,
            independentSidePanes: visible?.querySelectorAll(".d2h-file-side-diff").length || 0,
            dom: JSON.stringify(normalizeNode(visible)),
            computed: {
                header: styleFor(".d2h-file-header"),
                table: styleFor(".local-mr-split-table"),
                code: styleFor(".d2h-code-line-ctn"),
                lineNumber: styleFor(".d2h-code-side-linenumber"),
            },
        };
    })()`);

    const commitMessageSnapshot = () => evaluate(String.raw`(() => {
        const root = document.querySelector("[data-local-mr-commit-message]");
        const title = root?.querySelector(".local-mr-commit-message-title");
        const body = root?.querySelector(".local-mr-commit-message-body");
        const diff = document.getElementById("diff");
        const style = root ? getComputedStyle(root) : null;
        return {
            found: Boolean(root),
            kind: root?.dataset.kind || "",
            title: title?.textContent.trim() || "",
            body: body?.textContent.trim() || "",
            rootTag: root?.tagName || "",
            rootClasses: [...root?.classList || []].sort(),
            titleTag: title?.tagName || "",
            titleClasses: [...title?.classList || []].sort(),
            bodyTag: body?.tagName || "",
            bodyClasses: [...body?.classList || []].sort(),
            style: style ? {
                display: style.display,
                padding: style.padding,
                borderColor: style.borderColor,
                borderRadius: style.borderRadius,
                backgroundColor: style.backgroundColor,
                color: style.color,
                fontFamily: style.fontFamily,
            } : null,
            beforeDiff: Boolean(root && diff)
                && Boolean(root.compareDocumentPosition(diff) & Node.DOCUMENT_POSITION_FOLLOWING),
        };
    })()`);

    const virtualShared = await sharedWorkspaceSnapshot();
    const virtualCommitMessage = await commitMessageSnapshot();
    const virtualReturnUrl = await evaluate("location.href");
    const virtualNavigation = await evaluate(String.raw`(() => {
        const data = JSON.parse(document.getElementById("local-mr-version-data").textContent);
        const real = document.querySelector('[data-review-source="real"]');
        const virtual = document.querySelector('[data-review-source="virtual"]');
        real?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
        return {
            navigation: data.reviewNavigation,
            realHref: real?.href || "",
            activeReal: real?.getAttribute("aria-current") || "",
            activeVirtual: virtual?.getAttribute("aria-current") || "",
        };
    })()`);
    const bridgeResponse = await fetch(virtualNavigation.realHref, { redirect: "manual" });
    realReviewUrl = bridgeResponse.headers.get("location") || "";
    if (bridgeResponse.status !== 302 || !realReviewUrl) {
        throw new Error(`Real review bridge failed with status ${bridgeResponse.status}`);
    }

    await evaluate("document.querySelector('[data-review-source=\"real\"]').click()");
    await waitFor(`(() => {
        const node = document.getElementById('local-mr-version-data');
        if (!node?.textContent.trim()) return false;
        const data = JSON.parse(node.textContent);
        return location.origin === ${JSON.stringify(new URL(realReviewUrl).origin)}
            && data.reviewNavigation?.active === 'real'
            && data.reviewNavigation?.virtualUrl === ${JSON.stringify(virtualReturnUrl)}
            && document.documentElement.dataset.localMrDiffWorkspace === 'review-ui-v1'
            && document.documentElement.classList.contains('local-mr-ready');
    })()`, "Real workspace from Virtual");
    await selectFile(
        "test/app.test.mjs",
        ["COVERAGE_SENTINEL"],
        ["SECONDARY_NEW"],
        "Real coverage diff",
    );
    const realShared = await sharedWorkspaceSnapshot();
    const realCommitMessage = await commitMessageSnapshot();
    const realState = await evaluate(String.raw`(() => {
        const data = JSON.parse(document.getElementById("local-mr-version-data").textContent);
        return {
            navigation: data.reviewNavigation,
            virtualHref: document.querySelector('[data-review-source="virtual"]')?.href || "",
            paths: data.files.map((file) => file.displayPath || file.path).sort(),
            commitSubjects: data.commits.map((commit) => commit.subject),
            visibleText: document.querySelector('.d2h-file-wrapper:not([hidden])')?.textContent || "",
            modeOptions: [...document.querySelectorAll(
                ".local-mr-version-mode .local-mr-version-option",
            )].map((option) => option.textContent.trim()),
        };
    })()`);

    await evaluate("document.querySelector('[data-review-source=\"virtual\"]').click()");
    await waitFor(`(() => {
        const node = document.getElementById('local-mr-version-data');
        if (!node?.textContent.trim()) return false;
        const data = JSON.parse(node.textContent);
        return location.href === ${JSON.stringify(virtualReturnUrl)}
            && data.reviewNavigation?.active === 'virtual'
            && data.mode === 'single'
            && data.selection.from === ${JSON.stringify(secondCommitSha)}
            && data.selection.to === ${JSON.stringify(secondCommitSha)}
            && document.documentElement.dataset.localMrDiffWorkspace === 'review-ui-v1';
    })()`, "exact Virtual commit return");
    const virtualReturned = await panel();

    const standaloneRealUrl = new URL(realReviewUrl);
    standaloneRealUrl.searchParams.delete("virtual-review-url");
    standaloneRealUrl.searchParams.delete("return");
    standaloneRealUrl.hash = "";
    await evaluate(`location.href = ${JSON.stringify(standaloneRealUrl.href)}`);
    await waitFor(`(() => {
        const node = document.getElementById('local-mr-version-data');
        if (!node?.textContent.trim()) return false;
        const data = JSON.parse(node.textContent);
        return data.reviewNavigation?.active === 'real'
            && data.reviewNavigation?.virtualUrl === null
            && document.documentElement.dataset.localMrDiffWorkspace === 'review-ui-v1'
            && document.documentElement.classList.contains('local-mr-ready');
    })()`, "standalone Real workspace");
    const standaloneRealState = await evaluate(String.raw`(() => {
        const data = JSON.parse(document.getElementById("local-mr-version-data").textContent);
        const sourceSwitch = document.querySelector("[data-review-source-switch]");
        const real = document.querySelector('[data-review-source="real"]');
        const virtual = document.querySelector('[data-review-source="virtual"]');
        return {
            navigation: data.reviewNavigation,
            workspace: document.documentElement.dataset.localMrDiffWorkspace || "",
            sourceCount: sourceSwitch?.querySelectorAll("[data-review-source]").length || 0,
            real: {
                tag: real?.tagName || "",
                active: real?.getAttribute("aria-current") || "",
                available: real?.dataset.reviewSourceAvailable || "",
                hasHref: real?.hasAttribute("href") || false,
            },
            virtual: {
                tag: virtual?.tagName || "",
                active: virtual?.getAttribute("aria-current") || "",
                available: virtual?.dataset.reviewSourceAvailable || "",
                disabled: Boolean(virtual?.disabled),
                ariaDisabled: virtual?.getAttribute("aria-disabled") || "",
                hasHref: virtual?.hasAttribute("href") || false,
                title: virtual?.title || "",
                text: virtual?.textContent.trim() || "",
            },
        };
    })()`);
    const standaloneNextMode = await evaluate(String.raw`(() => {
        const data = JSON.parse(document.getElementById("local-mr-version-data").textContent);
        const nextMode = data.mode === "single" ? "range" : "single";
        const nextLabel = nextMode === "single" ? "Single commit" : "Commit range";
        const control = document.querySelector(".local-mr-version-mode");
        control.querySelector(".local-mr-version-trigger").click();
        const option = [...control.querySelectorAll(".local-mr-version-option")]
            .find((candidate) => candidate.textContent.trim() === nextLabel);
        if (!option) throw new Error(nextLabel + " mode is missing");
        option.click();
        return nextMode;
    })()`);
    await waitFor(`(() => {
        const node = document.getElementById('local-mr-version-data');
        if (!node?.textContent.trim()) return false;
        const data = JSON.parse(node.textContent);
        const virtual = document.querySelector('[data-review-source="virtual"]');
        return data.mode === ${JSON.stringify(standaloneNextMode)}
            && data.reviewNavigation?.active === 'real'
            && data.reviewNavigation?.virtualUrl === null
            && virtual?.getAttribute('aria-disabled') === 'true'
            && !virtual.hasAttribute('href')
            && document.documentElement.classList.contains('local-mr-ready');
    })()`, "standalone Real mode switch");
    const standaloneAfterModeSwitch = await evaluate(String.raw`(() => {
        const data = JSON.parse(document.getElementById("local-mr-version-data").textContent);
        const virtual = document.querySelector('[data-review-source="virtual"]');
        return {
            mode: data.mode,
            navigation: data.reviewNavigation,
            sourceCount: document.querySelectorAll("[data-review-source]").length,
            virtualAvailable: virtual?.dataset.reviewSourceAvailable || "",
            virtualText: virtual?.textContent.trim() || "",
        };
    })()`);

    await command("Emulation.setDeviceMetricsOverride", {
        width: 1440,
        height: 900,
        deviceScaleFactor: 1,
        mobile: false,
    });
    await evaluate(`location.href = ${JSON.stringify(liveRealReviewUrl)}`);
    await waitFor(`(() => {
        const node = document.getElementById('local-mr-version-data');
        if (!node?.textContent.trim()) return false;
        const data = JSON.parse(node.textContent);
        return data.reviewNavigation?.active === 'real'
            && data.reviewNavigation?.virtualState === 'stale'
            && document.querySelector('[data-review-source="virtual"]')?.dataset.reviewSourceState === 'stale'
            && document.documentElement.classList.contains('local-mr-ready');
    })()`, "live Real with stale Virtual attachment");
    const liveRealReturnUrl = await evaluate("location.href");
    const liveRealState = await evaluate(String.raw`(() => {
        const data = JSON.parse(document.getElementById("local-mr-version-data").textContent);
        const heading = document.querySelector("body > h1");
        const listHeader = document.querySelector(".d2h-file-list-header");
        const listTitle = listHeader?.querySelector(".d2h-file-list-title");
        const summary = listHeader?.querySelector(".local-mr-summary");
        const search = listHeader?.querySelector(".local-mr-search-label");
        const virtual = document.querySelector('[data-review-source="virtual"]');
        const fileItems = [...document.querySelectorAll(".d2h-file-list-line")];
        const total = (selector) => fileItems.reduce((sum, item) => (
            sum + Math.abs(Number.parseInt(item.querySelector(selector)?.textContent, 10) || 0)
        ), 0);
        const titleRect = listTitle?.getBoundingClientRect();
        const summaryRect = summary?.getBoundingClientRect();
        const searchRect = search?.getBoundingClientRect();
        return {
            navigation: data.reviewNavigation,
            warningCount: document.querySelectorAll("[data-review-source-warning]").length,
            virtual: {
                tag: virtual?.tagName || "",
                state: virtual?.dataset.reviewSourceState || "",
                available: virtual?.dataset.reviewSourceAvailable || "",
                hasHref: virtual?.hasAttribute("href") || false,
            },
            summary: {
                count: document.querySelectorAll(".local-mr-summary").length,
                inListHeader: summary?.parentElement === listHeader,
                afterTitle: summary?.previousElementSibling === listTitle,
                absentFromHeading: !heading?.querySelector(".local-mr-summary"),
                sameLine: Boolean(titleRect && summaryRect)
                    && Math.abs(
                        titleRect.top + titleRect.height / 2
                        - summaryRect.top - summaryRect.height / 2,
                    ) <= 2,
                searchBelow: Boolean(searchRect && titleRect && summaryRect)
                    && searchRect.top >= Math.max(titleRect.bottom, summaryRect.bottom),
                fileCount: summary?.dataset.fileCount || "",
                expectedFiles: fileItems.length,
                title: listTitle?.textContent.trim() || "",
                added: summary?.querySelector(".local-mr-summary-added")?.textContent || "",
                deleted: summary?.querySelector(".local-mr-summary-deleted")?.textContent || "",
                expectedAdded: total(".d2h-lines-added"),
                expectedDeleted: total(".d2h-lines-deleted"),
            },
        };
    })()`);

    await evaluate("document.querySelector('[data-review-source=\"virtual\"]').click()");
    await waitFor(`(() => {
        const node = document.getElementById('local-mr-version-data');
        if (!node?.textContent.trim()) return false;
        const data = JSON.parse(node.textContent);
        return data.reviewNavigation?.active === 'virtual'
            && data.reviewNavigation?.virtualState === 'stale'
            && document.querySelectorAll('[data-review-source-warning]').length === 1
            && document.documentElement.classList.contains('local-mr-ready');
    })()`, "stale Virtual from live Real");
    const liveVirtualState = await evaluate(String.raw`(() => {
        const data = JSON.parse(document.getElementById("local-mr-version-data").textContent);
        const warning = document.querySelector("[data-review-source-warning]");
        return {
            navigation: data.reviewNavigation,
            warningCount: document.querySelectorAll("[data-review-source-warning]").length,
            warningDisplay: warning ? getComputedStyle(warning).display : "",
            sourceCommit: warning?.dataset.sourceCommit || "",
            currentCommit: warning?.dataset.currentCommit || "",
        };
    })()`);
    await switchMode("Commit range", "range");
    const liveVirtualAfterModeSwitch = await evaluate(String.raw`(() => ({
        warningCount: document.querySelectorAll("[data-review-source-warning]").length,
        active: JSON.parse(document.getElementById("local-mr-version-data").textContent)
            .reviewNavigation?.active || "",
    }))()`);

    const sharedAssetsEqual = virtualShared.workspace === "review-ui-v1"
        && realShared.workspace === "review-ui-v1"
        && JSON.stringify(virtualShared.styleAsset) === JSON.stringify(realShared.styleAsset)
        && JSON.stringify(virtualShared.scriptAsset) === JSON.stringify(realShared.scriptAsset);
    const sharedDiffEqual = virtualShared.activePath === "test/app.test.mjs"
        && realShared.activePath === virtualShared.activePath
        && virtualShared.dom === realShared.dom
        && JSON.stringify(virtualShared.computed) === JSON.stringify(realShared.computed)
        && JSON.stringify(virtualShared.wrapperClasses) === JSON.stringify(realShared.wrapperClasses)
        && JSON.stringify(virtualShared.splitClasses) === JSON.stringify(realShared.splitClasses)
        && JSON.stringify(virtualShared.tableClasses) === JSON.stringify(realShared.tableClasses)
        && virtualShared.splitCount === 1
        && realShared.splitCount === 1
        && virtualShared.independentSidePanes === 0
        && realShared.independentSidePanes === 0;
    const sharedCommitMessageShell = virtualCommitMessage.found
        && realCommitMessage.found
        && virtualCommitMessage.rootTag === realCommitMessage.rootTag
        && JSON.stringify(virtualCommitMessage.rootClasses) === JSON.stringify(realCommitMessage.rootClasses)
        && virtualCommitMessage.titleTag === realCommitMessage.titleTag
        && JSON.stringify(virtualCommitMessage.titleClasses) === JSON.stringify(realCommitMessage.titleClasses)
        && virtualCommitMessage.bodyTag === realCommitMessage.bodyTag
        && JSON.stringify(virtualCommitMessage.bodyClasses) === JSON.stringify(realCommitMessage.bodyClasses)
        && JSON.stringify(virtualCommitMessage.style) === JSON.stringify(realCommitMessage.style)
        && virtualCommitMessage.beforeDiff
        && realCommitMessage.beforeDiff;

    const checks = {
        "Virtual /review defaults to V1 in the shared workspace": landing.pathname.endsWith("/review")
            && landing.revisionParameter === "2"
            && landing.revision === 2
            && landing.mode === "single"
            && landing.selection.mode === "single"
            && landing.selection.from === landing.commits[0].sha
            && landing.selection.to === landing.commits[0].sha
            && landing.navigation.active === "virtual"
            && landing.modeOptions.includes("Single commit")
            && landing.modeOptions.includes("Commit range"),
        "revision choices identify the exact frozen branch commit": landing.revision === 2
            && landing.revisions.length === 2
            && landing.revisions[0].revision === 1
            && landing.revisions[0].branchCommit.sha === newerBranchCommitSha
            && landing.revisions[0].branchCommit.subject === "advance branch after the initial review source"
            && landing.revisions[1].revision === 2
            && landing.revisions[1].branchCommit.sha === reviewCommitSha
            && landing.revisions[1].branchCommit.subject === realCommitSubject
            && landing.revisionTrigger.includes("R2")
            && landing.revisionTrigger.includes(reviewCommitSha.slice(0, 8))
            && landing.revisionOptions.length === 2
            && landing.revisionOptions[0].branchCommit === newerBranchCommitSha
            && landing.revisionOptions[1].branchCommit === reviewCommitSha
            && landing.revisionOptions.every((item) => item.text.includes("Commit ")),
        "stale Virtual reviews remain clickable and show a persistent boundary warning": (
            landing.navigation.virtualState === "stale"
            && landing.virtualSource?.tag === "A"
            && landing.virtualSource.state === "stale"
            && landing.virtualSource.available === "true"
            && landing.virtualSource.hasHref
            && landing.virtualSource.text.includes("stale")
            && landing.sourceWarning?.state === "stale"
            && landing.sourceWarning.display !== "none"
            && landing.sourceWarning.sourceCommit === reviewCommitSha
            && landing.sourceWarning.currentCommit !== reviewCommitSha
            && landing.sourceWarning.text.includes(reviewCommitSha.slice(0, 8))
            && landing.sourceWarning.text.includes("Later commits are not included")
        ),
        "stale warnings appear only after entering Virtual from the live Real page": (
            liveRealState.navigation.active === "real"
            && liveRealState.navigation.virtualState === "stale"
            && liveRealState.warningCount === 0
            && liveRealState.virtual.tag === "A"
            && liveRealState.virtual.state === "stale"
            && liveRealState.virtual.available === "true"
            && liveRealState.virtual.hasHref
            && liveVirtualState.navigation.active === "virtual"
            && liveVirtualState.navigation.virtualState === "stale"
            && liveVirtualState.navigation.realUrl === liveRealReturnUrl
            && liveVirtualState.warningCount === 1
            && liveVirtualState.warningDisplay !== "none"
            && liveVirtualState.sourceCommit === reviewCommitSha
            && liveVirtualState.currentCommit === liveBranchCommitSha
            && liveVirtualAfterModeSwitch.active === "virtual"
            && liveVirtualAfterModeSwitch.warningCount === 1
        ),
        "Diff totals sit beside the Changed files read summary instead of the page heading": (
            liveRealState.summary.count === 1
            && liveRealState.summary.inListHeader
            && liveRealState.summary.afterTitle
            && liveRealState.summary.absentFromHeading
            && liveRealState.summary.sameLine
            && liveRealState.summary.searchBelow
            && liveRealState.summary.fileCount === String(liveRealState.summary.expectedFiles)
            && liveRealState.summary.title.includes(
                `Changed files · ${liveRealState.summary.expectedFiles} ·`,
            )
            && liveRealState.summary.title.endsWith(" read")
            && liveRealState.summary.added === (
                liveRealState.summary.expectedAdded > 0
                    ? `+${liveRealState.summary.expectedAdded}`
                    : ""
            )
            && liveRealState.summary.deleted === (
                liveRealState.summary.expectedDeleted > 0
                    ? `−${liveRealState.summary.expectedDeleted}`
                    : ""
            )
        ),
        "Virtual range merges one continuous interval of virtual commits": landing.commits.length === 2
            && aggregateInitial.mode === "range"
            && aggregateInitial.hasRevisionControl
            && aggregateInitial.virtualActions.length === 0
            && aggregateInitial.selection.from === landing.commits[0].sha
            && aggregateInitial.selection.to === landing.commits.at(-1).sha
            && aggregateInitial.paths.join(",") === "README.md,src/app.mjs,test/app.test.mjs"
            && aggregateInitial.treePaths.join(",") === aggregateInitial.paths.join(",")
            && aggregateProduction.visibleText.includes("CORE_NEW")
            && aggregateProduction.visibleText.includes("SECONDARY_NEW")
            && aggregateProduction.syntaxLanguage === "mjs"
            && aggregateProduction.syntaxLineCount > 0
            && aggregateProduction.syntaxKeywordCount > 0
            && aggregateProduction.syntaxFunctionCount > 0,
        "Virtual Single commit renders V1 by itself": firstCommit.mode === "single"
            && firstCommit.selection.from === firstCommitSha
            && firstCommit.selection.to === firstCommitSha
            && firstCommit.hasRevisionControl
            && firstCommit.hasVirtualProgress
            && firstCommit.virtualActions.join(",") === "next,previous,reviewed"
            && firstCommit.selectedCommitSubject === "Revised checkpoint 1"
            && firstCommit.paths.join(",") === "src/app.mjs"
            && firstCommit.treePaths.join(",") === "src/app.mjs"
            && firstCommit.visibleText.includes("CORE_NEW")
            && !firstCommit.visibleText.includes("SECONDARY_NEW"),
        "Virtual Single commit renders V2 by itself": secondCommitInitial.mode === "single"
            && secondCommitInitial.selection.from === secondCommitSha
            && secondCommitInitial.selection.to === secondCommitSha
            && secondCommitInitial.paths.join(",") === "README.md,src/app.mjs,test/app.test.mjs"
            && secondProduction.visibleText.includes("SECONDARY_NEW")
            && !secondProduction.visibleText.includes("CORE_NEW")
            && secondCoverage.visibleText.includes("COVERAGE_SENTINEL"),
        "switching back to Commit range restores the cumulative virtual diff": aggregateRestored.mode === "range"
            && aggregateRestored.selection.from === landing.commits[0].sha
            && aggregateRestored.selection.to === landing.commits.at(-1).sha
            && aggregateRestored.paths.join(",") === "README.md,src/app.mjs,test/app.test.mjs"
            && aggregateRestored.visibleText.includes("CORE_NEW")
            && aggregateRestored.visibleText.includes("SECONDARY_NEW"),
        "Virtual and Real load the exact same shared style and behavior assets": sharedAssetsEqual,
        "the same file renders equivalent normalized Diff DOM, classes, and computed styles": sharedDiffEqual,
        "Real and Virtual commit messages share one DOM shell and placement": sharedCommitMessageShell
            && virtualCommitMessage.kind === "virtual"
            && virtualCommitMessage.title === "Revised checkpoint 2"
            && realCommitMessage.kind === "real"
            && realCommitMessage.title === realCommitSubject
            && realCommitMessage.body === realCommitBody,
        "Real and Virtual source buttons preserve the exact Virtual commit workspace": virtualNavigation.activeReal === ""
            && virtualNavigation.activeVirtual === "page"
            && realState.navigation.active === "real"
            && realState.navigation.virtualUrl === virtualReturnUrl
            && realState.virtualHref === virtualReturnUrl
            && !realState.paths.some((filePath) => filePath.includes("live_only_fixture"))
            && !realState.commitSubjects.includes("advance live repository after frozen virtual source")
            && !realState.visibleText.includes("LIVE_REPOSITORY_DRIFT_MUST_NOT_ENTER_FROZEN_REAL")
            && realState.modeOptions.includes("Single commit")
            && realState.modeOptions.includes("Commit range")
            && virtualReturned.mode === "single"
            && virtualReturned.selection.from === secondCommitSha
            && virtualReturned.selection.to === secondCommitSha
            && virtualReturned.workspace === "review-ui-v1",
        "standalone Real reviews keep the unified source switch": standaloneRealState.workspace === "review-ui-v1"
            && standaloneRealState.navigation.active === "real"
            && standaloneRealState.navigation.virtualUrl === null
            && standaloneRealState.navigation.virtualUnavailableReason.includes(
                "No matching Virtual Review",
            )
            && standaloneRealState.sourceCount === 2
            && standaloneRealState.real.tag === "A"
            && standaloneRealState.real.active === "page"
            && standaloneRealState.real.available === "true"
            && standaloneRealState.real.hasHref
            && standaloneRealState.virtual.tag === "BUTTON"
            && standaloneRealState.virtual.active === ""
            && standaloneRealState.virtual.available === "false"
            && standaloneRealState.virtual.disabled
            && standaloneRealState.virtual.ariaDisabled === "true"
            && !standaloneRealState.virtual.hasHref
            && standaloneRealState.virtual.text.includes("none")
            && standaloneRealState.virtual.title.includes("No matching Virtual Review")
            && standaloneAfterModeSwitch.mode === standaloneNextMode
            && standaloneAfterModeSwitch.navigation.virtualUrl === null
            && standaloneAfterModeSwitch.sourceCount === 2
            && standaloneAfterModeSwitch.virtualAvailable === "false"
            && standaloneAfterModeSwitch.virtualText.includes("none"),
    };

    printPublicTestReport({
        reviewId: revisionTwo.reviewId,
        landing,
        aggregateInitial,
        aggregateProduction,
        firstCommit,
        secondCommitInitial,
        secondProduction,
        secondCoverage,
        aggregateRestored,
        virtualShared: { ...virtualShared, dom: `<${virtualShared.dom.length} chars>` },
        virtualCommitMessage,
        realShared: { ...realShared, dom: `<${realShared.dom.length} chars>` },
        realCommitMessage,
        realState,
        virtualReturned,
        standaloneRealState,
        standaloneAfterModeSwitch,
        liveRealState,
        liveVirtualState,
        liveVirtualAfterModeSwitch,
        checks,
    });
    if (Object.values(checks).some((passed) => !passed)) process.exitCode = 1;
} finally {
    browser?.close();
    if (realReviewUrl) {
        try {
            const shutdown = new URL(realReviewUrl);
            shutdown.pathname = shutdown.pathname.replace(/\/review$/, "/shutdown");
            shutdown.search = "";
            shutdown.hash = "";
            await fetch(shutdown, { method: "POST" });
        } catch {}
    }
    if (liveRealReviewUrl) {
        try {
            const shutdown = new URL(liveRealReviewUrl);
            shutdown.pathname = shutdown.pathname.replace(/\/review$/, "/shutdown");
            shutdown.search = "";
            shutdown.hash = "";
            await fetch(shutdown, { method: "POST" });
        } catch {}
    }
    await Promise.all(reviewUrls.map(async (reviewUrl) => {
        try {
            const shutdown = new URL(reviewUrl);
            shutdown.pathname = shutdown.pathname.replace(/\/review$/, "/shutdown");
            shutdown.search = "";
            shutdown.hash = "";
            await fetch(shutdown, { method: "POST" });
        } catch {}
    }));
    await delay(150);
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
}
