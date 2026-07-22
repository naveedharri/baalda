// Shared configuration + helpers for the "Test Organization" demo harness.
//
// Two scripts use this:
//   • seed-demo-org.ts     — builds the org, 15 members, vault, folders, notes.
//   • simulate-activity.ts — connects the 15 members live for a recording.
//
// Everything is env-overridable so you can retarget the source vault, scale the
// note count, or point at a remote server without editing code.

/** Read an env var with a default. */
function env(name: string, fallback: string): string {
  const v = process.env[name];
  return v == null || v === "" ? fallback : v;
}
function envInt(name: string, fallback: number): number {
  const v = process.env[name];
  const n = v == null || v === "" ? NaN : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export const demoConfig = {
  /** Root of the vault whose structure/content we mirror into the demo. */
  /** Source vault to mirror. Set DEMO_SOURCE_VAULT in your (git-ignored) .env. */
  sourceVaultPath: env("DEMO_SOURCE_VAULT", "./demo-source-vault"),
  orgName: env("DEMO_ORG_NAME", "Demo Vault"),
  orgSlug: env("DEMO_ORG_SLUG", "demo-vault"),
  vaultName: env("DEMO_VAULT_NAME", "Demo Vault"),
  emailDomain: env("DEMO_EMAIL_DOMAIN", "testorg.demo"),
  /** The owner account — this is YOU. Override with DEMO_OWNER_EMAIL /
   *  DEMO_OWNER_NAME in .env if you like. Log in as this (OAuth or
   *  email+password); the simulator skips it so you don't collide with your own
   *  presence. */
  ownerEmail: env("DEMO_OWNER_EMAIL", "naveedharri@gmail.com"),
  ownerName: env("DEMO_OWNER_NAME", "Naveed"),
  /** Shared login password for every demo member (≥ 8 chars for Better Auth). */
  password: env("DEMO_PASSWORD", "demopass1234"),
  /** Grow the tree to at least this many notes (real import + synthetic). */
  targetNotes: envInt("DEMO_TARGET_NOTES", 6000),
  /** Cap on how many real files to import (default: effectively all). */
  maxImport: envInt("DEMO_MAX_IMPORT", 1_000_000),
  /** Largest note body we import verbatim (bytes); longer files are trimmed. */
  maxNoteBytes: envInt("DEMO_MAX_NOTE_BYTES", 60_000),

  // ---- simulator ----
  /** WebSocket endpoint of the sync server (3011 dedicated, or /sync single-port).
   *  127.0.0.1 (not "localhost") to avoid IPv6/IPv4 resolution flakiness. */
  wsUrl: env("DEMO_WS_URL", "ws://127.0.0.1:3011"),
  /** Email of the account YOU log into the desktop app as; the simulator skips
   *  it so you don't fight your own presence. Defaults to the owner (you). */
  skipEmail: env("DEMO_SKIP_EMAIL", env("DEMO_OWNER_EMAIL", "naveedharri@gmail.com")),
  /** How many notes to keep "hot" (crowded with live teammates) for recording. */
  hotSetSize: envInt("DEMO_HOTSET", 48),
  /** How many live docs each member spreads across. */
  docsPerUser: envInt("DEMO_DOCS_PER_USER", 4),
};

/** The 15-person team. First name → email local-part (all unique). */
export interface TeamMember {
  name: string;
  email: string;
  role: "owner" | "admin" | "member";
}

/** Fold a name to a lowercase ascii email local-part (strips accents). */
function asciiLocal(s: string): string {
  // NFD splits accented letters into base + combining mark; the ascii filter
  // then drops the marks, so "Tomás" → "tomas", "Bergström" → "bergstrom".
  return s.toLowerCase().normalize("NFD").replace(/[^a-z0-9]+/g, "");
}

export function buildTeam(domain = demoConfig.emailDomain): TeamMember[] {
  // You are the owner (real email, OAuth login); 14 synthetic teammates fill out
  // the team and are driven live by the simulator.
  const owner: TeamMember = {
    name: demoConfig.ownerName,
    email: demoConfig.ownerEmail,
    role: "owner",
  };
  const teammates: Array<[string, "admin" | "member"]> = [
    ["Marcus Reed", "admin"],
    ["Priya Nair", "admin"],
    ["Diego Santos", "member"],
    ["Lena Kowalski", "member"],
    ["Tomás Rivera", "member"],
    ["Yuki Tanaka", "member"],
    ["Fatima Al-Sayed", "member"],
    ["Noah Bergström", "member"],
    ["Amara Okafor", "member"],
    ["Sofia Rossi", "member"],
    ["Kai Andersen", "member"],
    ["Hana Park", "member"],
    ["Oliver Grant", "member"],
    ["Zoe Martin", "member"],
  ];
  return [
    owner,
    ...teammates.map(([name, role]) => ({
      name,
      email: `${asciiLocal(name.split(" ")[0])}@${domain}`,
      role,
    })),
  ];
}

// ---- Presence colours: replicated from desktop lib/presence/color.ts so the
// simulator tints each teammate exactly as their profile ring / avatar does. ----

const PRESENCE_PALETTE = [
  "#6366f1", "#3b82f6", "#0ea5e9", "#06b6d4", "#14b8a6", "#10b981",
  "#22c55e", "#84cc16", "#a855f7", "#8b5cf6", "#d946ef", "#ec4899",
] as const;

/** 32-bit FNV-1a hash — must match the desktop implementation exactly. */
export function hashString(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export function colorForUser(userId: string): string {
  if (!userId) return PRESENCE_PALETTE[0];
  return PRESENCE_PALETTE[hashString(userId) % PRESENCE_PALETTE.length];
}

/** Run async tasks with a bounded concurrency (keeps the pg pool from starving). */
export async function pMapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await fn(items[i], i);
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, worker);
  await Promise.all(workers);
  return results;
}

/** Tiny stable PRNG (mulberry32) so a reseed lays content out the same way. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
