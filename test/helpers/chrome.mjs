import { spawn } from "node:child_process";

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export const openChromePage = async ({ url, profile, debuggingPort, attempts = 160 }) => {
    const chrome = spawn("google-chrome", [
        "--headless=new",
        "--disable-gpu",
        "--no-sandbox",
        `--remote-debugging-port=${debuggingPort}`,
        `--user-data-dir=${profile}`,
        url,
    ], { stdio: "ignore" });
    let socket;
    try {
        let pages;
        for (let attempt = 0; attempt < attempts; attempt += 1) {
            try {
                pages = await fetch(`http://127.0.0.1:${debuggingPort}/json/list`)
                    .then((response) => response.json());
                if (pages.some((page) => page.type === "page" && page.url.startsWith(url))) break;
            } catch {}
            await delay(100);
        }
        const page = pages?.find((entry) => entry.type === "page" && entry.url.startsWith(url));
        if (!page) throw new Error(`Chrome did not open ${url}`);

        socket = new WebSocket(page.webSocketDebuggerUrl);
        const pending = new Map();
        let nextId = 1;
        await new Promise((resolve, reject) => {
            socket.addEventListener("open", resolve, { once: true });
            socket.addEventListener("error", reject, { once: true });
        });
        socket.addEventListener("message", (event) => {
            const message = JSON.parse(event.data);
            if (!message.id || !pending.has(message.id)) return;
            const { resolve, reject } = pending.get(message.id);
            pending.delete(message.id);
            if (message.error) reject(new Error(JSON.stringify(message.error)));
            else resolve(message.result);
        });
        const command = (method, params = {}) => {
            const id = nextId++;
            socket.send(JSON.stringify({ id, method, params }));
            return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
        };
        const evaluate = async (expression) => {
            const result = await command("Runtime.evaluate", {
                expression,
                returnByValue: true,
                awaitPromise: true,
            });
            if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
            return result.result.value;
        };
        const waitFor = async (expression, label, maximumAttempts = 160) => {
            for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
                try {
                    if (await evaluate(expression)) return;
                } catch {}
                await delay(100);
            }
            throw new Error(`Timed out waiting for ${label}`);
        };
        let closed = false;
        const close = () => {
            if (closed) return;
            closed = true;
            socket.close();
            chrome.kill("SIGTERM");
        };
        await command("Runtime.enable");
        return { close, command, evaluate, waitFor };
    } catch (error) {
        socket?.close();
        chrome.kill("SIGTERM");
        throw error;
    }
};
