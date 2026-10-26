import { describe, expect, it } from "vitest";
import {
  conflictKey,
  forceInstallSkill,
  replaceUnmanagedSkill,
  pendingStates,
  planSkillsSync,
  runSkillsPlan,
  runToasts,
  type SkillsPlan,
  type SkillsRunDeps,
} from "../syncEngine";
import { defaultSkillsPrefs, keepMineKey, optInKey, type SkillsDevicePrefs } from "../prefs";
import type { ManifestOrg, ManifestSkill, SkillsManifest } from "../types";

const SERVER = "https://api.test";
const ME = "u-me";

const skill = (id: string, name: string, over: Partial<ManifestSkill> = {}): ManifestSkill => ({
  skillId: id, name, description: "d", delivery: "required", version: 1, bundleSha256: "h1", files: [], source: null, ...over,
});
const org = (id: string, name: string, skills: ManifestSkill[], over: Partial<ManifestOrg> = {}): ManifestOrg => ({
  orgId: id, orgName: name, orgSlug: id, role: "member", skills, ...over,
});
const manifest = (...orgs: ManifestOrg[]): SkillsManifest => ({ serverTime: "t", orgs });

const marker = (skillId: string, orgId: string, over: Record<string, unknown> = {}) => ({
  skillId, orgId, serverUrl: SERVER, name: "x", version: 1, bundleSha256: "h1", files: {}, ...over,
});
const inst = (name: string, m: ReturnType<typeof marker> | null, status = "managed") => ({
  name, status, marker: m, editedFiles: [],
});
const T = (target: string) => ({ target, root: "/r", rootExists: true, toolInstalled: true, detectedTools: [] });

interface Opts {
  manifest?: SkillsManifest | null;
  prefs?: SkillsDevicePrefs;
  targets?: string[];
  claude?: unknown[];
  agents?: unknown[];
  serverUrl?: string;
  userId?: string;
  knownConflicts?: Map<string, "unmanaged" | "other_owner">;
}
function plan(o: Opts): SkillsPlan {
  return planSkillsSync({
    serverUrl: o.serverUrl ?? SERVER,
    userId: o.userId ?? ME,
    manifest: o.manifest === undefined ? null : o.manifest,
    prefs: o.prefs ?? defaultSkillsPrefs(),
    targets: (o.targets ?? ["claude", "agents"]).map(T),
    installed: { claude: o.claude ?? [], agents: o.agents ?? [] },
    knownConflicts: o.knownConflicts,
  } as never);
}
const kinds = (p: SkillsPlan) => p.map((a) => a.kind);

describe("planSkillsSync: wanted", () => {
  it("manifest null gives an empty plan", () => {
    expect(plan({ manifest: null, claude: [inst("a", marker("s", "o"))] })).toEqual([]);
  });

  it("required skill installs on both targets", () => {
    const p = plan({ manifest: manifest(org("o", "O", [skill("s", "a")])) });
    expect(p).toHaveLength(2);
    expect(p.every((a) => a.kind === "install" && a.fromVersion === null)).toBe(true);
  });

  it("optional installs only when opted in", () => {
    const m = manifest(org("o", "O", [skill("s", "a", { delivery: "optional" })]));
    expect(plan({ manifest: m, targets: ["claude"] })).toEqual([]);
    const prefs = defaultSkillsPrefs();
    prefs.optIns[`${SERVER}|o|s`] = true;
    expect(optInKey(SERVER, "o", "s")).toBe(`${SERVER}|o|s`);
    expect(kinds(plan({ manifest: m, prefs, targets: ["claude"] }))).toEqual(["install"]);
  });

  it("a target missing from targets is skipped", () => {
    const p = plan({ manifest: manifest(org("o", "O", [skill("s", "a")])), targets: ["agents"] });
    expect(p).toHaveLength(1);
    expect(p[0]).toMatchObject({ kind: "install", target: "agents" });
  });
});

