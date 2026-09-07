// Data-loss guard: a bridge that is "born empty" — opened with seedFromFile
// false onto a note whose CRDT is empty (a doc_id mismatch, or an empty server
// doc pulled by the background feed) — must NEVER let its emptiness reach the
// file that still has real content on disk. This is the exact failure that
// zeroed imported notes (`How Baalda works.md` → 0 bytes) before the fix. A
// genuine clear-all (the doc held content, then it was emptied) must still
// egest normally.

import { describe, expect, it, vi } from "vitest";
import { NoteBridge } from "../noteBridge";
import { makeHarness } from "./helpers";

const PATH = "note.md";
const CONTENT = "# Real content\n\nthat must not be lost\n";

describe("empty-egest clobber guard", () => {
  it("opening an imported note the sync way leaves on-disk content intact", async () => {
    vi.useFakeTimers();
    try {
      // File has content on disk; no CRDT persisted (a freshly imported note).
      // Open exactly as the signed-in editor / background feed does: no seed,
      // so the Y.Doc is empty and the server (absent here) can't fill it.
      const { io, fs } = makeHarness({ [PATH]: CONTENT });
      const bridge = await NoteBridge.open(io, {
        docId: "mismatched-id",
        path: PATH,
        seedFromFile: false,
      });
      const writesBefore = fs.writeCount;

      // Whatever the feed does — flush on eviction, timers firing — the file's
      // real bytes survive; the guard refuses any empty write over them.
      await bridge.flushEgest();
      await vi.advanceTimersByTimeAsync(1000);

      expect(fs.get(PATH)).toBe(CONTENT);
      expect(fs.writeCount).toBe(writesBefore);
      // The doc itself is (correctly) still empty — it just never clobbers disk.
      expect(bridge.serialize()).toBe("");

      bridge.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("directly refuses an empty egest over a non-empty file (born-empty doc)", async () => {
    vi.useFakeTimers();
    try {
      const { io, fs } = makeHarness({ [PATH]: CONTENT });
      const bridge = await NoteBridge.open(io, {
        docId: "mismatched-id",
        path: PATH,
        seedFromFile: false,
      });

      // Force the dangerous drain path: an empty doc egesting to disk. (Reaches
      // drainEgest via the private egest hook the feed's flush would trigger.)
      await (bridge as unknown as { drainEgest(): Promise<void> }).drainEgest();

      expect(fs.get(PATH)).toBe(CONTENT); // untouched
      bridge.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("still egests a genuine clear-all (doc held content, then emptied)", async () => {
    vi.useFakeTimers();
    try {
      const { io, fs } = makeHarness({ [PATH]: CONTENT });
      // Normal local-first open: seeds the doc from the file, so it has held
      // content this session.
      const bridge = await NoteBridge.open(io, { docId: "doc-1", path: PATH });

      // User selects all and deletes.
      bridge.edit((t) => t.delete(0, t.length));
      await vi.advanceTimersByTimeAsync(300);

      // The clear reaches disk — this is a real deletion, not a born-empty doc.
      expect(bridge.serialize()).toBe("");
      expect(fs.get(PATH)).toBe("");

      bridge.destroy();
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * The ingest twin (#93): a 0-byte FILE must not clear a doc that holds text.
 *
 * The registry materializes a server-only note as an empty placeholder, and on a
 * device that already holds that note's CRDT the placeholder used to be
 * diff-merged into the populated doc as a delete-all — and then pushed, which
 * destroyed the server's copy. The doc keeps what it has instead; a genuine
 * PARTIAL truncation is a normal edit and still applies.
 */
describe("empty-ingest truncation guard", () => {
  it("refuses to clear a populated doc from a 0-byte file", async () => {
    vi.useFakeTimers();
    try {
      const { io, fs } = makeHarness({ [PATH]: CONTENT });
      const errors: Array<{ err: unknown; context: string }> = [];
      const bridge = await NoteBridge.open(
        { ...io, onError: (err, context) => errors.push({ err, context }) },
        { docId: "doc-1", path: PATH },
      );
      expect(bridge.serialize()).toBe(CONTENT);

      // The exact sequence from the bug: the file becomes 0 bytes underneath a
      // doc that still holds the note.
      fs.externalWrite(PATH, "");
      expect(await bridge.ingestNow()).toBe(false);
      expect(bridge.serialize()).toBe(CONTENT);
      expect(errors.map((e) => e.context)).toContain("ingest:truncate");

      // Reported ONCE, however many events the placeholder generates.
      await bridge.ingestNow();
      expect(errors.filter((e) => e.context === "ingest:truncate")).toHaveLength(1);

      bridge.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("still applies a genuine partial truncation from disk", async () => {
    vi.useFakeTimers();
    try {
      const { io, fs } = makeHarness({ [PATH]: CONTENT });
      const bridge = await NoteBridge.open(io, { docId: "doc-1", path: PATH });

      // A person (or an AI) cutting the note down to one line is a real edit.
      fs.externalWrite(PATH, "# Real content\n");
      expect(await bridge.ingestNow()).toBe(true);
      expect(bridge.serialize()).toBe("# Real content\n");

      bridge.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("honours a 0-byte file when the note is configured to allow it", async () => {
    vi.useFakeTimers();
    try {
      const { io, fs } = makeHarness({ [PATH]: CONTENT });
      const bridge = await NoteBridge.open(io, {
        docId: "doc-1",
        path: PATH,
        config: { allowTruncateFromDisk: true },
      });

      fs.externalWrite(PATH, "");
      expect(await bridge.ingestNow()).toBe(true);
      expect(bridge.serialize()).toBe("");

      bridge.destroy();
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * The other half of the #93 fix: a materialized 0-byte placeholder is FILLED IN
 * from the local CRDT (`SyncManager.materializeContent`), which removes the
 * trigger rather than only guarding against it.
 *
 * `flushEgest` cannot do this. Nothing is pending after `hydrate` — applying
 * persisted state fires no text observer — and the echo hash is baselined at the
 * doc's own text, so the "already on disk" shortcut skips the write too.
 */
describe("writeThrough — filling a placeholder from the local CRDT", () => {
  it("writes the doc's text over the 0-byte file the registry just created", async () => {
    vi.useFakeTimers();
    try {
      // A previous session's CRDT for this note…
      const { io, fs, persistence } = makeHarness({ [PATH]: CONTENT });
      const first = await NoteBridge.open(io, { docId: "doc-1", path: PATH });
      expect(first.serialize()).toBe(CONTENT);
      first.destroy();
      expect(persistence.logLength("doc-1")).toBeGreaterThan(0);

      // …the file is deleted and the registry re-creates it empty.
      fs.externalWrite(PATH, "");
      const bridge = await NoteBridge.open(io, {
        docId: "doc-1",
        path: PATH,
        seedFromFile: false, // exactly how the doc store promotes it
      });
      expect(bridge.serialize()).toBe(CONTENT); // hydrated from the CRDT
      // Nothing is pending, so the normal flush is (correctly) a no-op.
      const writes = fs.writeCount;
      await bridge.flushEgest();
      expect(fs.writeCount).toBe(writes);

      expect(await bridge.writeThrough()).toBe(true);
      expect(fs.get(PATH)).toBe(CONTENT);

      // The echo hash now matches the file, so the watcher event for this write
      // is recognised as our own and no content push is queued for it.
      fs.externalWrite(PATH, CONTENT);
      expect(await bridge.ingestNow()).toBe(false);

      bridge.destroy();
    } finally {
      vi.useRealTimers();
    }
  });
});
