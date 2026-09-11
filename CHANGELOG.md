# Changelog

All notable changes to Baalda are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project aims to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Performance
- **Startup and note loading, Rust side.** CRDT state, state-vector manifests
  and attachment bytes now cross the desktop IPC boundary as raw bytes in both
  directions (framed; `src/lib/ipcCodec.ts` ↔ `commands.rs`) instead of JSON
  number arrays — the largest measured doc was 17.7 MB of CRDT shipped as
  ≈62 MB of JSON text per open. Thirteen config/vault commands moved off the
  main (painting) thread and the parsed app config is cached in `AppState`, so
  `app_config_dir` + `create_dir_all` is one syscall pair per process rather
  than per call. The open-time index rebuild now skips folder rows whose parent
  and name are unchanged (1,458 pointless writes per open on the measured
  vault), and folder churn alone no longer triggers a whole-vault link
  re-resolution pass. `open_vault` reports per-phase timings (on `VaultInfo`
  and as one log line) and `rebuild` logs one line unconditionally. Release
  builds now use thin LTO, one codegen unit and a stripped binary.

### Changed
- **Pressing Private seals the vault, for the person who pressed it too.** The
  control used to express Private by DELETING the vault's grant row, and absence
  already meant something else: a vault that was never shared, which is the
  private-by-default space `created_by` exists for, where people keep the notes
  they wrote. One state, two meanings, wanting opposite answers about
  authorship — so Private spared the author, and in a vault you set up yourself
  you wrote nearly every note in it, which made it a setting you could press and
  see nothing happen. `PUT /orgs/:orgId/team-access { mode: "private" }` now
  upserts an org-principal **`denied`** row on the vault resource (all three
  modes upsert one row in place, so `grantId` is stable and there is no instant
  mid-transaction where the vault reads as never-shared), and
  `resolver.vaultBaseline` reports it as a fourth posture, `sealed`. Sealed
  skips the role shortcut AND authorship: nobody reads anything until something
  is shared by name or a folder is shared with the team, which still lifts —
  sealed is a floor, not a wall, and that is the one thing an item set Private
  does differently, since there the point is to withdraw one item from a team
  that can otherwise reach it. Creation closes with reading
  (`vaultRootWritable`, `canEditFolder`): a note you make in a sealed vault is a
  note you instantly cannot open, so the root refuses one unless a per-user
  vault-scoped `edit` grant lifts you. Sealing narrows even from no row at all,
  so it kicks every live socket and broadcasts the ACL change, which ranking by
  grant alone would have missed (`denied` and absence both rank 0). A vault that
  merely never had a grant is untouched and keeps working exactly as it does
  today — pressing the button is what upgrades it.
- **Private means the same thing at every scope, owners and admins included.**
  An item set to Private already dropped them (the org `denied` row resolves
  above the role branch), but the vault-wide Private posture did not: with no
  org grant on the vault, `effectivePermission` still short-circuited
  owner/admin to `edit`, and `vault-docs.ts vaultAccess` answered
  `vaultWide: true` for the role before reading a single grant — the widest
  bypass in the system, feeding the readable set, the folder tree, blob reads,
  the graph, MCP search, the registry pull and the vault channel's
  `ready.revoked`. So one word meant two different things depending on which
  control you reached for, and the person who set it was the one person who
  could not observe it working. The role shortcut is now withdrawn under a
  Private posture in `effectivePermission`, in `resolveAccessForUser` (the "who
  can access" list, which must agree branch for branch), in `vaultAccess` (the
  early return is gone; the role reaches vault-wide read through the org grant
  like everyone else) and in `canEditFolder`. **Authorship survives** — everyone
  keeps the notes and folders they created, which is what the Private card has
  always promised members — and it deliberately does not survive an *item* set
  to Private: an item is one thing you withdraw from the team, while the posture
  is the state every vault sits in from birth, and a Private vault that dropped
  authorship too would be unreadable to the person who just made it. Managing
  access is untouched and role-based (`shares.ts canManage`), so an owner can
  always put it back. Two gates that used to ride on the role closed with it:
  minting a public link now requires read access as well as the management gate
  (publishing a note you cannot open would put it on the open web), and a
  whole-vault checkpoint revert requires vault-wide read (403
  `no_vault_wide_access`) because a partial revert restores the structure whole
  and the contents in part. Fixtures that seeded a vault directly were quietly
  testing a Private vault driven by an owner; they now seed the org grant
  `POST /api/vaults` creates, and `seedFolder` takes a creator like `seedNote`.
- **The "Entire vault" control reads what the team can actually reach.** Setting
  every folder and note to Private one at a time left the control saying
  **Shared**, because a per-item Private is a `denied` row on that item and
  never touches the vault row above it — two controls answering one question,
  and the one at the top was answering about a row. `lib/accessMode.ts`
  `effectiveVaultMode` now rolls the root items up: when they unanimously agree
  on a mode the posture disagrees with, that mode is what the control marks
  active and a line underneath names the posture. Unanimity, not the maximum —
  an item with no row of its own really is whatever the posture says, so one
  Private folder among many leaves "Shared" the honest answer. Root items are a
  sufficient sample because nothing under a Private folder is reachable however
  it is marked. Three pieces of copy that promised owners and admins keep access
  were wrong and are fixed, including the item-Private confirm, which had been
  describing the opposite of what the server did since the org deny was added.
