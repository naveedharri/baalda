// SPDX-License-Identifier: Apache-2.0
// A delete-all against the original history can leave ONLY the characters
// inserted by a concurrent formatting edit. This is why a damaged note can
// contain "**I:**" rather than being empty, and why checking the merged text
// for emptiness is not a substitute for refusing placeholder ingestion.

import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { NoteBridge } from "../noteBridge";
import { makeHarness } from "./helpers";

const PATH = "note.md";
const ORIGINAL = "> [!info] Raw auto-caption transcript\n> Full original body.\n";
const FORMATTED = "**Info: Raw auto-caption transcript**\nFull original body.\n";

describe("concurrent formatting and an empty disk placeholder", () => {
  it.each(["read", "hash", "snapshot"] as const)(
    "does not delete a teammate's update arriving during %s",
    async (phase) => {
      vi.useFakeTimers();
      const h = makeHarness({ [PATH]: ORIGINAL });
      const bridge = await NoteBridge.open(h.io, {
        docId: "doc", path: PATH, config: { largeDiffRatio: 0 },
      });
      const remote = new Y.Doc();
      Y.applyUpdate(remote, Y.encodeStateAsUpdate(bridge.doc));
      const sv = Y.encodeStateVector(remote);
      const added = "\nA teammate's new section.\n";
      remote.getText("content").insert(remote.getText("content").length, added);
      h.fs.externalWrite(PATH, FORMATTED);
      let resume!: () => void;
      let entered!: () => void;
      const waiting = new Promise<void>((resolve) => { entered = resolve; });
      const held = new Promise<void>((resolve) => { resume = resolve; });
      const pause = async () => { entered(); await held; };
      if (phase === "read") {
        h.io.readFile = async (path) => {
          const text = await h.fs.readFile(path);
          await pause();
          return text;
        };
      } else if (phase === "hash") {
        const hash = h.io.sha256!;
        h.io.sha256 = async (text) => { await pause(); return hash(text); };
      } else {
        const save = h.persistence.saveSnapshot.bind(h.persistence);
        h.persistence.saveSnapshot = async (...args) => {
          await save(...args);
          await pause();
        };
      }
      try {
        const ingest = bridge.ingestNow();
        await waiting;
        bridge.applyRemote(Y.encodeStateAsUpdate(remote, sv));
        resume();
        await ingest;
        expect(bridge.serialize()).toBe(FORMATTED + added);
        // A second watcher notification can be queued before the merged egest.
        // The same local bytes must not now delete the peer's retained section.
        await bridge.ingestNow();
        expect(bridge.serialize()).toBe(FORMATTED + added);
        Y.applyUpdate(remote, Y.encodeStateAsUpdate(bridge.doc));
        expect(remote.getText("content").toString()).toBe(FORMATTED + added);
        await vi.advanceTimersByTimeAsync(300);
        expect(h.fs.get(PATH)).toBe(FORMATTED + added);
        await bridge.whenPersisted();
        const saved = await h.persistence.loadState("doc");
        const reopened = new Y.Doc();
        try {
          if (saved.snapshot) Y.applyUpdate(reopened, saved.snapshot);
          for (const update of saved.updates) Y.applyUpdate(reopened, update);
          expect(reopened.getText("content").toString()).toBe(FORMATTED + added);
        } finally {
          reopened.destroy();
        }
      } finally {
        bridge.destroy();
        remote.destroy();
        vi.useRealTimers();
      }
    },
  );

  it.each([false, true])(
    "placeholder truncation allowed=%s",
    async (allowTruncateFromDisk) => {
      vi.useFakeTimers();
      const original = new Y.Doc();
      original.getText("content").insert(0, ORIGINAL);
      const snapshot = Y.encodeStateAsUpdate(original);
      const vector = Y.encodeStateVector(original);
      const formatted = makeHarness({ [PATH]: FORMATTED });
      const placeholder = makeHarness({ [PATH]: "" });
      let a: NoteBridge | undefined;
      let b: NoteBridge | undefined;
      try {
        for (const h of [formatted, placeholder]) {
          await h.persistence.saveSnapshot("doc", snapshot, vector);
        }
        a = await NoteBridge.open(formatted.io, {
          docId: "doc", path: PATH, seedFromFile: false,
        });
        b = await NoteBridge.open(placeholder.io, {
          docId: "doc", path: PATH, seedFromFile: false,
          // true reproduces the old unguarded ingestion path. Production
          // defaults to false; that refusal must happen BEFORE CRDT merging.
          config: { allowTruncateFromDisk },
        });
        await a.ingestNow();
        await b.ingestNow();
        Y.applyUpdate(original, Y.encodeStateAsUpdate(a.doc));
        Y.applyUpdate(original, Y.encodeStateAsUpdate(b.doc));
        expect(original.getText("content").toString()).toBe(
          allowTruncateFromDisk ? "**I:**" : FORMATTED,
        );
      } finally {
        a?.destroy();
        b?.destroy();
        original.destroy();
        vi.useRealTimers();
      }
    },
  );
});
