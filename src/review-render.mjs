import Diff2Html from "diff2html";

const htmlEscape = (value) => String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

const safeJson = (value) => JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026");

export const injectReviewUi = ({ html, fragment, versionData }) => {
    const injection = [
        `<script id="local-mr-version-data" type="application/json">${safeJson(versionData)}</script>`,
        fragment,
    ].join("\n");
    if (!html.includes("</head>")) throw new Error("diff2html output does not contain </head>");
    return html.replace("</head>", `${injection}\n</head>`);
};

export const renderDiffDocument = ({ patchText, style, color, title, stylesheet }) => {
    const diffHtml = Diff2Html.html(patchText, {
        colorScheme: color,
        drawFileList: true,
        matching: "lines",
        outputFormat: style === "line" ? "line-by-line" : "side-by-side",
    });
    const safeTitle = htmlEscape(title);
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${safeTitle}</title>
<style>${stylesheet}</style>
</head>
<body style="text-align:center">
<h1>${safeTitle}</h1>
<div id="diff">${diffHtml}</div>
</body>
</html>`;
};

const attributeValue = (tag, name) => {
    const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, "i"));
    return match?.[2] || "";
};

const matchingDivEnd = (html, start, startTag) => {
    const tokenPattern = /<\/?div\b[^>]*>/gi;
    tokenPattern.lastIndex = start + startTag.length;
    let depth = 1;
    let token;
    while ((token = tokenPattern.exec(html))) {
        if (/^<\/div/i.test(token[0])) {
            depth -= 1;
            if (depth === 0) return tokenPattern.lastIndex;
        } else if (!/\/>$/.test(token[0])) {
            depth += 1;
        }
    }
    throw new Error(`Unclosed div starting at byte ${start}`);
};

const divElements = (html, predicate) => {
    const elements = [];
    const startPattern = /<div\b[^>]*>/gi;
    let match;
    while ((match = startPattern.exec(html))) {
        if (!predicate(match[0])) continue;
        const start = match.index;
        const end = matchingDivEnd(html, start, match[0]);
        elements.push({
            start,
            end,
            html: html.slice(start, end),
            id: attributeValue(match[0], "id"),
        });
        startPattern.lastIndex = end;
    }
    return elements;
};

const hasClass = (tag, className) => attributeValue(tag, "class")
    .split(/\s+/)
    .includes(className);

const stripDiff2HtmlRuntime = (html) => html
    .replace(/\s*<script(?:\s[^>]*)?>[\s\S]*?<\/script>\s*/gi, "\n")
    .replace(/\s*<link\b(?=[^>]*\bhref\s*=\s*["'][^"']*highlight\.js)[^>]*>\s*/gi, "\n");

const disambiguateWrapperIds = (diffHtml, wrappers) => {
    const seen = new Map();
    const wrapperIds = wrappers.map((wrapper) => {
        if (!wrapper.id) throw new Error("diff2html file wrapper has no id");
        const occurrence = (seen.get(wrapper.id) || 0) + 1;
        seen.set(wrapper.id, occurrence);
        return occurrence === 1 ? wrapper.id : `${wrapper.id}-${occurrence}`;
    });
    if ([...seen.values()].every((count) => count === 1)) return diffHtml;

    const parts = [];
    let cursor = 0;
    wrappers.forEach((wrapper, index) => {
        parts.push(diffHtml.slice(cursor, wrapper.start));
        const wrapperHtml = wrapper.html.replace(/^<div\b[^>]*>/i, (tag) => tag.replace(
            /\bid\s*=\s*(["']).*?\1/i,
            `id="${wrapperIds[index]}"`,
        ));
        parts.push(wrapperHtml);
        cursor = wrapper.end;
    });
    parts.push(diffHtml.slice(cursor));
    let anchorIndex = 0;
    return parts.join("").replace(
        /(\bhref\s*=\s*["'])#([^"']+)(["'])/gi,
        (match, prefix, target, suffix) => {
            const wrapper = wrappers[anchorIndex];
            if (!wrapper || target !== wrapper.id) return match;
            const replacement = `${prefix}#${wrapperIds[anchorIndex]}${suffix}`;
            anchorIndex += 1;
            return replacement;
        },
    );
};

export const splitRenderedReview = (html) => {
    const bodyStart = html.lastIndexOf("<body");
    const searchableHtml = html.slice(Math.max(0, bodyStart));
    const diff = divElements(
        searchableHtml,
        (tag) => attributeValue(tag, "id") === "diff",
    )[0];
    if (!diff) throw new Error("diff2html output does not contain #diff");
    let diffHtmlSource = diff.html;
    let wrappers = divElements(diffHtmlSource, (tag) => hasClass(tag, "d2h-file-wrapper"));
    if (wrappers.length === 0) {
        return {
            shellHtml: stripDiff2HtmlRuntime(html),
            diffHtml: diff.html,
            fragments: new Map(),
            wrapperIds: [],
        };
    }
    diffHtmlSource = disambiguateWrapperIds(diffHtmlSource, wrappers);
    wrappers = divElements(diffHtmlSource, (tag) => hasClass(tag, "d2h-file-wrapper"));

    const fragments = new Map();
    wrappers.forEach((wrapper) => {
        if (!wrapper.id) throw new Error("diff2html file wrapper has no id");
        if (fragments.has(wrapper.id)) throw new Error(`Could not disambiguate diff wrapper id: ${wrapper.id}`);
        fragments.set(wrapper.id, wrapper.html);
    });

    const shellParts = [];
    let cursor = 0;
    wrappers.forEach((wrapper, index) => {
        shellParts.push(diffHtmlSource.slice(cursor, wrapper.start));
        if (index === 0) shellParts.push(wrapper.html);
        cursor = wrapper.end;
    });
    shellParts.push(diffHtmlSource.slice(cursor));
    const diffHtml = shellParts.join("");
    const absoluteDiffStart = Math.max(0, bodyStart) + diff.start;
    const absoluteDiffEnd = Math.max(0, bodyStart) + diff.end;
    const shellHtml = stripDiff2HtmlRuntime(
        html.slice(0, absoluteDiffStart) + diffHtml + html.slice(absoluteDiffEnd),
    );

    return {
        shellHtml,
        diffHtml,
        fragments,
        wrapperIds: [...fragments.keys()],
    };
};

const plural = (count, singular, pluralForm) => `${count} ${count === 1 ? singular : pluralForm}`;

export const patchSummary = (patchText) => {
    const sections = patchText
        .split(/(?=^diff --git )/m)
        .filter((section) => section.startsWith("diff --git "));
    let insertions = 0;
    let deletions = 0;
    sections.forEach((section) => {
        let inHunk = false;
        section.split("\n").forEach((line) => {
            if (line.startsWith("@@ ")) {
                inHunk = true;
                return;
            }
            if (!inHunk) return;
            if (line.startsWith("+")) insertions += 1;
            if (line.startsWith("-")) deletions += 1;
        });
    });
    const files = sections.length;
    const parts = [];
    if (files > 0) parts.push(plural(files, "file changed", "files changed"));
    if (insertions > 0) parts.push(plural(insertions, "insertion(+)", "insertions(+)"));
    if (deletions > 0) parts.push(plural(deletions, "deletion(-)", "deletions(-)"));
    return {
        files,
        insertions,
        deletions,
        empty: files === 0,
        shortstat: parts.join(", "),
    };
};