- **The Access panel's vault-level control enforces a mode instead of merely
  defaulting to it.** "This vault, by default" wrote one `shares` row on the
  vault resource and left every per-folder and per-note override standing, so
  "set the whole vault to Shared" quietly skipped everything anyone had ever
  overridden — which people read, correctly, as the control not working. It is
  now labelled **Entire vault** and calls `PUT /api/orgs/:orgId/team-access`,
  which in one transaction deletes every org-principal row on every folder and
  file in the vault's collections and then writes the new vault row (none, for
  Private). Per-**user** rows are untouched: people shared with by name keep
  their access. The confirm names what it is about to replace with exact counts
  (`accessMode.ts` `overrideCountPhrase` — "This replaces 3 folder settings and
  1 note setting"), and the toast afterwards quotes the server's own `cleared`
  count, because a teammate can add an override between the confirm and the
  write. Wording moved with it: `MODE_LABEL` makes `open` **"Shared"**
  everywhere (one hint in the detail pane still said "Open", which read as a
  fourth state nobody could find), and the per-member tri-state's "Default" is
  now **"Inherited"**. `docs/specs/04-team-collaboration.md` lost its stale
  "Private by default" paragraph, which still described the posture reversed on
  2026-08-07, and gained the two-control model.
- **"Readable line length" is now a Content width slider.** The two-state switch
  could only answer 88ch or the whole window; the slider runs 60–120ch in steps
  of 4 with one stop past the end that means full width (`lib/editorMeasure.ts`
  `sliderToMeasure`), and applies live as an inline `--editor-measure` on
  `.editor-column` rather than the old `data-measure="full"` attribute — so
  `--editor-pad-x` and its consumers still follow with no JavaScript at all.
  `context.readableLineLength` is read once to migrate a device that still has
  it ("off" ⇒ Full) and never written again; the new key is
  `context.editorMeasure`. The Suspense-fallback `EditorSkeleton` column takes
  the same style, so its bars no longer sit at the default 88ch and jump
  sideways when the real note lands. The graph panel's private restyling of the
  native range input was lifted into app-wide `.range-input` / `.range-value`
  rather than copied.
- **Settings rows have height and dividers.** `.menu-row` is the account
  popover's row rendered on a surface eight times the size, and at the popover's
  4px padding a column of them reads as one paragraph, with no line between the
  control you meant to reach and the one below it. A row that is a DIRECT child
  of `.settings-content` now gets `min-height: 40px`, `var(--sp-3)` vertical
  padding and a hairline between siblings. Side padding goes to zero rather than
  up, so rows stay aligned with the section headings above them;
  `.settings-footer-row` still wins on specificity, and rows nested inside a
  card (the billing plan, the Updates tab) are deliberately untouched because
  their container already spaces them.
- **The editor's default measure is 88ch, down from 120ch — a visible
  narrowing.** Past roughly ninety characters the eye loses the start of the
  next line; this is where every typographic rule of thumb, and Obsidian's own
  default, lands. Settings → Appearance → "Content width" moves it, and dragging
  that slider past its last stop, to Full, restores the full width.
- **`indentUnit.of("  ")`** is now set explicitly, so `lists.ts`'s Tab/Shift-Tab,
  `indentOnInput` and every CodeMirror indent command share one answer to "how
  wide is a level". `lists.ts` lost its dead `listEnter` command and the unused
  half of `parseItem` along with it: lang-markdown registers
  `insertNewlineContinueMarkup` at `Prec.high`, so ours could never run.
- **Markdown markers moved to a new faint tier.** `--text-faint` (light
  `#bfbfc8`, dark `#55555f`) is defined in all three `tokens.css` colour blocks
  — `:root`, `[data-theme="dark"]` and the `prefers-color-scheme` pre-hydration
  block, and missing the third would flash light markers on a dark cold start.
  `t.meta`, `t.processingInstruction`, `t.contentSeparator`, `t.labelName` and
  `t.comment` all consume it, as do `.cm-bullet` and `.cm-gutters`. Code tokens
  inside fences map onto the existing palette (`--accent`, `--success`,
  `--warning`, `--link`); `defaultHighlightStyle` is never imported, because it
  ships hardcoded colours that ignore the theme. New tokens alongside:
  `--highlight-bg` (the `==` wash), `--callout-tint`, `--editor-fold-gutter`,
  `--indent-guide` / `--indent-guide-active`.
- **Bullets stay dots on the active line.** The `ListMark` case now runs ahead of
  the scope checks: a marker that changes shape under the caret is exactly the
  flicker Stage 3 exists to remove, and Backspace still deletes the real `-`
  (`deleteMarkupBackward`) because the decoration never touches the document.
  Task items keep the old rule — the raw `- [ ]` has to come back for editing,
  and `tasks.ts` drops its checkbox on the same line rule.
- **Launch no longer waits for the network.** The whole UI used to be gated on
  the session restore, which ends in the sync reconcile — a full disk walk, ~14
  serial HTTP round trips and three reads of a `.context/config.json` that is
  1.85 MB on a 6k-note vault — so the window sat on "Loading…" for seconds. The
  boot flag now covers only the vault open: the sidebar paints as soon as the
  tree is in the store, and `initAuth` runs detached behind a generation guard
  (`authInitGen`), so a sign-in/sign-out performed meanwhile always wins over
  the restore that lands after it. Inside the restore, the roster and the
  billing flag run in parallel, `refreshVault`'s three independent GETs run in
  parallel, and seat usage no longer gates the landing. `AccountMenu` gained an
  `authPending` state, so the identity bar names the open vault instead of
  claiming "Local · not synced" while the answer is still in flight.
- **Sync enables in two phases, so a first click is safe.** `SyncManager.enable`
  now primes the registry from the folder's own `.context/config.json` before
  any round trip (`VaultRegistry.primeLocal`), which makes every already-mapped
  note openable *with* a provider — pull-before-seed — while the structural
  reconcile is still running. The prime is a second, narrower flag than
  `enabled` on purpose: the watcher pipeline, the debounced registry pull and
  attachments stay off until the reconcile finishes, because a pull racing a
  reconcile is its own class of bug. A folder whose config carries no
  `organizationId` stamp, or a foreign one, refuses to prime. The landing and
  the vault switch pass `{ background: true }` and return at the prime; "Turn on
  sync" still waits for the whole enable. New pure `lib/sync/openGate.ts` holds
  the rule for a click that beats the prime (wait for a folder we know syncs;
  open at once for one we know is local, or when signed out), with a 3 s belt so
  nothing can wedge the first click.
- **`peek_vault_config` → `peek_vault_stamp`.** The launch path asked three
  times "which vault does this folder belong to?", and every answer shipped the
  folder's entire config — doc-id map included — over IPC to be JSON-parsed in
  the webview. The new command streams the file in Rust and returns just
  `{ organizationId, serverVaultId }`; `rediscoverVaultFolder` now takes those
  typed stamps instead of raw JSON. The registry still reads the full file —
  once per boot, shared between the prime and the reconcile.
- **The reconcile stopped doing work nobody used.** `GET /api/notes` was
  downloaded on every pass to answer one boolean only a just-created vault can
  act on (and `syncStructure` fetches the same endpoint again regardless), so it
  is now requested only when a seed is actually possible. `list_note_titles` —
  which parks on the SQLite write lock held by the background rebuild — became a
  memoized thunk that fires only when some on-disk note is unmapped or missing
  from the server: zero calls on a steady-state relaunch.
- **CRDT compaction counts bytes, not just rows.** The trigger was ">64 updates,
  checked at load", and on a 5,933-note vault it had never fired (busiest doc:
  58 updates) while 28 individual updates were over 1 MB each. `compactBytes`
  (1 MB) now fires alongside `compactThreshold`, and both are checked live as
  well as at load, so a paste or an AI rewrite no longer leaves megabytes of log
  to replay on every open of that note.
- **Billing → Transfer is a dialog, not a one-item menu.** Clicking Transfer on
  a Pro vault now opens a dialog that names the vault the subscription is
  leaving, lists every eligible destination as a selectable card with its seat
  count and Free plan, pre-selects the only candidate when there is just one,
  and explains what happens to both vaults before the confirm. When some owned
  vaults are missing it says why (already on Pro). `ConfirmDialog` gained a
  `confirmDisabled` prop so the confirm waits for a pick.
- **Faster launch, smaller app.** The window now stays hidden until the UI has
  actually painted, so no blank frame precedes the app (a Rust timer reveals it
  anyway after 1.5s if the webview never gets that far). The editor
  (CodeMirror), the illustrated avatars, the graph, the settings dialog, the
  welcome screen, and the sign-in and share dialogs each load on demand, which
  cuts the startup bundle from 2.05 MB to ~890 KB; the editor and avatar chunks
  are prefetched right after the first paint, so the first click still feels
  instant. Also targets the oldest supported WKWebView (Safari 13, matching
  `minimumSystemVersion` 10.15) instead of Vite's newer default, drops 3.2 MB
  of unreferenced brand art and Vite template SVGs from every installer, loads
  only the wordmark the current theme shows, and removes an unused font
  dependency.
- **New notes are created empty.** Rust `notefile.rs create_note` used to seed
  `# {stem}`, a visible duplicate of the title the app already shows. With it
  gone, the "title follows heading" rule (`lib/editor/titleFollow.ts`) went too:
  its whole premise was that seeded H1, and on a *legacy* note all it could do
  was silently rename the file while you typed over an old heading. Naming a new
  note happens in the note's own inline title (below), armed by the new shared
  `store.createNoteIn` — one create path for the sidebar's New-note button, the
  tab strip's `+` and ⌘N (which used to invent `Untitled ${Date.now()}`). The
  Rust *index* title is unchanged (frontmatter `title:` → first H1 → stem): it
  is what `[[wikilinks]]` resolve against and what `notes_fts` indexes, and it
  stays the search/link title while the UI shows the file name.
- **The note title is its file name, in one place.** The header's `.note-title`
  span is gone and the tab strip is the header's top row, so the two can no
  longer disagree about a note whose H1 and filename differ (they did). New
  `lib/notePath.ts` (`stemOf` / `noteLabel` / `sanitizeFileStem`) is the one
  label rule, shared by the tab strip, the sidebar rows, search results and
  backlinks. The active tab is marked by one soft highlight that slides between tabs (tabs never reorder). Added
  ⌘W (close), Ctrl-Tab / Ctrl-Shift-Tab (walk the strip in its visible order)
  and a `+` button.
- **Opening a note reveals it in the sidebar.** Store `requestReveal` + one
  `FileTree` effect: the folders above it are listed in ancestor order, the row
  scrolls into view and pulses once (nothing under `prefers-reduced-motion`).
  This generalises the rAF-retry `beginRename` the new-folder flow used, which is
  now one mechanism for both.

