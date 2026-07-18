import assert from "node:assert/strict";
import test from "node:test";

import {
    decodeUtf8Text,
    materializeText,
    parseRawDiffZ,
    parseZeroContextDiff,
} from "../src/virtual-diff.mjs";

test("decodeUtf8Text preserves Unicode and CRLF payloads", () => {
    assert.deepEqual(decodeUtf8Text(Buffer.from("hé\r\n世界", "utf8")), {
        text: "hé\r\n世界",
        lines: ["hé\r", "世界"],
        endsWithNewline: false,
    });
    assert.deepEqual(decodeUtf8Text(Buffer.from("one\ntwo\n", "utf8")), {
        text: "one\ntwo\n",
        lines: ["one", "two"],
        endsWithNewline: true,
    });
    assert.equal(decodeUtf8Text(Buffer.from([0x61, 0x00, 0x62])), null);
    assert.equal(decodeUtf8Text(Buffer.from([0xc3, 0x28])), null);
});

test("parseRawDiffZ parses ordinary and Unicode rename records without path quoting", () => {
    const raw = [
        ":100644 100755 abc1234 def5678 M\0folder/file with spaces.txt\0",
        ":100644 100644 1111111 2222222 R100\0old name.txt\0新 name.txt\0",
    ].join("");
    assert.deepEqual(parseRawDiffZ(Buffer.from(raw)), [
        {
            oldMode: "100644",
            newMode: "100755",
            oldOid: "abc1234",
            newOid: "def5678",
            status: "M",
            score: null,
            oldPath: "folder/file with spaces.txt",
            newPath: "folder/file with spaces.txt",
        },
        {
            oldMode: "100644",
            newMode: "100644",
            oldOid: "1111111",
            newOid: "2222222",
            status: "R",
            score: 100,
            oldPath: "old name.txt",
            newPath: "新 name.txt",
        },
    ]);
    assert.throws(() => parseRawDiffZ(":100644 100644 aaa bbb M\0missing terminator"), /NUL/);
});

test("parseZeroContextDiff creates deterministic blocks for multiple replacements", () => {
    const baseText = "alpha\nold one\nstable\nold two\ntail\n";
    const targetText = "alpha\nnew one\nstable\nnew two\nextra\ntail\n";
    const patchText = [
        "diff --git a/example.txt b/example.txt",
        "--- a/example.txt",
        "+++ b/example.txt",
        "@@ -2 +2 @@",
        "-old one",
        "+new one",
        "@@ -4 +4,2 @@",
        "-old two",
        "+new two",
        "+extra",
        "",
    ].join("\n");
    const blocks = parseZeroContextDiff({
        patchText,
        fileId: "file-1",
        baseText,
        targetText,
    });

    assert.equal(blocks.length, 2);
    assert.deepEqual(blocks.map(({ id, ...block }) => block), [
        {
            fileId: "file-1",
            oldStart: 2,
            oldCount: 1,
            newStart: 2,
            newCount: 1,
            oldLines: ["old one"],
            newLines: ["new one"],
            changesFinalNewline: false,
        },
        {
            fileId: "file-1",
            oldStart: 4,
            oldCount: 1,
            newStart: 4,
            newCount: 2,
            oldLines: ["old two"],
            newLines: ["new two", "extra"],
            changesFinalNewline: false,
        },
    ]);
    assert.match(blocks[0].id, /^[0-9a-f]{64}$/);
    assert.deepEqual(
        blocks.map((block) => block.id),
        parseZeroContextDiff({ patchText, fileId: "file-1", baseText, targetText })
            .map((block) => block.id),
    );
    assert.equal(materializeText({
        baseText,
        targetText,
        blocks,
        selectedBlockIds: [blocks[1].id],
    }), "alpha\nold one\nstable\nnew two\nextra\ntail\n");
    assert.equal(materializeText({
        baseText,
        targetText,
        blocks,
        selectedBlockIds: blocks.map((block) => block.id),
    }), targetText);
});

test("parseZeroContextDiff preserves CRLF and Unicode lines", () => {
    const baseText = "a\r\nold\r\nz\r\n";
    const targetText = "a\r\n新\r\nz\r\n";
    const patchText = [
        "--- a/crlf.txt",
        "+++ b/crlf.txt",
        "@@ -2 +2 @@",
        "-old\r",
        "+新\r",
        "",
    ].join("\n");
    const blocks = parseZeroContextDiff({
        patchText,
        fileId: "crlf",
        baseText,
        targetText,
    });
    assert.deepEqual(blocks[0].oldLines, ["old\r"]);
    assert.deepEqual(blocks[0].newLines, ["新\r"]);
    assert.equal(materializeText({
        baseText,
        targetText,
        blocks,
        selectedBlockIds: [blocks[0].id],
    }), targetText);
});