describe("planSkillsSync: removals", () => {
  const m = () => manifest(org("o", "O", [skill("s", "a")]));

  it("target off removes our copy with targetOff", () => {
    const prefs = defaultSkillsPrefs();
    prefs.targets.claude = false;
    const p = plan({ manifest: m(), prefs, claude: [inst("a", marker("s", "o"))], agents: [inst("a", marker("s", "o"))] });
    expect(p).toContainEqual({
      kind: "remove", target: "claude", name: "a", reason: "targetOff", mode: "delete",
      owner: { skillId: "s", orgId: "o", serverUrl: SERVER, userId: ME },
    });
    expect(p.some((a) => a.kind === "install" && a.target === "claude")).toBe(false);
  });


  it("deleted skill", () => {
    const p = plan({ manifest: manifest(org("o", "O", [])), targets: ["claude"], claude: [inst("a", marker("s", "o"))] });
    expect(p).toMatchObject([{ kind: "remove", reason: "deleted" }]);
  });

  it("optional opted out", () => {
    const mm = manifest(org("o", "O", [skill("s", "a", { delivery: "optional" })]));
    const p = plan({ manifest: mm, targets: ["claude"], claude: [inst("a", marker("s", "o"))] });
    expect(p).toMatchObject([{ kind: "remove", reason: "optedOut" }]);
  });

  it("lost membership", () => {
    const p = plan({ manifest: manifest(org("other", "X", [])), targets: ["claude"], claude: [inst("a", marker("s", "o"))] });
    expect(p).toMatchObject([{ kind: "remove", reason: "lostMembership" }]);
  });

  it("removals come before installs", () => {
    const mm = manifest(org("o", "O", [skill("s2", "b")]));
    const p = plan({ manifest: mm, targets: ["claude"], claude: [inst("a", marker("s", "o"))] });
    expect(kinds(p)).toEqual(["remove", "install"]);
  });
});

describe("planSkillsSync: installed copies", () => {
  const m = (over: Partial<ManifestSkill> = {}) => manifest(org("o", "O", [skill("s", "a", over)]));

  it("version bump installs with fromVersion", () => {
    const p = plan({ manifest: m({ version: 3 }), targets: ["claude"], claude: [inst("a", marker("s", "o", { version: 2 }))] });
    expect(p).toMatchObject([{ kind: "install", fromVersion: 2 }]);
  });

  it("same version but different hash installs", () => {
    const p = plan({ manifest: m({ bundleSha256: "new" }), targets: ["claude"], claude: [inst("a", marker("s", "o"))] });
    expect(p).toMatchObject([{ kind: "install", fromVersion: 1 }]);
  });

  it("up to date", () => {
    const p = plan({ manifest: m(), targets: ["claude"], claude: [inst("a", marker("s", "o"))] });
    expect(p).toMatchObject([{ kind: "status", status: "upToDate" }]);
  });

  it("edited, and keptMine with the key", () => {
    const e = inst("a", marker("s", "o"), "edited");
    expect(plan({ manifest: m({ version: 2 }), targets: ["claude"], claude: [e] })).toMatchObject([
      { kind: "status", status: "edited" },
    ]);
    const prefs = defaultSkillsPrefs();
    prefs.keepMine[`${SERVER}|o|s|claude`] = true;
    expect(keepMineKey(SERVER, "o", "s", "claude")).toBe(`${SERVER}|o|s|claude`);
    expect(plan({ manifest: m({ version: 2 }), prefs, targets: ["claude"], claude: [e] })).toMatchObject([
      { kind: "status", status: "keptMine" },
    ]);
  });

  it("unmanaged folder with the wanted name is offered to Rust once (adopt or conflict)", () => {
    const p = plan({ manifest: m(), targets: ["claude"], claude: [inst("a", null, "unmanaged")] });
    expect(p).toMatchObject([{ kind: "install", target: "claude", fromVersion: null }]);
  });

  it("an unmanaged folder that refused this version stays a conflict without re-asking", () => {
    const known = new Map([[conflictKey("claude", skill("s", "a")), "unmanaged" as const]]);
    const p = plan({ manifest: m(), targets: ["claude"], claude: [inst("a", null, "unmanaged")], knownConflicts: known });
    expect(p).toMatchObject([{ kind: "status", status: "conflict", conflict: "unmanaged" }]);
    // A new version is a new question.
    const next = manifest(org("o", "O", [skill("s", "a", { version: 2, bundleSha256: "h2" })]));
    expect(plan({ manifest: next, targets: ["claude"], claude: [inst("a", null, "unmanaged")], knownConflicts: known }))
      .toMatchObject([{ kind: "install" }]);
  });

  it("Keep my own leaves an unmanaged folder alone", () => {
    const prefs = defaultSkillsPrefs();
    prefs.keepMine[keepMineKey(SERVER, "o", "s", "claude")] = true;
    const p = plan({ manifest: m(), prefs, targets: ["claude"], claude: [inst("a", null, "unmanaged")] });
    expect(p).toMatchObject([{ kind: "status", status: "keptMine" }]);
  });
});

