#!/usr/bin/env node
/**
 * CouchSync remote inspection tool.
 *
 * Reads credentials from `scripts/.env` (gitignored — never committed)
 * and runs read-only queries against the configured CouchDB. No external
 * dependencies — just node 18+ with built-in fetch.
 *
 * v0.11.0 splits configs into a separate database, so this tool now
 * supports two targets:
 *   --target vault   (default) — uses COUCHSYNC_DB
 *   --target config              uses COUCHSYNC_CONFIG_DB
 *
 * Usage:
 *   node scripts/inspect-remote.mjs                       # vault summary
 *   node scripts/inspect-remote.mjs --target config       # config summary
 *   node scripts/inspect-remote.mjs --list                # list every replicated doc id
 *   node scripts/inspect-remote.mjs --prefix file:        # list ids matching a prefix
 *   node scripts/inspect-remote.mjs --doc <docId>         # fetch a single doc
 *   node scripts/inspect-remote.mjs --legacy              # find legacy/non-conforming docs
 *
 * The credentials file MUST live at `scripts/.env` and MUST contain:
 *   COUCHSYNC_URI=<https://host:port>
 *   COUCHSYNC_USER=<user>
 *   COUCHSYNC_PASSWORD=<password>
 *   COUCHSYNC_DB=<vault database>
 *   COUCHSYNC_CONFIG_DB=<config database>   # optional, only needed for --target config
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ENV_PATH = path.join(__dirname, ".env");

// ── env loading ──────────────────────────────────────────────────────────
function loadEnv() {
    if (!fs.existsSync(ENV_PATH)) {
        console.error(`error: ${ENV_PATH} not found.`);
        console.error(`       Copy scripts/.env.example to scripts/.env and fill it in.`);
        process.exit(2);
    }
    const text = fs.readFileSync(ENV_PATH, "utf-8");
    const env = {};
    for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith("#")) continue;
        const eq = line.indexOf("=");
        if (eq < 0) continue;
        const key = line.slice(0, eq).trim();
        let value = line.slice(eq + 1).trim();
        if ((value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }
        env[key] = value;
    }
    const required = ["COUCHSYNC_URI", "COUCHSYNC_USER", "COUCHSYNC_PASSWORD", "COUCHSYNC_DB"];
    const missing = required.filter((k) => !env[k] || env[k].startsWith("<"));
    if (missing.length > 0) {
        console.error(`error: missing or placeholder values in scripts/.env: ${missing.join(", ")}`);
        process.exit(2);
    }
    return env;
}

const env = loadEnv();

// ── argument parsing (target, command flags) ────────────────────────────
const argv = process.argv.slice(2);
function takeFlag(name) {
    const idx = argv.indexOf(name);
    if (idx === -1) return null;
    const value = argv[idx + 1];
    argv.splice(idx, 2);
    return value;
}

const targetArg = takeFlag("--target") ?? "vault";
if (targetArg !== "vault" && targetArg !== "config") {
    console.error(`error: --target must be "vault" or "config" (got "${targetArg}")`);
    process.exit(2);
}

let dbName;
if (targetArg === "vault") {
    dbName = env.COUCHSYNC_DB;
} else {
    dbName = env.COUCHSYNC_CONFIG_DB;
    if (!dbName || dbName.startsWith("<")) {
        console.error(
            "error: --target config requires COUCHSYNC_CONFIG_DB in scripts/.env",
        );
        process.exit(2);
    }
}

// ── HTTP helpers ─────────────────────────────────────────────────────────
const baseUrl = env.COUCHSYNC_URI.replace(/\/$/, "");
const dbUrl = `${baseUrl}/${dbName}`;
const authHeader = "Basic " + Buffer.from(`${env.COUCHSYNC_USER}:${env.COUCHSYNC_PASSWORD}`).toString("base64");

async function couch(pathSuffix, init = {}) {
    const url = `${dbUrl}${pathSuffix}`;
    const res = await fetch(url, {
        ...init,
        headers: {
            Authorization: authHeader,
            Accept: "application/json",
            ...(init.headers ?? {}),
        },
    });
    if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`${res.status} ${res.statusText} for ${url}: ${body.slice(0, 300)}`);
    }
    return res.json();
}

function targetLabel() {
    return `[${targetArg}: ${dbName}]`;
}

// ── operations ───────────────────────────────────────────────────────────
async function showSummary() {
    const info = await couch("/");
    console.log(`Target: ${targetLabel()}`);
    console.log(`Database: ${info.db_name}`);
    console.log(`Documents: ${info.doc_count} (${info.doc_del_count} deleted tombstones)`);
    console.log(`Update seq: ${info.update_seq}`);
    console.log(`Disk size: ${(info.sizes?.file ?? 0) / 1024 / 1024} MiB`);
    console.log("");

    const kinds = [
        { label: "file:",    start: "file:",   end: "file:\ufff0"   },
        { label: "chunk:",   start: "chunk:",  end: "chunk:\ufff0"  },
        { label: "config:",  start: "config:", end: "config:\ufff0" },
    ];
    console.log("Counts by kind:");
    let replicated = 0;
    for (const k of kinds) {
        const r = await couch(`/_all_docs?startkey=${encodeURIComponent(JSON.stringify(k.start))}&endkey=${encodeURIComponent(JSON.stringify(k.end))}`);
        console.log(`  ${k.label.padEnd(8)} ${r.total_rows >= 0 ? r.rows.length : "?"}`);
        replicated += r.rows.length;
    }
    console.log(`  ${"replicated total:".padEnd(20)} ${replicated}`);
    console.log(`  ${"_all_docs total:".padEnd(20)} ${info.doc_count} (incl. design/local)`);
}

async function listAll() {
    console.log(`Target: ${targetLabel()}`);
    const r = await couch(`/_all_docs`);
    for (const row of r.rows) console.log(row.id);
    console.log(`\n${r.rows.length} ids total`);
}

async function listByPrefix(prefix) {
    console.log(`Target: ${targetLabel()}`);
    const start = encodeURIComponent(JSON.stringify(prefix));
    const end = encodeURIComponent(JSON.stringify(prefix + "\ufff0"));
    const r = await couch(`/_all_docs?startkey=${start}&endkey=${end}`);
    for (const row of r.rows) console.log(row.id);
    console.log(`\n${r.rows.length} ids with prefix "${prefix}"`);
}

async function fetchDoc(id) {
    console.log(`Target: ${targetLabel()}`);
    const r = await couch(`/${encodeURIComponent(id)}?conflicts=true`);
    console.log(JSON.stringify(r, null, 2));
}

/**
 * Find docs that don't conform to the v0.11.0 schema for the selected
 * target. Vault DB rules and Config DB rules are different:
 *
 *   Vault DB:
 *     - bare-path doc (no kind prefix) → legacy
 *     - any `config:*` doc → orphan from pre-v0.11.0 split, needs cleanup
 *     - FileDoc without `vclock` → legacy
 *
 *   Config DB:
 *     - any non-`config:` doc (file:, chunk:, bare) → wrong store
 *     - ConfigDoc without `vclock` → legacy
 *     - ConfigDoc with deprecated `binary` field → legacy
 */
