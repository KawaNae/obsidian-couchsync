/**
 * Config ops never overlap. A confirmation dialog an op shows (the Push
 * list, Create's confirmation) is part of the op: while it is open every
 * other config op, local exclusive task and rebind is refused as busy and
 * changes nothing, and the op goes on when the user answers. The busy
 * state is announced when it starts and ends, so a view can disable the
 * buttons while it lasts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import "fake-indexeddb/auto";
import { ConfigSync } from "../src/sync/config-sync.ts";
import { ConfigLocalDB } from "../src/db/config-local-db.ts";
import { AuthGate } from "../src/db/sync/auth-gate.ts";
import { ALWAYS_VISIBLE } from "../src/db/visibility-gate.ts";
import type { ReconnectBridge } from "../src/sync/reconnect-bridge.ts";
import type { ConfigCreateConfirm } from "../src/sync/config-create-preview.ts";
import type { PushReview } from "../src/sync/config-push-review.ts";
import { DOC_ID } from "../src/types/doc-id.ts";
import { FakeCouchClient } from "./helpers/fake-couch-client.ts";
import { FakeVaultIO } from "./helpers/fake-vault-io.ts";
import { FakeModalPresenter } from "./helpers/fake-modal-presenter.ts";
import { makeSettings } from "./helpers/settings-factory.ts";
import { attachPlain, getAttachment } from "./helpers/config-attach.ts";

let counter = 0;
function uniqueName() { return `cs-overlap-${Date.now()}-${counter++}`; }

/** A dialog that stays open until the test answers it. */
class Dialog<T> {
    private answer!: (v: T) => void;
    open = false;
    show(): Promise<T> {
        this.open = true;
        return new Promise<T>((r) => { this.answer = r; });
    }
    close(v: T): void {
        this.open = false;
        this.answer(v);
    }
}

class HeldModalPresenter extends FakeModalPresenter {
    readonly push = new Dialog<string[] | null>();
    readonly create = new Dialog<boolean>();
    review: PushReview | null = null;
    async showConfigPushModal(review: PushReview): Promise<string[] | null> {
        this.review = review;
        return this.push.show();
    }
    async showConfigCreateModal(confirm: ConfigCreateConfirm): Promise<boolean> {
        this.createCalls.push(confirm);
        return this.create.show();
    }
}

