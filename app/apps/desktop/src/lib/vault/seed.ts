// First-run vault seeding. A brand-new, empty vault gets a small amount of
// starter content so it isn't an empty void: a root `Welcome` note that pitches
// the idea, plus a `Getting Started` folder with a short walkthrough. This runs
// once, only when the vault has no notes and no folders — see `vaultIsEmpty`.
//
// Content is written with `write_note` (full-file, atomic) rather than
// `create_note` (which would prepend its own H1), so we control the exact
// Markdown. `write_note` creates any missing parent folder, so the walkthrough
// note materializes its folder on its own.

import * as ipc from "../ipc";
import type { TreeNode } from "../ipc";

/** Vault-relative path of the root welcome note (used to open it after seeding). */
export const WELCOME_NOTE_PATH = "Welcome.md";

const GETTING_STARTED_NOTE_PATH = "Getting Started/How Baalda works.md";

const WELCOME_BODY = `# Welcome to Baalda 👋

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

> New here? Open **Getting Started → How Baalda works** for a two-minute tour.

Happy writing. ✍️
`;

const GETTING_STARTED_BODY = `# How Baalda works

A quick tour of the essentials. This whole note is just a Markdown file — try
editing it as you read.

## 1. Everything is a file

Notes are plain \`.md\` files in this folder. Create one with **⌘N**, organise
them into folders in the sidebar, and link between them with \`[[wikilinks]]\`.
Anything you do here shows up as ordinary files on disk.

## 2. Work together in real time

Sign in and create (or join) a **workspace** to sync this vault across your
devices and with your team. Open the same note as a teammate and you'll see
each other's cursors — edits merge instantly, nothing gets overwritten.

## 3. Bring in your AI

Baalda speaks **MCP**, so an assistant like **Claude** (in Claude Desktop or
Cowork) can work in your vault directly:

1. Open **Workspace Settings → MCP** and create a connection token.
2. Add it to Claude as an MCP server.
3. Ask Claude to read, search, and write your notes — its edits show up here
   live, the same way a teammate's would.

Now your notes, your team, and your AI all share one source of truth.

---

That's it. Delete these starter notes whenever you like — this is your space.
`;

/** True when a vault has no notes and no folders (a brand-new, empty vault). */
export function vaultIsEmpty(tree: TreeNode): boolean {
  return (tree.children ?? []).length === 0;
}

/**
 * Write the first-run starter content into an (assumed empty) vault. Returns the
 * welcome note's vault-relative path so the caller can open it, or null if the
 * write failed (seeding is best-effort — a failure must never block vault open).
 */
export async function seedWelcomeContent(): Promise<string | null> {
  try {
    await ipc.writeNote(WELCOME_NOTE_PATH, WELCOME_BODY);
    await ipc.writeNote(GETTING_STARTED_NOTE_PATH, GETTING_STARTED_BODY);
    return WELCOME_NOTE_PATH;
  } catch (e) {
    console.warn("[seed] failed to write welcome content", e);
    return null;
  }
}
