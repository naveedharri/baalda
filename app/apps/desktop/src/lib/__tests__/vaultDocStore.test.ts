import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { VaultDocStore, type ManifestStore } from "../sync/vaultDocStore";
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

  it("promote({ markRecent: false }) keeps a bulk run out of the priority list", async () => {
    const { io } = makeHarness({ "1.md": "", "2.md": "" });
    const store = new VaultDocStore({ io, resolvePath: () => "", hotCap: 10 });
    await store.promote("real", "1.md");
    // A 500-note upload would otherwise flush the genuine recency list.
    await store.promote("bulk", "2.md", { markRecent: false });
    expect(store.recentDocs()).toEqual(["real"]);
    expect(store.knownDocs()).toContain("bulk"); // still in the manifest
  });

  it("demote flushes and releases a doc, keeping its manifest entry", async () => {
    const { io, fs } = makeHarness({ "d.md": "" });
    const store = new VaultDocStore({ io, resolvePath: () => "d.md" });
    await store.promote("d", "d.md", { pin: true });
    await store.applyUpdate("d", updateSetting("resident"));
    expect(store.hotSize()).toBe(1);

    await store.demote("d");

    expect(store.hotSize()).toBe(0); // residency released
    expect(fs.get("d.md")).toBe("resident"); // pending write flushed
    expect(store.knownDocs()).toContain("d"); // manifest kept
    await store.demote("d"); // idempotent
  });

  it("a pinned doc is never LRU-evicted (its provider's Y.Doc must survive)", async () => {
    const { io } = makeHarness({ "a.md": "", "b.md": "", "c.md": "" });
    const store = new VaultDocStore({ io, resolvePath: () => "", hotCap: 1 });
    await store.promote("pinned", "a.md", { pin: true });
    await store.promote("b", "b.md");
    await store.promote("c", "c.md");
    expect(store.hotBridge("pinned")).not.toBeNull();
  });
});

/** An in-memory stand-in for the SQLite state-vector table. */
function fakeManifest(seed: Record<string, Uint8Array> = {}) {
  const rows = new Map<string, Uint8Array>(Object.entries(seed));
  let saves = 0;
  const store: ManifestStore = {
    load: async () => [...rows].map(([docId, stateVector]) => ({ docId, stateVector })),
    save: async (entries) => {
      saves++;
      for (const [docId, sv] of entries) rows.set(docId, sv);
    },
  };
  return { store, rows, saves: () => saves };
}

describe("VaultDocStore — durable manifest", () => {
  it("hydrates knownDocs from the persisted manifest (relaunch is incremental)", async () => {
    // The whole point: without this, `hello` was `{}` on every launch and the
    // server re-sent the FULL state of every readable doc, forever.
    const { io } = makeHarness({});
    const manifest = fakeManifest({ old: new Uint8Array([1, 2, 3]) });
    const store = new VaultDocStore({ io, resolvePath: () => null, manifest: manifest.store });

    await store.whenReady();

    expect(store.knownDocs()).toEqual(["old"]);
    expect(await store.stateVector("old")).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("persists state vectors in ONE batch, not one write per doc", async () => {
    const { io } = makeHarness({ "a.md": "", "b.md": "", "c.md": "" });
    const manifest = fakeManifest();
    const paths: Record<string, string> = { a: "a.md", b: "b.md", c: "c.md" };
    const store = new VaultDocStore({
      io,
      resolvePath: (id) => paths[id] ?? null,
      manifest: manifest.store,
    });
    await store.whenReady();

    await store.applyUpdate("a", updateSetting("one"));
    await store.applyUpdate("b", updateSetting("two"));
    await store.applyUpdate("c", updateSetting("three"));
    expect(manifest.saves()).toBe(0); // coalesced, not per doc

    await store.flushStateVectors();
    expect(manifest.saves()).toBe(1);
    expect([...manifest.rows.keys()].sort()).toEqual(["a", "b", "c"]);
  });

  it("flushes the manifest on destroyAll, so the NEXT launch resumes from it", async () => {
    const { io } = makeHarness({ "a.md": "" });
    const manifest = fakeManifest();
    const first = new VaultDocStore({
      io,
      resolvePath: () => "a.md",
      manifest: manifest.store,
    });
    await first.whenReady();
    await first.applyUpdate("a", updateSetting("hello"));
    await first.destroyAll();
    expect(manifest.rows.has("a")).toBe(true);

    const second = new VaultDocStore({
      io,
      resolvePath: () => "a.md",
      manifest: manifest.store,
    });
    await second.whenReady();
    expect(second.knownDocs()).toEqual(["a"]);
  });

  it("survives an unreadable manifest — a full backfill, never a crash", async () => {
    const { io } = makeHarness({});
    const store = new VaultDocStore({
      io,
      resolvePath: () => null,
      manifest: {
        load: async () => {
          throw new Error("vault-mismatch: epoch moved");
        },
        save: async () => {
          throw new Error("vault-mismatch: epoch moved");
        },
      },
    });
    await store.whenReady();
    expect(store.knownDocs()).toEqual([]);
    await store.flushStateVectors(); // must not reject
  });
});
