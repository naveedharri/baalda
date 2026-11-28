import { describe, expect, it } from "vitest";
import { inviteAccessOptions } from "../../components/InvitePeopleDialog";

describe("inviteAccessOptions", () => {
  it("offers the three levels: Can edit everything, Can view everything, No access", () => {
    const opts = inviteAccessOptions();
    expect(opts.map((o) => o.label)).toEqual(["Can edit everything", "Can view everything", "No access"]);
    expect(opts[2]).toMatchObject({ value: "default" });
    expect(opts[2]).not.toHaveProperty("tag");
  });
  it("gives admins Can edit everything only", () => {
    expect(inviteAccessOptions("admin")).toEqual([expect.objectContaining({ value: "open", label: "Can edit everything" })]);
  });
});