### Added
- **`ready.revoked` — the server STATES a revocation on every connect.** The
  vault channel's `ready` frame gained `revoked` / `revokedTruncated`
  (`sync/vault-protocol.ts`), the third of its doc lists after `empty` and
  `behind`: the docs THIS CLIENT'S OWN hello manifest claims it holds that are
  not in its readable set any more. `vault-channel.ts` `revokedFromManifest` is
  set arithmetic over two things already in hand, so it costs **no query**, and
  `REVOKED_CAP = 2000` bounds it — bounded by what the client holds, never by
  the vault, so a member of a private vault full of docs they never had is named
  none of them, and every id named is one the client itself sent us. The desktop
  fires `onServerRevoked` inside the `ready` handler FIRST, ahead of
  `setStatus("synced")`, because that flip is what arms the reconnect's registry
  pull and recording the authority afterwards would be one pull too late.
  `docSession.handleServerRevoked` stamps `aclChangedAt`, records the set and
  queues an `acl-revoked` pull; `authoritativeRevoked()` hands it to the planner,
  which NARROWS the allow-list instead of lifting `revokeCap` wholesale: only
  docs the server named are exempt from the cap, and the residue is measured on
  its own size once they leave the group. What that agreement buys is narrow and
  worth stating exactly: `GET /api/notes` and `revokedFromManifest` both call
  `listReadableDocsInVault`, so the named list is ONE resolver read twice, at two
  moments over two transports. It catches a transient or racy short answer and
  nothing else — a regression inside that function would produce the short
  listing and the announcement together. The answer that can genuinely disagree
  is `access-check` (below), which every cap-lifted removal now waits for.
  The named set is a UNION for the vault session: `handleServerReauth` no longer
  clears it, and the live path feeds it too, because `refreshAcl` sends one
  `drop` per lost doc immediately before the `reauth` and `onServerDrop` records
  each id — so an announcement that names nothing (a lock toggled on a note this
  user cannot see) can never widen a three-note authority into a whole-vault
  one. A truncated list likewise keeps the 2000 ids it did carry as the
  allow-list rather than lifting wholesale; the residue rides the ordinary cap
  and the next connect names the next batch, so a very large revocation
  converges over a few connects. The DELETION cap is never lifted by any of it.
  Folders are separate: `folderLift` requires an authoritative pass that named
  NOTHING, because folder ids are not doc ids and neither the named list nor the
  access-check can speak about them — and folder removal is empty-only all the
  way down (`ipc.deleteFolderIfEmpty` is `remove_dir`, never recursive), so the
  worst a wrong folder revocation can do is take away directories holding
  nothing. Old clients ignore the new fields (`parseServerControl` rebuilds the
  frame from the keys it knows) and an old server's bare `ready` fires nothing.
- **`POST /api/vaults/:vaultId/access-check` — a second, differently computed
  answer before any file leaves the disk.** Member-gated, body `{ docIds }`
  capped at `ACCESS_CHECK_MAX = 2000` (the same bound the channel frame carries),
  replying `{ none }` computed per doc with `permissions/resolver.ts`
  `effectivePermission` — the resolver DUAL of the listing, so a bug in
  `listReadableDocsInVault` can no longer corroborate itself. It enumerates
  nothing: the response is a subset of what was asked. An id with no row in THIS
  vault is left UNANSWERED rather than reported unreadable — the client's rule for
  an unanswered id is to keep the file, and saying `none` for an id the caller
  reads perfectly well in a different vault would be a false confirmation on the
  one route whose whole job is to be a second opinion. There is deliberately no
  `deleted_at` filter: a soft-deleted note does have a row and should reach the
  resolver, which answers `none` for it through `locateDoc`, and a merely REVOKED
  doc always has a live row, so a real revocation is always answered. The ids run
  through a `runPool` at `config.backfillConcurrency` — the same width the vault
  channel backfills at — because `effectivePermission` is roughly seven queries
  per doc and awaiting them in series held one pool connection for thousands of
  sequential round trips (300 ids, same data: 1067 ms → 285 ms).
  The client pays for it only where it matters. `planInbound` emits
  `InboundPlan.needsAccessCheck` — the revoked entries that survive only because
  the cap was lifted, measured against the revoked group as it stood BEFORE any
  refusal, so a named survivor cannot skip corroboration just because the unnamed
  half blew its own cap and left it back under the line — and `applyInbound` runs
  `confirmRevocations` before anything is deleted: the resolver agreeing lets the
  removal stand; the resolver still granting pulls the entry out of `plan.trash`
  AND `plan.suppress` (so the next pass treats it as an ordinary note instead of
  freezing it out) and hands the id back through `InboundHost.revocationRefused`,
  which is the one way the named set ever shrinks; a request that throws removes
  nothing in the group. The call is chunked in slices of `ACCESS_CHECK_MAX` and
  the answers unioned, because the route 400s above the bound and a 400 reads as
  "no answer" — unchunked, every revocation on a vault of more than 2000 mapped
  notes was struck in full on every connect, forever. A throw on ANY slice fails
  the WHOLE group, never just that slice: the answers corroborate one decision,
  and acting on the half that came back would delete files on a partial second
  opinion. The bound is mirrored as `lib/api.ts ACCESS_CHECK_MAX` (the two
  packages cannot import each other) and pinned by `accessCheckBound.test.ts`,
  which reads the number out of the server source — drift there reinstates
  exactly that bug. `ApiClient.request` also gained a `timeoutMs`
  (`AbortController`, cleared in a `finally`) and `accessCheck` passes
  `ACCESS_CHECK_TIMEOUT_MS = 30_000`, so a wedged proxy reads as "no answer" and
  removes nothing rather than holding up the pull. A revocation small enough to
  have needed no lift still costs no round trip at all.
- **`tests/root-freeze.test.ts` pins the frozen-root contract**, 16 cases across
  both surfaces: the toggle's owner/admin gate, a plain member's root note and
  root folder refused with `code: "root_frozen"` while creation inside an
  existing root folder still works, a move out to the root refused through all
  four spellings (`folderId:null`, `relPath` alone, `parentId:null`, `path`
  alone), a `rel_path`/`folder_id` disagreement refused as a 400
  `path_folder_mismatch` rather than resolved to the root, a soft-deleted root
  note that cannot come back under a new doc_id, and MCP `create_note` /
  `create_folder` parity, which had no coverage at all. Every assertion reads
  the `notes`/`folders` tables rather than trusting the response body.
- **A read-only vault shows the padlock on every folder and note.**
  `GET /api/vaults/:vaultId/locks` now returns one synthetic row —
  `resource_type: 'vault'`, `permission: 'locked'`, id `vault:<orgId>` so it can
  never collide with a routable share id — when the vault's posture is `view`,
  while the stored row still says `view`. The rewrite is unambiguous precisely
  because a vault-scoped `locked` cannot exist in the table: it would collide
  with the vault GRANT on (`resource_type`, `resource_id`, `principal_type`,
  `principal_id`), which is why `isLocked` is folder/file only. So a `vault` row
  on the wire always means the Read-only posture and never a stored lock. The
  same response also carries the LIFTS — the `edit` rows on a folder or file
  that survive the posture: the org-principal ones plus the caller's OWN
  per-user ones, and nobody else's — because the padlock has to stop where
  someone's real access starts. `store.refreshLocks` splits the overlay three
  ways and keeps those in a separate `lifts` bucket, so no consumer of `locks`
  can ever see an `edit` row and offer to Unlock a grant. `lib/locks.ts`
  `lockScopesByPath` seeds every path in the tree from the posture
  (`hasVaultLock`) at a `vault` scope that outranks the per-person ones but sits
  below `all`, so only an item carrying an Everyone row of its own keeps the
  per-item wording; the badge reads "This vault is read-only — changes won't
  sync". It then subtracts each lifted subtree from that seed, and `vault` is
  the one scope `effectiveLockForPath` never INHERITS — the posture marks every
  path directly, so a path without the mark lacks it deliberately and a note
  freed by a personal grant cannot take the padlock straight back from its
  folder. Both panel consumers read through the new `itemLockRows`, and
  `Share.resourceType` widened to `"folder" | "file" | "vault"`. On a row whose
  padlock comes only from the posture (`vaultLockedOnly`) the context menu shows
  a disabled **"Locked by the vault"** entry rather than hiding one — the
  padlock is right beside it, and a vanished entry reads as a bug — the
  selection bar's Lock/Unlock pair hides outright, and the folder "empty" hint
  is back, because a vault-wide lock is no reason to stop saying a folder is
  empty. The padlocks update live, because the ACL frame already runs
  `refreshLocks`. The editor was ALREADY read-only under a read-only vault (the
  sync token says so); this is what makes the sidebar say it too, from the first
  frame.
