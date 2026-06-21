/**
 * Low-level HTTP helpers for CouchDB server/database operations.
 *
 * Extracted from status-tab.ts so they can be shared between the CouchDB
 * connection tab (server-level Test) and the dashboard (server info,
 * database list, delete).  Uses raw `fetch()` with HTTP Basic Auth —
 * not CouchClient, which is purpose-built for per-database operations.
 */

export class AuthError extends Error {
    constructor(public status: number, reason: string) {
        super(reason);
    }
}

export async function fetchJson(url: string, user: string, pass: string): Promise<any> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (user) {
        headers["Authorization"] = "Basic " + btoa(`${user}:${pass}`);
    }
    const res = await fetch(url, { headers });
    if (res.status === 401 || res.status === 403) {
        let reason = res.statusText;
        try {
            const body = await res.json();
            if (body?.reason) reason = body.reason;
        } catch { /* ignore */ }
        throw new AuthError(res.status, reason);
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    return res.json();
}

export async function deleteDb(
    baseUri: string, user: string, pass: string, dbName: string,
): Promise<void> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (user) {
        headers["Authorization"] = "Basic " + btoa(`${user}:${pass}`);
    }
    const res = await fetch(`${baseUri}/${encodeURIComponent(dbName)}`, {
        method: "DELETE",
        headers,
    });
    if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.reason || `HTTP ${res.status}`);
    }
}

export function formatBytes(bytes: number): string {
    if (bytes === 0) return "0 B";
    const units = ["B", "KB", "MB", "GB"];
    const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    const val = bytes / Math.pow(1024, i);
    return `${val.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export function formatTimestamp(ms: number): string {
    const d = new Date(ms);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export interface ServerInfo {
    version: string;
    uuid: string;
    features: string[];
}

export interface DbInfo {
    db_name: string;
    doc_count: number;
    sizes: { file: number; active: number; external: number };
}
