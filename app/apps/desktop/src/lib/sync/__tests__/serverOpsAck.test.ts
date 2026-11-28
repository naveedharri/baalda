// Ops the server sends are ops it holds. The vault channel's frames used to
// record no acknowledgement, so a device acked once (a Hocuspocus `synced`,
// `ready.covered`) and then sent a teammate's or an AI's edit read that edit
// as ITS OWN unsent work when access went: a view-only member was told her
// notes were "removed with unsent changes" she never made. The store now
// reports each server update's own state vector, which can never cover a local
// op the server lacks.

import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { VaultDocStore } from "../vaultDocStore";
import { makeHarness } from "../../bridge/__tests__/helpers";
import { mergeSv, unseenWork } from "../ackedSv";

describe("VaultDocStore — server ops count as acknowledged", () => {
  it("a teammate's edit after this device's ack is not unsent work; a local edit still is", async () => {
    const server = new Y.Doc();
    server.clientID = 7;
    server.getText("content").insert(0, "hello");
    const { io } = makeHarness({ "n.md": "" });
    let acked: Uint8Array | null = null;
    const store = new VaultDocStore({
      io,
      resolvePath: () => "n.md",
      onServerOps: (_id, sv) => { acked = mergeSv(acked, sv); },
    });
    await store.applyUpdate("doc1", Y.encodeStateAsUpdate(server));
    // A teammate (or MCP) edits on the server; the delta arrives by frame.
    const before = Y.encodeStateVector(server);
    server.clientID = 9;
    server.getText("content").insert(5, " world");
    await store.applyUpdate("doc1", Y.encodeStateAsUpdate(server, before));

    const local = new Y.Doc();
    Y.applyUpdate(local, Y.encodeStateAsUpdate(server));
    expect(unseenWork({ localSv: Y.encodeStateVector(local), ackedSv: acked })).toBe(false);

    // A word typed here and never sent stays unseen work.
    local.clientID = 11;
    local.getText("content").insert(0, ">");
    expect(unseenWork({ localSv: Y.encodeStateVector(local), ackedSv: acked })).toBe(true);
  });

  it("reports even an update it parks (the server holds it either way)", async () => {
    const server = new Y.Doc();
    server.getText("content").insert(0, "x");
    const { io } = makeHarness({});
    const seen: string[] = [];
    const store = new VaultDocStore({ io, resolvePath: () => null, onServerOps: (id) => seen.push(id) });
    await store.applyUpdate("unmapped", Y.encodeStateAsUpdate(server));
    expect(seen).toEqual(["unmapped"]);
    expect(store.parkedDocs()).toEqual(["unmapped"]);
  });
});
