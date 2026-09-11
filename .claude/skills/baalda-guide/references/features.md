# Baalda features, in plain words

Everything below is shipped unless marked **Planned**. Last verified against the repo on
2026-09-03 (desktop v0.1.42). When in doubt about a detail, check `docs/STATUS.md`.

## The idea

Baalda is a "team second brain". Three things that normally do not go together:

1. **Your notes are plain Markdown files on your disk.** No database lock-in. Open them in any
   editor, back them up, put them in Git. If Baalda vanished tomorrow you would still have
   everything.
2. **Teammates edit the same notes live**, with visible cursors, like a shared Google Doc.
3. **An AI can read and write the notes as a teammate**, either directly on disk or through a
   built-in connection point (MCP), and its edits merge with yours instead of overwriting.

Why nobody else does this: file-based note apps (Obsidian, Logseq) are single-player, and
collaborative apps (Notion, Confluence) keep your data in their database. Baalda bridges the two.

## Vaults

- A **vault** is a folder of notes. It can be **Local** (just a folder, no account), **Synced**
  (your folder, backed up and shared through a server) or **Remote** (a team vault you joined
  that Baalda downloads to your machine).
- Create a new vault, open any existing folder, or type a path (even a whole drive) on the
  welcome screen. Recent vaults are listed for quick switching.
- Default location for new vaults: `~/Documents/Baalda Vaults/<vault name>` (under Documents so it
  shows in the Finder/Explorer sidebar). Change the root in settings; existing vaults stay put.
  A `current` shortcut inside that root always points at the vault you have open, handy for
  scripts and AI tools.
- Importing an existing folder (for example an Obsidian vault) is a plain "open folder".
  Import files or folders into a vault, and export a note, a folder or the whole vault as files.
- Very large vaults load lazily (folders are read when you expand them), so size is not a
  problem. Marketing says "millions of notes" and "thousands of teammates"; the engineering
  docs are more measured: one server instance handles hundreds of concurrent users, thousands
  need several instances behind a load balancer with Redis, and a vault's live fan-out is sized
  for teams under about 50 people editing at once. Quote the measured numbers to a buyer.
- **Freeze vault root**: a setting that stops anyone, including owners, from adding new items at
  the top level once the structure is settled.
- **Deleting a vault** is the owner's call and it is permanent on the server: the notes, the
  history and everyone's access go. Your own `.md` files stay on your disk unless you also
  choose to move the folder to the Trash. If the vault is on Pro, deleting it also stops the
  subscription (see "Hosting options"); if that step fails, nothing is deleted and Baalda shows
  the error.

## Writing

- Markdown editor with live preview (headings, lists, links, images, tables, code blocks render
  in place while you type). Inline HTML is rendered but sanitized.
- **Tables are edited like a table, not like text.** A table in a note shows as a real table
  and stays that way: click any cell to type in it, Tab and Shift-Tab step between cells, Enter
  drops to the next row and adds a new row when you are on the last one, and the arrow keys walk
  out of the table at the top and the bottom. Hovering shows a `+` for a new column or row, and
  right-clicking a cell offers insert row above/below, insert column left/right, delete row,
  delete column, and align the column left, centre or right. Bold, italic, code, links and
  `[[wikilinks]]` inside a cell render as themselves; clicking into the cell shows the markdown
  behind them. The file on disk stays ordinary Markdown — an edit rewrites only the cell you
  changed, so the spacing and alignment of every other cell are left exactly as you typed them.
- `[[Wikilinks]]` between notes, with a backlinks panel. Links survive renames and moves.
- `#tags` inline or in frontmatter. Typing `#` suggests the tags the vault already uses, the
  ones you use most first, so a tag stays one tag instead of drifting into three spellings.
- **Folding.** Hover the left edge of a heading, a list item, a callout or a code block and a
  small `>` appears; click it to fold that section away, leaving a `…` you can click to bring it
  back. Baalda remembers what you folded per note, on this device, and restores it the next time
  you open the note — even if lines were added above it in the meantime. What you fold is a way
  of reading; it never changes the file.
- **Keyboard shortcuts** (beyond the usual ⌘N / ⌘W / ⌘F): ⌘B bold, ⌘I italic, ⌘E inline code,
  ⌘⇧X strikethrough, ⌘⇧H highlight, ⌘K link (select a URL first and the cursor lands where the
  words go), ⌘⌥1–⌘⌥6 heading level (press the same one again to clear it), ⌘L tick a task or turn
  any line into one, ⇧⏎ a line break inside a paragraph, ⌘; add a property, Tab / ⇧Tab indent a
  list item. Enter continues the list you are in and renumbers as you go.
