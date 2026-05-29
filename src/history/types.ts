export type HistorySource = "local" | "sync";

export interface DiffRecord {
    id?: string;
    filePath: string;
    timestamp: number;
    patches: string;
    baseHash: string;
    added?: number;
    removed?: number;
    conflict?: boolean;
    /** Origin of this entry. Required — writers always stamp it
     *  explicitly. The `_meta.schemaVersion` row in the history DB
     *  reflects this guarantee (invariant 15); v0.25.0 is the first
     *  format that mandates the field. */
    source: HistorySource;
}

export interface FileSnapshot {
    filePath: string;
    content: string;
    lastModified: number;
}

export interface HistoryEntry {
    record: DiffRecord;
    added: number;
    removed: number;
}
