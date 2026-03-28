import { fireAndForget } from "octagonal-wheels/promises";
import type { RemoteDBSettings } from "../../lib/src/common/types";
import { LiveSyncCouchDBReplicator } from "../../lib/src/replication/couchdb/LiveSyncReplicator";
import type { LiveSyncAbstractReplicator } from "../../lib/src/replication/LiveSyncAbstractReplicator";
import { AbstractModule } from "../AbstractModule";
import type { LiveSyncCore } from "../../main";

export class ModuleReplicatorCouchDB extends AbstractModule {
    _anyNewReplicator(settingOverride: Partial<RemoteDBSettings> = {}): Promise<LiveSyncAbstractReplicator | false> {
        return Promise.resolve(new LiveSyncCouchDBReplicator(this.core));
    }
    _everyAfterResumeProcess(): Promise<boolean> {
        if (this.services.appLifecycle.isSuspended()) return Promise.resolve(true);
        if (!this.services.appLifecycle.isReady()) return Promise.resolve(true);
        const LiveSyncEnabled = this.settings.liveSync;
        const continuous = LiveSyncEnabled;
        const eventualOnStart = !LiveSyncEnabled && this.settings.syncOnStart;
        if (LiveSyncEnabled || eventualOnStart) {
            fireAndForget(async () => {
                const canReplicate = await this.services.replication.isReplicationReady(false);
                if (!canReplicate) return;
                void this.core.replicator.openReplication(this.settings, continuous, false, false);
            });
        }

        return Promise.resolve(true);
    }
    override onBindFunction(core: LiveSyncCore, services: typeof core.services): void {
        services.replicator.getNewReplicator.addHandler(this._anyNewReplicator.bind(this));
        services.appLifecycle.onResumed.addHandler(this._everyAfterResumeProcess.bind(this));
    }
}
