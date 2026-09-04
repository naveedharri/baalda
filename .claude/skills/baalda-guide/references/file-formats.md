# What file types Baalda supports

The single most common question. Answer it precisely, because "supports" means
four different things in Baalda and people usually mean one of them:

| Level | What it means | File types |
|---|---|---|
| **Note** | Opens in the editor, edited live with teammates and AI, searchable, backlinks, version history, synced to the server | `.md` `.markdown` `.mdx` `.txt` `.html` `.htm` `.canvas` |
| **Viewable file** | Shows in the sidebar, opens in a built-in viewer, cannot be edited inside Baalda | Images: `.png` `.jpg` `.jpeg` `.gif` `.webp` `.svg` `.avif` · Documents: `.pdf` |
| **Attachment** | Any file dragged onto an open note. Copied into the vault's hidden `attachments/` folder, linked from the note, synced to teammates | Anything: `.docx` `.xlsx` `.pptx` `.csv` `.zip` `.mp4`, code files, and so on |
| **Ignored** | Not shown, not indexed, not synced | Everything else, plus `node_modules`, `dist`, `build`, `target`, `vendor`, `venv`, `__pycache__`, and any dot-folder like `.git` |

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

**Only the `attachments/` folder syncs binary files.** An image or PDF you put elsewhere in the
vault (say `Projects/diagram.png`) shows up in your sidebar and previews locally, but it is not
sent to the server or to teammates. The registry only registers text notes; binary sync only
mirrors `attachments/`. If someone asks "why don't my teammates see my image", this is why:
drop it onto a note instead of copying it into a folder.

**Office files (DOCX, XLSX, PPTX) are attachments, not notes.** Baalda does not open, convert,
render, or edit them. You can attach one to a note and it will sync to the team as a download
link, but that is all. To open the file itself, use "Reveal in Finder/Explorer" and open it
from the `attachments/` folder with Word or Excel; clicking the link inside the note does not
launch an external app. To get the *content* into Baalda, convert it to Markdown first (Pandoc,
"Save as Markdown", or ask your AI to convert it) or export a PDF and attach that.

**Spreadsheets have no special treatment.** A `.csv` is an attachment. Tables inside notes are
ordinary Markdown tables.

**Code files (`.py`, `.js`, `.ts`, `.rs`, etc.) are deliberately ignored.** Baalda is a notes
app, not a code editor. The exclusion exists so you can point Baalda at a real project folder
(or even a whole drive) and see only your notes, never source files or dependency folders.
If you want code in your second brain, paste it into a note inside a fenced code block, or
attach the file to a note. Do not expect syntax highlighting of a standalone `.py` file.

**Size limits (managed and self-hosted servers).**

| Thing | Limit | Where set |
|---|---|---|
| One note's text | 10 MB | `MAX_NOTE_MB` on the server |
| One attachment | 25 MB | `MAX_BLOB_BYTES` on the server |

Local-only vaults have no such limits; these apply when syncing.

**Attachments are never AI-edited or searched.** The MCP tools and the search index only see
note text. An AI connected over MCP cannot read a PDF or DOCX you attached.

## Ready answers

Q: *Can it hold and sync DOCX, XLSX, PNG, PY and JS files?*

> Partly. PNG (and other common images plus PDF) show in the sidebar and preview in the app.
> Anything you drag onto a note, including DOCX and XLSX, is stored as an attachment and syncs
> to your team as a link, but Baalda cannot open or edit Office files; convert them to Markdown
> if you want the content inside a note. PY and JS files are ignored on purpose so a project
> folder does not flood your vault with code; paste code into a note instead. Only Markdown and
> other text notes get the live editing, search and AI features.

Q: *Can I use my existing Obsidian vault?*

> Yes. Point Baalda at the folder. Your `.md` files, folders, `[[wikilinks]]` and tags work as-is.
> Obsidian-specific plugins and their data do not carry over, and `.canvas` files open as text.

Q: *Where do pasted images go?*

> Into a hidden `attachments/` folder at the top of your vault, named by a content hash.
> The note gets an embed line pointing at it. Teammates receive the file through sync.
