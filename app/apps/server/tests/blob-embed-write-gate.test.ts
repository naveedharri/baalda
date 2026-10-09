import { createHash } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/http/app.js";
import { testAppDeps } from "./helpers/app.js";
import { pool } from "../src/db/pool.js";
import { resetDb } from "./helpers/db.js";
import { signUp, type TestUser } from "./helpers/auth.js";
import {
  sealVault,
  seedFolder,
  seedMember,
  seedNote,
  seedOrg,
  seedShare,
  seedVault,
  seedVaultGrant,
} from "./helpers/seed.js";

/**
 * Who may upload a hash-named `attachments/` drop (an image pasted into a note).
 *
 * The gate used to be the vault ROOT alone, so in a vault whose Everyone level
 * is Can view or No access, a person who could edit the note (through a folder
 * or per-person grant) was refused the bytes of the image they had just pasted
 * into it: the text reached every teammate, the picture never did.
 */
const app = createApp(testAppDeps());
const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);
const sha = createHash("sha256").update(PNG).digest("hex");

function intent(user: TestUser, vaultId: string): Promise<Response> {
  return app.fetch(
    new Request(`http://local/api/vaults/${vaultId}/blobs/intent`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${user.token}` },
      body: JSON.stringify({
        sha256: sha,
        size: PNG.byteLength,
        mime: "image/png",
        relPath: "attachments/0123456789abcdef.png",
        filename: "0123456789abcdef.png",
      }),
    }),
  );
}

async function setup(slug: string, posture: "sealed" | "view") {
  const owner = await signUp(`owner@${slug}.com`);
  const member = await signUp(`member@${slug}.com`);
  const org = await seedOrg("Acme", slug);
  await seedMember(org, owner.userId, "owner");
  await seedMember(org, member.userId, "member");
  const vault = await seedVault(org);
  if (posture === "sealed") await sealVault(org);
  else await seedVaultGrant(org, "view");
  const folder = await seedFolder(vault, null, "Team", "Team", owner.userId);
  await seedNote(vault, folder, "Team/Shared.md", owner.userId);
  return { owner, member, org, vault, folder };
}

afterAll(async () => {
  await pool.end();
});

describe("attachments/ upload gate", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it.each(["sealed", "view"] as const)(
    "lets a member who can edit a folder upload an embed (Everyone %s)",
    async (posture) => {
      const { member, org, vault, folder } = await setup(`embed-${posture}`, posture);
      await seedShare(org, "folder", folder, member.userId, "edit");
      const res = await intent(member, vault);
      expect(res.status).toBe(200);
    },
  );

  it("still refuses a member who can edit nothing in the vault", async () => {
    const { member, org, vault, folder } = await setup("embed-viewonly", "sealed");
    await seedShare(org, "folder", folder, member.userId, "view");
    const res = await intent(member, vault);
    expect(res.status).toBe(403);
  });
});
