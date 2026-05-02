#!/usr/bin/env node
/**
 * Evaluate JS in the Obsidian WebView running on a connected Android
 * emulator / device, via Chrome DevTools Protocol over `adb forward`.
 *
 * Prerequisites
 * -------------
 *   1. Android emulator/device with Obsidian installed and running.
 *   2. `adb` on PATH (Android SDK Platform-Tools).
 *   3. WebView is debuggable. For Obsidian APK you may need a debug
 *      build OR `adb shell setprop debug.webview.devtools 1` on a
 *      WebView-enabled API.
 *
 * Usage
 * -----
 *   node scripts/android-eval.mjs '<javascript expression>'
 *   node scripts/android-eval.mjs --logs               # tail console
 *   node scripts/android-eval.mjs --buffer             # CouchSync log buffer dump
 *   node scripts/android-eval.mjs --buffer --tail 50   # last 50 entries
 *
 * The expression form mirrors `obsidian eval` semantics — return value
 * is JSON-serialised and printed.
 *
 * Notes
 * -----
 *   - The script auto-discovers the WebView socket via `adb shell cat
 *     /proc/net/unix | grep webview_devtools_remote_<pid>` and forwards
 *     it to `localhost:9222`. The forward is left in place after exit
 *     for follow-up runs (idempotent).
 *   - Picks the first `type:"page"` whose title contains "Obsidian".
 *   - For `--logs` the script subscribes to `Runtime.consoleAPICalled`
 *     and prints each event until interrupted (Ctrl-C).
 */

import { spawnSync } from "node:child_process";

const HOST = "localhost";
const PORT = 9222;

