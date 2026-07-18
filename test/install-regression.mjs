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

const run = (script, arguments_ = []) => execFileSync("bash", [script, ...arguments_], {
    cwd: projectRoot,
    env: environment,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
});

try {
    const copyOutput = run(installScript);
    const receipt = fs.readFileSync(path.join(runtimePath, ".command-sha256"), "utf8").trim();
    const help = execFileSync(commandPath, ["--help"], { encoding: "utf8" });
    const copiedRuntime = fs.realpathSync(runtimePath);
    const copyChecks = {
        "copy install reports its mode": copyOutput.includes("copy mode"),
        "copy install creates a standalone runtime": copiedRuntime === runtimePath,
        "copy install records command ownership": /^[a-f0-9]{64}$/.test(receipt),
        "copy install includes project and third-party licenses": fs.existsSync(
            path.join(runtimePath, "LICENSE"),
        ) && fs.existsSync(path.join(runtimePath, "THIRD_PARTY_NOTICES.md")),
        "installed command resolves its copied runtime": help.includes("Usage: local-mr"),
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

    console.log(JSON.stringify({ copyChecks, linkChecks, cleanupChecks }, null, 2));
} finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
}