- **Content width** (Settings → Appearance) sets how wide the text runs before it wraps: drag the
  slider between a narrow column and a comfortable one, or all the way to the end for the full
  window. A live preview shows the shape as you drag, and the setting is per-device. **Line
  numbers** live in the same place, off by default. Faint guides mark each level of a nested list.
- Tabs for open notes, with a right-click menu (close, close others, close to the right, close
  all).
- Autosave. Undo/redo is shared correctly even during live collaboration.
- Paste or drag images and PDFs into a note; they embed in place (see `file-formats.md`).
- `.html` files open as a sandboxed, read-only rendered page (scripts never run) with a
  Preview/Source toggle; they do not get live co-editing. `.txt` and `.canvas` open as text.
- Light and dark themes. Colour-tag notes and folders in the sidebar; colours sync to the team.
- Right-click any note or folder: rename, delete, move, share, lock, colour, reveal in
  Finder/Explorer, export.

## The note's name, and its properties

- **A note's name is its file name, and it sits at the top of the note.** Click it and type to
  rename the file — the tab, the sidebar and every list follow, and links to the note keep
  working (notes are tracked by an internal id, not their path). A new note opens with its name
  selected, ready to type. Names with `/ \ : * ? " < > |`, a leading dot, or one already used by
  a neighbouring note are refused with a message, not quietly changed.
- **Properties** are the block of information at the very top of a Markdown file (what other
  apps call "frontmatter" or "YAML"). Baalda shows it as a small table you fill in, one row per
  property, with a type you can change from the icon at the left of the row:
  - **Text** · **List** · **Number** · **Checkbox** · **Date** · **Date & time** · **Tags** ·
    **Aliases**. Lists, tags and aliases show as chips: Enter adds one, × removes one.
  - `tags` is always the tags type, because that is what feeds tag search.
- `⌘;` (Ctrl-; on Windows/Linux) adds a property anywhere in a note, creating the block if the
  note has none.
- **It is still just text in your file.** Editing a property changes only that one value — your
  comments, your quoting, and the order of your keys are left exactly as they were.
- **If Baalda cannot read the properties, it shows them as plain text and never rewrites them.**
  That happens with nested structures, multi-line values, anchors, or a repeated key. You will
  see a short note saying so, and the text stays yours to fix by hand.
- **Three display modes**, in Settings → Appearance → "Properties in document": *Visible* (the
  panel), *Hidden* (nothing shown; the text is still in the file) and *Source* (plain YAML).
  This is a per-device choice, not a per-vault one.
- **The types you pick are remembered per vault, on that machine** (in the vault's hidden
  `.context` folder). A teammate opening the same vault sees types worked out from the values
  themselves until they choose their own — the same as Obsidian.

## Finding things

- **Full-text search** runs locally and instantly, with highlighted snippets.
- **Semantic search** (meaning-based) is available for synced vaults, served by the server. It
  works offline-capable with a built-in lightweight embedder; a self-hoster can plug in OpenAI
  embeddings for better results. A stronger vector search is planned.
- **Backlinks** panel per note.
- **Graph view** of how notes link to each other.

## Sync (your own devices)

- Sign in, turn on sync for a vault, and open the same vault on another machine. Changes
  converge in milliseconds when online; offline edits merge when you reconnect.
- Sync is always on in the background for the whole vault, not just the open note, so notes are
  already up to date before you click them.
- What travels: binary change records, never whole files. Each device rebuilds its own `.md`.
- Deleting a note's file on disk (in Finder, with `rm`, or by asking an AI to tidy the vault) does
  remove it for the team, a couple of seconds later. Your own copy of the text is kept in the
  vault's hidden trash folder first, so a mistake is recoverable by hand.
  Two things are never propagated: a delete of a note this device had not finished uploading, and a
  mass disappearance (more than a fifth of the vault at once), because an unmounted drive or a
  cloud-storage hiccup looks exactly like a bulk delete. Deleting inside the app is unchanged and
  is still the clearest way to remove a note everywhere.
- Renames and moves are tracked by a stable note id, so nothing forks or loses its history — that
  holds for a rename done outside the app too.
