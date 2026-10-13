/**
 * The CouchDB tab's raw fetch helpers throw errors `describeError` can
 * word: a status the classifier reads, and a refused delete that says what
 * it needs instead of blaming the login.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { AuthError, deleteDb, fetchJson, HttpStatusError } from "../src/settings-tab/couch-fetch.ts";
import { describeError } from "../src/ui/describe-error.ts";

function respond(status: number, body: unknown = {}): void {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify(body), { status, statusText: "x" }));
}

describe("couch-fetch errors", () => {
    afterEach(() => { vi.unstubAllGlobals(); });

    it("fetchJson: a 5xx carries its status, a 401 is an AuthError", async () => {
        respond(503);
        const e = await fetchJson("http://c", "u", "p").catch((x) => x);
        expect(e).toBeInstanceOf(HttpStatusError);
        expect(describeError(e).text).toMatch(/^The server returned an error \(503\)/);
        respond(401, { reason: "bad" });
        expect(await fetchJson("http://c", "u", "p").catch((x) => x)).toBeInstanceOf(AuthError);
    });

    it("deleteDb: a 403 asks for an admin account instead of new credentials", async () => {
        respond(403, { reason: "You are not a server admin." });
        const e = await deleteDb("http://c", "u", "p", "old").catch((x) => x);
        expect(describeError(e).text).toMatch(/needs a server admin account/);
    });
});
