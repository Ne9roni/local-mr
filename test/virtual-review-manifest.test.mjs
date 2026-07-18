import assert from "node:assert/strict";
import test from "node:test";

import {
    ManifestValidationError,
    validateVirtualReviewManifest,
} from "../src/virtual-review-manifest.mjs";

const source = {
    sourceId: "a".repeat(64),
    files: [
        {
            oldPath: "src/app.mjs",
            newPath: "src/app.mjs",
            blocks: [{ id: "block-a" }, { id: "block-b" }],
        },
        {
            oldPath: "test/app.test.mjs",
            newPath: "test/app.test.mjs",
            blocks: [{ id: "block-c" }],
        },
    ],
};

const validManifest = () => ({
    schemaVersion: 1,
    title: "Review the behavior change",
    strategy: "Read production behavior before coverage",
    overview: {
        summary: "The change updates two behaviors and their test.",
        routeRationale: "Start with the highest-risk return value.",
        uncertainties: [],
    },
    virtualCommits: [
        {
            title: "Update the core behavior",
            intent: "Change the primary return value.",
            reviewFocus: [{
                text: "Check the new return contract.",
                targets: ["block:block-a"],
            }],
            risk: { level: "high", reason: "Callers depend on this value." },
            blocks: ["block-a"],
        },
        {
            title: "Complete the behavior and coverage",
            intent: "Update the secondary behavior and test it.",
            reviewFocus: [{
                text: "Check that the test covers the changed behavior.",
                targets: ["block:block-b", "file:test/app.test.mjs"],
            }],
            risk: { level: "medium", reason: "This closes the behavior path." },
            blocks: ["block-b", "block-c"],
        },
    ],
});

test("validateVirtualReviewManifest normalizes a complete strict partition", () => {
    const normalized = validateVirtualReviewManifest({ source, manifest: validManifest() });
    assert.equal(normalized.schemaVersion, 1);
    assert.deepEqual(normalized.virtualCommits.flatMap((commit) => commit.blocks), [
        "block-a",
        "block-b",
        "block-c",
    ]);
    assert.match(normalized.virtualCommits[0].id, /^[a-f0-9]{24}$/);
    assert.equal(
        normalized.virtualCommits[0].id,
        validateVirtualReviewManifest({ source, manifest: validManifest() }).virtualCommits[0].id,
    );
});

test("validateVirtualReviewManifest reports missing and duplicate blocks without repairing them", () => {
    const manifest = validManifest();
    manifest.virtualCommits[1].blocks = ["block-a"];
    assert.throws(
        () => validateVirtualReviewManifest({ source, manifest }),
        (error) => {
            assert.ok(error instanceof ManifestValidationError);
            assert.equal(error.code, "INVALID_MANIFEST");
            assert.ok(error.details.some((item) => item.code === "DUPLICATE_BLOCK" && item.blockId === "block-a"));
            assert.ok(error.details.some((item) => item.code === "MISSING_BLOCK" && item.blockId === "block-b"));
            assert.ok(error.details.some((item) => item.code === "MISSING_BLOCK" && item.blockId === "block-c"));
            return true;
        },
    );
});

test("validateVirtualReviewManifest rejects unanchored or unknown review guidance", () => {
    const manifest = validManifest();
    manifest.virtualCommits[0].reviewFocus[0].targets = [];
    manifest.overview.uncertainties = [{ text: "Unknown ownership", targets: ["file:missing.mjs"] }];
    assert.throws(
        () => validateVirtualReviewManifest({ source, manifest }),
        (error) => error.details.some((item) => item.code === "INVALID_TARGETS")
            && error.details.some((item) => item.code === "UNKNOWN_TARGET"),
    );
});
