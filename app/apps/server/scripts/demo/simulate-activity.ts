// ============================================================================
//  DEMO ACTIVITY SIMULATOR — live teammates for a recording
//  Connects the demo org's members to the sync server as headless clients,
//  concentrates them on a "hot set" of notes, and drives:
//    • presence  — each connection publishes a `user` awareness field so the
//                  profile circles light up (coloured exactly like the app does)
//    • cursors   — a wandering `cursor` (Yjs relative position) so remote carets
//                  glide around, each labelled with the teammate's name/colour
//    • activity  — an `activity` line marker ("Editing line N")
//    • edits     — occasional transient typing on SAFE notes (Team Journal /
//                  index notes), inserted then removed so content is unchanged
//
//  Run:   npm run demo:activity          (after npm run seed:demo)
//         DEMO_FOCUS="Projects" npm run demo:activity   (crowd one area)
//         DEMO_SKIP_EMAIL="ava@testorg.demo" npm run demo:activity
//
//  Ctrl-C to stop (disconnects everyone cleanly).
// ============================================================================

import { HocuspocusProvider } from "@hocuspocus/provider";
import WebSocket from "ws";
import * as Y from "yjs";

import { pool, closePool } from "../../src/db/pool.js";
import { mintSyncToken } from "../../src/tokens/sync-token.js";
import { buildTeam, colorForUser, demoConfig, mulberry32 } from "./config.js";

const TOKEN_TTL = 12 * 60 * 60; // 12h so tokens outlast a long recording
const FOCUS = process.env.DEMO_FOCUS ?? "";
/** DEMO_SPREAD_ALL=1 → one teammate per file across ALL files (uneven), instead
 *  of crowding a hot set. Great with the small --quick vault. */
const SPREAD_ALL = process.env.DEMO_SPREAD_ALL === "1";
/** DEMO_CROWD=1 → put DEMO_CROWD_N (default 10) teammates on ONE file and have
 *  them collaboratively write + edit it in sequence (live typing you can watch). */
const CROWD = process.env.DEMO_CROWD === "1";
const CROWD_N = Number(process.env.DEMO_CROWD_N ?? "10");
const CROWD_FILE = process.env.DEMO_CROWD_FILE ?? "";

interface Member {
  id: string;
  name: string;
  email: string;
}
interface NoteRow {
  id: string;
  relPath: string;
}

/** One live teammate-on-a-note connection. */
interface Client {
  provider: HocuspocusProvider;
  doc: Y.Doc;
  member: Member;
  note: NoteRow;
  pos: number;
  timer: ReturnType<typeof setInterval> | null;
  rand: () => number;
  synced?: boolean;
}

const clients: Client[] = [];
let stopping = false;

function isSafeToEdit(relPath: string): boolean {
  return (
    relPath.startsWith("Team Journal/") ||
    relPath.endsWith("_Index.md") ||
    relPath === "_Vault Index.md"
  );
}

async function loadWorld(): Promise<{ vaultId: string; members: Member[]; notes: NoteRow[] }> {
  const org = await pool.query<{ id: string }>("SELECT id FROM organization WHERE slug = $1", [
    demoConfig.orgSlug,
  ]);
  const orgId = org.rows[0]?.id;
  if (!orgId) throw new Error(`No org "${demoConfig.orgSlug}". Run: npm run seed:demo`);

  const vault = await pool.query<{ id: string }>(
    "SELECT id FROM vaults WHERE organization_id = $1 ORDER BY created_at LIMIT 1",
    [orgId],
  );
  const vaultId = vault.rows[0]?.id;
  if (!vaultId) throw new Error("Org has no vault — reseed.");

  const mem = await pool.query<{ id: string; name: string; email: string }>(
    `SELECT u.id, u.name, u.email FROM member m
     JOIN "user" u ON u.id = m."userId"
     WHERE m."organizationId" = $1`,
    [orgId],
  );
  const members = mem.rows.filter((m) => m.email !== demoConfig.skipEmail);

  const noteRows = await pool.query<{ id: string; rel_path: string }>(
    "SELECT id, rel_path FROM notes WHERE vault_id = $1 AND deleted_at IS NULL",
    [vaultId],
  );
  const notes = noteRows.rows.map((r) => ({ id: r.id, relPath: r.rel_path }));
  return { vaultId, members, notes };
}

