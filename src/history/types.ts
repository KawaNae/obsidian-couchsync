export interface DiffRecord {
    id?: string;
    filePath: string;
    timestamp: number;
    patches: string;
    baseHash: string;
    added?: number;
    removed?: number;
    conflict?: boolean;
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
