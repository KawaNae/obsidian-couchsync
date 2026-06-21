export type HistorySource = "local" | "sync";

export interface DiffRecord {
    id?: number;
    filePath: string;
    timestamp: number;
    patches: string;
    baseHash: string;
    added?: number;
    removed?: number;
    conflict?: boolean;
    source: HistorySource;
    parentId: number | null;
}

export interface FileSnapshot {
    filePath: string;
    content: string;
    lastModified: number;
    headRecordId: number | null;
}

export interface HistoryEntry {
    record: DiffRecord;
    added: number;
    removed: number;
}
