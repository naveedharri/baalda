import { describe, expect, it } from "vitest";

import { NOTICE_PRIORITY, pickNotice } from "../../lib/noticeSlot";
import { memberDisplayName } from "../../lib/vaultKeys/names";

describe("vault key UI", () => {
  it("names people from the roster, never by raw id", () => {
    const members = [
      { userId: "u1", user: { name: "Sara Khan", email: "sara@example.com" } },
      { userId: "u2", user: { name: " ", email: "lee@example.com" } },
    ];
    expect(memberDisplayName(members, "u1")).toBe("Sara Khan");
    expect(memberDisplayName(members, "u2")).toBe("lee@example.com");
    expect(memberDisplayName(members, "u9")).toBe("A teammate");
  });

  it("the waiting-for-key notice sits below closed-app changes and above not-syncing", () => {
    const at = (id: string) => NOTICE_PRIORITY.indexOf(id as never);
    expect(at("vault-key-waiting")).toBe(at("closed-app-changes") + 1);
    expect(at("not-syncing")).toBe(at("vault-key-waiting") + 1);
    expect(pickNotice(new Set(["vault-key-waiting", "root-missing"]))).toBe("root-missing");
  });
});
