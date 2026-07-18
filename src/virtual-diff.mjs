import crypto from "node:crypto";

const utf8Decoder = new TextDecoder("utf-8", {
    fatal: true,
    ignoreBOM: true,
});

const assertString = (value, name) => {
    if (typeof value !== "string") {
        throw new TypeError(`${name} must be a string`);
    }
};

const splitText = (text) => {
    const endsWithNewline = text.endsWith("\n");
    if (text.length === 0) {
        return { text, lines: [], endsWithNewline: false };
    }
    return {
        text,
        lines: (endsWithNewline ? text.slice(0, -1) : text).split("\n"),
        endsWithNewline,
    };
};

const joinText = (lines, endsWithNewline) => {
    if (lines.length === 0) {
        if (endsWithNewline) {
            throw new Error("an empty file cannot have a final newline");
        }
        return "";
    }
    return `${lines.join("\n")}${endsWithNewline ? "\n" : ""}`;
};

const diffCoordinateToIndex = (start, count, label) => {
    if (!Number.isSafeInteger(start) || start < 0) {
        throw new Error(`${label} start must be a non-negative safe integer`);
    }
    if (!Number.isSafeInteger(count) || count < 0) {
        throw new Error(`${label} count must be a non-negative safe integer`);
    }
    if (count > 0 && start === 0) {
        throw new Error(`${label} start must be at least 1 when count is non-zero`);
    }
    return count === 0 ? start : start - 1;
};

const indexToDiffCoordinate = (index, count) => count === 0 ? index : index + 1;

const equalLines = (left, right) => left.length === right.length
    && left.every((line, index) => line === right[index]);

const blockHash = (block) => crypto.createHash("sha256")
    .update(JSON.stringify({
        version: 1,
        fileId: block.fileId,
        oldStart: block.oldStart,
        oldCount: block.oldCount,
        newStart: block.newStart,
        newCount: block.newCount,
        oldLines: block.oldLines,
        newLines: block.newLines,
        changesFinalNewline: block.changesFinalNewline,
    }))
    .digest("hex");

const decodeRawUtf8 = (value, name) => {
    if (typeof value === "string") return value;
    if (!(value instanceof Uint8Array)) {
        throw new TypeError(`${name} must be a string, Buffer, or Uint8Array`);
    }
    try {
        return utf8Decoder.decode(value);
    } catch {
        throw new Error(`${name} is not valid UTF-8`);
    }
};

export const decodeUtf8Text = (buffer) => {
    if (!(buffer instanceof Uint8Array)) {
        throw new TypeError("buffer must be a Buffer or Uint8Array");
    }
    if (buffer.includes(0)) return null;
    try {
        return splitText(utf8Decoder.decode(buffer));
    } catch {
        return null;
    }
};

export const parseRawDiffZ = (bufferOrString) => {
    const text = decodeRawUtf8(bufferOrString, "raw diff");
    if (text.length === 0) return [];
    if (!text.endsWith("\0")) {
        throw new Error("raw diff must end with a NUL byte");
    }

    const fields = text.split("\0");
    fields.pop();
    const records = [];
    for (let index = 0; index < fields.length;) {
        const header = fields[index];
        index += 1;
        const match = /^:([0-7]{6}) ([0-7]{6}) ([0-9a-fA-F]+) ([0-9a-fA-F]+) ([A-Z])(\d*)$/.exec(header);
        if (!match) {
            throw new Error(`invalid raw diff record header: ${JSON.stringify(header)}`);
        }
        const [, oldMode, newMode, oldOid, newOid, status, scoreText] = match;
        const hasTwoPaths = status === "R" || status === "C";
        if (scoreText && !hasTwoPaths) {
            throw new Error(`raw diff status ${status} cannot have a similarity score`);
        }
        if (!scoreText && hasTwoPaths) {
            throw new Error(`raw diff status ${status} requires a similarity score`);
        }
        if (index >= fields.length || fields[index].length === 0) {
            throw new Error("raw diff record is missing its path");
        }
        const oldPath = fields[index];
        index += 1;
        let newPath = oldPath;
        if (hasTwoPaths) {
            if (index >= fields.length || fields[index].length === 0) {
                throw new Error(`raw diff ${status} record is missing its destination path`);
            }
            newPath = fields[index];
            index += 1;
        }
        const score = scoreText ? Number.parseInt(scoreText, 10) : null;
        if (score !== null && (score < 0 || score > 100)) {
            throw new Error(`invalid raw diff similarity score: ${scoreText}`);
        }
        records.push({
            oldMode,
            newMode,
            oldOid,
            newOid,
            status,
            score,
            oldPath,
            newPath,
        });
    }
    return records;
};

