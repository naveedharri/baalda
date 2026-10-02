// First-run vault seeding. A brand-new, empty vault gets a starter set of
// interlinked notes so it isn't an empty void — and so the graph view has
// something to show from day one. The set is a small, self-explanatory second
// brain: a root `Welcome` and three folders
// (`Getting Started`, `Concepts`, `Examples`) whose notes link to one another
// with `[[wikilinks]]`. Those links become graph edges (they resolve by
// basename), so a fresh vault opens onto a populated constellation.
//
// It also teaches the vault's own structure to any AI working in it: a root
// `AGENTS.md` (what goes where — a routing table and house rules) and, in every
// folder, an `AGENTS.md` index (a one-line purpose, a table of its notes, its
// rules). They reference notes by path in backticks, never `[[AGENTS]]`, since
// four notes share that basename. `seed.test.ts` holds every index to exactly
// the notes in its folder, so editing the starter set means editing its index.
//
// This runs once, only when the vault has no notes and no folders — see
// `vaultIsEmpty`. Content is written with `write_note` (full-file, atomic) so we
// control the exact Markdown; `write_note` creates any missing parent folder, so
// each note materializes its folder on its own.
//
// No note starts with a `# Title` line: a note's title is its FILE NAME, which
// the editor shows as the inline title above the body (and renames the file
// when edited). A heading that repeats it would show twice.
//
// Prose is deliberately NOT hard-wrapped: the editor renders a source newline
// as a line break, so wrapped-at-80 templates froze every paragraph at an old
// column width. One logical line per paragraph / list item lets the text flow
// to whatever measure the editor has.

import * as ipc from "../ipc";
import type { TreeNode } from "../ipc";

/** Vault-relative path of the root welcome note (used to open it after seeding). */
export const WELCOME_NOTE_PATH = "Welcome.md";

/**
 * The full starter set, in write order. Each entry is a vault-relative path and
 * the exact Markdown to write. Wikilinks reference other notes by basename
 * (case-insensitive), so `[[How Baalda works]]` resolves regardless of folder.
 * Keep every `[[…]]` target pointing at a real basename in this list — a typo
 * just yields a dangling link (no graph edge), never an error.
 */