test("pure insertion and deletion use unified-diff zero-count coordinates", () => {
    const addTarget = "one\n二\n";
    const addBlocks = parseZeroContextDiff({
        patchText: "--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1,2 @@\n+one\n+二\n",
        fileId: "added",
        baseText: "",
        targetText: addTarget,
    });
    assert.deepEqual({
        oldStart: addBlocks[0].oldStart,
        oldCount: addBlocks[0].oldCount,
        newStart: addBlocks[0].newStart,
        newCount: addBlocks[0].newCount,
    }, { oldStart: 0, oldCount: 0, newStart: 1, newCount: 2 });
    assert.equal(materializeText({
        baseText: "",
        targetText: addTarget,
        blocks: addBlocks,
        selectedBlockIds: [addBlocks[0].id],
    }), addTarget);

    const deleteBase = "gone\n";
    const deleteBlocks = parseZeroContextDiff({
        patchText: "--- a/gone.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-gone\n",
        fileId: "deleted",
        baseText: deleteBase,
        targetText: "",
    });
    assert.deepEqual({
        oldStart: deleteBlocks[0].oldStart,
        oldCount: deleteBlocks[0].oldCount,
        newStart: deleteBlocks[0].newStart,
        newCount: deleteBlocks[0].newCount,
    }, { oldStart: 1, oldCount: 1, newStart: 0, newCount: 0 });
    assert.equal(materializeText({
        baseText: deleteBase,
        targetText: "",
        blocks: deleteBlocks,
        selectedBlockIds: [deleteBlocks[0].id],
    }), "");
});

test("a trailing-newline-only edit is a selectable EOF block", () => {
    const baseText = "alpha\nomega";
    const targetText = "alpha\nomega\n";
    const blocks = parseZeroContextDiff({
        patchText: [
            "--- a/example.txt",
            "+++ b/example.txt",
            "@@ -2 +2 @@",
            "-omega",
            "\\ No newline at end of file",
            "+omega",
            "",
        ].join("\n"),
        fileId: "newline",
        baseText,
        targetText,
    });
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].changesFinalNewline, true);
    assert.deepEqual(blocks[0].oldLines, ["omega"]);
    assert.deepEqual(blocks[0].newLines, ["omega"]);
    assert.equal(materializeText({
        baseText,
        targetText,
        blocks,
        selectedBlockIds: [],
    }), baseText);
    assert.equal(materializeText({
        baseText,
        targetText,
        blocks,
        selectedBlockIds: [blocks[0].id],
    }), targetText);
});

test("materializeText rejects unknown, duplicate, and overlapping blocks", () => {
    const baseText = "a\nb\nc\n";
    const targetText = "A\nB\nc\n";
    const blocks = parseZeroContextDiff({
        patchText: "@@ -1,2 +1,2 @@\n-a\n-b\n+A\n+B\n",
        fileId: "strict",
        baseText,
        targetText,
    });
    assert.throws(() => materializeText({
        baseText,
        targetText,
        blocks,
        selectedBlockIds: ["missing"],
    }), /unknown/);
    assert.throws(() => materializeText({
        baseText,
        targetText,
        blocks,
        selectedBlockIds: [blocks[0].id, blocks[0].id],
    }), /duplicate selected/);

    const overlapping = [
        {
            ...blocks[0],
            id: "first",
            oldCount: 1,
            newCount: 1,
            oldLines: ["a"],
            newLines: ["A"],
        },
        {
            ...blocks[0],
            id: "second",
            oldStart: 1,
            oldCount: 1,
            newStart: 1,
            newCount: 1,
            oldLines: ["a"],
            newLines: ["A"],
        },
    ];
    assert.throws(() => materializeText({
        baseText,
        targetText,
        blocks: overlapping,
        selectedBlockIds: [],
    }), /overlap/);
});

test("parseZeroContextDiff rejects patches that disagree with source-of-truth text", () => {
    assert.throws(() => parseZeroContextDiff({
        patchText: "@@ -1 +1 @@\n-wrong\n+new\n",
        fileId: "bad",
        baseText: "old\n",
        targetText: "new\n",
    }), /does not match baseText/);
});