describe("planSkillsSync: servers", () => {
  const m = manifest(org("o", "O", [skill("s", "a")]));

  it("another server's marker is never removed when unwanted", () => {
    const p = plan({
      manifest: manifest(org("o", "O", [])), targets: ["claude"],
      claude: [inst("a", marker("s", "o", { serverUrl: "https://other" }))],
    });
    expect(p).toEqual([]);
  });

  it("another server's marker is a conflict when the name is wanted", () => {
    const p = plan({ manifest: m, targets: ["claude"], claude: [inst("a", marker("s", "o", { serverUrl: "https://other" }))] });
    expect(p).toMatchObject([{ kind: "status", status: "conflict", conflict: "other_owner" }]);
  });

  it("trailing slash is the same server", () => {
    const p = plan({ manifest: m, targets: ["claude"], serverUrl: `${SERVER}/`, claude: [inst("a", marker("s", "o"))] });
    expect(p).toMatchObject([{ kind: "status", status: "upToDate" }]);
  });
});

describe("planSkillsSync: cross-org collisions", () => {
  const m = manifest(org("ob", "Beta", [skill("sb", "deploy")]), org("oa", "Alpha", [skill("sa", "deploy")]));

  it("alphabetical orgName wins when nobody holds the folder", () => {
    const p = plan({ manifest: m, targets: ["claude"] });
    expect(p).toContainEqual(expect.objectContaining({ kind: "install", orgId: "oa" }));
    expect(p).toContainEqual(expect.objectContaining({ kind: "status", orgId: "ob", status: "conflict" }));
    expect(p).toHaveLength(2);
  });

  it("the org whose marker holds the folder wins even if later", () => {
    const p = plan({ manifest: m, targets: ["claude"], claude: [inst("deploy", marker("sb", "ob"))] });
    expect(p).toContainEqual(expect.objectContaining({ kind: "status", orgId: "ob", status: "upToDate" }));
    expect(p).toContainEqual(expect.objectContaining({ kind: "status", orgId: "oa", status: "conflict" }));
    expect(p.some((a) => a.kind === "install" || a.kind === "remove")).toBe(false);
  });
});

// ---- runner ----

interface Calls {
  fetch: string[];
  install: { target: string; name: string; marker: any; files: any[]; force: boolean }[];
  remove: { target: string; name: string; mode: string }[];
}
function deps(over: Partial<Record<"install" | "remove" | "fetch", any>> = {}) {
  const calls: Calls = { fetch: [], install: [], remove: [] };
  const d: SkillsRunDeps = {
    serverUrl: `${SERVER}/`,
    userId: ME,
    fetchVersion: over.fetch ?? (async (orgId: string, skillId: string, version: number) => {
      calls.fetch.push(`${orgId}|${skillId}|${version}`);
      return { version, files: [{ path: "SKILL.md", sha256: "fs", contentBase64: "QQ==", executable: false, size: 1 }] } as never;
    }),
    install: over.install ?? (async (target: string, name: string, m: any, files: any[], force: boolean) => {
      calls.install.push({ target, name, marker: m, files, force });
      return { status: "installed", backupPath: null, detail: null };
    }),
    remove: over.remove ?? (async (target: string, name: string, _owner: unknown, mode: string) => {
      calls.remove.push({ target, name, mode });
      return { status: "removed", backupPath: "/bk" };
    }),
  } as never;
  return { d, calls };
}
const installAction = (target: string, s: ManifestSkill, fromVersion: number | null = null) =>
  ({ kind: "install", target, orgId: "o", skill: s, fromVersion }) as never;

