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
| `VAULT_PLAINTEXT_RETENTION_DAYS` | 30 | Days between a verified-complete conversion and removing the old plaintext (see "Removing the old plaintext"). `0` is allowed; an invalid value falls back to 30. |
| `VAULT_KEY_CONVERSION` | off | `on` lets desktops key vaults that asked for it (see below). Also requires the desktop to report a version at or above the `MIN_CLIENT_VERSION` floor. Keep it off until every member runs a desktop that supports vault keys. |

Turn on `BAALDA_VAULT_KEYS` first, upgrade desktops, raise `MIN_CLIENT_VERSION`, and only then turn on
`VAULT_KEY_CONVERSION`. A vault no member opens after that stays unkeyed until someone does.

**Which vaults get keyed.** New vaults created while `BAALDA_VAULT_KEYS` is on are encrypted
automatically (`POST /api/vaults` records `vaults.encryption_requested_at`). Existing vaults stay
exactly as they are until an owner or admin clicks **Encrypt this vault** in Vault Settings → General
(`POST /api/vaults/:vaultId/keys/request-encryption`: owner/admin only, idempotent, one-way; there is no
undo, and the first request is recorded in the access history). `GET …/keys/mine` on an unkeyed vault
answers `encryptionRequested` and `conversionAllowed`, which is the rollout gate above AND a recorded
request. The server enforces it: `keys/pending` and `keys/init` refuse an unrequested vault with 409
`encryption_not_requested` and store nothing, whatever the client. Plain members see nothing until the
vault is keyed.

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
  vault-key encryption (`blobs.data`), and so do the file bytes pinned by checkpoints
  (`checkpoint_blob_bytes`). The null-out does not touch either: they have no sealed copy.
- Team skill files (`skill_version_files`, `skill_draft_files`).
- Wikilink targets (`note_links`), which are note titles.
- Note titles, file and folder paths and names, sizes, timestamps, membership, sharing rules and audit rows.
- Rows written before a vault was keyed stay as they were until a separate, delayed null-out step has checked
  every row. Database backups taken before then keep the plaintext until they age out under your retention.

## Removing the old plaintext

Once every older row has a verified sealed copy, the server waits `VAULT_PLAINTEXT_RETENTION_DAYS` (default
30; `0` is allowed, for testing) and then, only while a member's key is held, opens each sealed copy and
compares it byte for byte with the plaintext. Only an exact match clears the plaintext, in a statement that
also checks the row has not changed since. A row that does not match keeps both copies and is logged by id.
Until then, compaction of a converting note keeps exactly its old plaintext in one checked row and stores
everything newer encrypted only. Vault Settings shows "Older content is being encrypted; new edits are
already encrypted." until no plaintext is left. A search row re-indexed after keying keeps its older plaintext
beside the newer sealed entry, so the two never match. That plaintext is derived (rebuilt from the note), so
it is cleared too, with the same guarded statement, but only when the sealed entry is current: for a note,
its text equals the note's text right now; for a file, it is the entry every reader uses. A note edited
since its last re-index waits for the next one.

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
- **What fills the key cache.** A member's vault channel holds the key while it is connected, plus 10 minutes.
  A request that presented a key the server VERIFIED also fills it for 15 minutes after the last such request
  (`VaultKeyCache.holdForRequest`): any verified `X-Baalda-VK` request, an MCP or OAuth write with its token's own
  key (checked against `vk_check` first), and `keys/init` with the key it just set. So a keyed vault edited only
  over HTTP or MCP, with no desktop connected, is still indexed, its links kept and its idle versions captured
  (those fire about 10 minutes after the edit). It only ever goes one way: a request fills the cache and never
  reads from it. Read-only public-link views never fill it.
- **Indexing a keyed vault.** User writes index with the request's own key (debounced, after the response; the
  key copy is zeroed after the run). With no key at all, a note is queued in `index_pending`; any key arrival,
  and the 30-second tick while a key is held, drains the whole queue in batches of 500.
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
- **Conversion of an existing vault** (after an owner/admin asked for it). The first owner/admin device on a supporting version registers a pending
  key. Existing MCP tokens and public links are allow-listed by the device and upgraded on their next use. The
  vault is keyed only when nothing used in the last 30 days still lacks its own wrap; until then everything
  works exactly as before. A connection idle for more than 30 days needs one reconnect after conversion.

## Older desktops

A desktop released before vault keys (0.1.97 and older) never sees a vault-key refusal it does not
understand. On a keyed vault, every request it makes that leads to content (sync and vault-channel
tokens, registration, bootstrap, pushes, uploads, search, versions) is answered `426 client_outdated`,
the "update required" refusal those builds already handle: they stop syncing, keep every local file
as it is, and install the update. Nothing is written on the server. A desktop counts as supporting
vault keys when it reports version 0.1.98 or later, or presents the vault's verified key. Unkeyed
vaults work for every version exactly as before.

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
