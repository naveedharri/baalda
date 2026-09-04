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

## Writing

- Markdown editor with live preview (headings, lists, links, images, tables, code blocks render
  in place while you type). Inline HTML is rendered but sanitized.
- `[[Wikilinks]]` between notes, with a backlinks panel. Links survive renames and moves.
- `#tags` inline or in frontmatter.
- Tabs for open notes, with a right-click menu (close, close others, close to the right, close
  all).
- Autosave. Undo/redo is shared correctly even during live collaboration.
- Paste or drag images and PDFs into a note; they embed in place (see `file-formats.md`).
- `.html` files open as a sandboxed, read-only rendered page (scripts never run) with a
  Preview/Source toggle; they do not get live co-editing. `.txt` and `.canvas` open as text.
- Light and dark themes. Colour-tag notes and folders in the sidebar; colours sync to the team.
- Right-click any note or folder: rename, delete, move, share, lock, colour, reveal in
  Finder/Explorer, export.

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
- Deleting a file on disk does not delete it for the team (deliberate safety rule). Delete inside
  the app to remove it everywhere.
- Renames and moves are tracked by a stable note id, so nothing forks or loses its history.
- Multiple vaults per account. Switch between them from the account menu.

## Team collaboration

- **Invite** teammates by email, or hand out a **join code**. Invitations expire after 48 hours.
- **Roles**: owner, admin, member.
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
  unlocked.
- **Losing access** removes the note from the ex-reader's other devices (moved to trash, never
  destroyed); regaining access brings it back.
- Not built (deferred): comments and @mentions, activity feed, audit log, sub-teams or custom
  roles, SSO/SAML, two-factor authentication, email verification at sign-up.
- **Public links**: turn a note into a read-only web page anyone with the link can read. Revoke
  any time. **Private links** (`baalda://note/...`) open a note for teammates who already have
  access; they carry no access themselves.
- **Push-to-talk voice**: hold a button to talk to everyone in the vault. Nothing is recorded.
- **Access panel** (owners/admins): a tree of every folder and note in the vault with its sharing
  state, independent of what is on your own disk.

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
  it configured (the managed service does). There is no email verification step yet and no
  two-factor authentication.
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
  Set the server URL in the app's settings. No plan limits, and Google sign-in / billing are
  optional switches.
- **Managed server** at `https://api.baalda.com` (the default in the app). Same code as the
  self-hosted server. It is live and self-serve today: a team can sign up, sync and collaborate
  right away on the free tier, and upgrade from inside the app when they hit a cap.
  - **Free tier**: up to 3 vaults per user and 10 members per vault (members plus pending invites).
  - **Pro**: $10 per vault per month, or $97 per vault per year. Priced per vault, not per
    person. Unlocks unlimited members, notes, devices and AI edits; a Pro vault does not count
    toward the owner's free vaults. Two subscriptions exist today: monthly and yearly.
  - **How to buy**: Vault Settings → Billing → Upgrade to Pro (owners and admins). Checkout opens
    in the browser; the app flips to Pro as soon as payment lands. "Manage subscription" opens the
    billing portal for invoices, plan changes and cancellation.
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
