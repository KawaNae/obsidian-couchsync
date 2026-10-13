import { describe, it, expect } from "vitest";
import { backupConfigFiles, backupStamp, pruneBackups } from "../src/sync/config-backup.ts";
import { FakeVaultIO } from "./helpers/fake-vault-io.ts";

const ROOT = ".obsidian/plugins/couchsync/backups/config";
const enc = (s: string) => new TextEncoder().encode(s);

describe("config backups", () => {
    it("copies each file under one generation folder, below .obsidian/", async () => {
        const vault = new FakeVaultIO();
        const dir = await backupConfigFiles(vault, ROOT, [
            { path: ".obsidian/app.json", bytes: enc("a") },
            { path: ".obsidian/plugins/x/data.json", bytes: enc("d") },
        ], new Date(2026, 9, 13, 8, 5, 9));

        expect(dir).toBe(`${ROOT}/2026-10-13_08-05-09`);
        expect(vault.readText(`${dir}/app.json`)).toBe("a");
        expect(vault.readText(`${dir}/plugins/x/data.json`)).toBe("d");
    });

    it("gives a second backup in the same second its own folder", async () => {
        const vault = new FakeVaultIO();
        const at = new Date(2026, 9, 13, 8, 5, 9);
        await backupConfigFiles(vault, ROOT, [{ path: ".obsidian/app.json", bytes: enc("1") }], at);
        const second = await backupConfigFiles(vault, ROOT, [{ path: ".obsidian/app.json", bytes: enc("2") }], at);

        expect(second).toBe(`${ROOT}/${backupStamp(at)}_2`);
        expect(vault.readText(`${ROOT}/${backupStamp(at)}/app.json`)).toBe("1");
    });

    it("keeps the newest generations", async () => {
        const vault = new FakeVaultIO();
        for (let i = 0; i < 5; i++) {
            vault.addFile(`${ROOT}/2026-10-1${i}_00-00-00/app.json`, String(i));
        }
        await pruneBackups(vault, ROOT, 2);
        expect((await vault.list(ROOT)).folders.sort()).toEqual([
            `${ROOT}/2026-10-13_00-00-00`,
            `${ROOT}/2026-10-14_00-00-00`,
        ]);
    });
});
