/**
 * applyServerSettings — a refusal is reported only when the config binding
 * switch itself refused, before anything was switched or saved. A save that
 * throws runs after the switch, so it is never mistaken for that refusal.
 */
import { describe, it, expect } from "vitest";
import { applyServerSettings, type ConfigServerSwitch } from "../src/settings-tab/server-apply.ts";
import { BusyError } from "../src/ui/describe-error.ts";

function configSwitch(refuse: string | null): ConfigServerSwitch & { switched: string[] } {
    const switched: string[] = [];
    return {
        switched,
        changeBlocker: () => refuse,
        switchServer: async (uri, commit) => {
            if (refuse) throw new BusyError(refuse);
            switched.push(uri);
            await commit();
        },
    };
}

describe("applyServerSettings", () => {
    it("a switch refused because a config op runs saves nothing", async () => {
        const cfg = configSwitch("A config operation is running — Apply is available when it finishes.");
        let saves = 0;
        const result = await applyServerSettings({
            configBinding: cfg, oldUri: "a", newUri: "b", save: async () => { saves++; },
        });
        expect(result).toMatchObject({ kind: "refused", error: { name: "BusyError" } });
        expect(saves).toBe(0);
        expect(cfg.switched).toEqual([]);
    });

    it("a save refused after the switch is not reported as a refused switch", async () => {
        const cfg = configSwitch(null);
        const refusal = new BusyError("Init is running — wait for it to finish.");
        await expect(applyServerSettings({
            configBinding: cfg, oldUri: "a", newUri: "b", save: async () => { throw refusal; },
        })).rejects.toBe(refusal);
        expect(cfg.switched).toEqual(["b"]);
    });
});
