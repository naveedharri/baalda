import { describe, expect, it } from "vitest";
import { viewingDocId } from "../viewingDocId";

// "Who is looking at what" is only as good as the id it travels under. This
// shipped broken in one direction and looked fine in the other: whoever JOINED
// a vault could see everyone, and nobody could see them. These pin the choice
// that makes it symmetric.

describe("viewingDocId", () => {
  it("announces the server doc_id when the note is mapped", () => {
    // The whole point. A teammate's readable set and the sidebar's dot lookup
    // are both keyed on server ids; a local id matches neither.
    expect(viewingDocId("local-uuid", "server-doc-id")).toBe("server-doc-id");
  });

  it("makes a joined device announce the id its teammates know", () => {
    // On a device that joined an existing vault, the two ids always differ:
    // the note was materialized locally with a fresh uuid, while the registry
    // holds the server's. Announcing the local one is what made the newcomer
    // invisible to everyone else.
    const localAfterMaterialize = "3f7c1e94-local-only";
    const fromServer = "a1b2c3d4-server";
    expect(viewingDocId(localAfterMaterialize, fromServer)).toBe(fromServer);
    expect(viewingDocId(localAfterMaterialize, fromServer)).not.toBe(
      localAfterMaterialize,
    );
  });

  it("falls back to the local id when nothing is syncing the note", () => {
    // A local-only vault, or a non-markdown file: no server id exists, and the
    // local one is all anyone could match on.
    expect(viewingDocId("local-uuid", null)).toBe("local-uuid");
    expect(viewingDocId("local-uuid", undefined)).toBe("local-uuid");
    expect(viewingDocId("local-uuid", "")).toBe("local-uuid");
  });

  it("announces nothing when no note is open", () => {
    // A null doc is meaningful: it clears the dots, and the server lets it
    // through unconditionally rather than checking it against readable docs.
    expect(viewingDocId(null, null)).toBeNull();
    expect(viewingDocId(undefined, "server-doc-id")).toBeNull();
    expect(viewingDocId("", "server-doc-id")).toBeNull();
  });

  it("agrees with itself for a note created on this device", () => {
    // The server adopts the id we register, so both sides are the same string
    // and the fallback is indistinguishable from the mapped answer.
    expect(viewingDocId("same-id", "same-id")).toBe("same-id");
  });
});
