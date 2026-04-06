import type { LocalDB } from "../db/local-db.ts";
import type { CouchSyncDoc, FileDoc } from "../types.ts";
import { isFileDoc } from "../types.ts";

export class ConflictResolver {
    constructor(
        private db: LocalDB,
        private onConflictResolved?: (
            filePath: string,
            winnerDoc: FileDoc,
            loserDoc: FileDoc,
        ) => Promise<void>,
    ) {}

    async resolveIfConflicted(doc: CouchSyncDoc): Promise<boolean> {
        if (!doc._conflicts || doc._conflicts.length === 0) return false;
        if (!isFileDoc(doc)) return false;

        const db = this.db.getDb();
        // Clone to avoid mutating the caller's reference
        const winner = { ...(doc as FileDoc) };

        for (const conflictRev of doc._conflicts) {
            try {
                const conflicting = await db.get(doc._id, { rev: conflictRev }) as unknown as FileDoc;

                // Determine winner (newer editedAt, falling back to mtime) and loser
                const winnerTime = winner.editedAt ?? winner.mtime;
                const conflictTime = conflicting.editedAt ?? conflicting.mtime;
                let loserDoc: FileDoc;
                if (conflictTime > winnerTime) {
                    loserDoc = { ...winner };
                    winner.chunks = conflicting.chunks;
                    winner.mtime = conflicting.mtime;
                    winner.ctime = conflicting.ctime;
                    winner.size = conflicting.size;
                    winner.deleted = conflicting.deleted;
                    winner.editedAt = conflicting.editedAt;
                    winner.editedBy = conflicting.editedBy;
                } else {
                    loserDoc = conflicting;
                }

                // Save loser to history before removing
                if (this.onConflictResolved) {
                    this.onConflictResolved(doc._id, winner, loserDoc).catch((e) => {
                        console.error("CouchSync: Failed to save conflict history:", e);
                    });
                }

                await db.remove(doc._id, conflictRev);
            } catch (e) {
                console.error(`CouchSync: Failed to resolve conflict for ${doc._id} rev ${conflictRev}:`, e);
            }
        }

        await this.db.put(winner);
        console.log(`CouchSync: Auto-resolved ${doc._conflicts.length} conflict(s) for ${doc._id}`);
        return true;
    }

    async resolveAllConflicts(): Promise<number> {
        const db = this.db.getDb();
        const result = await db.allDocs({
            include_docs: true,
            conflicts: true,
        });

        let resolved = 0;
        for (const row of result.rows) {
            if ("doc" in row && row.doc) {
                const doc = row.doc as unknown as CouchSyncDoc;
                if (doc._conflicts && doc._conflicts.length > 0) {
                    if (await this.resolveIfConflicted(doc)) {
                        resolved++;
                    }
                }
            }
        }
        return resolved;
    }
}
