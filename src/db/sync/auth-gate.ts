/**
 * AuthGate — owns the "credentials are rejected" latch.
 *
 * Any caller that reaches the server (sync loops, settings-tab probes,
 * config-sync ops) checks `isBlocked()` before issuing a request and
 * calls `raise(status, reason)` on 401/403 to latch the gate. Clearing
 * is explicit (Test button, manual retry): a blocked gate never
 * self-clears, because an unattended retry storm is exactly what the
 * latch exists to prevent.
 *
 * Subscribers (`onChange`) are notified only on transitions — repeat
 * raises while blocked, or clears while already cleared, are no-ops.
 * This keeps listeners like the SyncController's hard-error handler
 * idempotent without each listener needing to track prior state.
 */
export interface AuthErrorDetail {
    status: number;
    reason: string;
}

export class AuthGate {
    private blocked = false;
    private lastError: AuthErrorDetail | null = null;
    private listeners = new Set<(detail: AuthErrorDetail | null) => void>();

    isBlocked(): boolean {
        return this.blocked;
    }

    /** Detail of the rejection that raised the gate, or null if clear. */
    getLastError(): AuthErrorDetail | null {
        return this.lastError;
    }

    /**
     * Latch the gate. Idempotent: subsequent raises while blocked update
     * the stored detail silently but do NOT re-fire onChange.
     */
    raise(status: number, reason?: string): void {
        const detail: AuthErrorDetail = { status, reason: reason ?? "" };
        this.lastError = detail;
        if (this.blocked) return;
        this.blocked = true;
        this.fire(detail);
    }

    /** Clear the latch. Idempotent: no-op when already cleared. */
    clear(): void {
        if (!this.blocked) return;
        this.blocked = false;
        this.lastError = null;
        this.fire(null);
    }

    /**
     * Subscribe to latch transitions. Fires with the detail on raise,
     * null on clear. Returns an unsubscribe function.
     */
    onChange(listener: (detail: AuthErrorDetail | null) => void): () => void {
        this.listeners.add(listener);
        return () => { this.listeners.delete(listener); };
    }

    private fire(detail: AuthErrorDetail | null): void {
        for (const l of this.listeners) {
            try {
                l(detail);
            } catch {
                // Listeners shouldn't throw; swallow to keep other listeners running.
            }
        }
    }
}
