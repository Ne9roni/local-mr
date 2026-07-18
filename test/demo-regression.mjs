import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { openChromePage } from "./helpers/chrome.mjs";
import { projectRoot } from "./helpers/paths.mjs";
import { printPublicTestReport } from "./helpers/public-report.mjs";

const demoRoot = path.join(projectRoot, "demo");
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "local-mr-demo-chrome-"));
const debuggingPort = 9340;
const initialCommitSha = "e524ea042bf9bf092363e6851fa2ed8507643256";
const featureCommitSha = "5d009fbc8571353641029b98a5ff166948dcb311";
const featureCommitShortSha = featureCommitSha.slice(0, 7);
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const contentTypes = new Map([
    [".html", "text/html; charset=utf-8"],
    [".js", "text/javascript; charset=utf-8"],
    [".json", "application/json; charset=utf-8"],
    [".md", "text/markdown; charset=utf-8"],
    [".txt", "text/plain; charset=utf-8"],
]);

const server = http.createServer((request, response) => {
    const requestedPath = new URL(request.url, "http://127.0.0.1").pathname;
    const relativePath = requestedPath === "/" ? "index.html" : requestedPath.slice(1);
    const filePath = path.resolve(demoRoot, relativePath);
    if (!filePath.startsWith(`${demoRoot}${path.sep}`)) {
        response.writeHead(403).end("Forbidden");
        return;
    }
    try {
        const content = fs.readFileSync(filePath);
        response.writeHead(200, {
            "Content-Type": contentTypes.get(path.extname(filePath)) || "application/octet-stream",
        });
        response.end(content);
    } catch {
        response.writeHead(404).end("Not found");
    }
});

