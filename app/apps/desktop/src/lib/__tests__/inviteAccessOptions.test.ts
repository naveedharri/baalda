import { describe, expect, it } from "vitest";
import { inviteAccessOptions } from "../../components/InvitePeopleDialog";

describe("inviteAccessOptions", () => {
  it("starts members on Only what's shared, tagged Default", () => {
    const opts = inviteAccessOptions();
    expect(opts.map((o) => o.label)).toEqual(["Only what's shared", "Can edit everything", "Can view everything"]);
    expect(opts[0]).toMatchObject({ value: "default", tag: "Default" });
  });
  it("gives admins Can edit everything only", () => {
    expect(inviteAccessOptions("admin")).toEqual([expect.objectContaining({ value: "open", label: "Can edit everything" })]);
  });
});
