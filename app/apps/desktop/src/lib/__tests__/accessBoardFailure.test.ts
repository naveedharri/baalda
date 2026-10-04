// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { ACCESS_WRITE_FAILED, accessWriteFailureMessage, revertModes } from "../accessBoard";

describe("access board write failures", () => {
  it("network errors, timeouts and server failures get the connection sentence", () => {
    expect(accessWriteFailureMessage(new TypeError("Load failed"))).toBe(ACCESS_WRITE_FAILED);
    expect(accessWriteFailureMessage(new DOMException("aborted", "AbortError"))).toBe(ACCESS_WRITE_FAILED);
    expect(accessWriteFailureMessage(Object.assign(new Error("HTTP 502"), { name: "ApiError", status: 502 }))).toBe(ACCESS_WRITE_FAILED);
    expect(accessWriteFailureMessage("weird")).toBe(ACCESS_WRITE_FAILED);
  });

  it("a refusal the server explained is passed through", () => {
    const refusal = Object.assign(new Error("Every selected person must be a current vault member"), { name: "ApiError", status: 400 });
    expect(accessWriteFailureMessage(refusal)).toBe("Every selected person must be a current vault member");
  });

  it("reverts only the written rows and keeps newer answers for the rest", () => {
    const before = new Map([["a", "private"], ["b", "private"]]);
    const current = new Map([["a", "readonly"], ["b", "readonly"], ["c", "readonly"], ["d", "open"]]);
    const next = revertModes(current, before, ["a", "b", "c"]);
    expect([...next.entries()]).toEqual([["a", "private"], ["b", "private"], ["d", "open"]]);
    expect(current.get("a")).toBe("readonly");
  });
});