let browser;
try {
    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    const demoUrl = `http://127.0.0.1:${address.port}/index.html`;
    browser = await openChromePage({
        url: demoUrl,
        profile,
        debuggingPort,
    });
    const { command, evaluate, waitFor } = browser;
    await waitFor(
        "document.readyState === 'complete' && document.documentElement.classList.contains('local-mr-ready')",
        "Virtual Commit Demo UI",
    );

    if (process.env.LOCAL_MR_SCREENSHOT) {
        const screenshotWidth = Number(process.env.LOCAL_MR_SCREENSHOT_WIDTH) || 1440;
        const screenshotHeight = Number(process.env.LOCAL_MR_SCREENSHOT_HEIGHT) || 900;
        await command("Emulation.setDeviceMetricsOverride", {
            width: screenshotWidth,
            height: screenshotHeight,
            deviceScaleFactor: 1,
            mobile: screenshotWidth <= 600,
        });
        await waitFor(
            `innerWidth === ${screenshotWidth} && innerHeight === ${screenshotHeight}`,
            "Demo screenshot viewport",
        );
        if (process.env.LOCAL_MR_SCREENSHOT_DARK) {
            await evaluate("document.body.classList.remove('local-mr-auto'); document.body.classList.add('local-mr-dark')");
        }
        await evaluate("new Promise((resolve) => setTimeout(resolve, 250))");
        const screenshot = await command("Page.captureScreenshot", {
            format: "png",
            fromSurface: true,
        });
        fs.writeFileSync(
            path.resolve(projectRoot, process.env.LOCAL_MR_SCREENSHOT),
            Buffer.from(screenshot.data, "base64"),
        );
        if (screenshotWidth !== 1440 || screenshotHeight !== 900) {
            await command("Emulation.setDeviceMetricsOverride", {
                width: 1440,
                height: 900,
                deviceScaleFactor: 1,
                mobile: false,
            });
            await waitFor("innerWidth === 1440 && innerHeight === 900", "restored Demo test viewport");
        }
        if (process.env.LOCAL_MR_SCREENSHOT_DARK) {
            await evaluate("document.body.classList.remove('local-mr-dark'); document.body.classList.add('local-mr-auto')");
        }
    }

    const initial = await evaluate(String.raw`(() => {
        const data = JSON.parse(document.getElementById('local-mr-version-data').textContent);
        const sourceLink = document.querySelector('.local-mr-demo-repository');
        return {
            badge: document.querySelector('.local-mr-demo-badge')?.textContent || '',
            files: document.querySelectorAll('.d2h-file-list-line').length,
            layouts: document.querySelectorAll('.local-mr-demo-layout').length,
            activePath: document.querySelector('.d2h-file-list-line.local-mr-active .d2h-file-name')?.title || '',
            sourceOptions: document.querySelectorAll('[data-review-source]').length,
            activeSource: document.querySelector('[data-review-source][aria-current="page"]')?.dataset.reviewSource || '',
            reviewKind: data.reviewKind,
            commits: data.commits.length,
            mode: data.mode,
            contextTitle: document.querySelector('[data-review-title]')?.textContent || '',
            focusItems: document.querySelectorAll('[data-review-focus-list] li').length,
            risk: document.querySelector('[data-review-risk]')?.dataset.reviewRisk || '',
            progress: document.querySelector('.local-mr-virtual-progress')?.textContent || '',
            revision: data.virtualSession?.revision || null,
            revisions: (data.virtualSession?.revisions || []).map((item) => ({
                revision: item.revision,
                label: item.label,
                title: item.title,
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
            hasNext: Boolean(document.querySelector('[data-virtual-action="next"]:not(:disabled)')),
            fragmentUrls: Object.keys(data.fragmentUrls || {}).length,
            contextUrls: Object.keys(data.contextUrls || {}).length,
            previewUrls: Object.keys(data.previewUrls || {}).length,
            source: data.demo?.source || null,
            sourceLinkText: sourceLink?.textContent || '',
            sourceLinkUrl: sourceLink?.href || '',
        };
    })()`);

    await evaluate(String.raw`(() => {
        const next = document.querySelector('[data-virtual-action="next"]');
        if (!next || next.disabled) throw new Error('Next Virtual Commit action is missing');
        next.click();
    })()`);
    await waitFor(String.raw`(() => {
        const data = JSON.parse(document.getElementById('local-mr-version-data').textContent);
        return document.documentElement.classList.contains('local-mr-ready')
            && data.selection.mode === 'single'
            && data.selection.from === data.commits[1].sha;
    })()`, "second Virtual Commit");
    const secondVirtual = await evaluate(String.raw`(() => ({
        files: document.querySelectorAll('.d2h-file-list-line').length,
        activePath: document.querySelector('.d2h-file-list-line.local-mr-active .d2h-file-name')?.title || '',
        contextTitle: document.querySelector('[data-review-title]')?.textContent || '',
        hasPrevious: Boolean(document.querySelector('[data-virtual-action="previous"]:not(:disabled)')),
        hasNext: Boolean(document.querySelector('[data-virtual-action="next"]:not(:disabled)')),
    }))()`);

    await evaluate("history.back()");
    await waitFor(String.raw`(() => {
        const data = JSON.parse(document.getElementById('local-mr-version-data').textContent);
        return document.documentElement.classList.contains('local-mr-ready')
            && data.selection.from === data.commits[0].sha;
    })()`, "first Virtual Commit after browser back");
    await evaluate("history.forward()");
    await waitFor(String.raw`(() => {
        const data = JSON.parse(document.getElementById('local-mr-version-data').textContent);
        return document.documentElement.classList.contains('local-mr-ready')
            && data.selection.from === data.commits[1].sha;
    })()`, "second Virtual Commit after browser forward");

    await evaluate(String.raw`(() => {
        const control = document.querySelector('.local-mr-version-mode');
        control.querySelector('.local-mr-version-trigger').click();
        const option = [...control.querySelectorAll('.local-mr-version-option')]
            .find((candidate) => candidate.textContent.trim() === 'Commit range');
        if (!option) throw new Error('Commit range mode is missing');
        option.click();
    })()`);
    await waitFor(String.raw`(() => {
        const data = JSON.parse(document.getElementById('local-mr-version-data').textContent);
        return document.documentElement.classList.contains('local-mr-ready')
            && data.selection.mode === 'range'
            && data.selection.from === data.commits[0].sha
            && data.selection.to === data.commits.at(-1).sha
            && data.demo?.source?.files > 0
            && document.querySelectorAll('.d2h-file-list-line').length === data.demo.source.files;
    })()`, "complete Virtual Commit range");
    const virtualRange = await evaluate(String.raw`(() => {
        const data = JSON.parse(document.getElementById('local-mr-version-data').textContent);
        const readme = data.files.find((file) => file.displayPath === 'README.md');
        return {
            patchId: data.patchId,
            files: data.files.map((file) => file.displayPath).sort(),
            contextTitle: document.querySelector('[data-review-title]')?.textContent || '',
            focusItems: document.querySelectorAll('[data-review-focus-list] li').length,
            readmeHasFragment: Boolean(data.fragmentUrls?.[document.querySelector('.d2h-file-name[title="README.md"]')?.hash.slice(1)]),
            readmeHasContext: Boolean(data.contextUrls?.[readme?.patchId]),
            readmeHasPreview: Boolean(data.previewUrls?.['README.md']),
        };
    })()`);

    await evaluate(String.raw`(() => {
        const link = [...document.querySelectorAll('.d2h-file-list-line .d2h-file-name')]
            .find((candidate) => candidate.title === 'README.md');
        if (!link) throw new Error('Virtual range README is missing');
        link.click();
    })()`);
    await waitFor(
        "document.querySelector('.d2h-file-list-line.local-mr-active .d2h-file-name')?.title === 'README.md'",
        "Virtual range README fragment",
    );
    await waitFor(
        "Boolean(document.querySelector('.d2h-file-wrapper:not([hidden]) .local-mr-context-button'))",
        "static README context controls",
    );
    await evaluate(String.raw`(() => {
        const button = document.querySelector('.d2h-file-wrapper:not([hidden]) .local-mr-context-button');
        if (!button) throw new Error('Demo context expansion control is missing');
        button.click();
    })()`);
    await waitFor(
        "document.querySelectorAll('.d2h-file-wrapper:not([hidden]) .local-mr-expanded-context').length > 0",
        "static context expansion",
    );
    const expandedContext = await evaluate(String.raw`(() => ({
        lines: document.querySelectorAll('.d2h-file-wrapper:not([hidden]) .local-mr-expanded-context').length,
        highlighted: document.querySelectorAll(
            '.d2h-file-wrapper:not([hidden]) .local-mr-expanded-context .d2h-code-line-ctn.hljs'
        ).length,
    }))()`);

    await evaluate(String.raw`(() => {
        const toggle = document.querySelector('.d2h-file-wrapper:not([hidden]) .local-mr-preview-toggle');
        if (!toggle) throw new Error('Static Markdown preview control is missing');
        toggle.click();
    })()`);
    await waitFor(
        "Boolean(document.querySelector('.d2h-file-wrapper:not([hidden]) .local-mr-markdown-body'))",
        "static Markdown preview",
    );
    const preview = await evaluate(String.raw`(() => {
        const article = document.querySelector('.d2h-file-wrapper:not([hidden]) .local-mr-markdown-body');
        return {
            heading: article?.querySelector('h1')?.textContent || '',
            hasTable: Boolean(article?.querySelector('table')),
            error: document.querySelector('.d2h-file-wrapper:not([hidden]) .local-mr-preview-error')?.textContent || '',
        };
    })()`);

    await evaluate(String.raw`(() => {
        const link = [...document.querySelectorAll('.d2h-file-list-line .d2h-file-name')]
            .find((candidate) => candidate.title === 'src/virtual-review-manifest.mjs');
        if (!link) throw new Error('Virtual range manifest source is missing');
        link.click();
    })()`);
    await waitFor(
        "document.querySelector('.d2h-file-list-line.local-mr-active .d2h-file-name')?.title === 'src/virtual-review-manifest.mjs'",
        "Virtual range source fragment",
    );
    await waitFor(
        "document.querySelectorAll('.d2h-file-wrapper:not([hidden]) .d2h-code-line-ctn.hljs [class*=\"hljs-\"]').length > 0",
        "Demo syntax highlighting",
    );
    const syntaxHighlight = await evaluate(String.raw`(() => {
        const wrapper = document.querySelector('.d2h-file-wrapper:not([hidden])');
        const keyword = wrapper?.querySelector('.hljs-keyword');
        const functionTitle = wrapper?.querySelector('.hljs-title.function_, .hljs-title');
        const string = wrapper?.querySelector('.hljs-string');
        return {
            language: wrapper?.dataset.lang || '',
            tokenCount: wrapper?.querySelectorAll('.d2h-code-line-ctn.hljs [class*="hljs-"]').length || 0,
            keywordCount: wrapper?.querySelectorAll('.hljs-keyword').length || 0,
            functionCount: wrapper?.querySelectorAll('.hljs-title.function_, .hljs-title').length || 0,
            stringCount: wrapper?.querySelectorAll('.hljs-string').length || 0,
            preservesInlineChanges: Boolean(wrapper?.querySelector(
                '.d2h-code-line-ctn.hljs ins, .d2h-code-line-ctn.hljs del',
            )),
            colors: [keyword, functionTitle, string]
                .filter(Boolean)
                .map((token) => getComputedStyle(token).color),
        };
    })()`);

    await evaluate(String.raw`(() => {
        const link = document.querySelector('[data-review-source="real"]');
        if (!link) throw new Error('Real commits source switch is missing');
        link.click();
    })()`);
    await waitFor(String.raw`(() => {
        const data = JSON.parse(document.getElementById('local-mr-version-data').textContent);
        return location.pathname.endsWith('/real.html')
            && document.documentElement.classList.contains('local-mr-ready')
            && data.reviewNavigation?.active === 'real'
            && data.selection.mode === 'range';
    })()`, "Real Commit Demo");
    const realRange = await evaluate(String.raw`(() => {
        const data = JSON.parse(document.getElementById('local-mr-version-data').textContent);
        return {
            patchId: data.patchId,
            files: data.files.map((file) => file.displayPath).sort(),
            sourceOptions: document.querySelectorAll('[data-review-source]').length,
            activeSource: document.querySelector('[data-review-source][aria-current="page"]')?.dataset.reviewSource || '',
            commits: data.commits.length,
            commit: data.commits[0] || null,
            focusedCommit: data.focusedCommit || null,
            dirty: data.dirty,
            title: document.querySelector('[data-review-title]')?.textContent || '',
        };
    })()`);

    await evaluate(String.raw`(() => {
        const control = document.querySelector('.local-mr-version-mode');
        control.querySelector('.local-mr-version-trigger').click();
        const option = [...control.querySelectorAll('.local-mr-version-option')]
            .find((candidate) => candidate.textContent.trim() === 'Single commit');
        if (!option) throw new Error('Single commit mode is missing');
        option.click();
    })()`);
    await waitFor(String.raw`(() => {
        const data = JSON.parse(document.getElementById('local-mr-version-data').textContent);
        return document.documentElement.classList.contains('local-mr-ready')
            && data.selection.mode === 'single'
            && data.selection.from === data.commits[0].sha;
    })()`, "single Real Commit");
    const realSingle = await evaluate(String.raw`(() => {
        const data = JSON.parse(document.getElementById('local-mr-version-data').textContent);
        return {
            files: data.files.length,
            rangeLabel: document.querySelector('.local-mr-commit-range .local-mr-version-trigger-label')?.textContent || '',
        };
    })()`);

    await evaluate(String.raw`(() => {
        const link = [...document.querySelectorAll('.local-mr-demo-layout')]
            .find((candidate) => candidate.textContent === 'Line-by-line');
        if (!link) throw new Error('Line-by-line Demo link is missing');
        link.click();
    })()`);
    await waitFor(
        "location.pathname.endsWith('/real-line.html') && document.documentElement.classList.contains('local-mr-ready')",
        "Real line-by-line Demo",
    );
    const realLineLayout = await evaluate(String.raw`(() => ({
        selected: document.querySelector('.local-mr-demo-layout.local-mr-selected')?.textContent || '',
        hasLineTable: Boolean(document.querySelector('.d2h-file-wrapper:not([hidden]) .d2h-file-diff .d2h-diff-table')),
        hasSplitTable: Boolean(document.querySelector('.d2h-file-wrapper:not([hidden]) .local-mr-split-table')),
        selection: JSON.parse(document.getElementById('local-mr-version-data').textContent).selection,
    }))()`);

    await evaluate(String.raw`(() => {
        const link = document.querySelector('[data-review-source="virtual"]');
        if (!link) throw new Error('Virtual commits source switch is missing');
        link.click();
    })()`);
    await waitFor(String.raw`(() => {
        const data = JSON.parse(document.getElementById('local-mr-version-data').textContent);
        return location.pathname.endsWith('/line.html')
            && document.documentElement.classList.contains('local-mr-ready')
            && data.reviewNavigation?.active === 'virtual'
            && data.selection.mode === 'single';
    })()`, "Virtual line-by-line Demo");
    const virtualLineLayout = await evaluate(String.raw`(() => {
        const data = JSON.parse(document.getElementById('local-mr-version-data').textContent);
        return {
            selected: document.querySelector('.local-mr-demo-layout.local-mr-selected')?.textContent || '',
            activeSource: document.querySelector('[data-review-source][aria-current="page"]')?.dataset.reviewSource || '',
            selectedCommit: data.selection.from,
            firstCommit: data.commits[0].sha,
        };
    })()`);

    await evaluate(String.raw`(() => {
        const control = document.querySelector('.local-mr-virtual-revision');
        if (!control) throw new Error('Virtual revision control is missing');
        control.querySelector('.local-mr-version-trigger').click();
        const option = control.querySelector('[data-revision="1"]');
        if (!option) throw new Error('Overview revision is missing');
        option.click();
    })()`);
    await waitFor(String.raw`(() => {
        const data = JSON.parse(document.getElementById('local-mr-version-data').textContent);
        return location.pathname.endsWith('/overview-line.html')
            && document.documentElement.classList.contains('local-mr-ready')
            && data.reviewNavigation?.active === 'virtual'
            && data.virtualSession?.revision === 1
            && data.commits.length === 6
            && data.selection.mode === 'single';
    })()`, "Overview revision");
    const overviewInitial = await evaluate(String.raw`(() => {
        const data = JSON.parse(document.getElementById('local-mr-version-data').textContent);
        return {
            commits: data.commits.length,
            mode: data.mode,
            activeSource: document.querySelector('[data-review-source][aria-current="page"]')?.dataset.reviewSource || '',
            revision: data.virtualSession?.revision || null,
            revisionTrigger: document.querySelector(
                '.local-mr-virtual-revision .local-mr-version-trigger-label'
            )?.textContent || '',
            selectedLayout: document.querySelector('.local-mr-demo-layout.local-mr-selected')?.textContent || '',
            contextTitle: document.querySelector('[data-review-title]')?.textContent || '',
            activePath: document.querySelector('.d2h-file-list-line.local-mr-active .d2h-file-name')?.title || '',
        };
    })()`);

    await evaluate(String.raw`(() => {
        const control = document.querySelector('.local-mr-version-mode');
        control.querySelector('.local-mr-version-trigger').click();
        const option = [...control.querySelectorAll('.local-mr-version-option')]
            .find((candidate) => candidate.textContent.trim() === 'Commit range');
        if (!option) throw new Error('Overview Commit range mode is missing');
        option.click();
    })()`);
    await waitFor(String.raw`(() => {
        const data = JSON.parse(document.getElementById('local-mr-version-data').textContent);
        return document.documentElement.classList.contains('local-mr-ready')
            && data.selection.mode === 'range'
            && data.selection.from === data.commits[0].sha
            && data.selection.to === data.commits.at(-1).sha
            && data.demo?.source?.files > 0
            && document.querySelectorAll('.d2h-file-list-line').length === data.demo.source.files;
    })()`, "complete Overview range");
    const overviewVirtualRange = await evaluate(String.raw`(() => {
        const data = JSON.parse(document.getElementById('local-mr-version-data').textContent);
        return {
            patchId: data.patchId,
            files: data.files.map((file) => file.displayPath).sort(),
            focusItems: document.querySelectorAll('[data-review-focus-list] li').length,
        };
    })()`);

    await evaluate(String.raw`(() => {
        const link = document.querySelector('[data-review-source="real"]');
        if (!link) throw new Error('Overview Real commits source switch is missing');
        link.click();
    })()`);
    await waitFor(String.raw`(() => {
        const data = JSON.parse(document.getElementById('local-mr-version-data').textContent);
        return location.pathname.endsWith('/overview-real-line.html')
            && document.documentElement.classList.contains('local-mr-ready')
            && data.reviewNavigation?.active === 'real'
            && data.selection.mode === 'range';
    })()`, "Overview Real Demo");
    const overviewRealRange = await evaluate(String.raw`(() => {
        const data = JSON.parse(document.getElementById('local-mr-version-data').textContent);
        return {
            patchId: data.patchId,
            files: data.files.map((file) => file.displayPath).sort(),
            selectedLayout: document.querySelector('.local-mr-demo-layout.local-mr-selected')?.textContent || '',
            activeSource: document.querySelector('[data-review-source][aria-current="page"]')?.dataset.reviewSource || '',
            virtualUrl: data.reviewNavigation?.virtualUrl || '',
        };
    })()`);

    await evaluate(String.raw`(() => {
        const link = document.querySelector('[data-review-source="virtual"]');
        if (!link) throw new Error('Overview Virtual commits return is missing');
        link.click();
    })()`);
    await waitFor(String.raw`(() => {
        const data = JSON.parse(document.getElementById('local-mr-version-data').textContent);
        return location.pathname.endsWith('/overview-line.html')
            && document.documentElement.classList.contains('local-mr-ready')
            && data.reviewNavigation?.active === 'virtual'
            && data.virtualSession?.revision === 1;
    })()`, "Overview revision after Real return");
    const overviewVirtualReturn = await evaluate(String.raw`(() => ({
        revision: JSON.parse(document.getElementById('local-mr-version-data').textContent)
            .virtualSession?.revision || null,
        selectedLayout: document.querySelector('.local-mr-demo-layout.local-mr-selected')?.textContent || '',
        activeSource: document.querySelector('[data-review-source][aria-current="page"]')?.dataset.reviewSource || '',
    }))()`);

    await evaluate(String.raw`(() => {
        const control = document.querySelector('.local-mr-virtual-revision');
        control.querySelector('.local-mr-version-trigger').click();
        const option = control.querySelector('[data-revision="2"]');
        if (!option) throw new Error('Deep review revision is missing');
        option.click();
    })()`);
    await waitFor(String.raw`(() => {
        const data = JSON.parse(document.getElementById('local-mr-version-data').textContent);
        return location.pathname.endsWith('/line.html')
            && document.documentElement.classList.contains('local-mr-ready')
            && data.reviewNavigation?.active === 'virtual'
            && data.virtualSession?.revision === 2;
    })()`, "Deep review revision after revision switch");
    const deepVirtualReturn = await evaluate(String.raw`(() => ({
        revision: JSON.parse(document.getElementById('local-mr-version-data').textContent)
            .virtualSession?.revision || null,
        revisionTrigger: document.querySelector(
            '.local-mr-virtual-revision .local-mr-version-trigger-label'
        )?.textContent || '',
        selectedLayout: document.querySelector('.local-mr-demo-layout.local-mr-selected')?.textContent || '',
        activeSource: document.querySelector('[data-review-source][aria-current="page"]')?.dataset.reviewSource || '',
    }))()`);

    const checks = {
        "Demo opens on the docs-first Deep review route": initial.badge === "VIRTUAL COMMIT DEMO"
            && initial.sourceOptions === 2
            && initial.activeSource === "virtual"
            && initial.reviewKind === "virtual"
            && initial.revision === 2
            && initial.commits === 14
            && initial.mode === "single"
            && initial.activePath === "docs/virtual-commits.md",
        "Overview and Deep review are native Virtual revisions": initial.revisions.length === 2
            && initial.revisions[0].revision === 1
            && initial.revisions[0].title === "Overview"
            && initial.revisions[1].revision === 2
            && initial.revisions[1].title === "Deep review"
            && initial.revisionTrigger.includes("R2")
            && initial.revisionTrigger.includes(featureCommitShortSha)
            && initial.revisionTrigger.includes("Deep review"),
        "each revision identifies its frozen branch commit": initial.revisions.every((item) => (
            item.branchCommit?.sha === featureCommitSha
            && item.branchCommit?.shortSha === featureCommitShortSha
            && item.branchCommit?.branchName === "main"
            && item.branchCommit?.author === "Ne9roni"
        )) && initial.revisionOptions.length === 2
            && initial.revisionOptions.every((item) => (
            item.branchCommit === featureCommitSha
            && item.text.includes(`Commit ${featureCommitShortSha}`)
            )),
        "the first Virtual Commit treats documentation as a contract": initial.files >= 2
            && initial.contextTitle === "Read the contract before the implementation"
            && initial.focusItems === 2
            && initial.risk === "medium"
            && initial.progress.includes("0/14 virtual commits reviewed")
            && initial.hasNext,
        "the Demo identifies its GitHub feature commit and offers a repository Star link": initial.source?.kind === "github-commit"
            && initial.source?.label === "Virtual Commit feature commit"
            && initial.source?.url === `https://github.com/Ne9roni/local-mr/commit/${featureCommitSha}`
            && initial.source?.baseSha === initialCommitSha
            && initial.source?.headSha === featureCommitSha
            && /^[a-f0-9]{64}$/u.test(initial.source?.diffHash || "")
            && Number.isInteger(initial.source?.files)
            && initial.source.files > 0
            && Number.isInteger(initial.source?.insertions)
            && initial.source.insertions > 0
            && Number.isInteger(initial.source?.deletions)
            && initial.source.deletions >= 0
            && initial.sourceLinkText === "Star on GitHub ↗"
            && initial.sourceLinkUrl === "https://github.com/Ne9roni/local-mr",
        "static files use content-addressed fragments and data": initial.fragmentUrls === initial.files
            && initial.contextUrls > 0
            && initial.previewUrls > 0,
        "Virtual Commit navigation follows the human route": secondVirtual.files > 0
            && secondVirtual.activePath === "skills/local-mr-virtual-commits/SKILL.md"
            && secondVirtual.contextTitle === "Map the CLI and agent contract"
            && secondVirtual.hasPrevious
            && secondVirtual.hasNext,
        "the complete Virtual range exposes the entire real MR": virtualRange.files.length === initial.source.files
            && virtualRange.contextTitle === "Review the MR in human order"
            && virtualRange.focusItems === 14
            && virtualRange.readmeHasFragment
            && virtualRange.readmeHasContext
            && virtualRange.readmeHasPreview,
        "complete Real and Virtual ranges render the same frozen Diff": realRange.patchId === virtualRange.patchId
            && JSON.stringify(realRange.files) === JSON.stringify(virtualRange.files)
            && realRange.sourceOptions === 2
            && realRange.activeSource === "real"
            && realRange.commits === 1
            && realRange.dirty === false,
        "the Real side remains the one AI-sized Git commit": realSingle.files === initial.source.files
            && realSingle.rangeLabel.includes("feat(virtual-commits)")
            && realRange.title === "feat(virtual-commits): let humans review AI-sized diffs in reading order",
        "public Demo commit metadata is curated instead of leaking Git identity fields": (() => {
            const metadata = JSON.stringify({
                commit: realRange.commit,
                focusedCommit: realRange.focusedCommit,
                branchCommits: initial.revisions.map((item) => item.branchCommit),
            });
            return realRange.commit?.author === "Ne9roni"
                && realRange.focusedCommit?.meta.startsWith("Ne9roni / ")
                && !/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/iu.test(metadata)
                && !/(?:co-authored-by|signed-off-by|reviewed-by|change-id):/iu.test(metadata);
        })(),
        "static context and Markdown preview work after lazy fragment loading": expandedContext.lines > 0
            && expandedContext.highlighted > 0
            && preview.heading === "local-mr"
            && preview.error === "",
        "language-aware syntax highlighting survives lazy fragments": syntaxHighlight.language === "mjs"
            && syntaxHighlight.tokenCount > 0
            && syntaxHighlight.keywordCount > 0
            && syntaxHighlight.functionCount > 0
            && syntaxHighlight.stringCount > 0
            && new Set(syntaxHighlight.colors).size === 3,
        "each source keeps a matching line-by-line entry point": initial.layouts === 2
            && realLineLayout.selected === "Line-by-line"
            && realLineLayout.hasLineTable
            && !realLineLayout.hasSplitTable
            && realLineLayout.selection.mode === "single"
            && virtualLineLayout.selected === "Line-by-line"
            && virtualLineLayout.activeSource === "virtual"
            && virtualLineLayout.selectedCommit === virtualLineLayout.firstCommit,
        "Overview offers the same MR as six architectural steps": overviewInitial.commits === 6
            && overviewInitial.mode === "single"
            && overviewInitial.activeSource === "virtual"
            && overviewInitial.revision === 1
            && overviewInitial.revisionTrigger.includes("R1")
            && overviewInitial.revisionTrigger.includes("Overview")
            && overviewInitial.selectedLayout === "Line-by-line"
            && overviewInitial.contextTitle === "Read the contract before the implementation"
            && overviewInitial.activePath === "docs/virtual-commits.md",
        "both Virtual revisions and Real render the identical complete Diff": overviewVirtualRange.patchId === virtualRange.patchId
            && overviewRealRange.patchId === virtualRange.patchId
            && overviewVirtualRange.focusItems === 6
            && JSON.stringify(overviewVirtualRange.files) === JSON.stringify(virtualRange.files)
            && JSON.stringify(overviewRealRange.files) === JSON.stringify(virtualRange.files),
        "source and revision switches preserve revision intent and Diff layout": overviewRealRange.selectedLayout === "Line-by-line"
            && overviewRealRange.activeSource === "real"
            && overviewRealRange.virtualUrl.endsWith("/overview-line.html")
            && overviewVirtualReturn.revision === 1
            && overviewVirtualReturn.selectedLayout === "Line-by-line"
            && overviewVirtualReturn.activeSource === "virtual"
            && deepVirtualReturn.revision === 2
            && deepVirtualReturn.revisionTrigger.includes("Deep review")
            && deepVirtualReturn.selectedLayout === "Line-by-line"
            && deepVirtualReturn.activeSource === "virtual",
    };
    printPublicTestReport({
        demoUrl,
        initial,
        secondVirtual,
        virtualRange: { ...virtualRange, files: virtualRange.files.length },
        expandedContext,
        preview,
        syntaxHighlight,
        realRange: { ...realRange, files: realRange.files.length },
        realSingle,
        realLineLayout,
        virtualLineLayout,
        overviewInitial,
        overviewVirtualRange: { ...overviewVirtualRange, files: overviewVirtualRange.files.length },
        overviewRealRange: { ...overviewRealRange, files: overviewRealRange.files.length },
        overviewVirtualReturn,
        deepVirtualReturn,
        checks,
    });
    if (Object.values(checks).some((passed) => !passed)) process.exitCode = 1;
} finally {
    browser?.close();
    await new Promise((resolve) => server.close(resolve));
    await delay(150);
    fs.rmSync(profile, { recursive: true, force: true });
}
