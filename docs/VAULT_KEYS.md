# Vault keys

Vault keys are encryption at rest with keys held by the client. Each vault has a random 32-byte key that
only its members' devices keep (in the OS keychain). The server stores ciphertext for vault content and
never writes the key to disk. Devices send the key with each request or connection. The server uses it in
memory to run sync, search, version history, MCP and public links, then discards it.

**This is not end-to-end encryption.** A running server process sees plaintext and keys while it works, so
a deliberately modified server build could capture them. What vault keys protect against is access to the
database, its backups and admin tools alone: those contain only ciphertext for the columns listed below.

The feature is **off by default**. With it off, the server behaves exactly as it did before.

## Enabling it on a self-hosted server

| Variable | Default | Meaning |
|---|---|---|
| `BAALDA_VAULT_KEYS` | off | `on` enables vault keys: the key routes, the `vault-keys` feature in `GET /health`, and sealed storage for keyed vaults. Off: nothing in `src/crypto/` is consulted. Any value other than on/off (`1/true/on/yes`, `0/false/off/no`, empty) stops the server at first use. |
| `VAULT_KEY_CONVERSION` | off | `on` lets desktops key vaults (new and existing). Also requires the desktop to report a version at or above the `MIN_CLIENT_VERSION` floor. Keep it off until every member runs a desktop that supports vault keys. |

Turn on `BAALDA_VAULT_KEYS` first, upgrade desktops, raise `MIN_CLIENT_VERSION`, and only then turn on
`VAULT_KEY_CONVERSION`. A vault no member opens after that stays unkeyed until someone does.

## What is encrypted

Sealed with AES-256-GCM under the vault key. Each value is bound to its table, column, vault and row, so a
ciphertext cannot be moved to another row.

- Note content: the CRDT update log and snapshots (`doc_updates.update_enc`, `doc_snapshots.snapshot_enc`).
- The search index: note text, vectors and token sets (`note_index.search_enc`), and text extracted from files
  (`blob_text.search_enc`).
- Version history and checkpoint text (`note_texts.content_enc`).
- Public link tokens: only a hash and a sealed copy are stored (`public_links.token_hash`, `token_enc`), plus
  the vault key wrapped under a key derived from the link's secret (`public_links.wrapped_vk`).
- MCP tokens: only hashes are stored, plus the vault key wrapped under a key derived from each token's own
  secret (`mcp_token_keys`).

## What is not encrypted

- **Attachment and file bytes.** With `BLOB_STORAGE=s3` (S3, R2, MinIO) uploads and downloads go straight to
  the bucket through presigned URLs and are **not** encrypted with the vault key. They are protected only by
  the storage provider's own encryption at rest. With `BLOB_STORAGE=postgres` they sit in Postgres without
  vault-key encryption.
- Note titles, file and folder paths and names, sizes, timestamps, membership, sharing rules and audit rows.
- Rows written before a vault was keyed stay as they were until a separate, delayed null-out step has checked
  every row. Database backups taken before then keep the plaintext until they age out under your retention.

## How it works

- **Who holds keys.** Members' devices only. Each user has an X25519 key pair; the vault key is sealed to each
  member's public key (`vault_key_wraps`, one row per member per key generation). The server stores the check
  value `vaults.vk_check` to verify a presented key, and never the key itself.
- **Transport.** HTTP requests carry `X-Baalda-VK` (base64). Per-note sync sockets send `<jwt>.<vk>` as the
  token. The vault channel's `hello` carries the key. Neither the header nor the token suffix may be logged:
  the server redacts sync tokens in logs and never prints the header.
- **Rule 1 — every request presents the key itself.** Any request or socket that reads or writes content must
  carry the key, checked against `vk_check`. The in-memory key cache serves only the server's own background work
  (indexing, compaction, checkpoints, backfill), never a user request, so a session forged in the database reads
  nothing.
- **Rule 2 — only a member's device shares the key.** Sealing the key to a new member or device happens on an
  existing member's device. The server only queues the request, so a member or device inserted into the
  database gets nothing.
- **Trust on first use.** Devices pin each member's key fingerprint the first time they seal to it. A later
  change refuses to seal and shows "<name>'s security key changed" until someone approves it.
- **Rule 3 — tokens unwrap their own key.** MCP tokens and public links store hashes only, plus the vault key
  wrapped under a key derived from the token's secret. Each call unwraps it, uses it and zeroes it. MCP and
  public links keep working with no desktop online.
- **Device linking.** A new device of the same account shows a code; one of the user's existing devices
  approves it and shares the account key. A session alone never yields keys.
- **Owner vault key.** Owners can reveal the vault key in Vault Settings → General ("Show vault key") to copy
  or save it. It is never emailed or sent anywhere. An owner who has lost every device restores with it.
- **Conversion of an existing vault.** The first member device on a supporting version registers a pending
  key. Existing MCP tokens and public links are allow-listed by the device and upgraded on their next use. The
  vault is keyed only when nothing used in the last 30 days still lacks its own wrap; until then everything
  works exactly as before. A connection idle for more than 30 days needs one reconnect after conversion.

## Zero data loss

- Plaintext is never removed before a per-row decrypt-and-compare check passes; removal is a separate,
  delayed and reversible step.
- A `key_required` refusal changes nothing on the server and never drops local edits; the desktop retries.
- Compaction replaces rows only after the new sealed snapshot decodes to the same state.
- Old key generations are never destroyed, so older rows stay readable.
- A vault is keyed only after a definitive "not keyed" answer. When in doubt, the server refuses and the
  client retries.

## Limits

- One key per vault. Per-note and per-folder access is still enforced by the server, not by separate keys.
- Removing a member does not rotate the key.
- A solo owner who never saved the vault key and loses every device cannot recover the server copy.
