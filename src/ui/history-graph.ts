import type { HistoryEntry } from "../history/types.ts";

export interface GraphRow {
    entry: HistoryEntry;
    column: number;
    hasUp: boolean;
    hasDown: boolean;
    passThrough: number[];
    mergeFrom: number[];
}

export function buildGraphLayout(
    entries: HistoryEntry[],
    headRecordId: number | null,
): GraphRow[] {
    if (entries.length === 0) return [];

    const recordMap = new Map<number, HistoryEntry>();
    const childrenMap = new Map<number | "root", HistoryEntry[]>();

    for (const e of entries) {
        if (e.record.id != null) recordMap.set(e.record.id, e);
        const key: number | "root" = e.record.parentId ?? "root";
        if (!childrenMap.has(key)) childrenMap.set(key, []);
        childrenMap.get(key)!.push(e);
    }

    const headPathIds = buildHeadPathIds(recordMap, headRecordId);

    const subtreeSize = new Map<number, number>();
    function computeSubtreeSize(id: number): number {
        if (subtreeSize.has(id)) return subtreeSize.get(id)!;
        const children = childrenMap.get(id) ?? [];
        let size = 1;
        for (const child of children) {
            if (child.record.id != null) size += computeSubtreeSize(child.record.id);
        }
        subtreeSize.set(id, size);
        return size;
    }
    for (const e of entries) {
        if (e.record.id != null && !subtreeSize.has(e.record.id)) {
            computeSubtreeSize(e.record.id);
        }
    }

    const columnMap = new Map<number, number>();
    let nextColumn = 1;

    for (const id of headPathIds) {
        columnMap.set(id, 0);
    }

    const headPathList: number[] = [];
    if (headRecordId !== null) {
        let cur: number | null = headRecordId;
        const visited = new Set<number>();
        while (cur !== null && !visited.has(cur)) {
            visited.add(cur);
            headPathList.unshift(cur);
            const rec = recordMap.get(cur);
            if (!rec) break;
            cur = rec.record.parentId;
        }
    }

    function assignBranch(startId: number, col: number): void {
        const queue: number[] = [startId];
        while (queue.length > 0) {
            const id = queue.shift()!;
            if (columnMap.has(id)) continue;
            columnMap.set(id, col);
            const children = (childrenMap.get(id) ?? [])
                .filter((c) => c.record.id != null && !columnMap.has(c.record.id!))
                .sort((a, b) => (subtreeSize.get(b.record.id!) ?? 0) - (subtreeSize.get(a.record.id!) ?? 0));
            let first = true;
            for (const child of children) {
                if (first) {
                    queue.push(child.record.id!);
                    first = false;
                } else {
                    assignBranch(child.record.id!, nextColumn++);
                }
            }
        }
    }

    for (const id of headPathList) {
        const children = childrenMap.get(id) ?? [];
        for (const child of children) {
            if (child.record.id != null && !columnMap.has(child.record.id)) {
                assignBranch(child.record.id, nextColumn++);
            }
        }
    }

    for (const e of entries) {
        if (e.record.id != null && !columnMap.has(e.record.id)) {
            columnMap.set(e.record.id, 0);
        }
    }

    const mergeFromMap = new Map<number, number[]>();
    for (const e of entries) {
        if (e.record.id == null) continue;
        const myCol = columnMap.get(e.record.id)!;
        const children = childrenMap.get(e.record.id) ?? [];
        const mergeCols: number[] = [];
        for (const child of children) {
            if (child.record.id != null) {
                const childCol = columnMap.get(child.record.id);
                if (childCol !== undefined && childCol !== myCol) {
                    if (!mergeCols.includes(childCol)) mergeCols.push(childCol);
                }
            }
        }
        if (mergeCols.length > 0) mergeFromMap.set(e.record.id, mergeCols);
    }

    const sorted = [...entries].sort((a, b) => b.record.timestamp - a.record.timestamp);

    const rows: { entry: HistoryEntry; column: number; mergeFrom: number[] }[] = [];
    for (const entry of sorted) {
        const col = columnMap.get(entry.record.id!) ?? 0;
        const mf = mergeFromMap.get(entry.record.id!) ?? [];
        rows.push({ entry, column: col, mergeFrom: mf });
    }

    const colRange = new Map<number, { start: number; end: number }>();
    for (let i = 0; i < rows.length; i++) {
        const col = rows[i].column;
        if (!colRange.has(col)) colRange.set(col, { start: i, end: i });
        else colRange.get(col)!.end = i;

        for (const mc of rows[i].mergeFrom) {
            if (!colRange.has(mc)) colRange.set(mc, { start: i, end: i });
            else colRange.get(mc)!.end = Math.max(colRange.get(mc)!.end, i);
        }
    }

    const maxCol = colRange.size > 0 ? Math.max(0, ...colRange.keys()) : 0;
    return rows.map((row, i) => {
        const range = colRange.get(row.column);
        const mergeSet = new Set(row.mergeFrom);
        const passThrough: number[] = [];
        for (let c = 0; c <= maxCol; c++) {
            if (c === row.column) continue;
            if (mergeSet.has(c)) continue;
            const cr = colRange.get(c);
            if (cr && cr.start <= i && i <= cr.end) {
                passThrough.push(c);
            }
        }
        return {
            entry: row.entry,
            column: row.column,
            hasUp: range ? i > range.start : false,
            hasDown: range ? i < range.end : false,
            passThrough,
            mergeFrom: row.mergeFrom,
        };
    });
}

export function getMaxColumn(rows: GraphRow[]): number {
    let max = 0;
    for (const r of rows) {
        max = Math.max(max, r.column);
        for (const c of r.passThrough) max = Math.max(max, c);
        for (const c of r.mergeFrom) max = Math.max(max, c);
    }
    return max;
}

function buildHeadPathIds(
    recordMap: Map<number, HistoryEntry>,
    headRecordId: number | null,
): Set<number> {
    const ids = new Set<number>();
    if (headRecordId === null) return ids;
    let cur: number | null = headRecordId;
    const visited = new Set<number>();
    while (cur !== null && !visited.has(cur)) {
        visited.add(cur);
        ids.add(cur);
        const rec = recordMap.get(cur);
        if (!rec) break;
        cur = rec.record.parentId;
    }
    return ids;
}