- **`GET` / `PUT /api/orgs/:orgId/team-access`** (`http/routes/shares.ts`,
  owner/admin only, gated by `canManage` on the vault resource). GET reports the
  vault's mode, the grant row backing it, and every per-item org row that
  currently survives it — one request, because the Access panel has to state how
  many settings it will clear *before* the confirm, and a count assembled from
  several round trips is a count that can be wrong. PUT applies a mode to the
  whole vault in a transaction, then force-closes the sync sockets of exactly
  what NARROWED — a client reconnects and re-mints its own token, so a change
  that gives people more access arrives by itself. Grants rank `edit=2 >
  view=1 > everything else 0` (`locked`/`denied` grant nothing, they only cap,
  so clearing one kicks nobody): a cleared item row kicks its docs iff its rank
  exceeds the target's, and the vault posture kicks every doc iff it dropped, so
  Read-only→Shared kicks nobody and Shared→Private kicks everything. A narrowed
  posture already reaches every doc in the org's collections, which makes the
  per-item walks underneath it pure duplication — they are skipped; otherwise
  the items resolve in one batched `permissions/lookup.ts` `docsForResources`
  instead of a recursive walk apiece. The disconnects are best effort, one doc
  at a time: the write is already committed, so a transport that throws on one
  socket must not cost the caller a 500 or strand the docs behind it.
  `onAclChanged` fires per collection only on a real change, or an idempotent
  PUT would make every vault-channel subscriber recompute its readable set for
  nothing. It answers `{ mode, cleared, postureChanged, disconnectedDocs }`,
  where `cleared` counts ITEM rows only — the ones GET would have listed — and
  `postureChanged` is the separate yes/no of whether the vault row itself moved,
  because the desktop reports the two as different sentences. Org rows stranded
  on soft-deleted notes are swept in the same transaction, silently and outside
  that count: the user never saw them, a deleted doc has no live editors for the
  row to have been protecting, and left behind a restored note would come back
  carrying the very override the whole-vault change was made to remove. New
  `tests/team-access.test.ts` covers the clearing, the per-user survivors and
  the role gate.
- **Clicking a folder or note row scrolls its controls into view.** New pure
  `lib/scrollPlan.ts` finds the one ancestor that actually scrolls by computed
  style (`Element.scrollIntoView` moves EVERY scrollable ancestor, which inside a
  modal drags the page behind it too) and plans a target that guarantees the
  per-item mode buttons rather than just the pane's title — the pane opens with a
  breadcrumb, a title and up to two banners above them, so on a short window
  "scroll the pane to the top" still left the three buttons the click was about
  below the fold. An already-visible pane and a sub-pixel move both plan `null`,
  and `prefers-reduced-motion` drops the smooth behaviour.
- **A live miniature under the Content width slider**
  (`components/ContentWidthPreview.tsx` + `lib/editorMeasure.ts`
  `computePreviewColumn`). It measures the real editor pane and the real width of
  a `0` in the editor's body font — `ch` resolves at the element using the token,
  which is `.cm-line`, not the settings panel — runs the same arithmetic the
  browser runs for `--editor-pad-x`, and scales the answer down. A window too
  narrow to grant the measure being dragged towards therefore shows the column
  stop growing, which is the one thing a fixed illustration could never say.
- **Tables are edited in place, not as markdown source.** A GFM table is now
  always the rendered table (`lib/editor/table/`): the `"Table"` branch in
  `livePreview.ts` no longer yields to the active line, and clicking a cell
  mounts a React `<input>` holding that cell's RAW markdown inside the widget —
  the block never flips to `| a | b |`. Cell, row, column and alignment edits
  are pure span planners (`table/edit.ts`) over doc-absolute spans
  (`table/parse.ts`, which honours `\|` as a literal pipe and leaves ragged
  rows ragged), dispatched as ONE ordinary transaction per commit
  (`input.table`, no selection change), so a cell edit reaches the `.md`, the
  index and Yjs undo exactly like typing and touches only that cell's bytes.
  Cell content renders through the app's own GFM parser with no `innerHTML`
  anywhere; `[[wikilinks]]` are masked out before that parse so CommonMark
  cannot claim them as reference links. The React-in-a-CM6-widget lifecycle
  moved out of `noteHeader.ts` into `lib/editor/reactWidget.ts` and is now
  shared. A table's range is atomic (`table/atomic.ts`), so no arrow key can
  park the caret inside a block that never shows its source.
