# Ready answers to common questions

Each answer is written for a non-technical reader. Reuse the wording; trim to fit.

## What is Baalda, in one breath?
A notes app for teams where every note is a plain Markdown file on your own computer, your
teammates can edit the same note with you live, and an AI assistant can read and edit those
notes too. Think "Obsidian, but multiplayer and AI-friendly".

## Is it free?
The desktop app and the server are open source (Apache 2.0). Using it on your own computer is
free forever, and you can run your own server for free with no limits. The managed backend
(hosted by Baalda, the app's default) also starts free: 3 vaults per user and 10 members per
vault. Past that, upgrade a vault to Pro from inside the app.

## What does the paid plan cost, and can my team start today?
Yes, today. Sign up in the app, turn on sync, invite the team. The free tier already covers a
team of up to 10 in one vault. When you need more members or more vaults, go to Vault Settings →
Billing → Upgrade to Pro: $10 per vault per month or $97 per vault per year, priced per vault,
not per person, with unlimited members. Only the vault owner or an admin pays; everyone else just
needs a free account. baalda.com/pricing is the place to ask questions or talk to the team, but
nobody has to wait for a call to get started.

## Do I need an account?
No. You can open a folder and start writing with no account and no internet. An account is only
needed for sync between devices, team collaboration, and the hosted AI endpoint.

## Does it work offline?
Yes. Everything local (editing, search, backlinks, graph) works with no connection. When you
reconnect, your changes merge with everyone else's; there are no conflict dialogs.

## What happens if two people edit the same note at once?
Both edits are kept and merged character by character, live, with visible cursors. The same is
true when an AI edits a note while a person is typing in it.

## Where are my notes stored?
In a folder you choose on your disk (default `~/Documents/Baalda Vaults/<vault name>`). They are ordinary `.md`
files you can open in any editor, back up, or put in Git. A hidden `.context/` folder inside the
vault holds the search index and sync state; you can delete it and Baalda rebuilds it.

## What does the server store? Can Baalda read my notes?
The server stores the sync history as binary change records, not `.md` files, and each device
rebuilds its own files from that. Be honest here: the server *can* reconstruct note text; that
is how server-side search, public links and the MCP endpoint work. Notes are not end-to-end
encrypted today (at-rest encryption is on the roadmap). If that matters, self-host.

## Can I use it with my Obsidian vault?
Yes. Open the folder. Markdown, folders, `[[wikilinks]]` and `#tags` carry over. Obsidian
plugins do not. See `file-formats.md` for what happens to non-Markdown files.

## Which platforms?
macOS (Apple Silicon and Intel), Windows 10/11, Linux (AppImage, .deb, .rpm). iOS is planned,
not available. The macOS build is signed and notarized; Windows and Linux builds are unsigned,
so a fresh Windows download shows a SmartScreen warning (More info → Run anyway). The app
updates itself with a signed updater after the first install.

## How do I share notes with my team?
Sign in, turn on sync for your vault, invite people by email or share a join code. New vaults
are shared with the whole team by default; you can make any folder or note private, share it
with specific people, and choose view or edit for each. Roles are owner, admin, member.

## Can I share a note with someone who does not use Baalda?
Yes. "Copy link" on a note offers a public link: a read-only web page anyone with the link can
open. Revoke it any time. There is also a private link that only works for teammates with access.

## How does the AI part work?
Two ways. (1) Local: because notes are plain files, any tool on your computer, for example
Claude Code, can edit them directly; Baalda notices the change and syncs it. (2) Remote: Baalda
has a built-in MCP endpoint (Model Context Protocol, the standard way AI assistants connect to
tools). Create a token in Vault Settings → MCP, give it to your AI client, and the AI can list,
search, read, create, update, move and delete notes, limited by the same permissions as a person.
There is no built-in chat panel or bundled AI model; you bring your own AI.

## Is there version history?
Yes. Each note keeps versions (captured automatically after a pause in editing, and before any
revert) that you can preview and restore. Owners and admins can also take a checkpoint of the
whole vault and revert to it.

## Can I lock a note?
Yes. Lock a note or folder so it becomes read-only for everyone, including admins, until unlocked.

## What is the voice button?
Push-to-talk. Hold it to speak to teammates who are in the same vault. Nothing is recorded or
stored; if someone was offline they simply did not hear it.

## Does it have a graph view, backlinks, tags, search?
Yes to all. Full-text search runs locally and instantly. When a vault is synced there is also a
server-side semantic search. Backlinks survive renames and moves because notes are tracked by a
stable id, not by filename.

## Is there a mobile app or web app?
Not yet. Desktop only; iOS is on the roadmap. Public note links open in any browser, read-only.

## Can I self-host?
Yes. The server is Node + Postgres. One-click deploy to Railway, a Docker Compose bundle, or
plain Docker; see `docs/DEPLOY.md`. Then paste your server URL into the app's settings.
Self-hosted servers have no plan limits.

## What is NOT there (so you do not overpromise)?
Rich WYSIWYG block editing, in-app AI chat, comments and @mentions, end-to-end encryption,
a mobile app, Office file conversion, plugins, two-factor authentication, SSO, audit logs. Several are on the Phase 4 roadmap in
`docs/STATUS.md`; say "planned", never "available".
