# Baalda Steward

**Vault Settings → AI → Scan vault** collects fresh whole-vault measurements and
asks the selected model to produce a prioritized action plan. AI has Diagnostics
and Settings tabs: a saved key opens Diagnostics by default; a missing key opens
Settings. Provider/key/model controls live only in Settings. The page is a
findings feed: there are no permanent link-repair, storage or inspector panels.
Findings are numbered and use measured error/warning/info indicators. Evidence and tools appear only when a finding is expanded. Jev 1.13 is the default;
other OpenRouter chat models supporting structured output can be selected.

## Evidence and decisions

Baalda runs the 15 filesystem/index integrity checks and gathers vault size, note
and file counts, largest-file size, history/index footprint, sync state, failure
categories and local/remote file differences. The model receives measurements
and categories, not raw note text, file paths or error logs. The UI joins returned
finding IDs to local evidence so people can inspect the actual files and errors.

A batched inference selects priority and a next step for each observed finding.
The model can distinguish ordinary storage from storage needing review; it cannot
invent a quota. Actual observed errors are not suppressed by uncertain model
judgment. Findings sort by model priority, then count and stable ID for ties.
This is analysis of measured evidence, not a claim that an LLM read every file or
can discover errors outside the supplied observations.

Available next steps include inspection, index rebuild, sync retry, affected-file
retry, reviewed link repair, and reviewing paths, empty notes, properties,
permissions, storage or recovery copies. The service validates choices against
each finding's capability list. Unsupported or uncertain action choices become
inspection. Models cannot execute arbitrary commands or supply arbitrary edits.

The client rechecks Pro before suggested local repairs, verifies the current
finding, invokes existing Health actions and refreshes measurements. Existing
manual tools retain their permission checks and destructive confirmation flows.
When AI is unavailable, measured local findings and manual tools remain Free.
Basic Health retains its sync overview and links to individual findings here.

## Personal OpenRouter key

Create a key at <https://openrouter.ai/settings/keys>, enable OpenRouter in AI,
and save the key. Keys live in the OS keychain, scoped to account and server.
Inference passes the key through the selected Baalda server to OpenRouter; the
server does not persist it or fall back to server credentials. Use a server you
trust. OpenRouter bills the user's account. Status/apply/undo do not include the
provider key. The provider toggle and model preference persist without storing
credentials in localStorage.

The pinned `@openrouter/sdk` uses `alpha.decisions.create` for Jev and `chat.send`
for custom chat models. There is no silent model fallback. Provider errors are
sanitized; SDK requests time out after 12 seconds with retries disabled.

## Link repair capability

When selected for a finding, link review reads canonical synced Yjs content and
retrieves up to eight permission-filtered Markdown candidates. It sends up to
700 characters per candidate and roughly 1,000 characters around the unresolved
link, with titles and paths. Plain wikilinks are supported; code, frontmatter,
comments, embeds and heading links are excluded. Four links are checked per scan,
with pagination. No confident candidate is an explicit no-fix result.

Previews are opaque, single-use, scoped to user/vault and expire after 15 minutes.
Apply rechecks Pro, note permissions, revisions, paths and link resolution before
a minimal edit through `DocWriter.editContent`. Undo uses an inverse edit guarded
by the post-edit revision. Later human edits are never overwritten. Existing Yjs
sync and Rust persistence own the resulting write.

## Availability and local preview

The engine lives under `app/apps/server/housekeeper/` under Apache-2.0 and ships
with the standard server. Every request requires vault membership. Cloud
instances also require a non-deleted Pro subscription in `active` or `past_due`.
Self-hosters have access without Pro. Users supply their own
OpenRouter key. Local-only vaults still need a registered vault for server AI.

Explicit local testing can use `HOUSEKEEPER_LOCAL_PREVIEW=true`, but only with
`NODE_ENV=development` and a loopback `DATABASE_URL`. Production ignores it.
Remove the flag to restore the local Pro gate. Membership, personal-key and note
permissions still apply during preview.

The Apache-2.0 engine ships in the standard server package and Docker image at
`housekeeper/`. `HOUSEKEEPER_MODULE` can override the module location. Self-hosters can use it without Pro; Cloud instances require Pro.
Limits: 2,000 readable notes, 100,000 characters per source/candidate, six inference
runs per user/vault/minute and one concurrent operation per user/vault. Previews
and limits are process-local; deployments need a single process or sticky routing.

## Verification

- `node --test app/apps/server/housekeeper/*.test.mjs` from the repository root.
- `pnpm exec vitest run src/http/routes/housekeeper.test.ts` in the server directory.
  This file mocks database/auth and SDK transport; it does not wipe a database.
- Desktop typecheck and the Steward, Health rendering and check-action suites.
- Live Jev tests used synthetic evidence and notes: diagnostic recommendations,
  candidate selection, guarded apply and undo. User vault notes were not edited.

Provider references: [OpenRouter SDK](https://openrouter.ai/docs/client-sdks/typescript/overview),
[Jev](https://openrouter.ai/typesafe/jev-1.13).

## Agent action lifecycle

The Baalda Agents contract is **observe → investigate → propose → approve →
execute → verify**. Model output chooses a typed capability; it is never executable
code. Investigation may gather additional permission-filtered evidence for a
specific finding. Link replacement previews and legal-filename plans show concrete
changes before Apply. Index rebuild and sync retry reuse existing guarded tools.
Unsupported repairs remain inspection; agents must not promise a fix they cannot
execute. Scan, preparation, apply and verification expose separate loading states.

Literal Markdown code examples and comments do not enter new link-index rows.
Integrity checks also validate unresolved legacy rows against current note bytes,
so an old index cannot keep reporting code examples as broken links.

## Additional repair actions

The `repair` endpoint prepares model-reviewed edits for malformed properties,
duplicate note titles, and restoring an empty synced note from its latest bounded
nonempty saved version. These use the same scoped, expiring preview tokens,
revision-checked CRDT edits and guarded undo as link repairs. The model receives
bounded excerpts and may abstain. Property repairs only close an unambiguous
block or preserve malformed lines under `recovered_properties`; they do not infer
missing values. Recovery is limited to available saved versions under the preview
size limit, and an intentional empty note should be left alone.

Local previews support distinct file names and shorter leaf names, backup copies
of oversized/unreadable files and recovery copies, approved heavy-history resets,
orphan-history reclamation, re-registration of preserved local files, and download
of missing remote binary files. Scope and findings are rechecked before execution;
renames also check live server edit permission and file identity. Recovery copies
are not emptied by these agent actions. Partial failures are reported explicitly.
Permission findings prepare an access request on the clipboard; they never grant
access or send messages. Oversized-file backups preserve the only copy but do not
split/compress content or remove the sync size limit. Deep folder restructuring,
arbitrary YAML rewrites and content deduplication are not supported repairs.

## Deployment policy

Set `BAALDA_DEPLOYMENT=self-hosted` for self-hosted installations (included in
`.env.example`). Steward remains available whether billing is absent, configured
at installation, or added later. Operator billing configuration is independent.
`BAALDA_DEPLOYMENT=cloud` requires Pro for AI and limits Free vaults to 20,000 synced
notes. Omission defaults to `cloud` so existing Cloud deployments remain guarded,
even if payment credentials are missing. Self-hosters bypass this Cloud note cap.
