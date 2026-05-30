# obsidian-couchsync — Threat Model

This document describes what obsidian-couchsync **does** and **does not**
protect against, and the trade-offs of each codec mode. Read it before
deciding whether to enable encryption or compression for your vault.

## What this plugin is for

Synchronising an Obsidian vault between multiple devices via a CouchDB
server you control. Obsidian itself stores all vault content as plaintext
files on each device's local disk; that constraint defines the ceiling
of what any sync layer can protect.

## Trust boundaries

| Component | Trust | Notes |
|---|---|---|
| **Obsidian (local app)** | **Trusted** | Reads/writes plaintext files. |
| **Local disk (per-device)** | **Trusted** | Obsidian's storage model. |
| **CouchDB server (your NAS / cloud)** | **Configurable** | If you don't trust the server admin, enable encryption. |
| **Network between devices and server** | **Configurable** | If you don't trust the network, use HTTPS *and* consider encryption. |
| **Anyone with file-system access on a device** | **Untrusted, but not in scope** | Standard OS-level account security applies. |

The plugin protects the **server storage** and **server-to-device
transport** when encryption is enabled. It does not protect against an
attacker who already has local file access on one of your devices.

## Codec modes

Both encryption and compression are independent toggles, set at Init time
and recorded in the `vault:meta` document. They form four named modes:

| Mode | Encryption | Compression | When to choose |
|---|---|---|---|
| **`raw`** | off | off | Internal benchmarking / debugging only. |
| **`gzip`** | off | on | Server fully trusted (LAN-only, your own NAS). Lowest wire bytes. |
| **`encrypt`** | on | off | Theoretical-best E2E secrecy under exotic threat models. See "Why turn compression off" below. |
| **`gzip-encrypt`** | on | on | **Default recommendation.** E2E confidentiality plus ~50 % less wire than `encrypt`-only. Trade-off described below. |

## What encryption protects (when enabled)

- **Chunk content**: each chunk's binary payload is encrypted with
  AES-256-GCM under a key derived from your passphrase via PBKDF2-SHA-256
  (600,000 iterations). The server stores only ciphertext.
- **File and config paths**: doc IDs are HMAC-SHA-256 of the original
  path. The original path is encrypted inside the doc body so authorised
  clients can recover it.
- **The whole file/config doc body**: chunk references, vector clock,
  sizes and timestamps are compressed-then-encrypted into a single
  `encBody` field (AES-256-GCM). Only the HMAC'd `_id` rides in the clear.
  The server cannot see which chunks a file is built from, its causal
  history, or its size.
- **Integrity against a malicious server** (cipherVersion 3): every
  `encBody` is GCM-bound to its `_id` (the id is the AES-GCM additional
  authenticated data), and every chunk body is re-hashed to its content-
  addressed id on *every* pull path — live sync, Clone, and repair alike.
  A server (or MITM) that reorders/substitutes chunk references, swaps a
  body onto another doc, rolls back a vclock, or tampers a chunk's bytes is
  **detected** (authentication failure → the doc/chunk is rejected and
  routed to repair) rather than silently restoring forged content. Note:
  this is tamper-*evidence*, not availability — a malicious server can
  still withhold or delete data; it just cannot forge it undetected.

## What encryption does **not** protect

- **Total number and size distribution of chunks**: a server admin can
  count chunk *attachments* and observe their cipher sizes. From these they
  can estimate vault size and the rough shape of content (many small chunks
  vs few large ones). The per-file chunk *mapping* is hidden (it lives in
  the encrypted body), but the chunk inventory itself is not.
- **Linkability of identical content**: chunks are content-addressed.
  A given plaintext chunk produces the same chunk ID across files, so
  a server admin can observe "this content appears in N files in this
  vault."
- **Update timing**: when you write a file, the resulting push is
  observable by anyone watching the server's `_changes` feed.
- **Anything stored locally on your devices**: Obsidian writes
  plaintext to disk. Local file-system compromise reveals everything. The
  plugin's own `data.json` also stores your CouchDB password and encryption
  passphrase in plaintext.
- **A weak passphrase against offline brute force**: the per-vault `salt`
  and `keyCheck` are readable by anyone with server access, so an attacker
  who copies them can guess passphrases offline. Each guess costs one
  PBKDF2-SHA-256 (600k) derivation — strong against casual attempts but
  PBKDF2-SHA-256 is comparatively GPU-friendly, so a short or common
  passphrase is recoverable. Use a long, high-entropy passphrase.

## Why turn compression off (`encrypt` mode)

The `gzip-encrypt` mode applies gzip **before** AES-GCM. This is the
order all reputable backup tools (BorgBackup, restic, Duplicati, Tarsnap,
Signal sticker packs, age) use for the same reason: it shrinks
network bytes substantially on text-heavy data.

The theoretical concern is the **CRIME/BREACH class of attacks**:
when an attacker can inject chosen content alongside a secret into the
same compression context and observe the post-compression size, they
can recover the secret byte-by-byte. The attack requires three
ingredients:

1. Attacker can mix chosen plaintext with the secret in a single
   compressed stream.
2. Attacker can observe the encrypted output size.
3. The secret has structure short enough to brute-force byte-by-byte
   (e.g. a session cookie).

In obsidian-couchsync, **(1) does not exist as a path** — your vault
contains only your own writes, and an external attacker has no way to
inject text into your chunks. The "secret" (your vault content) also
has no fixed structure to brute-force.

However, with compression enabled, two minor residual side channels do
exist:

- **Compression ratio fingerprinting**: a server admin observing many
  chunks can infer their content category from compression ratio
  (markdown ~50 % shrink, images ~0 %). Without compression all chunks
  approximately match plaintext binary size.
