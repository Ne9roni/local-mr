import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { localMr } from "./helpers/paths.mjs";
import { printPublicTestReport } from "./helpers/public-report.mjs";

const execFileAsync = promisify(execFile);
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "local-mr-cli-scan-"));
const repoRoot = path.join(temporary, "dirty-repo");
const binaryDirectory = path.join(temporary, "bin");
const runtimeDirectory = path.join(temporary, "runtime");
const virtualStateDirectory = path.join(temporary, "virtual-state");
const logPath = path.join(temporary, "git.log");
const openerLogPath = path.join(temporary, "opener.log");

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
    await fs.writeFile(path.join(repoRoot, "README.md"), "# committed\n");
    await execFileAsync(gitPath, ["add", "README.md"], { cwd: repoRoot });
    await execFileAsync(gitPath, ["commit", "-m", "committed comparison"], { cwd: repoRoot });
    await fs.writeFile(path.join(repoRoot, "README.md"), "# changed\n");
    const wrapper = `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "$LOCAL_MR_GIT_LOG"\nexec ${JSON.stringify(gitPath)} "$@"\n`;
    const wrapperPath = path.join(binaryDirectory, "git");
    await fs.writeFile(wrapperPath, wrapper, { mode: 0o700 });
    const openerWrapper = (name, status) => [
        "#!/usr/bin/env bash",
        `printf '${name}\\t%s\\n' "$1" >> "$LOCAL_MR_OPEN_LOG"`,
        `exit ${status}`,
        "",
    ].join("\n");
    await Promise.all([
        fs.writeFile(
            path.join(binaryDirectory, "explorer.exe"),
            openerWrapper("explorer.exe", 23),
            { mode: 0o700 },
        ),
        fs.writeFile(
            path.join(binaryDirectory, "wslview"),
            openerWrapper("wslview", 0),
            { mode: 0o700 },
        ),
        fs.writeFile(
            path.join(binaryDirectory, "xdg-open"),
            openerWrapper("xdg-open", 0),
            { mode: 0o700 },
        ),
    ]);
    const result = await execFileAsync(localMr, ["main"], {
        cwd: repoRoot,
        env: {
            ...process.env,
            PATH: `${binaryDirectory}:${process.env.PATH}`,
            WSL_DISTRO_NAME: "Local-MR-Test",
            XDG_RUNTIME_DIR: runtimeDirectory,
            LOCAL_MR_GIT_LOG: logPath,
            LOCAL_MR_OPEN_LOG: openerLogPath,
            LOCAL_MR_SERVER_IDLE_MINUTES: "1",
            LOCAL_MR_VIRTUAL_STATE_DIR: virtualStateDirectory,
        },
        timeout: 60_000,
        maxBuffer: 16 * 1024 * 1024,
    });
    const startupCommands = (await fs.readFile(logPath, "utf8")).trim().split("\n");
    const reviewUrl = result.stdout.match(/^Review: (.+)$/m)?.[1];
    if (!reviewUrl) throw new Error(`local-mr did not print a review URL:\n${result.stdout}`);
    const openerCalls = (await fs.readFile(openerLogPath, "utf8")).trim().split("\n");
    const snapshotPath = result.stdout.match(/^HTML snapshot: (.+)$/m)?.[1];
    if (!snapshotPath) throw new Error(`local-mr did not print an HTML snapshot path:\n${result.stdout}`);
    const snapshotHtml = await fs.readFile(snapshotPath, "utf8");
    const versionDataMatch = snapshotHtml.match(
        /<script id="local-mr-version-data" type="application\/json">([\s\S]*?)<\/script>/,
    );
    if (!versionDataMatch) throw new Error("HTML snapshot does not contain version data");
    const snapshotVersionData = JSON.parse(versionDataMatch[1]);
    const worktreeUrl = new URL(reviewUrl);
    worktreeUrl.searchParams.set("mode", "push");
    worktreeUrl.searchParams.set("from", "base");
    worktreeUrl.searchParams.set("to", "worktree");
    const worktreeResponse = await fetch(worktreeUrl);
    if (!worktreeResponse.ok) {
        throw new Error(`manual worktree review failed: ${worktreeResponse.status}`);
    }
    await worktreeResponse.text();
    const commands = (await fs.readFile(logPath, "utf8")).trim().split("\n");
    const resultData = {
        startupAddWorktreeScans: startupCommands.filter((command) => command === "add -A -- .").length,
        startupReadTreeScans: startupCommands.filter((command) => command === "read-tree HEAD").length,
        addWorktreeScans: commands.filter((command) => command === "add -A -- .").length,
        readTreeScans: commands.filter((command) => command === "read-tree HEAD").length,
        gitCommandCount: commands.length,
        output: result.stdout.trim().split("\n"),
        openerCalls,
        openerWarning: result.stderr.trim(),
        standaloneNavigation: snapshotVersionData.reviewNavigation,
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
                LOCAL_MR_VIRTUAL_STATE_DIR: virtualStateDirectory,
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
        "default committed review does not snapshot the dirty worktree": resultData.startupAddWorktreeScans === 0
            && resultData.startupReadTreeScans === 0,
        "manual worktree comparison is snapshotted once": resultData.addWorktreeScans === 1,
        "manual worktree comparison initializes one temporary index": resultData.readTreeScans === 1,
        "CLI prints server-generated shortstat": resultData.output.some((line) => (
            /files? changed/.test(line)
        )),
        "WSL dispatches exactly one explorer.exe URL without fallback": (
            resultData.openerCalls.length === 1
            && resultData.openerCalls[0] === `explorer.exe\t${reviewUrl}`
            && resultData.openerWarning === ""
        ),
        "bare CLI snapshots advertise the unified Real and Virtual workspace": (
            resultData.standaloneNavigation?.active === "real"
            && Boolean(resultData.standaloneNavigation.realUrl)
            && resultData.standaloneNavigation.virtualUrl === null
            && resultData.standaloneNavigation.virtualUnavailableReason.includes(
                "No matching Virtual Review",
            )
        ),
        "clean comparisons stop their newly started server": /No changes between HEAD/.test(
            resultData.noChangeOutput,
        ) && resultData.readyServersAfterNoChange === 1,
    };
    printPublicTestReport({ result: resultData, checks });
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