function adb(...args) {
    const r = spawnSync("adb", args, { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`adb ${args.join(" ")} failed: ${r.stderr}`);
    return r.stdout;
}

function findWebViewSocket() {
    const out = adb("shell", "cat", "/proc/net/unix");
    const matches = [...out.matchAll(/@webview_devtools_remote_(\d+)/g)];
    if (matches.length === 0) {
        throw new Error("No webview_devtools_remote socket found. Is Obsidian running with debuggable WebView?");
    }
    // Prefer the most recent (highest pid) when multiple.
    return `webview_devtools_remote_${matches.at(-1)[1]}`;
}

function forwardPort(socketName) {
    adb("forward", `tcp:${PORT}`, `localabstract:${socketName}`);
}

async function fetchJson(path) {
    const res = await fetch(`http://${HOST}:${PORT}${path}`);
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} for ${path}`);
    return res.json();
}

async function pickObsidianPage() {
    const list = await fetchJson("/json");
    const obsidianPages = list.filter(
        (p) => p.type === "page" && (p.title || "").toLowerCase().includes("obsidian"),
    );
    if (obsidianPages.length === 0) {
        throw new Error("No Obsidian page in DevTools list (try unlocking the device / opening Obsidian).");
    }
    return obsidianPages[0];
}

class CdpClient {
    constructor(wsUrl) {
        this.ws = new WebSocket(wsUrl);
        this.id = 0;
        this.pending = new Map();
        this.eventHandlers = new Map();
        this.ready = new Promise((resolve, reject) => {
            this.ws.addEventListener("open", () => resolve(), { once: true });
            this.ws.addEventListener("error", reject, { once: true });
        });
        this.ws.addEventListener("message", (ev) => {
            const msg = JSON.parse(ev.data);
            if (msg.id !== undefined && this.pending.has(msg.id)) {
                const { resolve, reject } = this.pending.get(msg.id);
                this.pending.delete(msg.id);
                if (msg.error) reject(new Error(msg.error.message ?? JSON.stringify(msg.error)));
                else resolve(msg.result);
                return;
            }
            if (msg.method) {
                const handlers = this.eventHandlers.get(msg.method) ?? [];
                for (const h of handlers) h(msg.params);
            }
        });
    }
    send(method, params = {}) {
        const id = ++this.id;
        const payload = JSON.stringify({ id, method, params });
        this.ws.send(payload);
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
        });
    }
    on(event, handler) {
        if (!this.eventHandlers.has(event)) this.eventHandlers.set(event, []);
        this.eventHandlers.get(event).push(handler);
    }
    close() { this.ws.close(); }
}

async function evaluate(client, expression) {
    const { result, exceptionDetails } = await client.send("Runtime.evaluate", {
        expression,
        returnByValue: true,
        awaitPromise: true,
    });
    if (exceptionDetails) {
        const e = exceptionDetails;
        const msg = e.exception?.description ?? e.text ?? JSON.stringify(e);
        throw new Error(msg);
    }
    return result.value;
}

function formatConsoleEvent(params) {
    const ts = new Date(params.timestamp).toISOString().slice(11, 23);
    const lvl = params.type.padEnd(7, " ");
    const args = params.args.map((a) => {
        if (a.type === "string") return a.value;
        if (a.type === "number" || a.type === "boolean") return String(a.value);
        if (a.value !== undefined) return JSON.stringify(a.value);
        return a.description ?? `[${a.type}]`;
    }).join(" ");
    return `${ts} ${lvl} ${args}`;
}

// The log buffer in src/ui/log.ts is module-local. We scrape the
// rendered LogView DOM instead — open the view first via:
//   app.workspace.getLeaf(true).setViewState({ type: "couchsync-log-view" })
// or the "Open CouchSync Log" command. Returns entries newest-first
// (LogView's render order).
const COUCHSYNC_BUFFER_EXPR = `(() => {
    const p = app.plugins.plugins["obsidian-couchsync"];
    if (!p) return { error: "plugin not loaded" };
    const leaf = app.workspace.getLeavesOfType("couchsync-log-view")[0];
    if (!leaf) return { error: "Log View not open. Run command 'CouchSync: Open Log' or open it from the sidebar." };
    const rows = leaf.view.containerEl.querySelectorAll(".couchsync-log-entry");
    const entries = [];
    for (const row of rows) {
        entries.push({
            ts: row.querySelector(".couchsync-log-time")?.textContent ?? "",
            level: row.querySelector(".couchsync-log-level")?.textContent ?? "",
            msg: row.querySelector(".couchsync-log-message")?.textContent ?? "",
        });
    }
    return { count: entries.length, entries };
})()`;

async function main() {
    const args = process.argv.slice(2);
    if (args.length === 0) {
        console.error("Usage: node scripts/android-eval.mjs '<expression>' | --logs | --buffer [--tail N]");
        process.exit(1);
    }

    const socket = findWebViewSocket();
    forwardPort(socket);
    const page = await pickObsidianPage();
    const client = new CdpClient(page.webSocketDebuggerUrl);
    await client.ready;

    try {
        if (args[0] === "--logs") {
            await client.send("Runtime.enable");
            client.on("Runtime.consoleAPICalled", (params) => {
                console.log(formatConsoleEvent(params));
            });
            console.error(`[android-eval] streaming console of "${page.title}" — Ctrl-C to stop`);
            await new Promise(() => {}); // hold open
        } else if (args[0] === "--buffer") {
            const tailIdx = args.indexOf("--tail");
            const tail = tailIdx >= 0 ? Number(args[tailIdx + 1]) : null;
            const result = await evaluate(client, COUCHSYNC_BUFFER_EXPR);
            const entries = result?.entries;
            if (!entries) {
                console.log(JSON.stringify(result, null, 2));
            } else {
                const slice = tail ? entries.slice(-tail) : entries;
                for (const e of slice) console.log(`${e.ts ?? ""} ${e.level ?? ""} ${e.msg ?? JSON.stringify(e)}`);
            }
        } else {
            const value = await evaluate(client, args[0]);
            console.log(typeof value === "string" ? value : JSON.stringify(value, null, 2));
        }
    } finally {
        client.close();
    }
}

main().catch((e) => { console.error(`[android-eval] ${e.message}`); process.exit(1); });
