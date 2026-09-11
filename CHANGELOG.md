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
