import assert from "node:assert/strict";
import test from "node:test";

import { publicTestReport } from "./helpers/public-report.mjs";

const nonPublicEmail = ["developer", "corp.example"].join("@");

test("public test reports redact ephemeral URLs, paths, and email addresses", () => {
    const report = publicTestReport({
        review: [["http://127.0.0.1:4567", "A".repeat(24)].join("/"), "review"].join("/"),
        opener: `explorer.exe\t${[["http://localhost:4567", "B".repeat(24)].join("/"), "review"].join("/")}`,
        pathname: `/C${"D".repeat(23)}/review`,
        path: ["", "home", "developer", "sample-project"].join("/"),
        email: nonPublicEmail,
    });
    assert.ok(!report.includes("127.0.0.1"));
    assert.ok(!report.includes("sample-project"));
    assert.ok(!report.includes("D".repeat(23)));
    assert.ok(!report.includes(nonPublicEmail));
    assert.match(report, /local review URL redacted/u);
});
