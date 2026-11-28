import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { healForkedIds, planFold } from "../forkHeal";
import type { YjsState } from "../../ipcCodec";

const state = (doc: Y.Doc | null): YjsState =>
  doc ? { snapshot: Y.encodeStateAsUpdate(doc), updates: [], updateCount: 0 } : { snapshot: null, updates: [], updateCount: 0 };
const textOf = (...states: Array<YjsState | Uint8Array>) => {
  const d = new Y.Doc();
  for (const s of states) {
    if (s instanceof Uint8Array) Y.applyUpdate(d, s);
    else { if (s.snapshot) Y.applyUpdate(d, s.snapshot); for (const u of s.updates) Y.applyUpdate(d, u); }
  }
  return d.getText("content").toString();
};
function serverDoc(text: string): Y.Doc {
  const d = new Y.Doc();
  d.getText("content").insert(0, text);
  return d;
}
function fork(of: Y.Doc): Y.Doc {
  const d = new Y.Doc();
  Y.applyUpdate(d, Y.encodeStateAsUpdate(of));
  return d;
}

describe("planFold", () => {
  it("nothing under the fresh id: nothing to keep", () => {
    expect(planFold(state(serverDoc("a")), state(null))).toEqual({ kind: "none" });
  });
  it("the fresh log is the same history: nothing to keep", () => {
    const s = serverDoc("team text");
    expect(planFold(state(s), state(fork(s)))).toEqual({ kind: "none" });
  });
  it("unsent edits under the fresh id on the same history are kept, once", () => {
    const s = serverDoc("team text");
    const f = fork(s);
    f.getText("content").insert(9, " + mine");
    const plan = planFold(state(s), state(f));
    expect(plan.kind).toBe("fold");
    if (plan.kind === "fold") expect(textOf(state(s), plan.update)).toBe("team text + mine");
  });
  it("edits on both sides of one history merge", () => {
    const s = serverDoc("ab");
    const f = fork(s);
    f.getText("content").insert(2, "F");
    s.getText("content").insert(0, "S");
    const plan = planFold(state(s), state(f));
    expect(plan.kind).toBe("fold");
    if (plan.kind === "fold") expect(textOf(state(s), plan.update)).toBe("SabF");
  });
  it("two separate seeds of one file are never merged (that doubles the note)", () => {
    expect(planFold(state(serverDoc("same words")), state(serverDoc("same words")))).toEqual({ kind: "refuse" });
  });
  it("no real history: kept only when it grew from what the server acknowledged", () => {
    const s = serverDoc("team text");
    const f = fork(s);
    f.getText("content").insert(0, "x");
    expect(planFold(null, state(f), Y.encodeStateVector(s)).kind).toBe("fold");
    expect(planFold(null, state(serverDoc("other seed")), Y.encodeStateVector(s))).toEqual({ kind: "refuse" });
    expect(planFold(null, state(f), null)).toEqual({ kind: "refuse" });
  });
});

describe("healForkedIds", () => {
  it("re-keys a forked row, keeps its unsent edits under the real id, and leaves busy or matching rows alone", async () => {
    const s = serverDoc("team text");
    const f = fork(s);
    f.getText("content").insert(9, " + mine");
    const logs = new Map<string, YjsState>([["real", state(s)], ["fresh", state(f)], ["open-fresh", state(null)]]);
    const append = vi.fn(async (id: string, u: Uint8Array) => { logs.set(id, { ...logs.get(id)!, updates: [...logs.get(id)!.updates, u] }); });
    const heal = vi.fn(async () => true);
    const clear = vi.fn(async () => undefined);
    const svs = new Map<string, Uint8Array>();
    const n = await healForkedIds({
      stateVector: (id, sv) => svs.set(id, sv),
      titles: async () => [
        { id: "fresh", path: "a.md" },
        { id: "same", path: "b.md" },
        { id: "open-fresh", path: "c.md" },
        { id: "local-only", path: "d.md" },
      ],
      registeredId: (p) => ({ "a.md": "real", "b.md": "same", "c.md": "open-real" } as Record<string, string>)[p] ?? null,
      busy: (id) => id === "open-real",
      load: async (id) => logs.get(id) ?? state(null),
      acked: () => null,
      append,
      heal,
      clear,
    });
    expect(n).toEqual({ healed: 1, folded: ["real"] });
    expect(heal).toHaveBeenCalledTimes(1);
    expect(heal).toHaveBeenCalledWith("a.md", "real");
    expect(clear).toHaveBeenCalledWith("fresh");
    expect(textOf(logs.get("real")!)).toBe("team text + mine");
    // The manifest learns the real id now holds the fork's ops.
    expect(Y.decodeStateVector(svs.get("real")!)).toEqual(Y.decodeStateVector(Y.encodeStateVector(f)));
  });
  it("a refused merge changes nothing", async () => {
    const heal = vi.fn(async () => true);
    const n = await healForkedIds({
      titles: async () => [{ id: "fresh", path: "a.md" }],
      registeredId: () => "real",
      busy: () => false,
      load: async (id) => state(serverDoc(id === "real" ? "words" : "words")),
      acked: () => null,
      append: vi.fn(),
      heal,
      clear: vi.fn(),
    });
    expect(n).toEqual({ healed: 0, folded: [] });
    expect(heal).not.toHaveBeenCalled();
  });
});
