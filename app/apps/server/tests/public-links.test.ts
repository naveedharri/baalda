import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/http/app.js";
import { pool } from "../src/db/pool.js";
import { resetDb } from "./helpers/db.js";
import { testAppDeps, memoryDocWriter } from "./helpers/app.js";
import { authHeaders, createOrg, signUp, type TestUser } from "./helpers/auth.js";
import { seedMember, seedNote, seedVault } from "./helpers/seed.js";

/**
 * Public note links: /api/notes/:docId/public-link (mint/inspect/revoke, gated
 * like share management) and /p/:token (the read-only page, no auth — the
 * token IS the capability). The suite pins the two safety properties the
 * design leans on: repeated copies return the SAME url, and every miss
 * (malformed, unknown, revoked, deleted note) is one byte-identical page.
 */

const docWriter = memoryDocWriter();
const app = createApp(testAppDeps({ docWriter }));

const TOKEN_SHAPE = /^[A-Za-z0-9_-]{32}$/;

async function mint(user: TestUser, docId: string) {
  return app.fetch(
    new Request(`http://local/api/notes/${docId}/public-link`, {
      method: "POST",
      headers: authHeaders(user),
    }),
  );
}

describe("public note links", () => {
  let owner: TestUser;
  let orgId: string;
  let vault: string;
  let docId: string;

  beforeEach(async () => {
    await resetDb();
    docWriter.store.clear();
    docWriter.writes.length = 0;
    owner = await signUp(`owner-${randomUUID().slice(0, 8)}@pl.test`);
    orgId = (await createOrg(owner, "PL Co", `pl-co-${randomUUID().slice(0, 8)}`)).id;
    vault = await seedVault(orgId);
    docId = await seedNote(vault, null, "shared.md");
    docWriter.store.set(docId, "# Hello\n\nSome **shared** text.");
  });
  afterAll(async () => {
    await pool.end();
  });

  it("owner mints a link; repeated mints return the SAME url", async () => {
    const first = await mint(owner, docId);
    expect(first.status).toBe(201);
    const a = (await first.json()) as { token: string; url: string; existing: boolean };
    expect(a.token).toMatch(TOKEN_SHAPE);
    expect(a.url).toContain(`/p/${a.token}`);
    expect(a.existing).toBe(false);

    const second = await mint(owner, docId);
    expect(second.status).toBe(200);
    const b = (await second.json()) as { token: string; url: string; existing: boolean };
    expect(b.token).toBe(a.token);
    expect(b.url).toBe(a.url);
    expect(b.existing).toBe(true);
  });

  it("gate: creator-member can mint, other member 403, anon 401, unknown/deleted 404", async () => {
    const creator = await signUp(`creator-${randomUUID().slice(0, 8)}@pl.test`);
    await seedMember(orgId, creator.userId, "member");
    const other = await signUp(`other-${randomUUID().slice(0, 8)}@pl.test`);
    await seedMember(orgId, other.userId, "member");
    const ownDoc = await seedNote(vault, null, "mine.md", creator.userId);

    expect((await mint(creator, ownDoc)).status).toBe(201);
    expect((await mint(other, ownDoc)).status).toBe(403);
    expect((await mint(creator, docId)).status).toBe(403); // not their note, not admin

    const anon = await app.request(`/api/notes/${docId}/public-link`, { method: "POST" });
    expect(anon.status).toBe(401);

    expect((await mint(owner, randomUUID())).status).toBe(404);
    await pool.query("UPDATE notes SET deleted_at = now() WHERE id = $1", [ownDoc]);
    expect((await mint(creator, ownDoc)).status).toBe(404);
  });

  it("GET /p/:token renders the note read-only for anyone, with the safety headers", async () => {
    const { token } = (await (await mint(owner, docId)).json()) as { token: string };
    const res = await app.request(`/p/${token}`); // no auth header at all
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("x-robots-tag")).toBe("noindex");
    const html = await res.text();
    expect(html).toContain("<strong>shared</strong>");
    expect(html).toContain("<h1>Hello</h1>");
  });

  it("hostile note content is never reflected as markup", async () => {
    docWriter.store.set(docId, `<script>alert(1)</script><img src=x onerror=1>`);
    const { token } = (await (await mint(owner, docId)).json()) as { token: string };
    const html = await (await app.request(`/p/${token}`)).text();
    expect(html).not.toContain("<script>alert");
    expect(html).not.toContain("<img src=x");
  });

  it("revoked, deleted-note, and unknown tokens serve one byte-identical 404", async () => {
    const { token } = (await (await mint(owner, docId)).json()) as { token: string };

    const del = await app.fetch(
      new Request(`http://local/api/notes/${docId}/public-link`, {
        method: "DELETE",
        headers: authHeaders(owner),
      }),
    );
    expect(del.status).toBe(200);

    const revoked = await app.request(`/p/${token}`);
    const unknown = await app.request(`/p/${"A".repeat(32)}`);
    const malformed = await app.request(`/p/not-a-token`);
    expect(revoked.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(malformed.status).toBe(404);
    const bodies = await Promise.all([revoked.text(), unknown.text(), malformed.text()]);
    expect(bodies[0]).toBe(bodies[1]);
    expect(bodies[1]).toBe(bodies[2]);

    // Soft-deleting the note kills a still-active link the same way.
    const { token: token2 } = (await (await mint(owner, docId)).json()) as { token: string };
    expect(token2).not.toBe(token); // re-create after revoke = NEW token
    await pool.query("UPDATE notes SET deleted_at = now() WHERE id = $1", [docId]);
    const deleted = await app.request(`/p/${token2}`);
    expect(deleted.status).toBe(404);
    expect(await deleted.text()).toBe(bodies[0]);
  });

  it("GET /api/notes/:docId/public-link reports { link | null }", async () => {
    const before = await app.fetch(
      new Request(`http://local/api/notes/${docId}/public-link`, {
        headers: authHeaders(owner),
      }),
    );
    expect(((await before.json()) as { link: unknown }).link).toBeNull();

    const { token } = (await (await mint(owner, docId)).json()) as { token: string };
    const after = await app.fetch(
      new Request(`http://local/api/notes/${docId}/public-link`, {
        headers: authHeaders(owner),
      }),
    );
    const body = (await after.json()) as { link: { token: string; url: string } };
    expect(body.link.token).toBe(token);
  });

  it("serves only images the note actually references, and only image mimes", async () => {
    docWriter.store.set(docId, "![pic](/attachments/ok.png)\n");
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    for (const [rel, mime] of [
      ["attachments/ok.png", "image/png"],
      ["attachments/secret.png", "image/png"], // exists but unreferenced
      ["attachments/page.html", "text/html"], // referenced check n/a — wrong mime
    ] as const) {
      await pool.query(
        `INSERT INTO blobs (id, vault_id, org_id, sha256, size, mime, data, rel_path, filename)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [randomUUID(), vault, orgId, randomUUID(), png.length, mime, png, rel, rel.split("/")[1]],
      );
    }
    const { token } = (await (await mint(owner, docId)).json()) as { token: string };

    const ok = await app.request(`/p/${token}/a/attachments/ok.png`);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe("image/png");
    expect(ok.headers.get("x-content-type-options")).toBe("nosniff");

    expect((await app.request(`/p/${token}/a/attachments/secret.png`)).status).toBe(404);
    expect((await app.request(`/p/${token}/a/attachments/page.html`)).status).toBe(404);
    expect((await app.request(`/p/${token}/a/../etc/passwd`)).status).toBe(404);
  });

  it("the page renders the embedded image through the token-scoped route", async () => {
    docWriter.store.set(docId, "![pic](/attachments/ok.png)");
    const { token } = (await (await mint(owner, docId)).json()) as { token: string };
    const html = await (await app.request(`/p/${token}`)).text();
    expect(html).toContain(`src="/p/${token}/a/attachments/ok.png"`);
  });
});
