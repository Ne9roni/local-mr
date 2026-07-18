import { spawnSync } from "node:child_process";
import path from "node:path";

import { projectRoot } from "../test/helpers/paths.mjs";

const run = (script, arguments_ = []) => {
    const result = spawnSync(process.execPath, [path.join(projectRoot, "test", script), ...arguments_], {
        cwd: projectRoot,
        stdio: "inherit",
    });
    if (result.status !== 0) process.exit(result.status || 1);
};

if (spawnSync("google-chrome", ["--version"], { stdio: "ignore" }).status !== 0) {
    throw new Error("google-chrome is required for browser regressions");
}

run("markdown-mermaid-regression.mjs");
run("context-expansion-regression.mjs", ["--side"]);
run("context-expansion-regression.mjs", ["--line"]);
run("virtual-review-ui-regression.mjs");