describe("runSkillsPlan", () => {
  it("fetches once per version, builds the marker, installs with force=false", async () => {
    const s = skill("s", "a", { version: 4, bundleSha256: "bh" });
    const { d, calls } = deps();
    await runSkillsPlan([installAction("claude", s), installAction("agents", s)], d);
    expect(calls.fetch).toEqual(["o|s|4"]);
    expect(calls.install).toHaveLength(2);
    expect(calls.install[0].force).toBe(false);
    expect(calls.install[0].marker).toEqual({
      skillId: "s", orgId: "o", serverUrl: SERVER, userId: ME, name: "a", version: 4, bundleSha256: "bh", files: { "SKILL.md": "fs" },
    });
  });

  it("dedupes updated across targets and reports it in toasts", async () => {
    const s = skill("s", "a", { version: 2 });
    const { d } = deps();
    const r = await runSkillsPlan([installAction("claude", s, 1), installAction("agents", s, 1)], d);
    expect(r.updated).toEqual([{ skillId: "s", name: "a", from: 1, to: 2, codex: true }]);
    // It reached ~/.agents/skills: Codex needs a new chat to list it.
    expect(runToasts(r)).toEqual(["Updated /a v1 → v2. Start a new Codex chat to see it"]);
  });

  it("adds the Codex hint only when the agents folder got the skill", async () => {
    const { d } = deps();
    const viaAgents = await runSkillsPlan([installAction("agents", skill("s", "a"))], d);
    expect(runToasts(viaAgents)).toEqual(["Added /a v1. Start a new Codex chat to see it"]);
  });

  it("added: single and several", async () => {
    const { d } = deps();
    const one = await runSkillsPlan([installAction("claude", skill("s", "a"))], d);
    expect(runToasts(one)).toEqual(["Added /a v1"]);
    const three = await runSkillsPlan(
      [installAction("claude", skill("s1", "a")), installAction("claude", skill("s2", "b")), installAction("claude", skill("s3", "c"))],
      d,
    );
    expect(runToasts(three)).toEqual(["Added 3 team skills"]);
  });

  it("install failure is recorded and does not stop other actions", async () => {
    let n = 0;
    const { d } = deps({
      install: async () => {
        if (n++ === 0) throw new Error("boom");
        return { status: "installed", backupPath: null, detail: null };
      },
    });
    const r = await runSkillsPlan([installAction("claude", skill("s1", "a")), installAction("claude", skill("s2", "b"))], d);
    expect(r.results[0]).toMatchObject({ state: "failed", error: "boom" });
    expect(r.results[1].state).toBe("upToDate");
    expect(r.errors).toEqual(["a: boom"]);
  });

  it("remove notFound is not listed in removed", async () => {
    const { d } = deps({ remove: async () => ({ status: "notFound", backupPath: null }) });
    const owner = { skillId: "s", orgId: "o", serverUrl: SERVER, userId: ME };
    const r = await runSkillsPlan([{ kind: "remove", target: "claude", name: "a", owner, reason: "deleted", mode: "delete" }], d);
    expect(r.removed).toEqual([]);
    const ok = deps();
    const r2 = await runSkillsPlan([{ kind: "remove", target: "claude", name: "a", owner, reason: "deleted", mode: "delete" }], ok.d);
    expect(r2.removed).toEqual([{ target: "claude", name: "a", reason: "deleted", mode: "delete", backupPath: "/bk" }]);
  });
});

