/**
 * Minimal runtime stub for the `obsidian` package in the test env.
 *
 * The real `obsidian` npm package ships only .d.ts — the runtime API
 * exists inside the Obsidian app. Tests that transitively import code
 * which references `Notice`, etc. need a no-op implementation so the
 * module graph resolves.
 */

export class Notice {
    constructor(_message: string, _timeout?: number) {}
    setMessage(_message: string): this { return this; }
    hide(): void {}
}
