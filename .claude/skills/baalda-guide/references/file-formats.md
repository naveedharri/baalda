# What file types Baalda supports

The single most common question. Answer it precisely, because "supports" means
four different things in Baalda and people usually mean one of them:

| Level | What it means | File types |
|---|---|---|
| **Note** | Opens in the editor, edited live with teammates and AI, searchable, backlinks, version history, synced to the server | `.md` `.markdown` `.mdx` `.txt` `.html` `.htm` `.canvas` |
| **Viewable file** | Shows in the sidebar, opens in a built-in viewer, cannot be edited inside Baalda | Images: `.png` `.jpg` `.jpeg` `.gif` `.webp` `.svg` `.avif` · Documents: `.pdf` |
| **File** | Shows in the sidebar and syncs as a file (opened in a viewer, or as a card with "Open externally") | Images, PDF, Office files, audio/video, `.csv`/`.json` style data, and archives: `.zip` `.tar` `.tar.gz` `.tgz` `.gz` `.7z` (full list: `ALLOWED_EXTS`) |
| **Attachment** | Any file dragged onto an open note. Copied into the vault's hidden `attachments/` folder, linked from the note, synced to teammates | Anything: `.docx` `.xlsx` `.pptx` `.csv` `.zip` `.mp4`, code files, and so on |
| **Ignored** | Not shown, not indexed, not synced | By default: everything else (for example `.rar`, `.dmg`, `.exe`, `.js`), plus `node_modules`, `dist`, `build`, `target`, `vendor`, `venv`, `__pycache__`, and any dot-folder like `.github`. An owner or admin can turn several of these on in Vault Settings → Sync (see below) |

Source: `app/apps/desktop/src-tauri/src/vault.rs` (`ALLOWED_EXTS`, `DENIED_DIRS`),
`app/apps/desktop/src/lib/sync/registry.ts` (`NOTE_EXTS`), `app/apps/desktop/src/lib/preview.ts`,
`app/apps/desktop/src/lib/attachments.ts`.

## The details that matter

**Markdown is the real format.** Everything else is secondary. A note is a plain text file
on disk. Only text notes go through the live-collaboration engine and the AI path.

**Text-like formats open as text.** `.txt`, `.html`, `.canvas` (Obsidian canvas files, which
are JSON) are treated as notes: you can open and edit them as text and they sync like notes.
Two wrinkles: full-text search and backlinks only index `.md` files, and the Import command
converts `.txt` and `.markdown` files to `.md` on the way in so they get the full treatment.
`.html` files render as a sandboxed read-only page (with a Source toggle); they are not
co-edited live. There is no rich rendering of `.canvas`.

**Images and PDFs are view-only.** Baalda previews them in place (images inline, PDFs as a
block) and lets you embed them in notes with `![name](/attachments/...)`. It does not edit them.

**How images and PDFs get into a note.** Paste a screenshot or drag a file onto an open note.
Baalda copies it into `attachments/` at the vault root, names it by content hash (so the same
file dropped twice is stored once), and inserts the embed for you. HEIC and TIFF photos are
converted to PNG on import so they display on every platform. That `attachments/` folder is
hidden from the sidebar on purpose; it is the sync store for binary files.

**Files in folders sync on Team, embeds sync everywhere.** A file of a supported type put
anywhere in the vault (say `Projects/diagram.png` or `Backups/site.tar.gz`) shows in the
sidebar and, on the Team plan or a self-hosted server without billing, syncs to teammates as a
file. On the Free plan only files embedded in a note (the `attachments/` folder) sync. A file
of an unsupported type (see "Ignored" above) never shows and never syncs.

**Office files are previewed, not edited.** `.docx` and `.xlsx`/`.xlsm` open in a read-only
preview inside Baalda; `.pptx` shows a card with "Open externally". None of them can be edited
in Baalda, and their text is searchable but they are not notes. To work on the content as a
note, convert it to Markdown first (Pandoc, "Save as Markdown", or ask your AI).

**Spreadsheet data opens as a table.** `.csv` and `.tsv` open in a read-only table view. Tables
inside notes are ordinary Markdown tables.

