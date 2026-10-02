// Updates for a doc the registry cannot place yet are PARKED, not dropped.
//
// A note created on the server (MCP `create_note`, a teammate) is persisted,
// then announced with `registry-changed`; the vault channel answers with a full
// backfill for the newly readable doc within milliseconds, while the registry
// pull that maps its doc_id is a debounced HTTP round trip. The backfill used to
// land first and `coldApply` threw it away ("next reconnect retries"), so the
// pull materialized a 0-byte placeholder with no local CRDT to fill it from, and
// every later delta (an `append_note`) stayed pending on the lost base: new
// server notes came down EMPTY while edits to existing notes synced fine.

import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { PARKED_DOC_CAP, PARKED_TTL_MS, VaultDocStore } from "../vaultDocStore";
import { makeHarness } from "../../bridge/__tests__/helpers";

/** A server-side doc we can keep editing, handing out full state or deltas. */
function serverDoc(text: string) {
  const doc = new Y.Doc();
  doc.getText("content").insert(0, text);
  return {
    full: () => Y.encodeStateAsUpdate(doc),
    /** Append `more` and return ONLY the delta, which depends on the prior state. */
    append(more: string): Uint8Array {
      const before = Y.encodeStateVector(doc);
      const t = doc.getText("content");
      t.insert(t.length, more);
      return Y.encodeStateAsUpdate(doc, before);
    },
  };
}

/** A registry whose mapping the test flips, like a pull landing. */
function registry() {
  const paths = new Map<string, string>();
  return {
    resolvePath: (id: string) => paths.get(id) ?? null,
    map: (id: string, path: string) => paths.set(id, path),
  };
}

describe("VaultDocStore — parked updates for unmapped docs", () => {
  it("parks a backfill that beats the registry pull, then writes it once the doc maps", async () => {
    const { io, fs } = makeHarness({ "n.md": "" }); // the pull's 0-byte placeholder
    const reg = registry();
    const converged: string[] = [];
    const store = new VaultDocStore({ io, resolvePath: reg.resolvePath, onConverged: (id) => converged.push(id) });
    const server = serverDoc("created over MCP");

    const mark = store.parkMark();
    await store.applyUpdate("docX", server.full()); // registry does not know docX yet
    expect(fs.get("n.md")).toBe("");
    expect(store.parkedDocs()).toEqual(["docX"]);
    expect(await store.stateVector("docX")).toBeNull(); // nothing claimed in the manifest

    reg.map("docX", "n.md"); // the pull lands
    await store.settleParked(mark);

    expect(fs.get("n.md")).toBe("created over MCP");
    expect(store.parkedDocs()).toEqual([]);
    expect(converged).toEqual(["docX"]); // same cold-apply path a known doc takes
    expect(await store.stateVector("docX")).not.toBeNull();
  });

  it("lands a later live delta that depends on the parked base", async () => {
    const { io, fs } = makeHarness({ "n.md": "" });
    const reg = registry();
    const store = new VaultDocStore({ io, resolvePath: reg.resolvePath });
    const server = serverDoc("base");

    const mark = store.parkMark();
    await store.applyUpdate("docX", server.full());
    await store.applyUpdate("docX", server.append("\nfirst append")); // also before the map
    reg.map("docX", "n.md");
    await store.settleParked(mark);
    expect(fs.get("n.md")).toBe("base\nfirst append");

    // An `append_note` after the doc is mapped arrives as a plain live delta.
    await store.applyUpdate("docX", server.append("\nsecond append"));
    expect(fs.get("n.md")).toBe("base\nfirst append\nsecond append");
  });

  it("discards a parked doc the completed pull never maps, and never writes it", async () => {
    const { io, fs } = makeHarness({ "n.md": "" });
    const reg = registry();
    const store = new VaultDocStore({ io, resolvePath: reg.resolvePath });

    const mark = store.parkMark();
    await store.applyUpdate("ghost", serverDoc("not readable here").full());
    await store.settleParked(mark + 1); // a pull that started AFTER the park completed without it
    expect(store.parkedDocs()).toEqual([]);

    // Even if the id later resolves, the discarded bytes are gone — no write.
    reg.map("ghost", "n.md");
    await store.settleParked();
    expect(fs.get("n.md")).toBe("");
  });

  it("keeps a doc parked AFTER the pull started for the next pull, then expires it by TTL", async () => {
    const { io, fs } = makeHarness({ "n.md": "" });
    const reg = registry();
    let now = 1_000;
    const store = new VaultDocStore({ io, resolvePath: reg.resolvePath, now: () => now });

    const mark = store.parkMark(); // pull starts; its listing predates the create
    await store.applyUpdate("late", serverDoc("newer than the listing").full());
    await store.settleParked(mark);
    expect(store.parkedDocs()).toEqual(["late"]); // too new for that pull to judge

    now += PARKED_TTL_MS + 1;
    await store.settleParked(store.parkMark());
    expect(store.parkedDocs()).toEqual([]);
    expect(fs.get("n.md")).toBe("");
  });

  it("evicts the oldest parked doc past the cap and reports it for a re-request", async () => {
    const { io } = makeHarness({});
    const reg = registry();
    const store = new VaultDocStore({ io, resolvePath: reg.resolvePath });

    for (let i = 0; i <= PARKED_DOC_CAP + 1; i++) {
      await store.applyUpdate(`d${i}`, serverDoc(`note ${i}`).full());
    }

    const parked = store.parkedDocs();
    expect(parked).toHaveLength(PARKED_DOC_CAP);
    expect(parked).not.toContain("d0");
    expect(parked).not.toContain("d1");
    expect(parked).toContain(`d${PARKED_DOC_CAP + 1}`);
    // Only an evicted doc the pull placed is worth a reconnect: re-requesting
    // one that still does not map would just overflow again, every pull.
    reg.map("d0", "d0.md");
    expect(store.takeOverflowed()).toEqual(["d0"]);
    expect(store.takeOverflowed()).toEqual([]); // cleared on read
  });

  it("discards a doc parked before the pull's mark that the pull did not map", async () => {
    // The customer path end to end: one note the pull maps, one it never lists.
    const { io, fs } = makeHarness({ "new.md": "" });
    const reg = registry();
    const store = new VaultDocStore({ io, resolvePath: reg.resolvePath });
    const created = serverDoc("# Agenda");

    await store.applyUpdate("created", created.full());
    await store.applyUpdate("unlisted", serverDoc("never listed").full());
    const mark = store.parkMark(); // the pull starts AFTER both parked
    reg.map("created", "new.md");
    await store.settleParked(mark);

    expect(fs.get("new.md")).toBe("# Agenda");
    expect(store.parkedDocs()).toEqual([]);
    await store.applyUpdate("created", created.append("\n- item"));
    expect(fs.get("new.md")).toBe("# Agenda\n- item");
  });

  it("forgets parked updates for a dropped doc", async () => {
    const { io, fs } = makeHarness({ "n.md": "" });
    const reg = registry();
    const store = new VaultDocStore({ io, resolvePath: reg.resolvePath });

    await store.applyUpdate("docX", serverDoc("revoked before it mapped").full());
    store.drop("docX");
    reg.map("docX", "n.md");
    await store.settleParked();

    expect(store.parkedDocs()).toEqual([]);
    expect(fs.get("n.md")).toBe("");
  });
});
