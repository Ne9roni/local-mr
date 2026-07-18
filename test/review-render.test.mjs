import assert from "node:assert/strict";
import test from "node:test";

import {
    injectReviewUi,
    patchSummary,
    renderDiffDocument,
    splitRenderedReview,
} from "../src/review-render.mjs";

test("injectReviewUi provides the same escaped client-data boundary to every review source", () => {
    const result = injectReviewUi({
        html: "<!doctype html><html><head><title>Review</title></head><body></body></html>",
        fragment: '<style id="local-mr-review-ui"></style>',
        versionData: { source: "virtual", unsafe: "</script><b>&" },
    });
    assert.match(result, /id="local-mr-version-data"/);
    assert.match(result, /id="local-mr-review-ui"/);
    assert.doesNotMatch(result, /<\/script><b>/);
    assert.match(result, /\\u003c\/script\\u003e\\u003cb\\u003e\\u0026/);
    assert.throws(() => injectReviewUi({ html: "<html>", fragment: "", versionData: {} }), /<\/head>/);
});

test("renderDiffDocument renders a standalone diff without a browser runtime", () => {
    const patch = `diff --git a/a.txt b/a.txt
--- a/a.txt
+++ b/a.txt
@@ -1 +1 @@
-old
+new
`;
    const html = renderDiffDocument({
        patchText: patch,
        style: "side",
        color: "dark",
        title: "A < B",
        stylesheet: ".d2h-wrapper{display:block}",
    });
    assert.match(html, /<!doctype html>/i);
    assert.match(html, /d2h-file-list-wrapper/);
    assert.match(html, /d2h-file-wrapper/);
    assert.match(html, /d2h-dark-color-scheme/);
    assert.match(html, /A &lt; B/);
    assert.doesNotMatch(html, /Diff2HtmlUI|<script/);
});

test("splitRenderedReview keeps one file in the shell and indexes every fragment", () => {
    const html = `<!doctype html><html><head>
<link rel="stylesheet" href="https://cdn.example/highlight.js/theme.css">
<script>window.Diff2HtmlUI = function heavyweightRuntime() {};</script>
</head><body>
<h1>Local MR</h1>
<div id="diff"><div class="d2h-file-list-wrapper">files</div><div class="d2h-wrapper">
<div id="d2h-101" class="d2h-file-wrapper"><div><div>nested</div></div></div>
<div class="other d2h-file-wrapper" id="d2h-202"><div>second</div></div>
<div id="d2h-303" data-kind="x" class="wide d2h-file-wrapper final"><div>third</div></div>
</div></div></body></html>`;

    const result = splitRenderedReview(html);

    assert.deepEqual(result.wrapperIds, ["d2h-101", "d2h-202", "d2h-303"]);
    assert.equal((result.shellHtml.match(/d2h-file-wrapper/g) || []).length, 1);
    assert.equal((result.diffHtml.match(/d2h-file-wrapper/g) || []).length, 1);
    assert.match(result.shellHtml, /id="d2h-101"/);
    assert.doesNotMatch(result.shellHtml, /id="d2h-202"/);
    assert.doesNotMatch(result.shellHtml, /Diff2HtmlUI|highlight\.js/);
    assert.match(result.fragments.get("d2h-101"), /nested/);
    assert.match(result.fragments.get("d2h-202"), /second/);
    assert.match(result.fragments.get("d2h-303"), /third/);
});

test("splitRenderedReview keeps an empty committed comparison renderable", () => {
    const html = renderDiffDocument({
        patchText: "",
        style: "side",
        color: "auto",
        title: "No committed changes",
        stylesheet: "",
    });
    const result = splitRenderedReview(html);

    assert.deepEqual(result.wrapperIds, []);
    assert.equal(result.fragments.size, 0);
    assert.match(result.diffHtml, /d2h-file-list-wrapper/);
    assert.match(result.diffHtml, /d2h-wrapper/);
});

test("splitRenderedReview disambiguates colliding diff2html wrapper ids", () => {
    const result = splitRenderedReview(`<div id="diff">
<div class="d2h-file-list-wrapper"><a href="#same">first</a><a href="#same">second</a></div>
<div class="d2h-wrapper"><div id="same" class="d2h-file-wrapper">one</div><div id="same" class="d2h-file-wrapper">two</div></div>
</div>`);

    assert.deepEqual(result.wrapperIds, ["same", "same-2"]);
    assert.match(result.diffHtml, /href="#same">first/);
    assert.match(result.diffHtml, /href="#same-2">second/);
    assert.match(result.fragments.get("same-2"), />two</);
});

test("splitRenderedReview rejects malformed wrappers", () => {
    assert.throws(
        () => splitRenderedReview('<div id="diff"><div id="broken" class="d2h-file-wrapper"><div></div>'),
        /unclosed/i,
    );
});

test("patchSummary counts files and changed lines without counting headers", () => {
    const patch = `diff --git a/one.txt b/one.txt
--- a/one.txt
+++ b/one.txt
@@ -1,2 +1,3 @@
-old
+new
+added
 context
diff --git a/two.txt b/two.txt
new file mode 100644
--- /dev/null
+++ b/two.txt
@@ -0,0 +1 @@
+hello
`;

    assert.deepEqual(patchSummary(patch), {
        files: 2,
        insertions: 3,
        deletions: 1,
        empty: false,
        shortstat: "2 files changed, 3 insertions(+), 1 deletion(-)",
    });
    assert.deepEqual(patchSummary(""), {
        files: 0,
        insertions: 0,
        deletions: 0,
        empty: true,
        shortstat: "",
    });
});