const hunkHeader = (line) => {
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:.*)$/.exec(line);
    if (!match) return null;
    return {
        oldStart: Number.parseInt(match[1], 10),
        oldCount: match[2] === undefined ? 1 : Number.parseInt(match[2], 10),
        newStart: Number.parseInt(match[3], 10),
        newCount: match[4] === undefined ? 1 : Number.parseInt(match[4], 10),
    };
};

const validateNoNewlineMarker = ({ previous, base, target }) => {
    if (!previous || previous.markedNoNewline) {
        throw new Error("orphan or duplicate 'No newline at end of file' marker");
    }
    const oldMatches = previous.oldIndex !== null
        && previous.oldIndex === base.lines.length - 1
        && !base.endsWithNewline;
    const newMatches = previous.newIndex !== null
        && previous.newIndex === target.lines.length - 1
        && !target.endsWithNewline;
    if (!oldMatches && !newMatches) {
        throw new Error("'No newline at end of file' marker does not refer to an unterminated final line");
    }
    previous.markedNoNewline = true;
};

const validateBlockOrder = (blocks) => {
    let previous = null;
    for (const block of blocks) {
        const oldIndex = diffCoordinateToIndex(block.oldStart, block.oldCount, "block old");
        const newIndex = diffCoordinateToIndex(block.newStart, block.newCount, "block new");
        if (previous) {
            const oldCollision = oldIndex < previous.oldEnd
                || (oldIndex === previous.oldIndex
                    && (block.oldCount === 0 || previous.oldCount === 0));
            const newCollision = newIndex < previous.newEnd
                || (newIndex === previous.newIndex
                    && (block.newCount === 0 || previous.newCount === 0));
            if (oldCollision || newCollision) {
                throw new Error("diff blocks overlap or are not in monotonic order");
            }
        }
        previous = {
            oldIndex,
            oldCount: block.oldCount,
            oldEnd: oldIndex + block.oldCount,
            newIndex,
            newCount: block.newCount,
            newEnd: newIndex + block.newCount,
        };
    }
};

const materializeLines = (baseLines, blocks, selectedIds) => {
    const result = [];
    let cursor = 0;
    for (const block of blocks) {
        const oldIndex = diffCoordinateToIndex(block.oldStart, block.oldCount, "block old");
        result.push(...baseLines.slice(cursor, oldIndex));
        if (selectedIds.has(block.id)) {
            result.push(...block.newLines);
        } else {
            result.push(...baseLines.slice(oldIndex, oldIndex + block.oldCount));
        }
        cursor = oldIndex + block.oldCount;
    }
    result.push(...baseLines.slice(cursor));
    return result;
};

