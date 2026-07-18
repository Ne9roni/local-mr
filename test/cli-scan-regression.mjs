import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { localMr } from "./helpers/paths.mjs";

const execFileAsync = promisify(execFile);
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "local-mr-cli-scan-"));
const repoRoot = path.join(temporary, "dirty-repo");
const binaryDirectory = path.join(temporary, "bin");
const runtimeDirectory = path.join(temporary, "runtime");
const logPath = path.join(temporary, "git.log");

try {
    await fs.mkdir(binaryDirectory);
    await fs.mkdir(runtimeDirectory);
    const gitPath = (await execFileAsync("which", ["git"])).stdout.trim();
    await fs.mkdir(repoRoot);
    await execFileAsync(gitPath, ["init", "--initial-branch=main"], { cwd: repoRoot });
    await execFileAsync(gitPath, ["config", "user.name", "Local MR Test"], { cwd: repoRoot });
    await execFileAsync(gitPath, ["config", "user.email", "local-mr@example.invalid"], { cwd: repoRoot });
    await fs.writeFile(path.join(repoRoot, "README.md"), "# base\n");
    await execFileAsync(gitPath, ["add", "README.md"], { cwd: repoRoot });
    await execFileAsync(gitPath, ["commit", "-m", "base"], { cwd: repoRoot });
    await execFileAsync(gitPath, ["switch", "-c", "feature/cli-scan"], { cwd: repoRoot });
    await fs.writeFile(path.join(repoRoot, "README.md"), "# changed\n");
    const wrapper = `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "$LOCAL_MR_GIT_LOG"\nexec ${JSON.stringify(gitPath)} "$@"\n`;
    const wrapperPath = path.join(binaryDirectory, "git");
    await fs.writeFile(wrapperPath, wrapper, { mode: 0o700 });
    const result = await execFileAsync(localMr, ["main", "--no-open"], {
        cwd: repoRoot,
        env: {
            ...process.env,
            PATH: `${binaryDirectory}:${process.env.PATH}`,
            XDG_RUNTIME_DIR: runtimeDirectory,
            LOCAL_MR_GIT_LOG: logPath,
            LOCAL_MR_SERVER_IDLE_MINUTES: "1",
        },
        timeout: 60_000,
        maxBuffer: 16 * 1024 * 1024,
    });
    const commands = (await fs.readFile(logPath, "utf8")).trim().split("\n");
    const resultData = {
        addWorktreeScans: commands.filter((command) => command === "add -A -- .").length,
        readTreeScans: commands.filter((command) => command === "read-tree HEAD").length,
        gitCommandCount: commands.length,
        output: result.stdout.trim().split("\n"),
    };
    const cleanRepo = path.join(temporary, "clean-repo");
    await fs.mkdir(cleanRepo);
    await execFileAsync(gitPath, ["init", "--initial-branch=main"], { cwd: cleanRepo });
    await execFileAsync(gitPath, ["config", "user.name", "Local MR Test"], { cwd: cleanRepo });
    await execFileAsync(gitPath, ["config", "user.email", "local-mr@example.invalid"], { cwd: cleanRepo });
    await fs.writeFile(path.join(cleanRepo, "README.md"), "# clean\n");
    await execFileAsync(gitPath, ["add", "README.md"], { cwd: cleanRepo });
    await execFileAsync(gitPath, ["commit", "-m", "base"], { cwd: cleanRepo });
    const noChange = await execFileAsync(
        localMr,
        ["HEAD", "--no-open"],
        {
            cwd: cleanRepo,
            env: {
                ...process.env,
                PATH: `${binaryDirectory}:${process.env.PATH}`,
                XDG_RUNTIME_DIR: runtimeDirectory,
                LOCAL_MR_GIT_LOG: logPath,
                LOCAL_MR_SERVER_IDLE_MINUTES: "1",
            },
            timeout: 60_000,
        },
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    const readyAfterNoChange = [];
    const collectReady = async (directory) => {
        for (const entry of await fs.readdir(directory, { withFileTypes: true }).catch(() => [])) {
            const entryPath = path.join(directory, entry.name);
            if (entry.isDirectory()) await collectReady(entryPath);
            else if (entry.name === "ready.json") readyAfterNoChange.push(entryPath);
        }
    };
    await collectReady(runtimeDirectory);
    resultData.noChangeOutput = noChange.stdout.trim();
    resultData.readyServersAfterNoChange = readyAfterNoChange.length;
    const checks = {
        "worktree is snapshotted once": resultData.addWorktreeScans === 1,
        "temporary index is initialized once": resultData.readTreeScans === 1,
        "CLI prints server-generated shortstat": resultData.output.some((line) => (
            /files? changed/.test(line)
        )),
        "clean comparisons stop their newly started server": /No changes between HEAD/.test(
            resultData.noChangeOutput,
        ) && resultData.readyServersAfterNoChange === 1,
    };
    console.log(JSON.stringify({ result: resultData, checks }, null, 2));
    if (Object.values(checks).some((passed) => !passed)) process.exitCode = 1;
} finally {
    const readyFiles = [];
    const visit = async (directory) => {
        for (const entry of await fs.readdir(directory, { withFileTypes: true }).catch(() => [])) {
            const entryPath = path.join(directory, entry.name);
            if (entry.isDirectory()) await visit(entryPath);
            else if (entry.name === "ready.json") readyFiles.push(entryPath);
        }
    };
    await visit(runtimeDirectory);
    for (const readyFile of readyFiles) {
        try {
            const ready = JSON.parse(await fs.readFile(readyFile, "utf8"));
            process.kill(ready.pid, "SIGTERM");
        } catch {}
    }
    await fs.rm(temporary, { recursive: true, force: true });
}