export const STARTER_NOTES: ReadonlyArray<{ path: string; body: string }> = [
  {
    path: WELCOME_NOTE_PATH,
    body: `Baalda is your **local-first second brain** — notes that live as plain Markdown files on your own computer.

What makes it different:

- **Your files, your disk.** Every note is a real \`.md\` file in this folder. No lock-in — open them in any editor, back them up, sync them however you like.
- **Write together, live.** Invite teammates and edit the same note at the same time, with cursors and presence — like a shared doc, but still just files.
- **Your AI can edit too.** Connect an assistant like Claude and let it read and write these notes directly, right alongside you.

Most tools give you one of these. Baalda is the bridge between all three.

## Start here

- 🚀 [[How Baalda works]] — a two-minute tour of the essentials.
- 🕸️ [[The graph view]] — see how these notes connect.
- 🤖 \`AGENTS.md\` — how an AI assistant should work in this vault. Every folder has one too, listing what's inside.

> These starter notes are already linked together, which is why your graph isn't empty. Delete them whenever you like — this is your space.

Happy writing. ✍️
`,
  },

  {
    path: "AGENTS.md",
    body: `---
type: guide
status: active
tags: [meta, routing, guide]
---

You are working in a Baalda vault: a folder of plain Markdown files that people and AI assistants read and edit together. Everything durable lives in these files, so whatever you write here becomes context for the next session — yours or a teammate's.

Core context:
- Where to start: \`Welcome.md\`
- How Baalda works: \`Getting Started/How Baalda works.md\`

## Session Startup

Read this file first, then the \`AGENTS.md\` inside any folder you are about to work in. Each one says what the folder holds and its local rules. Do not narrate the loading unless it matters to the answer.

## Knowledge Routing

Every piece of information needs one specific home. Do not create catch-all notes.

| What it is | Where it goes | Read first |
|---|---|---|
| How to use Baalda: the basics, shortcuts, AI, teamwork | \`Getting Started/\` | \`Getting Started/AGENTS.md\` |
| One idea or method, explained on its own | \`Concepts/\` | \`Concepts/AGENTS.md\` |
| Working notes: projects, meetings, reading, reviews | \`Examples/\` | \`Examples/AGENTS.md\` |
| A vault-wide rule for AI assistants | \`AGENTS.md\` (this file) | |

The three folders above are a starter set. As the vault grows — \`Projects/\`, \`Meetings/\`, \`People/\`, whatever fits the work — give each new top-level folder its own \`AGENTS.md\` and a row in this table.

## Where Work Lands

1. File a note in the folder whose \`AGENTS.md\` describes it. If no folder fits, choose the closest one and say which you chose, or propose a new folder.
2. Use today's actual date for date-stamped notes and filenames, written \`YYYY-MM-DD\`. Nearby notes may be stale.
3. A note's title is its file name. Do not start a note with a \`# Title\` heading that repeats it.
4. Keep the vault root for control files: \`AGENTS.md\` and \`Welcome.md\`. Everything else goes in a folder.
5. Corrections get written down without asking. Vault-wide behavior goes in this file; folder-specific behavior goes in that folder's \`AGENTS.md\`.

## Folders And Indexes

1. Every folder has an \`AGENTS.md\` index: a one-line purpose, a table of its notes, and its rules. Open it before filing work there.
2. When you add, rename, move or delete a note, update its folder's index table in the same change.
3. When you create, move or delete a folder, give it an \`AGENTS.md\`, then update the routing table above in the same change.

## Searching And Creating

1. Search before creating. Duplicates are a vault's main failure mode. If a relevant note already exists, update it and say which note changed.
2. One idea per note, titled so it can be linked later. Connect related notes with \`[[wikilinks]]\`: the other note's title in double square brackets.
3. Read a note end to end before rewriting or restructuring it, or when the answer depends on what is missing from it.
4. Put anything you will want to filter by — \`tags\`, \`status\`, a \`date\` — in the note's frontmatter properties.

## Working Alongside People

Teammates may be editing the same note while you work, and every edit merges live. Change only the part you mean to change; never rewrite a whole file to fix one line.

## Sources Of Truth

Never invent a number, date, name or quote. If something is not known, write \`unknown\` and say what would confirm it.

## Communication

Lead with the answer: the first sentence should say what happened or what you found. Keep supporting detail brief.

Use plain English and the simplest everyday words that carry the idea. If a technical term is needed, define it in a few words the first time it appears. State each fact once.

Match the length of a note to the task. Cover the substance without padding, filler sections or repeated summaries.

## Why AGENTS.md, Not CLAUDE.md

\`AGENTS.md\` is the instructions file that Codex, Cursor and most other AI agents read, and Claude reads it too when there is no \`CLAUDE.md\` — so one file covers every assistant. If you only use Claude, you can name this file \`CLAUDE.md\` instead. If you also use Codex, Cursor or any other agent, keep \`AGENTS.md\`. Do not keep both with different rules: when a \`CLAUDE.md\` exists, Claude reads only that file. To have both, make \`CLAUDE.md\` the single line \`@AGENTS.md\`.
`,
  },

  // ── Getting Started ───────────────────────────────────────────────────────
  {
    path: "Getting Started/AGENTS.md",
    body: `---
type: index
status: active
tags: [getting-started, guide]
---

How to use Baalda: the essentials, shortcuts, connecting an AI and working with a team. Flat folder of short, standalone guides (no subfolders).

## Notes

| File | What it covers |
|---|---|
| \`How Baalda works.md\` | Two-minute tour: plain files, live collaboration, your AI |
| \`Keyboard shortcuts.md\` | The shortcuts worth learning first |
| \`Working with your AI.md\` | Connecting an assistant over MCP or a coding tool |
| \`Collaborating with your team.md\` | Sync, live co-editing and per-folder sharing |

## Rules

- New guide → add it here with a descriptive filename and a row in the table above.
- Each guide covers one task, step by step, in plain words.
- Link the ideas a guide relies on with \`[[wikilinks]]\` instead of explaining them again.
- Ideas and methods belong in \`Concepts/\`; working notes belong in their own folders, not here.
- **Keep this index current**: when a note is added, renamed or removed, update the table.
`,
  },
  {
    path: "Getting Started/How Baalda works.md",
    body: `A quick tour of the essentials. This whole note is just a Markdown file — try editing it as you read.

## 1. Everything is a file

Notes are plain \`.md\` files in this folder. Create one with **⌘N**, then type its name straight into the title at the top — that *is* the file name, so renaming a note is just editing its title. Organise notes in the sidebar, and connect them with [[Wikilinks and backlinks]]. See [[Local-first notes]] for why that matters, and [[Keyboard shortcuts]] to move faster.

Want tags, a status or a date on a note? Press **⌘;** to add a **property** — it is stored as plain frontmatter at the top of the file and shown as a small panel above the text.

## 2. Work together in real time

This vault starts out **local** — just files on this computer. Sign in and turn on sync to keep it updated across your own devices, or accept a teammate's invite to collaborate on theirs — more in [[Collaborating with your team]].

## 3. Bring in your AI

Baalda speaks **MCP**, so an assistant like Claude can work in your vault directly — see [[Working with your AI]].

When you're ready, open [[The graph view]] to see how everything connects.
`,
  },
  {
    path: "Getting Started/Keyboard shortcuts.md",
    body: `The handful worth memorising first:

| Action | Shortcut |
| --- | --- |
| New note | **⌘N** |
| Close the current tab | **⌘W** |
| Switch between open tabs | **Ctrl-Tab** / **Ctrl-Shift-Tab** |
| Search notes | **⌘F** |
| Toggle the [[The graph view]] | **⌘G** |
| Bold / italic | **⌘B** / **⌘I** |
| Highlight | **⌘⇧H** |
| Heading level 1–6 | **⌘⌥1** … **⌘⌥6** |
| Tick / create a task | **⌘L** |
| Line break inside a paragraph | **⇧⏎** |
| Insert a link | **⌘K** |
| Add a property (tags, dates…) | **⌘;** |
| Insert a \`[[wikilink]]\` | type \`[[\` |

Typing \`[[\` anywhere starts a link, \`#\` suggests tags you already use, and \`/\` at the start of a line opens the block menu. To rename a note, click its title at the top and type — the file follows.

Hover the left edge of a heading, a list item or a callout for a › to fold it away; Baalda remembers what you folded the next time you open the note.

That's the core move behind [[Wikilinks and backlinks]]. Back to [[How Baalda works]].
`,
  },
  {
    path: "Getting Started/Working with your AI.md",
    body: `Baalda exposes your vault over **MCP**, so an assistant like **Claude** (in Claude Desktop or Cowork) can read and write these notes directly.

1. Open **Vault Settings → MCP** and create a connection token.
2. Add it to Claude as an MCP server.
3. Ask Claude to search, summarise, and write notes — its edits appear here live, exactly the way a teammate's would (see [[Collaborating with your team]]).

You can also just open this folder in a coding assistant like Claude Code — files it writes here sync like any other edit.

Every assistant should start from the \`AGENTS.md\` file at the root of the vault: it says where each kind of note belongs and how to keep the vault tidy. Each folder has its own \`AGENTS.md\` that indexes the notes inside it — keep them current as the vault grows, and your AI will always know where things go.

Good first tasks: turn your [[Ideas inbox]] into [[Atomic notes]], or draft a [[Weekly review]]. Back to [[How Baalda works]].
`,
  },
  {
    path: "Getting Started/Collaborating with your team.md",
    body: `Turn on sync and this vault stops being local-only — it stays updated across your own devices and with everyone you invite, live.

- Open the same note as a teammate and you'll see each other's cursors.
- Edits **merge** in real time — nothing gets overwritten.
- Share a single folder or the whole vault; permissions are per-folder.

Try it on [[Meeting notes]] or a [[Website launch]] plan. Your AI joins the same way — see [[Working with your AI]]. Back to [[How Baalda works]].
`,
  },

  // ── Concepts ──────────────────────────────────────────────────────────────
  {
    path: "Concepts/AGENTS.md",
    body: `---
type: index
status: active
tags: [concepts, guide]
---

Short explanations of one idea each — how notes, links and the graph fit together. Flat folder of atomic notes (no subfolders).

## Notes

| File | The idea |
|---|---|
| \`Local-first notes.md\` | Your files live on your device; sync is optional |
| \`Wikilinks and backlinks.md\` | Linking notes, and the links that point back |
| \`Maps of Content.md\` | Hand-made index notes for a topic |
| \`Atomic notes.md\` | One idea per note, so ideas recombine |
| \`Daily notes.md\` | One page per day as a log and landing spot |
| \`The graph view.md\` | Seeing every note and link as a map |

## Rules

- New concept → one idea per note, titled as the idea itself, plus a row in the table above.
- Explain the idea in a few short paragraphs and link at least one related note.
- Step-by-step how-tos belong in \`Getting Started/\`, not here.
- **Keep this index current**: when a note is added, renamed or removed, update the table.
`,
  },
  {
    path: "Concepts/Local-first notes.md",
    body: `**Local-first** means the source of truth lives on *your* device, not a server. Your notes are plain \`.md\` files you fully own — they work offline, open in any editor, and sync only when you choose.

Syncing is additive, not a dependency: turn it on for [[Collaborating with your team]], turn it off and everything still works. This is the foundation the rest of [[How Baalda works]] builds on.
`,
  },
  {
    path: "Concepts/Wikilinks and backlinks.md",
    body: `A **wikilink** connects one note to another: write \`[[Atomic notes]]\` and it becomes a link. The note you link *to* automatically gains a **backlink** — a list of everything pointing at it.

Links are the real structure of a vault (folders are secondary). Enough of them and you get [[The graph view]], and you can curate them by hand with [[Maps of Content]]. This idea powers [[Atomic notes]] and [[Daily notes]].
`,
  },
  {
    path: "Concepts/Maps of Content.md",
    body: `A **Map of Content** (MOC) is a note that links to a cluster of related notes — a table of contents you write by hand. Use one whenever a topic grows past a few notes.

They pair naturally with [[Wikilinks and backlinks]]: the MOC links out, the backlinks point home. Each folder's \`AGENTS.md\` index does a similar job for your AI — a table of everything in that folder. See also [[Atomic notes]].
`,
  },
  {
    path: "Concepts/Atomic notes.md",
    body: `An **atomic note** holds *one* idea, titled so you can link to it later. Small notes recombine — one idea can support many others through [[Wikilinks and backlinks]].

It's the core habit from [[How to Take Smart Notes]]. Capture rough thoughts in your [[Ideas inbox]] first, then split them into atomic notes. Gather related ones under [[Maps of Content]].
`,
  },
  {
    path: "Concepts/Daily notes.md",
    body: `A **daily note** is one page per day — a log, a scratchpad, a landing spot for whatever comes up. Link out from it liberally with [[Wikilinks and backlinks]].

Daily notes feed two rhythms: drop half-formed thoughts into your [[Ideas inbox]], and roll the week up in your [[Weekly review]].
`,
  },
  {
    path: "Concepts/The graph view.md",
    body: `The **graph** draws every note as a node and every [[Wikilinks and backlinks]] connection as an edge. Press **⌘G** (see [[Keyboard shortcuts]]) to open it.

It's a fast way to *see* your thinking: clusters are topics, hubs are your [[Maps of Content]], and lonely nodes are notes worth linking. The vault you're reading now is why your graph isn't empty. Back to [[Welcome]].
`,
  },

  // ── Examples ──────────────────────────────────────────────────────────────
  {
    path: "Examples/AGENTS.md",
    body: `---
type: index
status: active
tags: [examples, guide]
---

Sample working notes that show how real work lives in a vault: reading, a book, a project, a meeting, an inbox and a weekly review. Replace them with your own whenever you are ready.

## Notes

| File | What it shows |
|---|---|
| \`Reading list.md\` | A living list of books, each becoming its own note |
| \`How to Take Smart Notes.md\` | Notes on one book, written as linked ideas |
| \`Website launch.md\` | A small project with milestones as tasks |
| \`Meeting notes.md\` | Attendees, decisions and action items |
| \`Ideas inbox.md\` | One place to capture raw thoughts fast |
| \`Weekly review.md\` | A short checklist to keep the vault tidy |

## Rules

- New working note → descriptive filename and a row in the table above.
- Date-stamped notes such as meetings are named \`YYYY-MM-DD Topic.md\`, using today's actual date.
- Write tasks as \`- [ ]\` checkboxes inside the note they belong to.
- When one kind of note outgrows this folder, give it its own top-level folder (\`Projects/\`, \`Meetings/\`, \`Reading/\`…) with its own \`AGENTS.md\`, and add it to the routing table in the root \`AGENTS.md\`.
- **Keep this index current**: when a note is added, renamed or removed, update the table.
`,
  },
  {
    path: "Examples/Reading list.md",
    body: `A living list. Each book becomes its own note once you start taking [[Atomic notes]] from it.

- 📖 [[How to Take Smart Notes]] — Sönke Ahrens *(reading)*
- 📕 *Building a Second Brain* — Tiago Forte *(next)*
- 📗 *How to Read a Book* — Adler & Van Doren *(someday)*

New ideas from what you read land in the [[Ideas inbox]].
`,
  },
  {
    path: "Examples/How to Take Smart Notes.md",
    body: `Notes on Sönke Ahrens' book — the case for the *Zettelkasten* method.

## Key ideas

- Write **[[Atomic notes]]** in your own words — one idea each.
- Link every note to others so ideas find each other later ([[Wikilinks and backlinks]]).
- Don't file by folder; let structure emerge, then curate with [[Maps of Content]].

Part of the [[Reading list]].
`,
  },
  {
    path: "Examples/Website launch.md",
    body: `A tiny project note, to show how work lives in the vault.

## Milestones

- [ ] Finalise copy
- [ ] Design review — notes in [[Meeting notes]]
- [ ] Ship 🚀

Progress gets summarised in the [[Weekly review]]; coordinate with the team via [[Collaborating with your team]].
`,
  },
  {
    path: "Examples/Meeting notes.md",
    body: `**Attendees:** you + the team · **Project:** [[Website launch]]

## Decisions

- Ship the new landing page Friday.
- Keep the pricing section for a follow-up.

## Action items

- [ ] Capture leftover ideas in the [[Ideas inbox]]
- [ ] Review progress in the [[Weekly review]]

Everyone edits this live — see [[Collaborating with your team]].
`,
  },
  {
    path: "Examples/Ideas inbox.md",
    body: `A single place to dump raw thoughts fast, so nothing gets lost. Process it later into [[Atomic notes]] — that's the habit from [[How to Take Smart Notes]].

- A graph filter for orphan notes?
- Blog post: what "local-first" really means → [[Local-first notes]]
- Follow up on the [[Website launch]] copy

Empty this out during your [[Weekly review]]; it often fills from your [[Daily notes]].
`,
  },
  {
    path: "Examples/Weekly review.md",
    body: `A five-minute ritual to keep the vault (and your head) tidy.

## Checklist

- [ ] Empty the [[Ideas inbox]] into [[Atomic notes]]
- [ ] Skim this week's [[Daily notes]]
- [ ] Update project notes like [[Website launch]]
- [ ] Prune or link any lonely nodes in [[The graph view]]

Start from [[Welcome]] and follow the links.
`,
  },
];

/** True when a vault has no notes and no folders (a brand-new, empty vault). */
export function vaultIsEmpty(tree: TreeNode): boolean {
  return (tree.children ?? []).length === 0;
}

/**
 * Write the first-run starter content into an (assumed empty) vault. Returns the
 * welcome note's vault-relative path so the caller can open it, or null if any
 * write failed (seeding is best-effort — a failure must never block vault open).
 *
 * `expectedEpoch` pins the writes to one vault: seeding 20 notes takes many
 * awaits, and without the pin a vault switch part-way through would scatter the
 * remaining starter notes into the vault the user just opened.
 */
export async function seedWelcomeContent(
  expectedEpoch?: ipc.VaultEpoch,
): Promise<string | null> {
  try {
    for (const note of STARTER_NOTES) {
      await ipc.writeNote(note.path, note.body, expectedEpoch);
    }
    return WELCOME_NOTE_PATH;
  } catch (e) {
    console.warn("[seed] failed to write starter content", e);
    return null;
  }
}
