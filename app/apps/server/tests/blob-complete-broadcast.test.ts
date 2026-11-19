import { createHash } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/http/app.js";
import { recordingAppDeps } from "./helpers/app.js";
import { pool } from "../src/db/pool.js";
import { resetDb } from "./helpers/db.js";
import { signUp } from "./helpers/auth.js";
import { seedMember, seedOrg, seedVault, seedVaultGrant } from "./helpers/seed.js";

/**
 * A blob that becomes ready is announced to the vault (`registry-changed`),
 * even a hash-named `attachments/` embed with no `files` row: the note that
 * embeds it registered before its bytes landed, so without this frame a
 * member's blob mirror never heard about it and their disk lagged until some
 * unrelated structural change.
 */
const rec = recordingAppDeps();
const app = createApp(rec.deps);

const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);
const sha = createHash("sha256").update(PNG).digest("hex");

afterAll(async () => {
  await pool.end();
});

describe("blob complete broadcasts registry-changed", () => {
  beforeEach(async () => {
    await resetDb();
    rec.reset();
  });

  it("announces an attachments/ blob once it is ready, carrying the uploader's origin", async () => {
    const owner = await signUp("owner@blob-broadcast.com");
    const org = await seedOrg("Acme", "blob-broadcast");
    await seedMember(org, owner.userId, "owner");
    const vault = await seedVault(org);
    await seedVaultGrant(org, "edit");
    const auth = { authorization: `Bearer ${owner.token}`, "x-baalda-origin": "client-a" };

    const res = await app.fetch(
      new Request(`http://local/api/vaults/${vault}/blobs/intent`, {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({
          sha256: sha,
          size: PNG.byteLength,
          mime: "image/png",
          relPath: `attachments/${sha.slice(0, 16)}.png`,
        }),
      }),
    );
    expect(res.status).toBe(200);
    const plan = (await res.json()) as {
      blobId: string;
      upload: { url: string; headers: Record<string, string> };
    };
    const put = await app.fetch(
      new Request(plan.upload.url.replace(/^https?:\/\/[^/]+/, "http://local"), {
        method: "PUT",
        headers: plan.upload.headers,
        body: PNG,
      }),
    );
    expect(put.status).toBe(204);
    // Nothing is ready yet, so nothing is announced.
    expect(rec.registryBroadcasts).toEqual([]);

    const done = await app.fetch(
      new Request(`http://local/api/blobs/${plan.blobId}/complete`, {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: "{}",
      }),
    );
    expect(done.status).toBe(200);
    expect(rec.registryBroadcasts).toEqual([{ vaultId: vault, originId: "client-a" }]);

    // A retried complete of a row already ready changes nothing: no second frame.
    const again = await app.fetch(
      new Request(`http://local/api/blobs/${plan.blobId}/complete`, {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: "{}",
      }),
    );
    expect(again.status).toBe(200);
    expect(rec.registryBroadcasts).toHaveLength(1);
  });
});
