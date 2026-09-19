// The "Check a note" box answers one question — "is THIS note safe?" — with one
// sentence. These tests are the guard on that sentence.
//
// Two ways it could lie, and both are here. It could claim a sync state for a
// note that is not on disk at all. And it could say "the server confirmed this"
// on anything weaker than a confirmation: a doc that was merely mapped, merely
// queued, or merely never reported this session. The order below is what keeps
// the most urgent true thing in front of the reader, because several of these
// facts are true at once on an unhappy note.

import { describe, expect, it } from "vitest";
import { composeInspectionVerdict, type InspectVerdictInput } from "../model";
import type { HealthIssue } from "../types";

function v(over: Partial<InspectVerdictInput> = {}): string {
  return composeInspectionVerdict({
    exists: true,
    syncEnabled: true,
    issue: null,
    permanentFailure: null,
    queued: false,
    diverged: false,
    state: null,
    pushed: false,
    docId: "doc-1",
    ...over,
  });
}

const issue: HealthIssue = {
  key: "doc-1",
  docId: "doc-1",
  path: "A.md",
  kind: "too-large",
  severity: "error",
  title: "Too large to sync",
  why: "…",
  remedies: [],
  code: null,
  explanation: { meaning: "…", next: "…", fixes: ["…"], safety: "only-here" },
  facts: [],
  autoRetries: false,
};

describe("composeInspectionVerdict", () => {
  it("says there is no file before saying anything about syncing", () => {
    // Every later sentence describes a file. Saying "synced" about a path with
    // nothing at it would send someone looking for a note that isn't there.
    expect(v({ exists: false, state: "synced", pushed: true })).toBe(
      "There is no file at this path.",
    );
  });

  it("says the folder doesn't sync before reporting any sync state", () => {
    expect(v({ syncEnabled: false, pushed: true, state: "synced" })).toContain(
      "does not sync",
    );
  });

  it("points at the issue row when the note has one, ahead of every softer fact", () => {
    const out = v({ issue, queued: true, diverged: true, state: "synced", pushed: true });
    expect(out).toContain("Too large to sync");
    expect(out).toContain("Needs attention");
  });

  it("reports a remembered permanent failure when no issue row covers it", () => {
    const out = v({ permanentFailure: "too large to sync (12.4 MB; the limit is 10 MB)" });
    expect(out).toContain("stopped trying");
    expect(out).toContain("12.4 MB");
  });

  it("prefers 'queued' over 'diverged' — the queue is the thing about to act", () => {
    expect(v({ queued: true, diverged: true })).toContain("Waiting to be pushed");
    expect(v({ diverged: true })).toContain("edits the Remote Vault may not have");
  });

  it("only claims a confirmation when BOTH the report and the checkpoint agree", () => {
    expect(v({ state: "synced", pushed: true })).toBe(
      "Synced — the Remote Vault confirmed this note's content.",
    );
    // A `synced` report with no durable checkpoint is not a confirmation, and
    // a checkpoint with a live `unsynced` state is not one either.
    for (const weak of [
      v({ state: "synced", pushed: false }),
      v({ state: "unsynced", pushed: true }),
    ]) {
      expect(weak).toContain("Not confirmed yet");
      expect(weak).not.toContain("the Remote Vault confirmed");
    }
  });

  it("explains a pushed note nothing has spoken for this session", () => {
    expect(v({ pushed: true, state: null })).toContain("nothing about it has changed");
  });

  it("says the Remote Vault doesn't know an unmapped note", () => {
    expect(v({ docId: null })).toBe("The Remote Vault does not know this note yet.");
  });

  it("falls back to 'not confirmed', never to something reassuring", () => {
    const out = v({ state: "unsynced" });
    expect(out).toContain("Not confirmed yet");
    expect(out).not.toContain("Synced");
  });
});
