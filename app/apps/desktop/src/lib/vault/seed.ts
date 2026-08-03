// First-run vault seeding. A brand-new, empty vault gets a starter set of
// interlinked notes so it isn't an empty void — and so the graph view has
// something to show from day one. The set is a small, self-explanatory second
// brain: a root `Welcome`, a `Map of Content` hub, and three folders
// (`Getting Started`, `Concepts`, `Examples`) whose notes link to one another
// with `[[wikilinks]]`. Those links become graph edges (they resolve by
// basename), so a fresh vault opens onto a populated constellation.
//
// This runs once, only when the vault has no notes and no folders — see
// `vaultIsEmpty`. Content is written with `write_note` (full-file, atomic)
// rather than `create_note` (which would prepend its own H1), so we control the
// exact Markdown. `write_note` creates any missing parent folder, so each note
// materializes its folder on its own.

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
    body: `# Welcome to Baalda 👋

Baalda is your **local-first second brain** — notes that live as plain Markdown
files on your own computer.

What makes it different:

- **Your files, your disk.** Every note is a real \`.md\` file in this folder. No
  lock-in — open them in any editor, back them up, sync them however you like.
- **Write together, live.** Invite teammates and edit the same note at the same
  time, with cursors and presence — like a shared doc, but still just files.
- **Your AI can edit too.** Connect an assistant like Claude and let it read and
  write these notes directly, right alongside you.

Most tools give you one of these. Baalda is the bridge between all three.

## Start here

- 🧭 [[Map of Content]] — a hand-made index of everything in this vault.
- 🚀 [[How Baalda works]] — a two-minute tour of the essentials.
- 🕸️ [[The graph view]] — see how these notes connect.

> These starter notes are already linked together, which is why your graph
> isn't empty. Delete them whenever you like — this is your space.

Happy writing. ✍️
`,
  },

  {
    path: "Map of Content.md",
    body: `# Map of Content

A **Map of Content** (MOC) is a note whose only job is to link to other notes.
It's how you navigate a vault by hand instead of by folders. This one indexes
your starter set — see [[Maps of Content]] for the idea behind it.

## Getting started

- [[How Baalda works]]
- [[Keyboard shortcuts]]
- [[Working with your AI]]
- [[Collaborating with your team]]

## Concepts

- [[Local-first notes]]
- [[Wikilinks and backlinks]]
- [[Maps of Content]]
- [[Atomic notes]]
- [[Daily notes]]
- [[The graph view]]

## Examples

- [[Reading list]]
- [[How to Take Smart Notes]]
- [[Website launch]]
- [[Meeting notes]]
- [[Ideas inbox]]
- [[Weekly review]]

← back to [[Welcome]]
`,
  },

  // ── Getting Started ───────────────────────────────────────────────────────
  {
    path: "Getting Started/How Baalda works.md",
    body: `# How Baalda works

A quick tour of the essentials. This whole note is just a Markdown file — try
editing it as you read.

## 1. Everything is a file

Notes are plain \`.md\` files in this folder. Create one with **⌘N**, organise
them in the sidebar, and connect them with [[Wikilinks and backlinks]]. See
[[Local-first notes]] for why that matters, and [[Keyboard shortcuts]] to move
faster.

## 2. Work together in real time

This vault starts out **local** — just files on this computer. Sign in and
turn on sync to keep it updated across your own devices, or accept a
teammate's invite to collaborate on theirs — more in
[[Collaborating with your team]].

## 3. Bring in your AI

Baalda speaks **MCP**, so an assistant like Claude can work in your vault
directly — see [[Working with your AI]].

When you're ready, the [[Map of Content]] links to everything else.
`,
  },
  {
    path: "Getting Started/Keyboard shortcuts.md",
    body: `# Keyboard shortcuts

The handful worth memorising first:

| Action | Shortcut |
| --- | --- |
| New note | **⌘N** |
| Quick open / search | **⌘P** |
| Toggle the [[The graph view]] | **⌘G** |
| Bold / italic | **⌘B** / **⌘I** |
| Insert a \`[[wikilink]]\` | type \`[[\` |

Typing \`[[\` starts a link — that's the core move behind
[[Wikilinks and backlinks]]. Back to [[How Baalda works]].
`,
  },
  {
    path: "Getting Started/Working with your AI.md",
    body: `# Working with your AI

Baalda exposes your vault over **MCP**, so an assistant like **Claude** (in
Claude Desktop or Cowork) can read and write these notes directly.

1. Open **Vault Settings → MCP** and create a connection token.
2. Add it to Claude as an MCP server.
3. Ask Claude to search, summarise, and write notes — its edits appear here
   live, exactly the way a teammate's would (see [[Collaborating with your team]]).

Good first tasks: turn your [[Ideas inbox]] into [[Atomic notes]], or draft a
[[Weekly review]]. Back to [[How Baalda works]].
`,
  },
  {
    path: "Getting Started/Collaborating with your team.md",
    body: `# Collaborating with your team

Turn on sync and this vault stops being local-only — it stays updated across
your own devices and with everyone you invite, live.

- Open the same note as a teammate and you'll see each other's cursors.
- Edits **merge** in real time — nothing gets overwritten.
- Share a single folder or the whole vault; permissions are per-folder.

Try it on [[Meeting notes]] or a [[Website launch]] plan. Your AI joins the same
way — see [[Working with your AI]]. Back to [[How Baalda works]].
`,
  },

  // ── Concepts ──────────────────────────────────────────────────────────────
  {
    path: "Concepts/Local-first notes.md",
    body: `# Local-first notes

**Local-first** means the source of truth lives on *your* device, not a server.
Your notes are plain \`.md\` files you fully own — they work offline, open in any
editor, and sync only when you choose.

Syncing is additive, not a dependency: turn it on for
[[Collaborating with your team]], turn it off and everything still works. This is
the foundation the rest of [[How Baalda works]] builds on.
`,
  },
  {
    path: "Concepts/Wikilinks and backlinks.md",
    body: `# Wikilinks and backlinks

A **wikilink** connects one note to another: write \`[[Atomic notes]]\` and it
becomes a link. The note you link *to* automatically gains a **backlink** —
a list of everything pointing at it.

Links are the real structure of a vault (folders are secondary). Enough of them
and you get [[The graph view]], and you can curate them by hand with
[[Maps of Content]]. This idea powers [[Atomic notes]] and [[Daily notes]].
`,
  },
  {
    path: "Concepts/Maps of Content.md",
    body: `# Maps of Content

A **Map of Content** (MOC) is a note that links to a cluster of related notes —
a table of contents you write by hand. Use one whenever a topic grows past a few
notes.

They pair naturally with [[Wikilinks and backlinks]]: the MOC links out, the
backlinks point home. Your vault's top-level MOC is the [[Map of Content]]. See
also [[Atomic notes]].
`,
  },
  {
    path: "Concepts/Atomic notes.md",
    body: `# Atomic notes

An **atomic note** holds *one* idea, titled so you can link to it later. Small
notes recombine — one idea can support many others through
[[Wikilinks and backlinks]].

It's the core habit from [[How to Take Smart Notes]]. Capture rough thoughts in
your [[Ideas inbox]] first, then split them into atomic notes. Gather related
ones under [[Maps of Content]].
`,
  },
  {
    path: "Concepts/Daily notes.md",
    body: `# Daily notes

A **daily note** is one page per day — a log, a scratchpad, a landing spot for
whatever comes up. Link out from it liberally with [[Wikilinks and backlinks]].

Daily notes feed two rhythms: drop half-formed thoughts into your
[[Ideas inbox]], and roll the week up in your [[Weekly review]].
`,
  },
  {
    path: "Concepts/The graph view.md",
    body: `# The graph view

The **graph** draws every note as a node and every [[Wikilinks and backlinks]]
connection as an edge. Press **⌘G** (see [[Keyboard shortcuts]]) to open it.

It's a fast way to *see* your thinking: clusters are topics, hubs are your
[[Maps of Content]], and lonely nodes are notes worth linking. The vault you're
reading now is why your graph isn't empty. Back to the [[Map of Content]].
`,
  },

  // ── Examples ──────────────────────────────────────────────────────────────
  {
    path: "Examples/Reading list.md",
    body: `# Reading list

A living list. Each book becomes its own note once you start taking
[[Atomic notes]] from it.

- 📖 [[How to Take Smart Notes]] — Sönke Ahrens *(reading)*
- 📕 *Building a Second Brain* — Tiago Forte *(next)*
- 📗 *How to Read a Book* — Adler & Van Doren *(someday)*

New ideas from what you read land in the [[Ideas inbox]].
`,
  },
  {
    path: "Examples/How to Take Smart Notes.md",
    body: `# How to Take Smart Notes

Notes on Sönke Ahrens' book — the case for the *Zettelkasten* method.

## Key ideas

- Write **[[Atomic notes]]** in your own words — one idea each.
- Link every note to others so ideas find each other later
  ([[Wikilinks and backlinks]]).
- Don't file by folder; let structure emerge, then curate with
  [[Maps of Content]].

Part of the [[Reading list]].
`,
  },
  {
    path: "Examples/Website launch.md",
    body: `# Website launch

A tiny project note, to show how work lives in the vault.

## Milestones

- [ ] Finalise copy
- [ ] Design review — notes in [[Meeting notes]]
- [ ] Ship 🚀

Progress gets summarised in the [[Weekly review]]; coordinate with the team via
[[Collaborating with your team]].
`,
  },
  {
    path: "Examples/Meeting notes.md",
    body: `# Meeting notes — Design review

**Attendees:** you + the team · **Project:** [[Website launch]]

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
    body: `# Ideas inbox

A single place to dump raw thoughts fast, so nothing gets lost. Process it later
into [[Atomic notes]] — that's the habit from [[How to Take Smart Notes]].

- A graph filter for orphan notes?
- Blog post: what "local-first" really means → [[Local-first notes]]
- Follow up on the [[Website launch]] copy

Empty this out during your [[Weekly review]]; it often fills from your
[[Daily notes]].
`,
  },
  {
    path: "Examples/Weekly review.md",
    body: `# Weekly review

A five-minute ritual to keep the vault (and your head) tidy.

## Checklist

- [ ] Empty the [[Ideas inbox]] into [[Atomic notes]]
- [ ] Skim this week's [[Daily notes]]
- [ ] Update project notes like [[Website launch]]
- [ ] Prune or link any lonely nodes in [[The graph view]]

Start from the [[Map of Content]] and follow the links.
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