- Multiple vaults per account. Switch between them from the account menu.

## Team collaboration

- **Invite** teammates by email, or hand out a **join code**. Invitations expire after 48 hours.
  On a server with email configured (the managed service does) the invitee gets an email with a
  link that opens Baalda on the invitation; otherwise Members shows a **Copy link** for each
  pending invitation to paste into chat. Someone invited by email who uses the join code instead
  ends up in exactly the same place, with the invited role.
- **Roles**: owner, admin, member.
- **Leaving a vault** (members and admins): Vault Settings → Vaults → **Leave** on the vault, then
  confirm. Access ends on all your devices at once, the vault disappears from your switcher and
  recents, and its folder on that device moves to the Trash (it is not kept as a local copy). The
  owner gets an email that you left and you get a receipt, on servers that send email. To come
  back you need a new invitation or join code. The **owner cannot leave** — their way out is to
  delete the vault. "Remove from device" is the gentler option: it only detaches the folder on
  that one device and keeps your membership.
- **Live presence**: coloured cursors and selections in the note, "who is viewing" avatars,
  and small presence dots in the sidebar showing who is in which note or folder. Ping a
  teammate to get their attention.
- **Sharing model**: new vaults are shared with the whole team by default (vaults created before
  mid-2026 stayed private until their owner flips them in Access). Any folder or note
  can be made **private** (visible only to people you name), **shared with the team**, or shared
  with specific people, each as **view** or **edit**. A person can also be blocked from an item.
  Permissions cascade down folders; the most permissive grant wins, except that "denied" and
  "locked" override. **Private really means nobody**: not the owner, not an admin, not even the
  person who wrote the note, until they are named on the item's list. So when you make your own
  folder private, add yourself. Owners and admins can always change the setting back.
- The MCP screen in the app puts the AI rule in one line: "It gets the same access you do."
  Deleting a token cuts the AI off immediately.
- **Locks**: lock a note or folder so it is read-only for everyone, admins included, until
  unlocked. Setting the whole vault to read-only shows that same lock on every folder and note,
  except the ones you were given edit access to.
- **Losing access** removes the note from the ex-reader's other devices (moved to trash, never
  destroyed); regaining access brings it back.
- Not built (deferred): comments and @mentions, activity feed, audit log, sub-teams or custom
  roles, SSO/SAML, two-factor authentication, mandatory email verification.
- **Public links**: turn a note into a read-only web page anyone with the link can read. Revoke
  any time. **Private links** (`baalda://note/...`) open a note for teammates who already have
  access; they carry no access themselves.
- **Push-to-talk voice**: hold a button to talk to everyone in the vault. Nothing is recorded.
- **Access panel** (owners/admins): a tree of every folder and note in the vault with its sharing
  state, independent of what is on your own disk. The **"Entire vault"** choice at the top applies
  to every folder and note at once and replaces whatever you had set on individual folders and
  notes, so the app asks you to confirm and tells you how many of those settings it is about to
  clear; people you shared something with by name keep their access either way.

## History and recovery

- **Note versions**: captured automatically after roughly ten minutes of quiet following an edit,
  and always before a revert. Preview any version and restore it.
- **Vault checkpoints**: owners and admins can snapshot the whole vault and revert it later.
- A local recovery snapshot is taken before a large external rewrite (for example an AI replacing
  most of a note).

## AI

- **Local agents** (Claude Code, Codex, any script): nothing to configure. They edit the `.md`
  files; Baalda notices and syncs. A human typing and an AI rewriting the same note merge.
- **Remote / cloud agents** use the built-in **MCP endpoint** (`<server>/api/mcp`). Create a
  token in Vault Settings → MCP. Tools: list vaults, list/create/move/delete folders,
  list/read/search/create/update/append/move/delete notes. The AI is bound by the exact same
  permissions as the person who created the token. If a note is open, you watch the AI type.
- Bring your own model. Baalda ships no AI model, no API key requirement, and no chat panel.
- **Planned**: in-app AI panel, AI as a live collaboration peer, richer vector search.

## Accounts and security

- Email + password accounts (argon2id hashing). Google sign-in is available when the server has
  it configured (the managed service does). **Forgot password?** on the sign-in screen emails a
  one-hour reset link when the server has email configured (the managed service does; a
  self-hosted server needs `EMAIL_FROM` + SMTP or Resend). An account created with Google can use
  the same link to set a password. Sign-up sends a confirmation email but it isn't required to
  sign in yet. No two-factor authentication.
