import { describe, expect, it } from "vitest";
import { inviteAccessOptions } from "../../components/InvitePeopleDialog";

describe("inviteAccessOptions", () => {
  it("tags the New members level as Default and maps it to the vault default", () => {
    const opts = inviteAccessOptions("readonly");
    expect(opts.map((o) => o.label)).toEqual(["Can edit", "Can view", "No access"]);
    expect(opts[1]).toMatchObject({ value: "default", tag: "Default" });
    expect(opts.filter((o) => o.value === "default")).toHaveLength(1);
    expect(opts.some((o) => o.label === "Vault default")).toBe(false);
  });
  it("keeps a Vault default row while the setting is unknown", () => {
    const opts = inviteAccessOptions(null);
    expect(opts.map((o) => o.value)).toEqual(["open", "readonly", "private", "default"]);
  });
});