export const parseZeroContextDiff = ({ patchText, fileId, baseText, targetText }) => {
    assertString(patchText, "patchText");
    assertString(fileId, "fileId");
    assertString(baseText, "baseText");
    assertString(targetText, "targetText");
    if (fileId.length === 0) throw new Error("fileId must not be empty");
    if (baseText.includes("\0") || targetText.includes("\0")) {
        throw new Error("baseText and targetText must be textual and contain no NUL characters");
    }

    const base = splitText(baseText);
    const target = splitText(targetText);
    const patchLines = patchText.split("\n");
    const parsedBlocks = [];
    let lineIndex = 0;
    let sawHunk = false;

    while (lineIndex < patchLines.length) {
        const header = hunkHeader(patchLines[lineIndex]);
        if (!header) {
            const line = patchLines[lineIndex];
            const isFinalEmptyLine = line.length === 0 && lineIndex === patchLines.length - 1;
            if (sawHunk && !isFinalEmptyLine) {
                throw new Error(`unexpected line after diff hunk: ${JSON.stringify(line)}`);
            }
            lineIndex += 1;
            continue;
        }
        sawHunk = true;
        lineIndex += 1;

        const hunkOldIndex = diffCoordinateToIndex(header.oldStart, header.oldCount, "hunk old");
        const hunkNewIndex = diffCoordinateToIndex(header.newStart, header.newCount, "hunk new");
        if (hunkOldIndex + header.oldCount > base.lines.length
            || hunkNewIndex + header.newCount > target.lines.length) {
            throw new Error("diff hunk coordinates exceed the supplied file contents");
        }

        let oldIndex = hunkOldIndex;
        let newIndex = hunkNewIndex;
        let oldConsumed = 0;
        let newConsumed = 0;
        let current = null;
        let previous = null;

        const finishCurrent = () => {
            if (!current) return;
            const oldLines = base.lines.slice(current.oldIndex, oldIndex);
            const newLines = target.lines.slice(current.newIndex, newIndex);
            parsedBlocks.push({
                fileId,
                oldStart: indexToDiffCoordinate(current.oldIndex, oldLines.length),
                oldCount: oldLines.length,
                newStart: indexToDiffCoordinate(current.newIndex, newLines.length),
                newCount: newLines.length,
                oldLines,
                newLines,
                changesFinalNewline: false,
            });
            current = null;
        };

        while (oldConsumed < header.oldCount || newConsumed < header.newCount) {
            if (lineIndex >= patchLines.length) {
                throw new Error("truncated diff hunk");
            }
            const line = patchLines[lineIndex];
            lineIndex += 1;
            if (line === "\\ No newline at end of file") {
                validateNoNewlineMarker({ previous, base, target });
                continue;
            }
            const prefix = line[0];
            const payload = line.slice(1);
            if (prefix === " ") {
                finishCurrent();
                if (oldConsumed >= header.oldCount || newConsumed >= header.newCount) {
                    throw new Error("context line exceeds diff hunk counts");
                }
                if (base.lines[oldIndex] !== payload || target.lines[newIndex] !== payload) {
                    throw new Error("diff context does not match the supplied file contents");
                }
                previous = { oldIndex, newIndex, markedNoNewline: false };
                oldIndex += 1;
                newIndex += 1;
                oldConsumed += 1;
                newConsumed += 1;
            } else if (prefix === "-") {
                if (oldConsumed >= header.oldCount) {
                    throw new Error("deletion line exceeds diff hunk old count");
                }
                current ||= { oldIndex, newIndex };
                if (base.lines[oldIndex] !== payload) {
                    throw new Error("diff deletion does not match baseText");
                }
                previous = { oldIndex, newIndex: null, markedNoNewline: false };
                oldIndex += 1;
                oldConsumed += 1;
            } else if (prefix === "+") {
                if (newConsumed >= header.newCount) {
                    throw new Error("addition line exceeds diff hunk new count");
                }
                current ||= { oldIndex, newIndex };
                if (target.lines[newIndex] !== payload) {
                    throw new Error("diff addition does not match targetText");
                }
                previous = { oldIndex: null, newIndex, markedNoNewline: false };
                newIndex += 1;
                newConsumed += 1;
            } else {
                throw new Error(`invalid diff hunk line: ${JSON.stringify(line)}`);
            }
        }

        while (lineIndex < patchLines.length
            && patchLines[lineIndex] === "\\ No newline at end of file") {
            validateNoNewlineMarker({ previous, base, target });
            lineIndex += 1;
        }
        finishCurrent();
        if (oldIndex !== hunkOldIndex + header.oldCount
            || newIndex !== hunkNewIndex + header.newCount) {
            throw new Error("diff hunk counts do not match its body");
        }
    }

    validateBlockOrder(parsedBlocks);
    const provisionalBlocks = parsedBlocks.map((block, index) => ({
        ...block,
        id: `provisional-${index}`,
    }));
    const provisionalIds = new Set(provisionalBlocks.map((block) => block.id));
    const lineResult = materializeLines(base.lines, provisionalBlocks, provisionalIds);
    if (!equalLines(lineResult, target.lines)) {
        throw new Error("diff blocks do not reproduce targetText line contents");
    }

    if (base.endsWithNewline !== target.endsWithNewline) {
        const eofBlock = [...parsedBlocks].reverse().find((block) => {
            const oldIndex = diffCoordinateToIndex(block.oldStart, block.oldCount, "block old");
            const newIndex = diffCoordinateToIndex(block.newStart, block.newCount, "block new");
            return oldIndex + block.oldCount === base.lines.length
                && newIndex + block.newCount === target.lines.length;
        });
        if (eofBlock) {
            eofBlock.changesFinalNewline = true;
        } else {
            if (base.lines.length === 0 || target.lines.length === 0
                || base.lines.at(-1) !== target.lines.at(-1)) {
                throw new Error("diff does not account for the final-newline change");
            }
            parsedBlocks.push({
                fileId,
                oldStart: base.lines.length,
                oldCount: 1,
                newStart: target.lines.length,
                newCount: 1,
                oldLines: [base.lines.at(-1)],
                newLines: [target.lines.at(-1)],
                changesFinalNewline: true,
            });
            validateBlockOrder(parsedBlocks);
        }
    }

    const blocks = parsedBlocks.map((block) => ({
        id: blockHash(block),
        ...block,
    }));
    const materialized = materializeText({
        baseText,
        targetText,
        blocks,
        selectedBlockIds: blocks.map((block) => block.id),
    });
    if (materialized !== targetText) {
        throw new Error("diff blocks do not reproduce targetText exactly");
    }
    return blocks;
};