describe("config ops never overlap, their confirmation dialogs included", () => {
    let vault: FakeVaultIO;
    let db: ConfigLocalDB;
    let remote: FakeCouchClient;
    let modal: HeldModalPresenter;
    let settings: ReturnType<typeof makeSettings>;
    let cs: ConfigSync;

    beforeEach(async () => {
        vi.spyOn(console, "error").mockImplementation(() => {});
        vi.spyOn(console, "warn").mockImplementation(() => {});
        vault = new FakeVaultIO();
        db = new ConfigLocalDB(uniqueName());
        db.open();
        remote = new FakeCouchClient();
        modal = new HeldModalPresenter();
        settings = makeSettings({
            deviceId: "dev-A",
            couchdbUri: "http://localhost:5984",
            couchdbConfigDbName: "config-test",
            compressionEnabled: false,
        });
        const bridge: ReconnectBridge = { notifyTransient: () => {} };
        cs = new ConfigSync(
            vault, modal, "test-vault", new AuthGate(), ALWAYS_VISIBLE, bridge,
            () => settings,
            { storeFactory: () => db, clientFactory: () => remote, rawClientFactory: () => remote },
        );
        await cs.rebind("config-test");
    });

    afterEach(async () => {
        vi.restoreAllMocks();
        await cs.close().catch(() => {});
        await db.destroy().catch(() => {});
    });

    /** Every other way in is refused as busy. */
    async function expectAllRefused(): Promise<void> {
        expect(cs.bindingChangeBlocker()).not.toBeNull();
        for (const other of [
            () => cs.push(),
            () => cs.pull(),
            () => cs.overwrite(),
            () => cs.shareAgain(".obsidian/app.json", "/theme"),
            () => cs.create(),
            () => cs.join(),
            () => cs.runExclusive(async () => {}),
            () => cs.rebind(null),
            () => cs.changeCodecSetting({ configCompressionEnabled: true }),
        ]) {
            await expect(other()).rejects.toMatchObject({ name: "BusyError" });
        }
    }

    it("while the Push list is open, nothing else runs; the Push then sends what was chosen", async () => {
        await attachPlain(settings, remote, db);
        vault.addFile(".obsidian/app.json", `{"theme":"dark"}`);
        const pushing = cs.push();
        await vi.waitFor(() => expect(modal.push.open).toBe(true));

        await expectAllRefused();
        // The refusals changed nothing: no doc on the server, the file as it was.
        expect(await remote.getDoc(`${DOC_ID.CONFIG}.obsidian/app.json`)).toBeNull();
        expect(vault.readText(".obsidian/app.json")).toBe(`{"theme":"dark"}`);
        expect(cs.currentBinding()).not.toBeNull();

        modal.push.close(modal.review!.items.map((i) => i.id));
        await expect(pushing).resolves.toBe(1);
        expect(cs.bindingChangeBlocker()).toBeNull();
        expect(await remote.getDoc(`${DOC_ID.CONFIG}.obsidian/app.json`)).not.toBeNull();
    });

    it("saving what a Push left out keeps a Filter change made during the Push", async () => {
        await attachPlain(settings, remote, db);
        vault.addFile(".obsidian/app.json", `{"theme":"dark"}`);
        const pushing = cs.push();
        await vi.waitFor(() => expect(modal.push.open).toBe(true));
        const policy = settings.configSyncPolicy;
        settings.configSyncPolicy = {
            ...policy, unitDefaults: { ...policy.unitDefaults, snippets: false },
        };
        // Leave the file out: the Push saves it as an override.
        modal.push.close([]);
        await pushing;
        expect(settings.configSyncPolicy.overrides[".obsidian/app.json"]).toBe(false);
        expect(settings.configSyncPolicy.unitDefaults.snippets).toBe(false);
    });

    it("Create's confirmation is shown inside the op: nothing else runs while it is open, and Cancel changes nothing", async () => {
        await attachPlain(settings, remote, db);
        const before = (await remote.info()).doc_count;
        const creating = cs.create();
        await vi.waitFor(() => expect(modal.create.open).toBe(true));
        expect(modal.createCalls[0]).toMatchObject({
            dbName: "config-test",
            server: { kind: "read", docCount: before, meta: "present" },
        });

        await expectAllRefused();

        modal.create.close(false);
        await expect(creating).rejects.toMatchObject({ name: "AbortError" });
        expect((await remote.info()).doc_count).toBe(before);
        expect(await getAttachment(db)).not.toBeNull();
        expect(cs.currentBinding()!.relation().lastOp).toBeNull();
        expect(cs.bindingChangeBlocker()).toBeNull();
    });

    it("a server that cannot be read fails Create before its confirmation", async () => {
        remote.info = async () => { throw new TypeError("Failed to fetch"); };
        await expect(cs.create()).rejects.toThrow();
        expect(modal.createCalls).toEqual([]);
    });

    it("Step 1 cannot change while Create's confirmation is open: the DB is built with the codec it showed, and Step 1 still describes it", async () => {
        await attachPlain(settings, remote, db);
        const creating = cs.create();
        await vi.waitFor(() => expect(modal.create.open).toBe(true));
        expect(modal.createCalls[0].next).toMatchObject({ encryption: false, compression: false });

        for (const patch of [
            { configCompressionEnabled: true },
            { configEncryptionEnabled: true },
            { configEncryptionPassphrase: "other" },
        ]) {
            await expect(cs.changeCodecSetting(patch)).rejects.toMatchObject({
                name: "BusyError",
                message: expect.stringMatching(/^Another config operation is already in progress/),
            });
        }
        expect(settings).not.toHaveProperty("configCompressionEnabled", true);
        expect(settings).not.toHaveProperty("configEncryptionEnabled", true);
        expect(settings).not.toHaveProperty("configEncryptionPassphrase", "other");

        modal.create.close(true);
        await creating;
        expect((await getAttachment(db))!.codec).toMatchObject({ encryption: false, compression: false });

        await cs.changeCodecSetting({ configCompressionEnabled: true });
        expect(settings.configCompressionEnabled).toBe(true);
    });

    it("announces when an op starts and when it ends", async () => {
        await attachPlain(settings, remote, db);
        vault.addFile(".obsidian/app.json", "{}");
        const seen: boolean[] = [];
        const off = cs.onChange(() => seen.push(cs.bindingChangeBlocker() !== null));
        const pushing = cs.push();
        expect(seen).toEqual([true]);
        await vi.waitFor(() => expect(modal.push.open).toBe(true));
        modal.push.close(null);
        await pushing.catch(() => {});
        expect(seen).toEqual([true, false]);
        off();
    });
});