/** Choose the notes we crowd: focus filter if set, else nice showcase notes. */
function pickHotNotes(notes: NoteRow[], memberCount: number): NoteRow[] {
  const capacity = Math.max(2, Math.floor((memberCount * demoConfig.docsPerUser) / 2));
  const wanted = Math.min(demoConfig.hotSetSize, capacity);

  let pool_ = notes;
  if (FOCUS) pool_ = notes.filter((n) => n.relPath.includes(FOCUS));
  if (pool_.length === 0) pool_ = notes;

  // Rank: generated index/journal notes first (guaranteed content), then
  // shallow top-level notes (read nicely), then everything else.
  const score = (n: NoteRow): number => {
    if (n.relPath.endsWith("_Index.md") || n.relPath === "_Vault Index.md") return 0;
    if (n.relPath.startsWith("Team Journal/")) return 1;
    return 2 + n.relPath.split("/").length;
  };
  const ranked = [...pool_].sort((a, b) => score(a) - score(b) || a.relPath.localeCompare(b.relPath));
  return ranked.slice(0, wanted);
}

async function makeClient(
  vaultId: string,
  member: Member,
  note: NoteRow,
  seed: number,
  autoTick = true,
): Promise<void> {
  const doc = new Y.Doc();
  const name = `vault:${vaultId}/note:${note.id}`;
  const provider = new HocuspocusProvider({
    url: demoConfig.wsUrl,
    name,
    document: doc,
    token: async () => mintSyncToken({ docId: note.id, vaultId, readOnly: false }, TOKEN_TTL),
    onAuthenticationFailed: ({ reason }) =>
      console.warn(`   auth failed (${member.name} → ${note.relPath}): ${reason}`),
    // WebSocketPolyfill isn't in this version's config type; pass it via a
    // spread so it slips past the excess-property check (same trick the desktop
    // client uses). The provider forwards it to its internal websocket.
    ...({ WebSocketPolyfill: WebSocket } as object),
  });
  // A bare ws 'error' (transient reset, server restart) is emitted on the
  // socket's EventEmitter; without a listener Node would crash the whole run.
  (provider.configuration.websocketProvider as unknown as {
    on?: (e: string, f: (err: unknown) => void) => void;
  })?.on?.("error", () => {
    /* swallow — the provider will retry on its own backoff */
  });

  const client: Client = {
    provider,
    doc,
    member,
    note,
    pos: 0,
    timer: null,
    rand: mulberry32(seed),
  };
  clients.push(client);

  // Presence circle: publish the `user` field the moment we connect.
  provider.setAwarenessField("user", {
    id: member.id,
    name: member.name,
    color: colorForUser(member.id),
    status: "online",
  });

  provider.on("synced", () => {
    if (stopping) return;
    client.synced = true;
    if (!autoTick) return; // crowd/compose mode drives edits via the conductor
    client.pos = Math.floor(client.rand() * Math.max(1, doc.getText("content").length));
    client.timer = setInterval(() => tick(client), 1000 + Math.floor(client.rand() * 900));
  });
}