describe("forceInstallSkill and pendingStates", () => {
  it("passes force=true", async () => {
    const { d, calls } = deps();
    await forceInstallSkill(d, "claude", "o", skill("s", "a"));
    expect(calls.install[0].force).toBe(true);
  });

  it("replaceUnmanagedSkill passes replaceUnmanaged=true, not force", async () => {
    const seen: unknown[][] = [];
    const { d } = deps({
      install: async (...args: unknown[]) => {
        seen.push(args);
        return { status: "installed", backupPath: "/bk", detail: null };
      },
    });
    const r = await replaceUnmanagedSkill(d, "claude", "o", skill("s", "a"));
    expect(seen[0][4]).toBe(false);
    expect(seen[0][5]).toBe(true);
    expect(r.backupPath).toBe("/bk");
  });

  it("a refused install carries Rust's conflict kind", async () => {
    const own = deps({ install: async () => ({ status: "conflict", backupPath: null, detail: "unmanaged" }) });
    expect((await runSkillsPlan([installAction("claude", skill("s", "a"))], own.d)).results)
      .toMatchObject([{ state: "conflict", conflict: "unmanaged" }]);
    const other = deps({ install: async () => ({ status: "conflict", backupPath: null, detail: "other_owner" }) });
    expect((await runSkillsPlan([installAction("claude", skill("s", "a"))], other.d)).results)
      .toMatchObject([{ state: "conflict", conflict: "other_owner" }]);
  });

  it("an adopted folder is up to date with no toast", async () => {
    const { d } = deps({ install: async () => ({ status: "adopted", backupPath: null, detail: null }) });
    const r = await runSkillsPlan([installAction("claude", skill("s", "a"))], d);
    expect(r.results).toMatchObject([{ state: "upToDate" }]);
    expect(runToasts(r)).toEqual([]);
  });

  it("pendingStates shows installs as updating", () => {
    const s = skill("s", "a", { version: 2 });
    const p = pendingStates([
      installAction("claude", s, 1),
      { kind: "status", target: "agents", orgId: "o", skillId: "s", name: "a", status: "edited" } as never,
    ]);
    expect(p[0]).toMatchObject({ state: "updating", fromVersion: 1, version: 2 });
    expect(p[1]).toMatchObject({ state: "edited", target: "agents" });
  });
});

describe("planSkillsSync: accounts", () => {
  const m = manifest(org("o", "O", [skill("s", "a")]));
  const theirs = (over: Record<string, unknown> = {}) => marker("s", "o", { userId: "u-other", ...over });

  it("another user's copy is never removed, even when nothing wants it", () => {
    for (const mm of [manifest(org("o", "O", [])), manifest(org("x", "X", []))]) {
      expect(plan({ manifest: mm, targets: ["claude"], claude: [inst("a", theirs())] })).toEqual([]);
    }
    const prefs = defaultSkillsPrefs();
    prefs.targets.claude = false;
    expect(plan({ manifest: m, prefs, targets: ["claude"], claude: [inst("a", theirs())] })).toEqual([]);
  });

  it("another user's copy with a wanted name is a conflict, never overwritten", () => {
    const outdated = inst("a", theirs({ version: 0 }));
    const p = plan({ manifest: m, targets: ["claude"], claude: [outdated] });
    expect(p).toEqual([
      { kind: "status", target: "claude", orgId: "o", skillId: "s", name: "a", status: "conflict", conflict: "other_owner" },
    ]);
  });

  it("another user's holder does not win a cross-org name clash", () => {
    const mm = manifest(org("ob", "Beta", [skill("sb", "deploy")]), org("oa", "Alpha", [skill("sa", "deploy")]));
    const p = plan({ manifest: mm, targets: ["claude"], claude: [inst("deploy", marker("sb", "ob", { userId: "u-other" }))] });
    expect(p).toContainEqual(expect.objectContaining({ kind: "status", orgId: "oa", status: "conflict" }));
    expect(p).toContainEqual(expect.objectContaining({ kind: "status", orgId: "ob", status: "conflict" }));
    expect(p.some((a) => a.kind === "install" || a.kind === "remove")).toBe(false);
  });

  it("our own userId and a marker without one are both ours", () => {
    for (const mk of [marker("s", "o", { userId: ME }), marker("s", "o"), marker("s", "o", { userId: null })]) {
      expect(plan({ manifest: m, targets: ["claude"], claude: [inst("a", mk)] })).toMatchObject([
        { kind: "status", status: "upToDate" },
      ]);
      expect(plan({ manifest: manifest(org("o", "O", [])), targets: ["claude"], claude: [inst("a", mk)] })).toMatchObject([
        { kind: "remove", reason: "deleted", mode: "delete" },
      ]);
    }
  });
});

describe("planSkillsSync: remove owner", () => {
  it("names the signed-in user, also for a legacy marker without one", () => {
    for (const mk of [marker("s", "o"), marker("s", "o", { userId: ME })]) {
      const p = plan({ manifest: manifest(org("o", "O", [])), targets: ["claude"], claude: [inst("a", mk)] });
      expect(p).toMatchObject([{ kind: "remove", owner: { skillId: "s", orgId: "o", serverUrl: SERVER, userId: ME } }]);
    }
  });
});