**Some code files show by default; the rest is a vault switch.** `.py`, `.rs`, `.go`, `.sh`, `.sql`
and data files (`.json`, `.yaml`, `.toml`, `.xml`) show in the sidebar, open read-only with syntax
colouring and sync as files. `.js`, `.ts`, `.css`, `.java`, `.c`/`.cpp` and similar are off by
default, so pointing Baalda at a project folder does not flood the sidebar; an owner or admin turns
them on for the whole vault with Vault Settings → Sync → "Code and text files". Code files sync as
whole files: if two people change the same one, the latest saved version wins.

**Vault Settings → Sync: what syncs in a vault.** One setting for the whole vault. Owners and
admins change it, every computer in the vault follows it, members can read it. It has:
- **File types:** notes, images, PDFs, Office files, audio and video always sync. "Code and text
  files" and "More file types" (fonts, design files, older Office formats, more video and archive
  types) are off until switched on.
- **Folders:** "Hidden folders and files" (names starting with a dot, like `.github` or
  `.obsidian`) and "Build and dependency folders" (`node_modules`, `dist`, `build`…), both off.
- **Don't sync:** a list of folders or patterns (like a `.gitignore`) that stay on each computer
  only, for example a Git checkout inside a project folder. "Edit as text" shows the raw list.

Nothing in this setting ever deletes a file. What stops syncing stays where it is, on every
computer and on the server, is hidden from the sidebar and search, and edits to it no longer
travel. Switching it back on picks the same files up again. A note edited on both sides while it
was hidden merges both edits. A file (code, image, document) changed on both sides takes the
server's version, and the local copy is replaced with no copy kept.
Some things never sync whatever the setting says, because syncing them would break them: Baalda's
own `.context` folder, Git's internal `.git` folder, app lock files, system files like
`.DS_Store` and `Thumbs.db`, and links (symlinks). Files with no extension (`Makefile`,
`.gitignore`) and empty files are not synced either.

**Archives are stored, never opened.** `.zip`, `.tar`, `.tar.gz`/`.tgz`, `.gz` and `.7z` show
in the sidebar and sync as files; clicking one shows a card with "Open externally". Search
finds an archive by its name (and a `.zip` by the names of the files inside it); Baalda never
unpacks one. Any `.gz` counts, not only compressed tarballs. `.rar` and other archive types are
not supported and are ignored.

**Size limits (managed and self-hosted servers).**

| Thing | Limit | Where set |
|---|---|---|
| One note's text | 10 MB | `MAX_NOTE_MB` on the server |
| A file dropped onto a note | 25 MB | the app refuses larger drops |
| A file in the vault, on a server that keeps files in its database | 25 MB | `MAX_BLOB_BYTES` on the server |
| A file in the vault, on a server with S3-compatible file storage | images 25 MB, documents 50 MB, PDF 100 MB, text/data 10 MB, audio and archives 200 MB, video 500 MB | per type on the server, at most `MAX_BLOB_BYTES_DIRECT` (500 MB) |

Local-only vaults have no such limits; these apply when syncing. Files in folders (outside
`attachments/`) sync on the Team plan and on self-hosted servers without billing; the Free plan
syncs only files embedded in notes.

**Attachments are never AI-edited.** An AI connected over MCP can list files and read the
text Baalda extracted from them (PDF, DOCX and similar) with `list_attachments` and
`read_attachment_text`, and search ranks file text beside notes. It can rename, move or delete a
file (`move_file`, `delete_file`) with the same permissions as the token's owner, but it never
receives or writes a file's raw bytes.

## Ready answers

Q: *Can it hold and sync DOCX, XLSX, PNG, PY and JS files?*

> Mostly. PNG, DOCX, XLSX and PY files show in the sidebar, open in a read-only preview and sync
> as files; Baalda does not edit them. JS files are ignored on purpose so a project folder does
> not flood your vault; paste that code into a note or attach the file. Only Markdown and other
> text notes get live co-editing and the AI editing tools.

Q: *Can I use my existing Obsidian vault?*

> Yes. Point Baalda at the folder. Your `.md` files, folders, `[[wikilinks]]` and tags work as-is.
> Obsidian-specific plugins and their data do not carry over, and `.canvas` files open as text.

Q: *Where do pasted images go?*

> Into a hidden `attachments/` folder at the top of your vault, named by a content hash.
> The note gets an embed line pointing at it. Teammates receive the file through sync.
