import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

import { projectRoot } from "../test/helpers/paths.mjs";

const collectFiles = (directory, suffix) => fs.readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
        const entryPath = path.join(directory, entry.name);
        if (entry.isDirectory()) return collectFiles(entryPath, suffix);
        return entry.name.endsWith(suffix) ? [entryPath] : [];
    });

const run = (command, arguments_) => {
    const result = spawnSync(command, arguments_, { cwd: projectRoot, stdio: "inherit" });
    if (result.status !== 0) process.exit(result.status || 1);
};

const moduleFiles = ["src", "test", "scripts"]
    .flatMap((directory) => collectFiles(path.join(projectRoot, directory), ".mjs"));
moduleFiles.forEach((file) => run(process.execPath, ["--check", file]));

const shellFiles = [
    path.join(projectRoot, "bin", "local-mr"),
    path.join(projectRoot, ".githooks", "pre-commit"),
    ...collectFiles(path.join(projectRoot, "scripts"), ".sh"),
];
shellFiles.forEach((file) => run("bash", ["-n", file]));

const reviewUi = fs.readFileSync(path.join(projectRoot, "src", "review-ui.html"), "utf8");
const behaviour = reviewUi.match(
    /<script id="local-mr-review-behaviour">([\s\S]*?)<\/script>/,
)?.[1];
if (!behaviour) throw new Error("review-ui.html has no behaviour script");
new vm.Script(behaviour, { filename: "review-ui.html#local-mr-review-behaviour" });

console.log(`Checked ${moduleFiles.length} JavaScript modules and ${shellFiles.length} shell scripts.`);