- **Cross-vault statistical analysis**: with a large enough corpus of
  encrypted chunks, byte-pattern analysis on gzip output could in
  theory yield content hints. This is academic in single-user vaults.

If you want to eliminate even these theoretical channels at the cost
of ~50 % more wire bytes, choose `encrypt` mode (compression off).

## Wire-byte comparison (typical markdown vault)

Relative to the `raw` baseline on a markdown-heavy vault, average
chunk wire bytes:

| Mode | Wire ratio | Notes |
|---|---|---|
| `raw` | 1.00x | plain binary |
| `gzip` | ~0.50x | text patterns + base64 redundancy both recovered |
| `encrypt` | ~1.00x | cipher binary ≈ plaintext binary + 28 B overhead |
| `gzip-encrypt` | ~0.55x | compression effective, encryption near-zero overhead |

(Measured on the `vault-dev` benchmark, 619 chunks averaging ~75 KB
plaintext binary; per-attachment, transport-layer overhead excluded.)

## Choosing a mode

- **You sync only within your own LAN / Tailscale and trust the server
  hardware** → `gzip`. Maximum speed, no E2E overhead.
- **You want E2E confidentiality and accept the standard
  compress-then-encrypt trade-off** → `gzip-encrypt`. Recommended default.
- **You want strict information-theoretic isolation of content sizes
  even at the cost of bandwidth** → `encrypt`.
- **You're debugging / benchmarking** → `raw`.

Once a vault is initialised, both flags are fixed for that vault. To
change them, run Init again (which is a destructive operation — it
recreates the remote database).

## Cryptographic primitives

| Purpose | Algorithm | Parameters |
|---|---|---|
| Key derivation | PBKDF2-HMAC-SHA-256 → HKDF-SHA-256 | 600 000 iterations PBKDF2, 16 B salt, separate HKDF info strings per key purpose. |
| Content encryption | AES-256-GCM | 12 B random IV per encryption, 16 B authentication tag. |
| Chunk ID (encrypted vault) | HMAC-SHA-256 | Over plain chunk bytes, hex-encoded. |
| Chunk ID (plaintext vault) | xxhash64 | Over plain chunk bytes, hex-encoded, 16 chars. |
| Path encryption | AES-256-GCM | Same key as content. Original path stored in `encryptedPath` field as a base64-wrapped envelope. |
| Passphrase verification | AES-256-GCM | `keyCheck`: a known-plaintext token encrypted under the derived key. Unlock decrypts it and matches the constant. Verifying a passphrase guess costs a full PBKDF2 derivation (the GCM auth tag is the verifier); there is no separate, cheaper verification token. |

All primitives use the Web Crypto API (`crypto.subtle`). No custom
crypto is implemented.

## Envelope format

Every byte sequence the plugin persists to the server — attachment
bodies and encrypted string fields — carries a 1-byte codec header so a
reader handed the raw bytes can decode them without consulting
`vault:meta` or any other external context.

```
byte 0     : codec flags
  bit 0    (0x01)  encrypted (AES-GCM v1; IV(12B) follows)
  bit 1    (0x02)  compressed (gzip v1)
  bit 2-6  reserved, must be 0 (reader rejects on non-zero)
  bit 7    (0x80)  extension flag, must be 0 in v1 (reserved escape
                   for a future extended descriptor at byte 1)
byte 1+    : [IV(12B) — present only when bit 0 is set] [payload]
```

The order of operations is fixed: on push the body is gzipped before
it is encrypted (compress → encrypt), so on pull the inverse order
applies (decrypt → decompress). The header records what was applied,
not the order, which is implicit and tested as an architectural
invariant.

### Where the envelope appears

| Site | Form | Notes |
|---|---|---|
| Chunk attachment (`_attachments.c`) | binary envelope | Plaintext + uncompressed still carries the `0x00` header — universality is required, not optional. |
| `ConfigDoc.data` when encrypted | base64(envelope) | Plaintext vaults skip the envelope (the field is just `base64(bytes)`); the format is unambiguous either way because `vault:meta.encryption.enabled` declares which case applies and the encrypted form's base64 has no colon separator (legacy hint). |
| `encryptedPath` field on FileDoc / ConfigDoc | base64(envelope) | Only present in encrypted vaults. Always carries `encrypted=1`. |
| `vault:meta.encryption.keyCheck` | base64(envelope) | Same shape; the well-known plaintext `"couchsync-e2e-v1"` confirms a passphrase derives the correct contentKey. |

### Why the envelope matters

Without per-blob version markers, every future change to the cipher,
KDF, compression algorithm, or any other on-wire detail would require a
synchronous migration of every existing byte sequence (or a dual-reader
that consults `vault:meta` for every decode and assumes the entire
vault is on one version). The envelope makes the format per-blob
identifiable, so the project can roll new algorithms in alongside the
old ones without requiring every device to upgrade in lockstep.

This is the primary structural reason v0.25.0 must land before the
plugin is published — after publication, every byte sequence that ever
shipped is something every future version has to be able to decode.

## Local-only schema versioning

Each local Dexie database (`couchsync-<vault>`,
`couchsync-<vault>-meta`, the per-config-pool variants,
`couchsync-history-<vault>`, `couchsync-logs-<vault>`) carries a
`_meta.schemaVersion = 1` row stamped on first open. A future build
that bumps the local row layout will increment the value and migrate
on open; a stale build encountering a higher version throws a
`degraded` error so the user is prompted to update rather than the
plugin silently mis-reading rows. This is local-only state and never
travels to the server.

## Reporting security issues

Please open a private security advisory on the GitHub repository.
Do not file public issues for vulnerabilities.