/** One animation step for a client: wander the caret, mark activity, maybe type. */
function tick(client: Client): void {
  if (stopping) return;
  const ytext = client.doc.getText("content");
  const len = ytext.length;
  if (len <= 0) return;

  // Wander: hop forward/back by up to ~48 chars, wrapping around the doc.
  const delta = Math.floor((client.rand() - 0.35) * 96);
  client.pos = ((client.pos + delta) % len + len) % len;
  const i = Math.min(client.pos, len);

  const anchor = Y.createRelativePositionFromTypeIndex(ytext, i);
  const head = Y.createRelativePositionFromTypeIndex(ytext, i);
  client.provider.setAwarenessField("cursor", { anchor, head });

  const line = ytext.toString().slice(0, i).split("\n").length;
  client.provider.setAwarenessField("activity", { line, at: Date.now() });

  // Occasional transient "typing" on safe notes only — inserted then removed so
  // the note's content is left exactly as seeded.
  if (isSafeToEdit(client.note.relPath) && client.rand() < 0.18) {
    const word = " ✍";
    ytext.insert(i, word);
    setTimeout(() => {
      if (stopping) return;
      const cur = client.doc.getText("content");
      if (i + word.length <= cur.length) cur.delete(i, word.length);
    }, 600);
  }
}

// ---- Crowd / live-compose mode: N teammates writing + editing one doc ----

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Set a collapsed caret at char index `i` in the doc's content text. */
function setCaret(client: Client, i: number): void {
  const ytext = client.doc.getText("content");
  const at = Math.max(0, Math.min(i, ytext.length));
  const anchor = Y.createRelativePositionFromTypeIndex(ytext, at);
  const head = Y.createRelativePositionFromTypeIndex(ytext, at);
  client.provider.setAwarenessField("cursor", { anchor, head });
  const line = ytext.toString().slice(0, at).split("\n").length;
  client.provider.setAwarenessField("activity", { line, at: Date.now() });
}

/** Type `text` character-by-character at `start`, advancing the caret so the
 *  keystrokes are visibly animated in the editor. */
async function typeAt(client: Client, start: number, text: string): Promise<void> {
  const ytext = client.doc.getText("content");
  let pos = Math.min(start, ytext.length);
  for (const ch of text) {
    if (stopping) return;
    ytext.insert(pos, ch);
    pos += 1;
    setCaret(client, pos);
    await sleep(38 + Math.floor(client.rand() * 55)); // ~40-90ms/keystroke
  }
}

const SENTENCES = [
  "Let's align on the top priority for this week.",
  "I pushed the draft — feedback welcome.",
  "One risk: the timeline is tight for QA.",
  "Agreed. I'll own the rollout checklist.",
  "Numbers look good, up 12% week over week.",
  "Can we move the review to Thursday?",
  "Adding a note here for visibility.",
  "Blocked on the API key — following up now.",
  "Ship it once the tests are green.",
  "Great work everyone, momentum is strong.",
];
const REPLACEMENTS = ["updated", "revised", "clarified", "confirmed", "adjusted", "refined"];

/**
 * The conductor: teammates take turns editing one shared doc IN SEQUENCE —
 * mostly appending a sentence (typed live), occasionally editing an existing
 * word — so you watch real collaborative writing and changes, not just cursors.
 */
async function runCompose(crowd: Client[]): Promise<void> {
  // Wait until everyone has synced the doc.
  for (let i = 0; i < 40 && crowd.some((c) => !c.synced); i++) await sleep(150);
  let turn = 0;
  while (!stopping) {
    const client = crowd[turn % crowd.length];
    const ytext = client.doc.getText("content");
    const text = ytext.toString();
    // ~30% of the time make a CHANGE to existing text; otherwise write new.
    const words = [...text.matchAll(/\b[A-Za-z]{4,}\b/g)];
    if (words.length > 6 && client.rand() < 0.3) {
      const w = words[Math.floor(client.rand() * words.length)];
      const start = w.index ?? 0;
      setCaret(client, start);
      await sleep(250);
      ytext.delete(start, w[0].length); // "select + delete"
      await sleep(120);
      await typeAt(client, start, REPLACEMENTS[Math.floor(client.rand() * REPLACEMENTS.length)]);
    } else {
      const sentence = `\n${client.member.name.split(" ")[0]}: ${
        SENTENCES[Math.floor(client.rand() * SENTENCES.length)]
      }`;
      await typeAt(client, ytext.length, sentence);
    }
    turn += 1;
    await sleep(500 + Math.floor(client.rand() * 700)); // brief hand-off pause
  }
}

