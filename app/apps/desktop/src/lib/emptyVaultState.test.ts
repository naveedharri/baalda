import { describe, expect, it } from "vitest";
import {
  editorEmptyPrompt,
  emptyVaultState,
  nothingSharedBody,
  type EmptyVaultInput,
} from "./emptyVaultState";

const base: EmptyVaultInput = {
  signedIn: true,
  synced: true,
  live: true,
  readableItems: 0,
  hiddenContent: true,
  isOwner: false,
};

describe("emptyVaultState", () => {
  it("is nothing-shared for a live member with zero readable items and hidden content", () => {
    expect(emptyVaultState(base)).toBe("nothing-shared");
  });
  it("is none when signed out", () => {
    expect(emptyVaultState({ ...base, signedIn: false })).toBe("none");
  });
  it("is none for a local (unsynced) vault", () => {
    expect(emptyVaultState({ ...base, synced: false })).toBe("none");
  });
  it("is none until the channel is live", () => {
    expect(emptyVaultState({ ...base, live: false })).toBe("none");
  });
  it("is none before any listing arrived", () => {
    expect(emptyVaultState({ ...base, readableItems: null })).toBe("none");
  });
  it("is none once anything is readable", () => {
    expect(emptyVaultState({ ...base, readableItems: 1 })).toBe("none");
  });
  it("is none when the server lacks the field", () => {
    expect(emptyVaultState({ ...base, hiddenContent: null })).toBe("none");
  });
  it("is empty-vault when nothing is hidden", () => {
    expect(emptyVaultState({ ...base, hiddenContent: false })).toBe("empty-vault");
  });
  it("is none for the owner even with hidden content", () => {
    expect(emptyVaultState({ ...base, isOwner: true })).toBe("none");
  });
});

describe("empty-state copy", () => {
  it("names the owner and vault, falling back when unknown", () => {
    expect(nothingSharedBody("Sara", "Acme")).toBe(
      "Sara hasn't given you access to any folders or notes in Acme. Ask them to share something with you.",
    );
    expect(nothingSharedBody(null, "Acme")).toMatch(/^The owner hasn't given you access/);
  });
  it("drops ⌘N only when the root create is refused", () => {
    expect(editorEmptyPrompt(false)).toBe("Select a note.");
    expect(editorEmptyPrompt(true)).toBe("Select a note, or press ⌘N to create one.");
    expect(editorEmptyPrompt(null)).toBe("Select a note, or press ⌘N to create one.");
  });
});
