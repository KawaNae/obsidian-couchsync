/**
 * Phase 11 (data-layer-v2): 4-mode matrix coverage.
 *
 * Every combination of {encryption ∈ {off, on}, compression ∈ {off, on}}
 * must round-trip a chunk attachment through the decorator stack
 * unchanged. This guards the architectural promise that the four codec
 * modes are first-class citizens — not just "encryption ON" with
 * everything else falling out.
 *
 * Stack composition (matches main.ts):
 *
 *    +--------------------- raw client (FakeCouchClient) ----+
 *    | + EncryptingCouchClient  (when encryption enabled)    |
 *    | + CompressingCouchClient (when compression enabled,   |
 *    |                            wraps outside Encrypting)  |
 *    +-------------------------------------------------------+
 *
 *  push path: app → compress → encrypt → wire
 *  pull path: wire → decrypt → ungzip → app
 *
 *  Every blob fed into the stack is envelope-formatted bytes
 *  (`[codec][IV?][body]`) and every blob returned by the stack is the
 *  same shape with the bits the decorators stripped now cleared.
 *  Tests wrap raw payloads via `asEnvelope` / `fromEnvelope` (see
 *  invariant 12).
 */

import { describe, it, expect, beforeAll } from "vitest";
import { FakeCouchClient } from "./helpers/fake-couch-client.ts";
import { EncryptingCouchClient } from "../src/db/encrypting-couch-client.ts";
import { CompressingCouchClient } from "../src/db/compressing-couch-client.ts";
import {
    createCryptoProvider,
    deriveKeys,
    generateSalt,
    type CryptoProvider,
} from "../src/db/crypto-provider.ts";
import type { ICouchClient } from "../src/db/interfaces.ts";
import { asEnvelope, fromEnvelope } from "./helpers/envelope.ts";

let crypto: CryptoProvider;
beforeAll(async () => {
    crypto = createCryptoProvider(await deriveKeys("matrix-test", generateSalt()));
});

interface Mode {
    name: string;
    encryption: boolean;
    compression: boolean;
}

const modes: Mode[] = [
    { name: "raw",          encryption: false, compression: false },
    { name: "gzip",         encryption: false, compression: true  },
    { name: "encrypt",      encryption: true,  compression: false },
    { name: "gzip-encrypt", encryption: true,  compression: true  },
];

function buildClient(mode: Mode): { app: ICouchClient; inner: FakeCouchClient } {
    const inner = new FakeCouchClient();
    let app: ICouchClient = inner;
    if (mode.encryption) {
        app = new EncryptingCouchClient(app, crypto);
    }
    if (mode.compression) {
        app = new CompressingCouchClient(app);
    }
    return { app, inner };
}

const enc = new TextEncoder();
const dec = new TextDecoder();

