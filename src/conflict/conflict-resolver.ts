import type { LocalDB } from "../db/local-db.ts";
import type { CouchSyncDoc, FileDoc } from "../types.ts";
import { isFileDoc } from "../types.ts";

export class ConflictResolver {
    constructor(private db: LocalDB) {}

    /**
     * Check a document for conflicts and auto-resolve.
     * Returns true if conflicts were resolved.
     */
    async resolveIfConflicted(doc: CouchSyncDoc): Promise<boolean> {
        if (!doc._conflicts || doc._conflicts.length === 0) return false;
        if (!isFileDoc(doc)) return false;

        const db = this.db.getDb();
        const winner = doc as FileDoc;

        for (const conflictRev of doc._conflicts) {
            try {
                const conflicting = await db.get(doc._id, { rev: conflictRev }) as unknown as FileDoc;

                // Auto-resolve: newer mtime wins
                if (conflicting.mtime > winner.mtime) {
                    // The conflicting version is newer — adopt its data
                    winner.chunks = conflicting.chunks;
                    winner.mtime = conflicting.mtime;
                    winner.ctime = conflicting.ctime;
                    winner.size = conflicting.size;
                    winner.deleted = conflicting.deleted;
                }

                // Remove the losing revision
                await db.remove(doc._id, conflictRev);
            } catch (e) {
                console.error(`CouchSync: Failed to resolve conflict for ${doc._id} rev ${conflictRev}:`, e);
            }
        }

        // Save the winning version
        await this.db.put(winner);
        console.log(`CouchSync: Auto-resolved ${doc._conflicts.length} conflict(s) for ${doc._id}`);
        return true;
    }

    /**
     * Scan all documents for unresolved conflicts.
     */
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
