import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { VaultDocStore } from "../sync/vaultDocStore";
import { makeHarness } from "../bridge/__tests__/helpers";

// Phase D tiering (spec 05 §3.4): hot docs apply-in-place + egest via their
// resident bridge; cold docs apply-transiently-and-evict. Uses the bridge's
// in-memory FS + persistence fakes — no Tauri, no network.

/** A Yjs update that sets a fresh doc's content to `text`. */
function updateSetting(text: string): Uint8Array {
  const src = new Y.Doc();
  src.getText("content").insert(0, text);
  const u = Y.encodeStateAsUpdate(src);
  src.destroy();
  return u;
}

describe("VaultDocStore", () => {
  it("cold-applies an update: writes the .md, persists, caches the state vector", async () => {
    const { io, fs, persistence } = makeHarness({ "note.md": "" });
    const store = new VaultDocStore({
      io,
      resolvePath: (id) => (id === "d1" ? "note.md" : null),
    });

    await store.applyUpdate("d1", updateSetting("hello world"));

    expect(fs.get("note.md")).toBe("hello world"); // egested to disk
    expect(persistence.logLength("d1")).toBeGreaterThan(0); // persisted
    expect(store.knownDocs()).toContain("d1"); // SV cached
    expect(store.hotBridge("d1")).toBeNull(); // evicted, not resident
  });

  it("hot-applies through a resident bridge that egests on flush", async () => {
    const { io, fs } = makeHarness({ "n2.md": "" });
    const store = new VaultDocStore({ io, resolvePath: () => "n2.md" });

    await store.promote("d2", "n2.md");
    await store.applyUpdate("d2", updateSetting("resident edit"));
    await store.hotBridge("d2")!.flushEgest();

    expect(fs.get("n2.md")).toBe("resident edit");
  });

  it("cold apply is cumulative across updates for the same doc", async () => {
    const { io, fs } = makeHarness({ "c.md": "" });
    const store = new VaultDocStore({ io, resolvePath: () => "c.md" });

    // Build two sequential updates on a shared source doc.
    const src = new Y.Doc();
    src.getText("content").insert(0, "one");
    const u1 = Y.encodeStateAsUpdate(src);
    const sv1 = Y.encodeStateVector(src);
    src.getText("content").insert(3, " two");
    const u2 = Y.encodeStateAsUpdate(src, sv1); // delta after "one"
    src.destroy();

    await store.applyUpdate("c1", u1);
    await store.applyUpdate("c1", u2);

    expect(fs.get("c.md")).toBe("one two");
  });

  it("evicts the LRU doc past the hot cap but keeps its manifest entry", async () => {
    const { io } = makeHarness({ "a.md": "", "b.md": "", "c.md": "" });
    const store = new VaultDocStore({ io, resolvePath: () => "", hotCap: 2 });

    await store.promote("a", "a.md");
    await store.promote("b", "b.md");
    await store.promote("c", "c.md"); // exceeds cap → 'a' (LRU) evicted

    expect(store.hotBridge("a")).toBeNull();
    expect(store.hotBridge("b")).not.toBeNull();
    expect(store.hotBridge("c")).not.toBeNull();
    // svCache retained so the reconnect manifest stays cheap.
    expect(store.knownDocs().sort()).toEqual(["a", "b", "c"]);
  });

  it("drop removes a doc from the hot tier and the manifest", async () => {
    const { io } = makeHarness({ "x.md": "" });
    const store = new VaultDocStore({ io, resolvePath: () => "x.md" });

    await store.promote("x", "x.md");
    expect(store.knownDocs()).toContain("x");

    store.drop("x");
    expect(store.hotBridge("x")).toBeNull();
    expect(store.knownDocs()).not.toContain("x");
  });

  it("prioritises recently-touched docs newest-first", async () => {
    const { io } = makeHarness({ "1.md": "", "2.md": "", "3.md": "" });
    const store = new VaultDocStore({ io, resolvePath: () => "", hotCap: 10 });
    await store.promote("one", "1.md");
    await store.promote("two", "2.md");
    await store.promote("three", "3.md");
    expect(store.recentDocs()).toEqual(["three", "two", "one"]);
  });
});