describe.each(modes)("sync mode matrix — $name", (mode) => {
    it("chunk attachment round-trips through the stack", async () => {
        const { app } = buildClient(mode);
        const payload = enc.encode("payload-" + mode.name.repeat(20));
        await app.bulkDocsWithAttachments([
            {
                doc: { _id: "chunk:rt-" + mode.name, type: "chunk", schemaVersion: 2 },
                attachments: { c: { contentType: "application/octet-stream", data: asEnvelope(payload) } },
            },
        ]);
        const back = await app.getAttachment("chunk:rt-" + mode.name, "c");
        expect(fromEnvelope(back!)).toEqual(payload);
    });

    it("the inner storage state reflects the codec actually applied", async () => {
        const { app, inner } = buildClient(mode);
        const payload = enc.encode("inner-view-" + mode.name);
        await app.bulkDocsWithAttachments([
            { doc: { _id: "chunk:iv-" + mode.name }, attachments: { c: { contentType: "x", data: asEnvelope(payload) } } },
        ]);

        const innerBlob = await inner.getAttachment("chunk:iv-" + mode.name, "c");
        expect(innerBlob).not.toBeNull();
        // Every byte on the wire is envelope-formatted (invariant 12).
        // The header reflects which codecs were actually applied.
        const expectedHeader =
            (mode.encryption ? 0x01 : 0) | (mode.compression ? 0x02 : 0);
        expect(innerBlob![0]).toBe(expectedHeader);

        if (!mode.encryption && !mode.compression) {
            // raw: stripping the 1-byte envelope yields the exact input.
            expect(innerBlob!.slice(1)).toEqual(payload);
        } else {
            // Anything else transforms the bytes before storage.
            expect(innerBlob!.slice(1)).not.toEqual(payload);
        }
    });

    it("highly compressible content actually shrinks in compressed modes", async () => {
        const { app, inner } = buildClient(mode);
        // 4 KiB of one character — gzip should crush this.
        const payload = enc.encode("a".repeat(4 * 1024));
        await app.bulkDocsWithAttachments([
            { doc: { _id: "chunk:cmp-" + mode.name }, attachments: { c: { contentType: "x", data: asEnvelope(payload) } } },
        ]);
        const innerBlob = await inner.getAttachment("chunk:cmp-" + mode.name, "c");
        if (mode.compression && !mode.encryption) {
            expect(innerBlob!.length).toBeLessThan(payload.length / 4);
        } else if (mode.compression && mode.encryption) {
            // gzip-then-encrypt: cipher is incompressible afterwards, but
            // the *plain* compression still ran, so the stored cipher
            // size reflects compressed plaintext + IV + tag overhead.
            // Less than the raw payload but bounded below by the
            // compressed plaintext.
            expect(innerBlob!.length).toBeLessThan(payload.length / 3);
        } else if (!mode.compression && mode.encryption) {
            // encrypt only: cipher ≈ plaintext + 28 B (envelope+IV+tag).
            expect(innerBlob!.length).toBeGreaterThanOrEqual(payload.length);
            expect(innerBlob!.length).toBeLessThan(payload.length + 64);
        } else {
            // raw: same bytes plus the 1-byte envelope header.
            expect(innerBlob!.length).toBe(payload.length + 1);
        }
    });

    it("multiple chunks in one batch each round-trip independently", async () => {
        const { app } = buildClient(mode);
        const items = Array.from({ length: 5 }, (_, i) => ({
            doc: { _id: `chunk:multi-${mode.name}-${i}` },
            attachments: {
                c: { contentType: "x", data: asEnvelope(enc.encode(`item-${i}-` + mode.name.repeat(10))) },
            },
        }));
        await app.bulkDocsWithAttachments(items);
        for (let i = 0; i < items.length; i++) {
            const back = await app.getAttachment(items[i].doc._id, "c");
            expect(dec.decode(fromEnvelope(back!))).toBe(`item-${i}-` + mode.name.repeat(10));
        }
    });

    it("empty attachment round-trips correctly", async () => {
        const { app } = buildClient(mode);
        await app.bulkDocsWithAttachments([
            { doc: { _id: "chunk:empty-" + mode.name }, attachments: { c: { contentType: "x", data: asEnvelope(new Uint8Array(0)) } } },
        ]);
        const back = await app.getAttachment("chunk:empty-" + mode.name, "c");
        expect(fromEnvelope(back!)).toEqual(new Uint8Array(0));
    });

    it("getAttachment on a missing doc returns null", async () => {
        const { app } = buildClient(mode);
        expect(await app.getAttachment("chunk:none-" + mode.name, "c")).toBeNull();
    });
});

describe("cross-mode independence", () => {
    it("two different mode instances do not interfere (separate fakes)", async () => {
        const a = buildClient(modes[0]);
        const b = buildClient(modes[3]);
        const payload = enc.encode("isolation-probe");
        await a.app.bulkDocsWithAttachments([
            { doc: { _id: "chunk:iso" }, attachments: { c: { contentType: "x", data: asEnvelope(payload) } } },
        ]);
        expect(await b.app.getAttachment("chunk:iso", "c")).toBeNull();
        const back = await a.app.getAttachment("chunk:iso", "c");
        expect(fromEnvelope(back!)).toEqual(payload);
    });
});
