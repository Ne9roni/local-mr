import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { localMr, projectRoot } from "./helpers/paths.mjs";

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "local-mr-install-"));
const prefix = path.join(temporaryRoot, "prefix");
const environment = { ...process.env, LOCAL_MR_PREFIX: prefix };
const installScript = path.join(projectRoot, "scripts", "install.sh");
const uninstallScript = path.join(projectRoot, "scripts", "uninstall.sh");
const commandPath = path.join(prefix, "bin", "local-mr");
const runtimePath = path.join(prefix, "share", "local-mr");
const alternateCheckout = path.join(temporaryRoot, "alternate-checkout");
const codexHome = path.join(temporaryRoot, "codex-home");
const bundledSkill = path.join("skills", "local-mr-virtual-commits");
const bundledSkillText = fs.readFileSync(path.join(projectRoot, bundledSkill, "SKILL.md"), "utf8");

const run = (script, arguments_ = []) => execFileSync("bash", [script, ...arguments_], {
    cwd: projectRoot,
    env: environment,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
});

try {
    const packReport = JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
        cwd: projectRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
    }));
    const packedFiles = new Set(packReport[0]?.files?.map((entry) => entry.path));
    const packageChecks = {
        "npm package includes the virtual-commit CLI": packedFiles.has("src/virtual-review-cli.mjs"),
        "npm package includes the virtual review server": packedFiles.has("src/virtual-review-server.mjs"),
        "npm package includes the shared diff workspace": packedFiles.has("src/review-ui.html"),
        "npm package includes the official Skill": packedFiles.has(`${bundledSkill}/SKILL.md`),
        "npm package includes the Skill agent metadata": packedFiles.has(`${bundledSkill}/agents/openai.yaml`),
        "npm package includes the Skill protocol": packedFiles.has(`${bundledSkill}/references/protocol.md`),
        "official Skill offers both review depths": bundledSkillText.includes("**Overview:**")
            && bundledSkillText.includes("**Deep review:**")
            && bundledSkillText.includes("Treat depth and order as independent choices"),
        "official Skill asks for depth before snapshot and analysis": bundledSkillText.includes(
            "ask before running `snapshot` or analyzing the comparison",
        ) && bundledSkillText.includes(
            "Wait for the user's choice",
        ),
        "official Skill gates creation on explicit plan approval": bundledSkillText.includes(
            "complete ordered, numbered list of virtual-commit titles",
        ) && bundledSkillText.includes(
            "explicitly approves the latest displayed title list",
        ) && bundledSkillText.includes(
            "Only after approval, submit the approved manifest with `create`",
        ),
    };
    if (Object.values(packageChecks).some((passed) => !passed)) {
        throw new Error(`Package regression failed: ${JSON.stringify(packageChecks)}`);
    }

    const copyOutput = run(installScript);
    const receipt = fs.readFileSync(path.join(runtimePath, ".command-sha256"), "utf8").trim();
    const help = execFileSync(commandPath, ["--help"], { encoding: "utf8" });
    const virtualHelp = execFileSync(commandPath, ["virtual-commit", "help"], { encoding: "utf8" });
    const skillInstall = JSON.parse(execFileSync(
        commandPath,
        ["virtual-commit", "install-skill", "codex"],
        {
            cwd: projectRoot,
            env: { ...environment, CODEX_HOME: codexHome },
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
        },
    ));
    const installedSkill = path.join(codexHome, bundledSkill);
    const copiedRuntime = fs.realpathSync(runtimePath);
    const copyChecks = {
        "copy install reports its mode": copyOutput.includes("copy mode"),
        "copy install creates a standalone runtime": copiedRuntime === runtimePath,
        "copy install records command ownership": /^[a-f0-9]{64}$/.test(receipt),
        "copy install includes project and third-party licenses": fs.existsSync(
            path.join(runtimePath, "LICENSE"),
        ) && fs.existsSync(path.join(runtimePath, "THIRD_PARTY_NOTICES.md")),
        "installed command resolves its copied runtime": help.includes("Usage: local-mr"),
        "installed command exposes virtual-commit help": virtualHelp.includes(
            "Usage: local-mr virtual-commit <command> [options]",
        ),
        "copied runtime includes the shared diff workspace": fs.existsSync(
            path.join(runtimePath, "src", "review-ui.html"),
        ),
        "copied runtime includes the official Skill": fs.existsSync(
            path.join(runtimePath, bundledSkill, "SKILL.md"),
        ),
        "copied runtime includes complete Skill support files": fs.existsSync(
            path.join(runtimePath, bundledSkill, "agents", "openai.yaml"),
        ) && fs.existsSync(path.join(runtimePath, bundledSkill, "references", "protocol.md")),
        "copied CLI explicitly installs the official Skill": skillInstall.ok === true
            && skillInstall.skill === "local-mr-virtual-commits"
            && skillInstall.destination === installedSkill
            && fs.existsSync(path.join(installedSkill, "SKILL.md")),
    };
    if (Object.values(copyChecks).some((passed) => !passed)) {
        throw new Error(`Copy install regression failed: ${JSON.stringify(copyChecks)}`);
    }
    fs.mkdirSync(path.join(alternateCheckout, "bin"), { recursive: true });
    fs.mkdirSync(path.join(alternateCheckout, "scripts"), { recursive: true });
    fs.copyFileSync(uninstallScript, path.join(alternateCheckout, "scripts", "uninstall.sh"));
    fs.writeFileSync(path.join(alternateCheckout, "bin", "local-mr"), "#!/usr/bin/env bash\necho newer checkout\n");
    run(path.join(alternateCheckout, "scripts", "uninstall.sh"));
    copyChecks["copy uninstall survives checkout changes"] = !fs.existsSync(commandPath)
        && !fs.existsSync(runtimePath);
    if (!copyChecks["copy uninstall survives checkout changes"]) {
        throw new Error(`Copy uninstall regression failed: ${JSON.stringify(copyChecks)}`);
    }

    const linkOutput = run(installScript, ["--link"]);
    const linkChecks = {
        "link install reports its mode": linkOutput.includes("link mode"),
        "link install points the command at the checkout": fs.realpathSync(commandPath) === localMr,
        "link install points the runtime at the checkout": fs.realpathSync(runtimePath) === projectRoot,
    };
    if (Object.values(linkChecks).some((passed) => !passed)) {
        throw new Error(`Link install regression failed: ${JSON.stringify(linkChecks)}`);
    }
    run(uninstallScript);

    const cleanupChecks = {
        "uninstall removes the command": !fs.existsSync(commandPath),
        "uninstall removes the runtime": !fs.existsSync(runtimePath),
    };
    if (Object.values(cleanupChecks).some((passed) => !passed)) {
        throw new Error(`Uninstall regression failed: ${JSON.stringify(cleanupChecks)}`);
    }

    console.log(JSON.stringify({ packageChecks, copyChecks, linkChecks, cleanupChecks }, null, 2));
} finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
}
