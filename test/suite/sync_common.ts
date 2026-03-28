import { expect } from "vitest";
import { waitForIdle, type LiveSyncHarness } from "../harness/harness";
import { type ObsidianLiveSyncSettings } from "@/lib/src/common/types";

import { delay } from "@/lib/src/common/utils";

export async function performReplication(harness: LiveSyncHarness) {
    await delay(500);
    const result = await harness.plugin.core.services.replication.replicate(true);
    return result;
}

export async function closeReplication(harness: LiveSyncHarness) {
    const replicator = await harness.plugin.core.services.replicator.getActiveReplicator();
    if (!replicator) {
        console.log("No active replicator to close");
        return;
    }
    await replicator.closeReplication();
    await waitForIdle(harness);
    console.log("Replication closed");
}

export async function prepareRemote(harness: LiveSyncHarness, setting: ObsidianLiveSyncSettings, shouldReset = false) {
    {
        if (shouldReset) {
            await delay(1000);
            await harness.plugin.core.services.replicator
                .getActiveReplicator()
                ?.tryResetRemoteDatabase(harness.plugin.core.settings);
        } else {
            await harness.plugin.core.services.replicator
                .getActiveReplicator()
                ?.tryCreateRemoteDatabase(harness.plugin.core.settings);
        }
        await harness.plugin.core.services.replicator
            .getActiveReplicator()
            ?.markRemoteResolved(harness.plugin.core.settings);
        // No exceptions should be thrown
        const status = await harness.plugin.core.services.replicator
            .getActiveReplicator()
            ?.getRemoteStatus(harness.plugin.core.settings);
        console.log("Remote status:", status);
        expect(status).not.toBeFalsy();
    }
}