export const materializeText = ({ baseText, targetText, blocks, selectedBlockIds }) => {
    assertString(baseText, "baseText");
    assertString(targetText, "targetText");
    if (!Array.isArray(blocks)) throw new TypeError("blocks must be an array");
    if (!Array.isArray(selectedBlockIds)) {
        throw new TypeError("selectedBlockIds must be an array");
    }

    const base = splitText(baseText);
    const target = splitText(targetText);
    const blockIds = new Set();
    for (const block of blocks) {
        if (!block || typeof block !== "object") throw new TypeError("each block must be an object");
        if (typeof block.id !== "string" || block.id.length === 0) {
            throw new Error("each block must have a non-empty string id");
        }
        if (blockIds.has(block.id)) throw new Error(`duplicate block id: ${block.id}`);
        blockIds.add(block.id);
        if (!Array.isArray(block.oldLines) || !block.oldLines.every((line) => typeof line === "string")
            || !Array.isArray(block.newLines) || !block.newLines.every((line) => typeof line === "string")) {
            throw new Error(`block ${block.id} must contain string oldLines and newLines arrays`);
        }
        if (block.oldLines.length !== block.oldCount || block.newLines.length !== block.newCount) {
            throw new Error(`block ${block.id} line arrays do not match its counts`);
        }
        const oldIndex = diffCoordinateToIndex(block.oldStart, block.oldCount, `block ${block.id} old`);
        const newIndex = diffCoordinateToIndex(block.newStart, block.newCount, `block ${block.id} new`);
        if (oldIndex + block.oldCount > base.lines.length
            || !equalLines(base.lines.slice(oldIndex, oldIndex + block.oldCount), block.oldLines)) {
            throw new Error(`block ${block.id} does not match baseText`);
        }
        if (newIndex + block.newCount > target.lines.length
            || !equalLines(target.lines.slice(newIndex, newIndex + block.newCount), block.newLines)) {
            throw new Error(`block ${block.id} does not match targetText`);
        }
        if (typeof block.changesFinalNewline !== "boolean") {
            throw new Error(`block ${block.id} must declare changesFinalNewline`);
        }
        if (block.changesFinalNewline) {
            if (base.endsWithNewline === target.endsWithNewline
                || oldIndex + block.oldCount !== base.lines.length
                || newIndex + block.newCount !== target.lines.length) {
                throw new Error(`block ${block.id} has an invalid final-newline marker`);
            }
        }
    }
    validateBlockOrder(blocks);

    const selected = new Set();
    for (const id of selectedBlockIds) {
        if (typeof id !== "string") throw new TypeError("selected block ids must be strings");
        if (selected.has(id)) throw new Error(`duplicate selected block id: ${id}`);
        if (!blockIds.has(id)) throw new Error(`unknown selected block id: ${id}`);
        selected.add(id);
    }

    const lines = materializeLines(base.lines, blocks, selected);
    const selectsFinalNewlineChange = blocks.some((block) => (
        block.changesFinalNewline && selected.has(block.id)
    ));
    const result = joinText(
        lines,
        selectsFinalNewlineChange ? target.endsWithNewline : base.endsWithNewline,
    );
    if (selected.size === blocks.length && result !== targetText) {
        throw new Error("selecting every block must reproduce targetText exactly");
    }
    return result;
};