- **Folding, with the folds remembered.** `lib/editor/folding.ts` adds
  `codeFolding()` (an accent-soft `…` pill), `foldKeymap` and a hover chevron.
  No new fold *services*: `@codemirror/lang-markdown` already folds headings
  (`headerIndent`) and, through its blanket `foldNodeProp`, list items,
  blockquotes/callouts and fenced code with exactly the ranges the plan
  specified — a probe against the real parser confirmed it, so the hand-written
  `listItemFold`/`calloutFold` were dropped rather than added as a second
  authority. What IS ours is `foldOwner`, which decides where a chevron may
  appear: the same blanket prop also makes a hard-wrapped paragraph and a GFM
  table foldable, and a table's lines belong to an atomic block replace widget.
  The chevron is an absolutely-positioned widget translated out of the column by
  `--editor-fold-gutter` (**Plan A** — a `foldGutter()` would take real width
  from `.cm-content`, so the prose would shift sideways the first time a note
  grew a foldable heading). Persistence is **line anchors** — `{v:1, folds:
  [{line, text(80)}]}` — resolved by exact text at the remembered line, then a
  ±8-line scan, then dropped; never offsets. Saved debounced 500 ms (well clear
  of the bridge's 150/300 ms timings, and into `index.sqlite`, never the `.md`),
  and RESTORED by a synchronous dispatch in the same tick as `new EditorView`,
  with the state fetched in parallel with the bridge open, so no unfolded frame
  ever paints. `remoteCursors` skips a peer whose caret is inside a range we
  folded. New Rust table `note_ui_state (doc_id PK, state, updated_at)`,
  appended to `index.rs::migrate()`'s idempotent batch, untouched by `rebuild()`
  like the `yjs_*` tables, swept by `prune_yjs_docs` against the same live set;
  IPC `get_note_ui_state` / `set_note_ui_state`.
- **Tag autocomplete.** Typing `#` suggests the vault's existing tags, ranked by
  use count so a spelling that already exists wins over a new near-duplicate.
  Rust `Index::list_tags` (a `tags` ⟕ `note_tags` count, most-used first, ties by
  name) → `list_tags` command → `ipc.listTags` → store `tags`/`refreshTags`,
  refreshed from inside `refreshTitles` (same index, same moments).
  `ofm/hashtag.ts` gains `tagCompletions`, added to the SINGLE
  `autocompletion({override})` in `lib/editor/index.ts` — a second
  `autocompletion()` config would conflict with the slash and `[[` sources.
- **More editing keys.** `Mod-Shift-h` → `==highlight==`; `Mod-Alt-1…6` set a
  heading level and clear it when pressed again (`changeByRange` over every line
  a selection touches); `Shift-Enter` inserts a markdown hard break `"  \n"`
  (a distinct key name from Enter, so lang-markdown's `Prec.high` binding never
  sees it — but `defaultKeymap` DOES fill Enter's `shift` slot, which is why
  `formattingKeymap()` must stay ahead of it); `Mod-l` (`tasks.ts`
  `toggleTaskAtCursor`) ticks a task, gives a bare bullet a box, or turns a plain
  line into `- [ ] `, every touched line in ONE transaction. `toggleInline` now
  trims whitespace off the selection (`**word **` is literal asterisks in
  markdown, so the naive version silently produced nothing) and expands an empty
  selection to `state.wordAt`. `Mod-k` over a URL produces `[](url)` with the
  caret in the label. `commands.test.ts` drives all of it — plus the list
  continuation, renumbering and `deleteMarkupBackward` we deliberately did NOT
  write — through a real `EditorView`, so lang-markdown changing under us is a
  test failure rather than a bug report.
- **Indentation guides.** `lib/editor/indentGuides.ts`: a `Decoration.line`
  carrying `--indent-depth` plus a `::before` filled with a repeating gradient,
  inset by `--editor-pad-x` and full-height so a wrapped line's guides run down
  every row. **No dependency** — `@replit/codemirror-indentation-markers` was
  installed, spiked and removed: it steps its gradients in `ch`, and our editor
  is set in a proportional font where a space is about half a `ch`, so every
  guide landed inside the text; the step is baked into JS-generated
  `background-position`, so no stylesheet could move it. Its pseudo-element is
  also pinned at `left: 2px` (blind to `--editor-pad-x`) and drawn at
  `z-index: -1` (behind any line with its own background — our code well, our
  callout tint). Instead the step is MEASURED: a probe span of real spaces in
  `.cm-scroller` (never in `.cm-content`, which the DOMObserver watches) is laid
  out on every geometry change and published as `--indent-guide-step`, so the
  guides track a webfont landing and any zoom.
- **Two layout settings** (Settings → Appearance, device-local like the theme):
  **Readable line length** (on by default) and **Line numbers** (off by
  default — a gutter takes real width from the prose column). The width control
  has since become the Content width slider (see the Changed entry above): it
  now sets `--editor-measure` inline on `.editor-column` rather than flipping a
  single attribute, but it is still only that one token, which `--editor-pad-x`
  and therefore `.cm-line`, `cm-block-inset`, the fold chevrons and the loading
  skeleton all follow with no JS. `lineNumbers()` sits in a Compartment so the
  switch reconfigures the live view instead of rebuilding it (and with it the
  CRDT binding).

- **Live preview reveals one token at a time.** New `lib/editor/reveal.ts` holds
  the two scopes the editor now distinguishes: LINE (headings, quote markers,
  the task dash, block widgets) and TOKEN (`**`, `*`, `~~`, `==`, `%%`, `` ` ``,
  `[]()`, `![]()`), where `tokenOwner` walks at most six parents to the inline
  node a marker delimits and the marker unfolds only when a selection range
  touches THAT node. Adjacency is inclusive at both ends, so the markers you are
  typing never vanish from under the caret. A `focused` StateField (fed by
  `EditorView.focusChangeEffect`) means a BLURRED editor has no active line at
  all: click into the sidebar and the note reads as a finished page. The blanket
  active-line early return in `livePreview.ts buildDecorations` is gone, and the
  block-widget StateField is memoised on the ranges of the blocks whose
  rendering still depends on the selection (HTML blocks and fences; a table is
  always the editable widget) — before this, every arrow key re-parsed the whole
  document through `ensureSyntaxTree`.
- **Obsidian-flavoured syntax** (`lib/editor/ofm/`): `==highlight==` (a
  MarkdownConfig mirroring GFM Strikethrough's delimiter and flanking rules,
  refusing any run of three or more `=`), `%%comment%%` inline and `%%`-fenced
  blocks, and `#tag`. Comments stay VISIBLE — faint and italic — with only their
  `%%` folding away; a comment you cannot see is a comment you publish by
  mistake. The comment nodes are `OfmComment` / `OfmCommentMark` /
  `OfmCommentBlock`, never `Comment`/`CommentBlock`: @lezer/markdown owns those
  names and `configure()` SILENTLY skips a duplicate, so the collision would
  have been a feature that quietly did nothing (regression test: `<!-- -->`
  still yields `CommentBlock`).
- **Callouts.** `> [!note] Title`, and thirteen more types folded onto five
  semantic tokens (accent / success / warning / danger / secondary), unknown
  types falling back to `note`. A decoration layer over `Blockquote`, NOT a new
  parser — a callout is a blockquote everywhere else, and a second parser would
  be a second authority next to `blocks.ts`. Off the line the `[!type]` marker
  becomes an icon built with `createElementNS`; on it, the raw text returns
  (`livePreview.ts` yields the marker span, since lezer reads `[!warning]` as a
  shortcut-reference Link whose brackets would otherwise fold TOKEN-scoped).
- **Syntax-highlighted code fences with a Copy button.** `codeLanguages.ts` is a
  curated list of ~14 `LanguageDescription`s whose grammars are DYNAMIC imports
  — 0 KB on the startup path, fetched the first time a fence claims a language —
  deliberately not `@codemirror/language-data` (~40 packages for a note app).
  `codeFence.ts` adds one inline widget at the end of the opening fence line.
- **`#tags` agree with the index.** The editor's tag rule
  (`ofm/hashtag.ts`) and Rust's `TAG_RE` (`parse.rs`) now say the same thing,
  character for character: the `#` is not preceded by `[\p{L}\p{N}_/]`, the
  body is `[\p{L}\p{N}_/-]+` and holds at least one non-digit. `#2026goals` and
  `(#tag)` are tags; `#2026`, `foo#bar` and a heading's `#` are not. Six Rust
  tests pin the contract, because a tag you can see but cannot search for is
  worse than no tag at all.
- **Wiki-links show what they mean.** `[[Note|label]]` renders as `label`,
  `[[Note#Heading]]` as `Note › Heading`, and the brackets return under the
  caret. `wikilinks.ts` exports a `wikilinkRe()` FACTORY — the shared `/g`
  regex carried `lastIndex` between its two consumers and silently skipped
  every other match.
- **The note's name is an editable title above the body.** A CodeMirror block
  widget at position 0 hosting a React `<input>` (`lib/editor/noteHeader.ts`,
  `components/InlineTitle.tsx`), inset to the prose column through the same
  `--editor-pad-x` the body uses. Committing it is a **rename**
  (`store.renameNoteFileExact` → `ipc.renamePath` + `registry.renamePath` +
  `followNoteRename`), never a CRDT edit — the file name is the note's name, so
  a title living in the text would be a second identity. Validation refuses
  rather than sanitizes (`lib/editor/titlePlan.ts`: empty, `/ \ : * ? " < > |`,
  a leading dot, over 100 chars) and a collision keeps focus with an inline
  warning instead of silently landing you on `Name 1` — which is why
  `renameNoteFile` was split into a dedup half and an exact half. ⌘N and the
  sidebar's + now put the cursor in the new note's title rather than the
  sidebar's rename box.
- **A structured Properties panel over YAML frontmatter.** A block replace over
  the frontmatter range, in the same StateField, rendering one typed row per key
  (`components/properties/`): text, list, number, checkbox, date, datetime, tags
  and aliases, with chips for the list kinds and a `MenuSelect` type picker.
  Every edit is a **minimal span replacement** dispatched as an ordinary editor
  transaction (`lib/frontmatter/edit.ts`), so changing one value cannot reorder
  keys, drop a comment or reformat another property — and it reaches the file,
  the index and Yjs undo through exactly the same path as typing. The parser
  (`lib/frontmatter/parse.ts`) is a dependency-free flat-YAML subset with
  doc-absolute spans that **refuses** anything it cannot round-trip (nested maps,
  block scalars, anchors, duplicate keys, tabs); a refusal renders a banner over
  the untouched source, and nothing is ever written. `⌘;` adds a property from
  anywhere in the note, creating the block if there is none. Per-vault types live
  in `.context/types.json` (new `get_vault_types` / `set_vault_types` commands);
  name and value suggestions come from `list_property_keys` /
  `list_property_values`, computed in Rust over `notes.frontmatter` with
  `serde_json`. Display mode (Visible / Hidden / Source) is a device-local
  preference in Settings → Appearance, plumbed through a Compartment.
- **Boot instrumentation.** `lib/perf.ts` marks `script`, `react-mount`,
  `tree-ready`, `tree-painted`, `auth-resolved`, `sync-primed`, `sync-enabled`,
  `reconcile-done` and `index-ready` — one `performance.mark` plus one
  `[boot] <name> +Nms` line each, which `mirrorConsoleToTerminal` puts in the
  `tauri dev` terminal. `tree-painted` is the number the user feels;
  `reconcile-done` is the one that must not regress.
- **Leave a vault you don't own** (#121). Members and admins get a **Leave**
  action in Vault Settings → Vaults. The server ends the membership the same way
  an admin's removal does — membership row, shares granted to you, your live
  sync sockets, and the vault is unpinned from your sessions — and, when email
  is configured, tells the owner you left and sends you a receipt. On the
  device you leave from the vault goes for good: out of the switcher and
  recents, and its folder moves to the OS Trash instead of lingering as a local
  copy. The owner is refused (`409 owner_cannot_leave`) and pointed at Delete.
  New route `POST /api/orgs/:orgId/leave`; two new email templates.
- **Tabs for open files.** Every note you open now stays open as a tab in a
  strip under the header — click to switch, × or middle-click to close, and
  closing the active tab lands on its neighbour. Tabs follow renames and moves
  (yours and teammates'), close when their file is deleted, and are scoped to
  the vault (switching vaults starts a fresh strip).

### Fixed
- **Read-only was enforced on the surfaces people type into, not on the ones
  they create with.** Three write paths asked only whether the caller was a
  MEMBER of the vault, so someone who could not change a single note in a folder
  could fill that folder with new ones. `POST /api/notes`, `/api/folders` and
  `/api/files` now go through a shared `permissions/http-gates.ts`
  `canCreateIn`, applied AFTER the parent is resolved so it judges the real
  parent: inside a folder it is exactly `canEditFolder`, byte for byte MCP's
  `folderWritePermission` already applied, so the two surfaces cannot drift; at
  the vault root it is `vaultRootWritable`, which refuses under the Read-only
  posture unless a per-user vault-scoped `edit` grant lifts that one caller —
  the same escape the resolver already honours for editing an existing root
  note. MCP had the mirror-image hole: its root branch returned `edit` for any
  admin, so in a Read-only vault an owner could not touch one existing note but
  could keep creating new ones at the top; it now checks `vaultRootWritable`
  too. `POST /api/vaults/:vaultId/blobs` was membership-gated as well and now
  calls `canWriteAttachment` — vault posture only, and documented as such,
  because a blob carries no `folder_id` and no ACL row of its own, so there is
  no folder to resolve a lock against. The idempotent adopt paths still run
  BEFORE every one of these gates, so a read-only client's sync reconcile
  re-registers what already exists exactly as before. Permission refusals carry
  `code: "no_write_access"`, and permission is checked BEFORE the `root_frozen`
  latch on purpose: "move it into a folder" is useless advice for someone who
  may not write to that folder either, and it would leak the latch to a caller
  with no write access at all — a caller who MAY write still gets `root_frozen`,
  which is the case the desktop's toast exists for. `POST /api/notes` naming an
  existing doc_id at a new path now answers 200 with the row's canonical
  `relPath`/`folderId` (the same shape the adopt paths use) instead of a 201
  echoing a path `ON CONFLICT (id) DO NOTHING` never wrote, so the client stops
  re-sending a location the server disagrees with. And `sync/hocuspocus.ts`
  `onAuthenticate` now re-resolves `effectivePermission` at connect instead of
  trusting the JWT's `readOnly` claim, which closes a replay window exactly as
  wide as `SYNC_TOKEN_TTL_SECONDS` (600 s by default): `disconnectDoc` closes
  live sockets the instant access narrows, but a kick is a disconnection, not a
  revocation, and the edit token the client still held let it reconnect as an
  editor. `none` now rejects the connection, anything short of `edit` connects
  read-only whatever the claim said, never the reverse (a regained grant still
  has to re-mint), and a resolver that throws fails CLOSED. New
  `tests/readonly-enforcement.test.ts` is the single place the read-only
  contract is proven end to end — 32 cases over sync-token minting, the
  Hocuspocus socket, every MCP write tool, the registry routes, versions, CRDT
  repair, blobs, public links and the vault channel, each run against all three
  ways read-only arises (an item or ancestor `locked` row, a bare `view` grant,
  and the vault-wide posture, which caps owners, admins and a note's own creator
  alike).
- **An external move to a frozen vault root was silently undone.**
  `VaultRegistry.renamePath` swallowed the server's 403 — `console.error` and
  return — so a note moved out to the root from outside Baalda was treated as
  renamed, rebound to the new path locally, and then quietly pulled back into
  its old folder by the next inbound pull, with nothing said to the person who
  moved it. Both catch blocks (the `api.updateFolder` branch and the
  `api.updateNote` one) now `recordFailure` with `reasonOf(e)` and
  `errorCode(e)`, keyed on the DESTINATION path because that is where the file
  now sits on disk. The existing one-toast-per-path explanation does the rest —
  "X can't sync — this vault's root is frozen. Move it into a folder to sync
  it." — and an ordinary 500 records a failure with a `null` code instead of
  vanishing into the console. New `__tests__/renameRefusal.test.ts` (5 cases)
  also pins that the path maps stay on the OLD path after a refusal, so the next
  pull can still reconcile them.
- **"Entire vault → Private" left every note sitting on the member's device.**
  The server was right all along — the readable set, the visible folders and
  both `/api/notes` and `/api/folders` come back empty, now asserted in
  `tests/team-access.test.ts` — and the desktop threw the answer away.
  `lib/sync/inbound.ts` `planInbound` carries a revocation circuit breaker,
  `revokeCap = max(20, ceil(mapped * 0.5))`, whose whole job is to disbelieve a
  shrunken listing: from the client a transport failure and a mass revoke look
  identical. A whole-vault revocation is 100% of the set, so it tripped the cap
  on every pass, and because `plan.suppress` still held those paths the member
  was left with a complete, permanently unsyncable copy of a vault they could no
  longer read. Per-item Private only ever worked because one folder fits under
  the cap. A revoked file now leaves the disk only when ALL SEVEN of these hold:
  (1) both listings of the pull returned 200 — a failure throws before planning;
  (2) the server ANSWERED the tombstone question (`tombstones !== null`); (3) the
  session is LIVE — vault channel `synced` plus a completed structure pull
  (`SyncManager.isLive`); (4) the server ANNOUNCED an access change within 60 s,
  either `ready.revoked` on connect or `acl-changed` → `reauth` live; (5) the doc
  is within the removal budget — either the revoked group fits under
  `revokeCap = max(20, ceil(mapped * 0.5))`, or the server NAMED this doc (a
  `ready.revoked` entry or a live `drop`) and is exempt from that cap; (6) when
  the cap lift is what saved it, the server's OTHER resolver answers "no access"
  too, via `POST /api/vaults/:vaultId/access-check` — a disagreement, or no
  answer at all, leaves the file; and (7) this device confirmed the doc's content
  upstream (`pushed`), or the file is empty on disk. The DELETION budget is
  untouched — that one guards work, not access. Revoked files are removed
  OUTRIGHT rather than trashed: the server holds every byte and the note returns
  the moment access does, while a copy in `.context/trash` would leave the
  ex-reader with exactly the readable `.md` the revocation exists to take away.
  The one exception is a note this user WROTE (below).
  That covered a member whose app was OPEN when the owner went Private, because
  it hangs off the live `reauth` frame. A member whose app was CLOSED at the
  time got no frame at all, so their next launch pulled with no authority and
  the revoked notes stayed readable on their disk until some unrelated ACL change
  happened to announce itself. `ready.revoked` (above) closes that half: the
  cleanup lands on the launch itself. Three gaps are known and left standing: on
  a vault with more than about 50 mapped folders a named-authority revocation
  leaves the emptied directories behind, because `folderLift` keeps the folder
  cap for a pass that named docs and the breaker abandons the group rather than
  draining it. A 0-byte materialized placeholder that was never opened holds no
  CRDT state, so `ready.revoked` cannot name it and it rides the ordinary cap —
  which is why the named list is a narrowing rather than a complete description.
  And a cold launch after an offline revocation still flashes one refusal per doc
  from the non-authoritative reconcile, for about a second, before the
  authoritative pull removes them.
- **A deleted folder reached a share-only member as a REVOCATION.**
  `registry/tree-ops.ts` `deleteFolderCascade` hard-deletes the `folders` rows
  while the notes under them are only soft-deleted, and the tombstone query
  resolved a folder share through the `folders` table — so once the row was gone,
  a member whose only grant ran through that folder got no tombstone, and "absent
  from both lists" is exactly how the desktop spells revoked. A deliberate delete
  therefore arrived as a loss of access: removed outright, with none of the trash
  path's gentleness. `permissions/vault-docs.ts` `listDocsInVault`'s
  `deleted: true` branch now recovers the ancestry from `folder_tombstones`,
  which still holds the deleted subtree's ids, paths and `deleted_at`, matched
  with `starts_with(lower(n.rel_path), lower(d.path) || '/')` and case-folded like
  every other path comparison in the system. The match is dated as well as
  spelled: `AND d.deleted_at >= n.created_at`, because folder shares survive the
  hard delete and a long-dead tombstone would otherwise keep claiming whatever
  later came to live at the same path. Compared against `created_at` rather than
  `deleted_at` deliberately — `deleteFolderCascade` soft-deletes the notes BEFORE
  it writes the folder tombstone, so the tombstone is always marginally the later
  of the two, and only "the note already existed when this folder died" expresses
  the intent. It is injected only for the
  tombstone question, so the hot `listReadableDocsInVault` path is unchanged and
  a live note's `folder_id` stays the only thing that decides it. New
  `tests/revocation-safety.test.ts` (9 cases) pins it, including a note under a
  deleted subfolder of a still-live shared folder, that a stranger still gets
  nothing, and the access-check route's own gating.
- **A revoked note you wrote yourself is now recoverable.**
  `InboundTrash.recoverable` is true for every `deleted` note and for a `revoked`
  note this user authored, and the executor then calls `ipc.trashNote` instead of
  `ipc.deleteFile`. Authorship cannot be read at plan time — a revoked doc is
  absent from the listing by definition — so it is learned in `syncStructure`
  from the listing's `created_by` (`learnAuthorship`, ahead of the inbound guard
  so a first pass with no baseline still learns it), accumulated like the
  baseline, and PERSISTED in `.context/config.json` as
  `authored: { userId, docIds }`. Without the persistence the exemption would
  have covered only a revocation that happened while the app was open, not the
  cold-launch case the path exists for; without the `userId` it would have been a
  leak, because that file travels with the vault and a device can be signed into
  another account tomorrow — inheriting someone else's list would write a full
  readable `.md` of THEIR note into THIS user's `.context/trash`, which is the
  one thing the outright removal exists to prevent. A record whose `userId` does
  not match the session is dropped rather than adopted (so is an older config's
  unattributed `string[]`), and `learnAuthorship` claims the list for the current
  user before adding to it. A stale entry costs a trash copy of a note the user
  did not write, which is the harmless direction. An item set to Private still
  beats authorship, per `docs/specs/04-team-collaboration.md`.
- **The no-undo delete can no longer be handed a directory.** The revocation
  branch called `ipc.deletePath`, whose Rust side is documented as recursive
  because the sidebar's folder Delete means that recursion. New Rust
  `notefile.rs delete_file` (plus `commands.rs`, `lib.rs` and `ipc.deleteFile`)
  refuses an ignored path with an `AppError` — `rel_path_is_ignored` FIRST, the
  same refusal `trash_note` and `delete_folder_if_empty` make, so `.context` is
  refused on its own merits and `.context/config.json` cannot slip through for
  being a file — then refuses a directory, and no-ops on a missing path; the
  revocation branch calls it instead. `delete_path` keeps its documented
  recursion and is now reachable only from the sidebar, where a person picked the
  folder themselves. The guard lives in Rust, not in the caller, so it cannot be
  refactored away from.
- **A revoked doc was re-announced on every reconnect, and its text stayed
  readable locally.** The removal only RELEASED the doc, which deliberately keeps
  its state vector, so the next `hello` still advertised it, `ready.revoked` named
  it again and `aclChangedAt` was re-stamped continuously — making "the server
  announced a change in the last minute" permanently true. `noteRemoved` now
  calls `docStore.drop(docId)` and `ipc.clearYjsDoc(docId, epoch)` on a `revoked`
  removal, so the id leaves the in-memory manifest for this session and the
  persisted CRDT rows leave `.context/index.sqlite`. That is also the right
  privacy answer: leaving the note's full text in the local log would keep
  readable exactly what deleting the `.md` took away.
- **The editor's width control had never actually worked.** `--editor-pad-x` —
  the inset every consumer follows — was composed on `:root` out of
  `var(--editor-measure)`, and a `var()` inside a custom property is substituted
  at computed-value time ON THE DECLARING ELEMENT: `:root`'s own 88ch was baked
  into the token stream before it inherited, so no override further down the tree
  could reach it. Neither the old
  `.editor-column[data-measure="full"] { --editor-measure: 100% }` rule nor the
  new inline measure changed a single line, which is why "Readable line length"
  off left the column exactly where it was. The declaration moved to
  `.editor-column` (`src/styles/tokens.css`) — the one element the override is
  set on — while `--editor-measure` and `--editor-gutter` stay `:root` defaults.
  `lib/__tests__/editorMeasure.test.ts` reads the stylesheet back and asserts
  both the selector and that the inset is declared exactly once, because a
  second declaration would reintroduce the ambiguity.
- **The Access page no longer paints Private and then jumps to Shared.** The
  vault mode was initialised to the Private end of the tri-state and corrected
  only when the shares GET landed, so every open of a Shared vault showed the
  opposite of the truth — on the cards AND on every row badge — for as long as
  the network took. The mode is now `null` until fetched: badges render a blank
  loading pill (`.access-badge.loading`), no card is marked active, and a write
  is refused (`vaultModeKnown`) because the confirm has to count overrides it has
  not fetched yet. New `lib/teamAccessCache.ts` remembers the last known mode per
  (server URL, vault) in `localStorage` for an instant correct first paint, keyed
  like `store.knownVaultsKey` because a vault id means nothing across two
  servers; it is never allowed to authorise a write.
- **A row badge and the item's own controls now give the same answer.** The
  badges read only the lock/deny overlay and then fell straight back to the vault
  mode, so a folder explicitly set to Shared inside a Private vault badged
  "Private" while the detail pane two inches away read the item's own share rows
  and said Shared. Both now call `lib/accessMode.ts` `effectiveTeamMode`, which
  mirrors `permissions/resolver.ts` at the ORG level: a `denied` on the item or
  any ancestor wins, then a `locked`, then the vault being open or an `edit`
  above, then the vault being read-only or a `view`, else private. It also
  reports where the answer came from, so the pane can name the folder that is
  deciding rather than sending someone to clear a row that is not.
- **The Properties-in-document dropdown had no styling.** Its `triggerClassName`
  was `role-trigger`, which matches no CSS anywhere — the member-role menus use
  `role-field-trigger` — so the one select on the Appearance tab rendered as a
  bare button beside properly framed controls.
- **Opening a note no longer flashes the whole app.** Three things fired on
  every click. The editor pane went bare for ~180 ms: the loading skeleton is
  held back so a 40 ms open never flashes one, but a note-to-note switch
  destroys the outgoing CodeMirror view first, so the delay showed an empty
  surface instead — `EditorSkeleton` now takes `immediate` and `Editor` sets it
  whenever a view was just torn down. The clicked sidebar row blinked: the
  `tree-reveal` pulse ended on `transparent` and, as a held animation end state,
  outranked `.selected` whatever the source order, so the row went bare and then
  snapped back to accent when the class dropped; the keyframes now land on the
  selection fill (a folder gets a variant that ends transparent), and a row that
  was already on screen is not pulsed at all — the selection is the signal. And
  the reveal re-listed every ancestor folder on every open, committing a fresh
  `tree` per level and re-sorting and re-rendering the whole sidebar mid-click;
  it now skips folders already carrying `childrenLoaded`, like `onToggle`. The
  row context value is memoized too — a fresh object literal there re-rendered
  every row on every `FileTree` render, and `FileTree` renders on every open.
- **Revealing a note in the sidebar glides instead of jumping.** `.filetree-scroll`
  sets `scroll-behavior: smooth` (react-window assigns `scrollTop`, which honours
  it; wheel scrolling is unaffected), the scroll is deferred one frame so the
  expanded rows start their `top` glide first, and it uses arborist's `"smart"`
  align so a visible row is left alone. Reduced-motion restores the instant
  scroll.
- **Opening a note in a never-synced folder no longer waits 3 s.** After a vault
  switch the open gate was re-armed and `openFolderIsSynced` reset to `null`,
  and nothing answered for an unstamped folder — so, while signed in, every
  note open sat out the full `SYNC_GATE_MS` belt ("opened … before sync
  primed"). `setVault` now peeks the folder's vault stamp and releases the gate
  for a folder that does not sync.
- **Selection rectangles bled ~58px into the margins.** CodeMirror's
  `drawSelection()` derives every selection rect from the *first* `.cm-line`'s
  computed padding and is blind to padding on `.cm-content` — which is where the
  centring inset lived, so a full-line or multi-line highlight started well left
  of the text and overran its right edge. The inset moved to `.cm-line` as the
  shared `--editor-pad-x` token (`.cm-content` stays full width, so a click out
  in the margin still places the caret); the blockquote bar, the fenced-code well
  and the `---` hairline are re-cut to paint inside the prose column now that a
  line box spans the sheet; and block replace widgets — tables, embedded HTML —
  get the same inset back through a shared `cm-block-inset` class. The code-block
  well is now a filled well without hairlines or rounded corners.
- **List item text was accent-coloured.** `@lezer/markdown` maps
  `"OrderedList/... BulletList/..."` to `tags.list`, and the `/...` hands the tag
  to every descendant — so a `t.list` colour painted the whole item's *text*
  rather than its marker. The rule is deleted rather than recoloured, so a list
  inside a blockquote correctly inherits the muted tier; the `•` bullet joins the
  faint marker tier. GFM task items were affected the same way and are fixed too.
- **YAML frontmatter rendered as a giant bold heading.** With no frontmatter
  parser, lezer reads `---` as a horizontal rule and `key: v\n---` as a Setext
  H2. New `lib/editor/frontmatter.ts` finds the region the same way Rust's
  `parse.rs split_frontmatter` does (parity-tested, CRLF included) and renders it
  as a compact dimmed source block whose fences hide while the caret is
  elsewhere; `blocks.ts` and both `livePreview.ts` builders now skip the range,
  so nothing else decorates inside it. Decorations only — no document change.
- **A note created empty and then filled while offline could never upload.**
  `contentWorkList` filters the `emptyEverywhere` verdict *before* it consults
  `serverEmpty`, and an egest from the note you have OPEN is suppressed in
  `handleLocalFileChanged` before the line that clears that verdict. So a note
  settled by `ready.empty`, then opened, typed into offline and closed, was
  skipped by every later `ready.empty` probe until an app restart. `openDoc` now
  clears the verdict when it takes over a doc. Previously reachable only for a
  0-byte inbound placeholder filled while open; with new notes created empty it
  would have been the common path.
- **A queued local-change push could park forever.** `runLocalChangePush`
  returned without re-arming its drain timer when the vault engine was not up
  yet, leaving the queued notes waiting on a timer nothing would set again. It
  now retries, exactly like the uploader-busy branch beside it.
- **Sidebar presence no longer waits out the backfill.** A client announced
  which note it was viewing only after the server's `ready` — i.e. after the
  entire vault download — and the roster round that reveals everyone *else* is
  triggered by that same first announce. On any real vault that read as
  "teammates don't show up" for many seconds on every launch and reconnect. The
  announce now rides right behind `hello`, and the server parks a frame that
  races its auth I/O and replays it once the connection is subscribed.
- **Public note links.** The share button now offers Private and Public: Public
  mints `https://<server>/p/<token>` — a server-rendered read-only page anyone
  with the link can open (images included, served token-scoped; never SVG).
  Revocable anytime from the same menu; revoked/unknown/deleted all serve one
  identical 404. New `public_links` table (migration 020) and an escape-first
  markdown renderer with no new dependencies.
- **Private links queue through sign-in.** A shared link opened while signed
  out now raises the sign-in dialog and opens the note right after auth; a link
  into a vault with no folder on the device parks on the folder prompt and opens
  once one is chosen. The wait for a first sync extends while sync is visibly
  working, and connectivity failures are named instead of implying no access.

### Changed
- Rebranded the project to Baalda (brand only; the internal
  "context" codename, storage identifiers, and bundle/keychain id are
  unchanged; see `docs/BRANDING.md`).

### Added
- Open-source project setup: Apache-2.0 `LICENSE`, `NOTICE`, `CONTRIBUTING.md`,
  `SECURITY.md`, `CODE_OF_CONDUCT.md`, `TRADEMARK.md`, and GitHub issue/PR
  templates.

## [0.1.30] - 2026-08-22

Access control, and the vault's shape.

### Added
- **Shareable note links.** A share icon in the note header copies
  `baalda://note/<vault>/<doc>`; opening it switches vault if needed and lands on
  the note. The link carries ids only, resolved against whoever opens it, and is
  keyed by `doc_id` so it survives every rename and move. Adds
  `tauri-plugin-deep-link` plus `tauri-plugin-single-instance`, so a click on
  Windows/Linux reaches the running app instead of starting a second one.
- **Private, at two scales** (`shares.permission = 'denied'`, migration 018) —
  the only row in the model that subtracts. Per-**member** it blocks one person
  and beats everything, authorship included. Per-**item** it takes a folder or
  note out of the team's reach, leaving only people shared with by name.
- **Freeze vault root** (Settings → General): a structural latch that closes the
  vault's top level to new folders and notes. Applies to everyone, lifted only by
  an owner/admin, and enforced on the HTTP registry *and* the MCP tools.
- **Reveal in Finder** on any note or folder in the sidebar (platform-labelled).
- `GET /api/vaults/:id/access-tree` — the vault's whole structure for the Access
  panel (owner/admin, ids and paths only, deliberately not ACL-filtered) so an
  item you have made Private stays administrable after its file leaves your disk.
- Item colours on the server (`folders.color` / `notes.color`), keyed by id.

### Changed
- **Access settings now apply to the person setting them.** The owner/admin and
  note-creator branches were shortcuts that ran before any grant was consulted,
  so a Read-only vault still let its owner edit and a Private folder still showed
  up for its author. Both are skipped under item-Private and under a Read-only
  vault. Managing shares stays role-gated, so an owner can always lift what they
  applied to themselves.
- **Losing access de-syncs the note from disk**, alongside the existing tombstone
  path. It only fires when the server actually answered about deletions, it moves
  the file to the vault's recoverable trash rather than destroying it, and it
  refuses any doc whose content the device never confirmed upstream. Revocations
  are capped separately from deletions and more loosely. Restoring access
  re-materialises the file.
- **Vault revert is owner *or* admin** — it is the recovery half of an action
  admins could already take.
- **Item colours sync to the team** and survive a rename; colours set before a
  vault gained sync are adopted upward once.
- The Access panel is a real tree: folders expand in place and pull their
  contents in on demand, which is what made the notes *inside* a folder reachable
  at all. Permission writes now say "Applying…" instead of appearing stuck.
- One popover select everywhere (`MenuSelect`, which `RoleSelect` now wraps),
  replacing the last native `<select>`; the freeze-root checkbox became an
  animated `Switch`; the account menu leads with **Home** instead of repeating the
  identity card its own trigger already shows.

### Fixed
- **Google sign-in failed with `account_not_linked` on any account created with a
  password.** Better Auth's `accountLinking.requireLocalEmailVerified` defaults to
  true and refuses to link while the local row is unverified — and with
  `requireEmailVerification` off, every password sign-up is unverified forever,
  which made the account-linking config dead code. Now set to false. Trade-off:
  without verification at sign-up an address can be squatted, so email
  verification remains the real fix and is still owed.
- The "who can access" list resolved through different branches than the enforcer
  and reported *No access* on a member's own note while the sync token granted
  edit. They now mirror each other.
- The Access panel's dropdown was clipped by the settings card, which becomes the
  containing block for `position: fixed` children because its entry animation
  keeps a `transform` applied. The menu is portalled to `<body>`.
- The Access item list no longer nests its own scroll region inside the settings
  page's, which sliced rows in half at the top edge.

## [0.1.0] - 2026-07-14

### Added
- Local-first desktop app (Tauri v2 + React/TS) with Markdown files as the
  source of truth.
- Markdown ↔ CRDT bridge (Yjs `Y.Text`) with echo-loop guards and convergence.
- Sync server (Hono HTTP + Hocuspocus WS + Postgres) for multi-device sync.
- Team collaboration: organizations, folder/file ACLs, presence, live cursors,
  attachments, locks, and join codes.
- MCP endpoint for AI clients, gated by the same per-file permissions.
- Local search (SQLite FTS5), backlinks, tags, and a graph view.
- Semantic search via a dependency-free hashed embedder.

[Unreleased]: https://github.com/naveedharri/baalda/compare/v0.1.30...HEAD
[0.1.30]: https://github.com/naveedharri/baalda/releases/tag/v0.1.30
[0.1.0]: https://github.com/naveedharri/baalda/releases/tag/v0.1.0