async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  console.log("\n👋  Disconnecting teammates…");
  for (const c of clients) {
    if (c.timer) clearInterval(c.timer);
    try {
      c.provider.destroy();
    } catch {
      /* ignore */
    }
    c.doc.destroy();
  }
  await closePool().catch(() => {});
  process.exit(0);
}

async function main(): Promise<void> {
  const { vaultId, members, notes } = await loadWorld();
  if (members.length === 0) throw new Error("No members to simulate (all skipped?).");

  // ---- Crowd mode: N teammates collaboratively write one file, in sequence ----
  if (CROWD) {
    const target =
      (CROWD_FILE ? notes.find((n) => n.relPath.includes(CROWD_FILE)) : undefined) ?? notes[0];
    const n = Math.min(CROWD_N, members.length);
    const crowd = members.slice(0, n);
    console.log(`\n🎬  ${n} teammates writing "${target.relPath}" together, live:\n`);
    crowd.forEach((m) => console.log(`   • ${m.name}`));
    let s = 1;
    for (const member of crowd) {
      if (stopping) break;
      await makeClient(vaultId, member, target, s++, /*autoTick*/ false);
      await sleep(60);
    }
    console.log(`\n🎥  Open "${target.relPath}" on camera — watch them type & edit it.`);
    console.log("\n   (Ctrl-C to stop.)\n");
    void runCompose(clients.filter((c) => c.note.id === target.id));
    return;
  }

  const opens: Array<{ member: Member; note: NoteRow }> = [];
  if (SPREAD_ALL) {
    // Spread everyone across ALL files, unevenly: give each note one teammate
    // first (so every file is covered when members ≥ files), then scatter the
    // remaining teammates at random so some files end up busier than others.
    const shuffledNotes = [...notes].sort(() => Math.random() - 0.5);
    members.forEach((member, k) => {
      const note =
        k < shuffledNotes.length
          ? shuffledNotes[k]
          : notes[Math.floor(Math.random() * notes.length)];
      opens.push({ member, note });
    });
    const counts = new Map<string, number>();
    for (const o of opens) counts.set(o.note.relPath, (counts.get(o.note.relPath) ?? 0) + 1);
    console.log(
      `\n🎬  Spreading ${members.length} teammates unevenly across ${counts.size}/${notes.length} files:\n`,
    );
    for (const [rel, c] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`   ${String(c).padStart(2)}×  ${rel}`);
    }
  } else {
    const hot = pickHotNotes(notes, members.length);
    console.log(
      `\n🎬  Simulating ${members.length} teammates across ${hot.length} hot notes ` +
        `(${members.length * demoConfig.docsPerUser} live connections)`,
    );
    if (FOCUS) console.log(`   focus filter: rel_path contains "${FOCUS}"`);
    members.forEach((member, k) => {
      for (let j = 0; j < demoConfig.docsPerUser; j++) {
        opens.push({ member, note: hot[(k * demoConfig.docsPerUser + j) % hot.length] });
      }
    });
    console.log("\n🎥  Open any of these files on camera to see live teammates:\n");
    for (const n of hot.slice(0, 20)) console.log(`   • ${n.relPath}`);
    if (hot.length > 20) console.log(`   … and ${hot.length - 20} more`);
  }

  // Open connections with a small stagger to avoid a thundering herd.
  let seed = 1;
  for (const { member, note } of opens) {
    if (stopping) break;
    await makeClient(vaultId, member, note, seed++);
    await new Promise((r) => setTimeout(r, 40));
  }

  console.log("\n   (Ctrl-C to stop.)\n");
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
// Backstop: a stray socket error/rejection should never tear down the demo.
process.on("uncaughtException", (e) => console.warn("   (ignored)", (e as Error)?.message));
process.on("unhandledRejection", (e) => console.warn("   (ignored)", (e as Error)?.message));

main().catch(async (err) => {
  console.error("\n❌  Simulator failed:\n", err);
  await closePool().catch(() => {});
  process.exit(1);
});