async function findLegacy() {
    console.log(`Target: ${targetLabel()}`);
    const r = await couch(`/_all_docs?include_docs=true`);
    const offenders = [];
    for (const row of r.rows) {
        if (!row.doc) continue;
        const id = row.id;
        if (id.startsWith("_")) continue;

        const isFile = id.startsWith("file:");
        const isChunk = id.startsWith("chunk:");
        const isConfig = id.startsWith("config:");

        if (targetArg === "vault") {
            if (!isFile && !isChunk && !isConfig) {
                offenders.push({ id, reason: "bare-path (no kind prefix)" });
                continue;
            }
            if (isConfig) {
                offenders.push({ id, reason: "config:* orphan in vault DB (migrate to config DB)" });
                continue;
            }
            if (isFile) {
                const vc = row.doc.vclock;
                if (!vc || Object.keys(vc).length === 0) {
                    offenders.push({ id, reason: "FileDoc missing vclock" });
                }
            }
        } else {
            // config target
            if (!isConfig) {
                offenders.push({ id, reason: `non-config doc in config DB (${isFile ? "file:" : isChunk ? "chunk:" : "bare"})` });
                continue;
            }
            const vc = row.doc.vclock;
            if (!vc || Object.keys(vc).length === 0) {
                offenders.push({ id, reason: "ConfigDoc missing vclock" });
                continue;
            }
            if ("binary" in row.doc) {
                offenders.push({ id, reason: "ConfigDoc carries deprecated `binary`" });
            }
        }
    }
    if (offenders.length === 0) {
        console.log(`✓ No legacy / non-conforming documents found in ${targetArg} DB.`);
    } else {
        console.log(`Found ${offenders.length} legacy doc(s) in ${targetArg} DB:`);
        for (const o of offenders) console.log(`  ${o.reason.padEnd(50)} ${o.id}`);
    }
}

// ── CLI ──────────────────────────────────────────────────────────────────
async function main() {
    const args = argv;
    try {
        if (args.length === 0) {
            await showSummary();
        } else if (args[0] === "--list") {
            await listAll();
        } else if (args[0] === "--prefix" && args[1]) {
            await listByPrefix(args[1]);
        } else if (args[0] === "--doc" && args[1]) {
            await fetchDoc(args[1]);
        } else if (args[0] === "--legacy") {
            await findLegacy();
        } else {
            console.error("Unknown args. Usage:");
            console.error("  inspect-remote.mjs                            # vault summary");
            console.error("  inspect-remote.mjs --target config            # config summary");
            console.error("  inspect-remote.mjs --list                     # list all ids");
            console.error("  inspect-remote.mjs --prefix file:             # list ids matching prefix");
            console.error("  inspect-remote.mjs --doc <docId>              # fetch single doc");
            console.error("  inspect-remote.mjs --legacy                   # find non-conforming docs");
            console.error("  inspect-remote.mjs --target config --legacy   # check config DB legacy state");
            process.exit(2);
        }
    } catch (e) {
        console.error(`error: ${e.message ?? e}`);
        process.exit(1);
    }
}

main();