describe("planSkillsSync: release instead of delete", () => {
  const prefsWith = (f: (p: SkillsDevicePrefs) => void) => {
    const p = defaultSkillsPrefs();
    f(p);
    return p;
  };
  const cases: { why: string; reason: string; manifest: SkillsManifest; prefs?: SkillsDevicePrefs }[] = [
    { why: "team deleted it", reason: "deleted", manifest: manifest(org("o", "O", [])) },
    { why: "lost access", reason: "lostMembership", manifest: manifest(org("x", "X", [])) },
    { why: "opted out", reason: "optedOut", manifest: manifest(org("o", "O", [skill("s", "a", { delivery: "optional" })])) },
    {
      why: "target off", reason: "targetOff", manifest: manifest(org("o", "O", [skill("s", "a")])),
      prefs: prefsWith((p) => { p.targets.claude = false; }),
    },
  ];

  for (const c of cases) {
    it(`${c.why}: an edited copy is released, a clean one deleted`, () => {
      const edited = plan({ manifest: c.manifest, prefs: c.prefs, targets: ["claude"], claude: [inst("a", marker("s", "o"), "edited")] });
      expect(edited).toMatchObject([{ kind: "remove", reason: c.reason, mode: "release" }]);
      const clean = plan({ manifest: c.manifest, prefs: c.prefs, targets: ["claude"], claude: [inst("a", marker("s", "o"))] });
      expect(clean).toMatchObject([{ kind: "remove", reason: c.reason, mode: "delete" }]);
    });
  }

  it("a kept-mine copy is released even when its files match", () => {
    const prefs = prefsWith((p) => { p.keepMine[keepMineKey(SERVER, "o", "s", "claude")] = true; });
    const p = plan({ manifest: manifest(org("o", "O", [])), prefs, targets: ["claude"], claude: [inst("a", marker("s", "o"))] });
    expect(p).toMatchObject([{ kind: "remove", reason: "deleted", mode: "release" }]);
  });

  it("keep-mine for the other target does not release this one", () => {
    const prefs = prefsWith((p) => { p.keepMine[keepMineKey(SERVER, "o", "s", "agents")] = true; });
    const p = plan({ manifest: manifest(org("o", "O", [])), prefs, targets: ["claude"], claude: [inst("a", marker("s", "o"))] });
    expect(p).toMatchObject([{ kind: "remove", mode: "delete" }]);
  });
});

describe("runSkillsPlan: release and stop", () => {
  const owner = { skillId: "s", orgId: "o", serverUrl: SERVER, userId: ME };

  it("passes the mode to remove and lists a released copy", async () => {
    const { d, calls } = deps({
      remove: async (target: string, name: string, _o: unknown, mode: string) => {
        calls.remove.push({ target, name, mode });
        return { status: "released", backupPath: null };
      },
    });
    const r = await runSkillsPlan([{ kind: "remove", target: "claude", name: "a", owner, reason: "optedOut", mode: "release" }], d);
    expect(calls.remove).toEqual([{ target: "claude", name: "a", mode: "release" }]);
    expect(r.removed).toEqual([{ target: "claude", name: "a", reason: "optedOut", mode: "release", backupPath: null }]);
  });

  it("stops between actions once shouldStop says so", async () => {
    let stop = false;
    const { d, calls } = deps();
    d.shouldStop = () => stop;
    const install = d.install;
    d.install = async (...args) => {
      stop = true; // e.g. a server switch lands mid-run
      return install(...args);
    };
    const r = await runSkillsPlan(
      [
        installAction("claude", skill("s1", "a")),
        { kind: "remove", target: "claude", name: "b", owner, reason: "deleted", mode: "delete" },
        installAction("claude", skill("s2", "c")),
      ],
      d,
    );
    expect(calls.install.map((c) => c.name)).toEqual(["a"]);
    expect(calls.remove).toEqual([]);
    expect(r.results).toHaveLength(1);
  });

  it("does nothing when already stopped", async () => {
    const { d, calls } = deps();
    d.shouldStop = () => true;
    await runSkillsPlan([installAction("claude", skill("s", "a"))], d);
    expect(calls.fetch).toEqual([]);
    expect(calls.install).toEqual([]);
  });
});