- Session token lives in the operating system keychain, never in a file.
- Server stores binary sync records, not `.md` files; but it can reconstruct note text for
  search, public links and MCP, so it is **not end-to-end encrypted**. At-rest encryption is
  **Planned**.
- The macOS app is Developer-ID signed and notarized. Auto-updates on every platform are
  verified with Baalda's own signing key.
- No analytics or tracking in the app or on the site.

## Platforms and install

- macOS (Apple Silicon + Intel, `.dmg`), Windows 10/11 (`.exe`, `.msi`), Linux x64 (`.AppImage`,
  `.deb`, `.rpm`). Windows/Linux builds are unsigned, so first launch may warn.
- In-app updater, signed. Releases at github.com/naveedharri/baalda/releases.
- **Planned**: iOS app. No web app for editing (public links are read-only pages).

## Hosting options

- **Local only**: no server, no account, free.
- **Self-hosted server**: Node + Postgres. Railway one-click, Docker Compose, or plain Docker.
  The app asks which server before your first sign-in ("Baalda managed service" or "Your own
  server"), and the URL is checked against the server before it is saved; you can change it
  later in Account settings → Connection. An account belongs to one server, so the sign-in form
  always names the server it is signing you in to. Admins can send teammates one link,
  `https://<your-server>/open/connect`, which opens the app and asks them to confirm.
  No plan limits, and Google sign-in / billing are optional switches.
- **Managed server** at `https://api.baalda.com` (the default in the app). Same code as the
  self-hosted server. It is live and self-serve today: a team can sign up, sync and collaborate
  right away on the free tier, and upgrade from inside the app when they hit a cap.
  - **Free tier**: up to 3 vaults per user and 3 members per vault (members plus pending invites). A vault that already has more members than that keeps them all; it just cannot add another until it upgrades.
  - **Pro**: $10 per vault per month, or $97 per vault per year. Priced per vault, not per
    person. Unlocks unlimited members, notes, devices and AI edits; a Pro vault does not count
    toward the owner's free vaults. Two subscriptions exist today: monthly and yearly.
  - **How to buy**: Vault Settings → Billing → Upgrade to Pro (owners and admins). Checkout opens
    in the browser; the app flips to Pro as soon as payment lands. "Manage subscription" opens the
    billing portal for invoices, plan changes and cancellation.
  - **One subscription per vault.** A vault that is already on Pro cannot be bought a second
    time; the app refuses the checkout instead of charging twice.
  - **Your subscriptions in one place**: Vault Settings → Billing lists every vault you are in —
    plan, status, renewal date and price, how many people are in it, and who looks after billing.
    It also says how many of your 3 free vaults are in use. The tab opens even when the vault you
    have open is a local one.
  - **Deleting a Pro vault stops the billing**, at the end of the period you already paid for:
    no further charges, and the paid time is not cut short. If the payment provider cannot be
    reached, the vault is *not* deleted and the app tells you why. The subscription itself is
    kept in a "From deleted vaults" list so you can still move it, cancel it outright, or open
    the billing portal for it.
  - **Move a subscription to another vault** (owners only): Vault Settings → Billing → Transfer,
    from a live vault or from one in "From deleted vaults". Transfer opens a dialog that lists
    every vault it can move to — each with its member count and Free plan — and explains what
    happens to the vault it leaves; pick one and confirm. Only vaults you own that are not already
    on Pro are offered (Transfer is greyed out with a reason when there are none). Same price, same
    billing period; if the subscription had been set to end because its vault was deleted,
    transferring makes it renew again. The vault it came from drops to Free.
  - The public pricing page (baalda.com/pricing) may still describe the Team plan as early access
    or "talk to us". The app is ahead of the page: tell people they can upgrade in-app now, and
    to use the pricing page as the contact route if they want to talk first.

## Licensing

Apache 2.0 for the whole app and core server. The `ee/` folder is reserved for future
commercial-only features under a separate licence. The Baalda name is a trademark; forks must
use their own name.

## Roadmap (Planned, not shipped)

From `docs/STATUS.md` Phase 4: rich WYSIWYG editing, vector/hybrid search, AI as a live CRDT
peer, at-rest encryption, OAuth beyond Google, iOS. Also not built: comments and mentions,
plugins, Office file import.
