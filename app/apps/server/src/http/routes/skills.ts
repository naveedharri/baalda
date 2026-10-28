// SPDX-License-Identifier: Apache-2.0
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { orgRole } from "../../permissions/lookup.js";
import { announceSkillsChanged } from "../../sync/member-events.js";
import {
  SKILL_BODY_LIMIT,
  SKILL_TOO_LARGE,
  SKILL_SOURCE_LABEL_MAX,
  SKILL_SOURCE_REF_RE,
  SkillError,
  decodeSkillFiles,
  isValidSkillName,
  isValidSourceRepo,
  parseSkillOrigin,
} from "../../skills/validate.js";
import {
  addSkillSource,
  asSkillRole,
  createSkill,
  getDraft,
  getSkillDetail,
  getVersion,
  isSkillAdmin,
  listSkillSources,
  listSkills,
  patchSkill,
  publishSkill,
  removeSkillSource,
  skillsManifest,
  softDeleteSkill,
  writeDraft,
} from "../../skills/store.js";
import type { SkillAccessLevel, SkillDelivery, SkillOrigin, SkillRole } from "../../skills/types.js";
import { getSession } from "../session.js";
import { getSkillAccess, isAccessLevel, memberSkillAccess, setSkillAccess, type SkillAccessChange } from "../../skills/access.js";

/**
 * Team skills (docs/SKILLS.md §3.3, migration 060). Any member reads the
 * catalog and published versions; owners/admins create, edit the draft,
 * publish, pin and delete. Every change to the catalog (create, publish,
 * delivery/pin, delete, a marketplace source) announces `skills-changed` on the
 * vault channel so open Skills pages update live; draft edits do not, since
 * drafts are never delivered and autosave would flood the channel.
 * Marketplace sources (`/skill-sources`) are a list of GitHub repos the
 * desktop imports from; the server never calls GitHub. Free on every plan.
 */
const ID_RE = /^[A-Za-z0-9._-]{1,128}$/;
const VERSION_RE = /^[1-9][0-9]{0,8}$/;

type Caller = { userId: string; orgId: string; role: SkillRole };

/** Session → org membership. A refusal is returned as a Response. */
async function caller(c: Context, admin: boolean): Promise<Caller | Response> {
  const session = await getSession(c);
  if (!session) return c.json({ error: "Authentication required" }, 401);
  const orgId = c.req.param("orgId") ?? "";
  if (!ID_RE.test(orgId)) return c.json({ error: "not_member" }, 404);
  const raw = await orgRole(orgId, session.userId);
  if (!raw) return c.json({ error: "not_member" }, 404);
  const role = asSkillRole(raw);
  if (admin && !isSkillAdmin(role)) return c.json({ error: "skills_admin_required" }, 403);
  return { userId: session.userId, orgId, role };
}

function skillIdParam(c: Context): string {
  const id = c.req.param("skillId") ?? "";
  if (!ID_RE.test(id)) throw new SkillError(404, { error: "skill_not_found" });
  return id;
}

async function jsonBody(c: Context): Promise<Record<string, unknown>> {
  const raw: unknown = await c.req.json().catch(() => null);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new SkillError(400, { error: "invalid_request" });
  }
  return raw as Record<string, unknown>;
}

function baseRevision(body: Record<string, unknown>): number {
  const r = body.baseRevision;
  if (typeof r !== "number" || !Number.isInteger(r)) throw new SkillError(400, { error: "invalid_request" });
  return r;
}

const filesBodyLimit = bodyLimit({
  maxSize: SKILL_BODY_LIMIT,
  onError: (c) => c.json(SKILL_TOO_LARGE, 413),
});

export function createSkillRoutes(): Hono {
  const routes = new Hono();

  routes.onError((err, c) => {
    if (err instanceof SkillError) return c.json(err.body, err.status);
    throw err;
  });

  // #1 — every org this user belongs to, with the effective version of each skill.
  routes.get("/skills/manifest", async (c) => {
    const session = await getSession(c);
    if (!session) return c.json({ error: "Authentication required" }, 401);
    return c.json(await skillsManifest(session.userId));
  });

  // #2
  routes.get("/orgs/:orgId/skills", async (c) => {
    const who = await caller(c, false);
    if (who instanceof Response) return who;
    return c.json({ role: who.role, skills: await listSkills(who.orgId, who) });
  });

  // #3 — not published yet, but admins' Skills pages list the new card.
  routes.post("/orgs/:orgId/skills", filesBodyLimit, async (c) => {
    const who = await caller(c, true);
    if (who instanceof Response) return who;
    const body = await jsonBody(c);
    if (!isValidSkillName(body.name)) return c.json({ error: "invalid_name" }, 400);
    const files = body.files === undefined ? undefined : decodeSkillFiles(body.files);
    const source = body.source === undefined ? null : parseSkillOrigin(body.source);
    const out = await createSkill(who.orgId, who.userId, body.name, files, source);
    await announceSkillsChanged(who.orgId);
    return c.json(out, 201);
  });

  // #4
  routes.get("/orgs/:orgId/skills/:skillId", async (c) => {
    const who = await caller(c, false);
    if (who instanceof Response) return who;
    return c.json(await getSkillDetail(who.orgId, skillIdParam(c), who));
  });

  // #5
  routes.patch("/orgs/:orgId/skills/:skillId", async (c) => {
    const who = await caller(c, true);
    if (who instanceof Response) return who;
    const skillId = skillIdParam(c);
    const body = await jsonBody(c);
    const patch: { delivery?: SkillDelivery; pinnedVersion?: number | null; source?: SkillOrigin | null } = {};
    if (body.delivery !== undefined) {
      if (body.delivery !== "required" && body.delivery !== "optional") {
        return c.json({ error: "invalid_request" }, 400);
      }
      patch.delivery = body.delivery;
    }
    if (body.pinnedVersion !== undefined) {
      const v = body.pinnedVersion;
      if (v !== null && (typeof v !== "number" || !Number.isInteger(v) || v < 1)) {
        return c.json({ error: "unknown_version" }, 400);
      }
      patch.pinnedVersion = v;
    }
    if (body.source !== undefined) patch.source = parseSkillOrigin(body.source);
    const out = await patchSkill(who.orgId, skillId, patch, who);
    await announceSkillsChanged(who.orgId);
    return c.json(out);
  });

  // #6
  routes.delete("/orgs/:orgId/skills/:skillId", async (c) => {
    const who = await caller(c, true);
    if (who instanceof Response) return who;
    await softDeleteSkill(who.orgId, skillIdParam(c), who.userId);
    await announceSkillsChanged(who.orgId);
    return c.json({ ok: true });
  });

  // #7
  routes.get("/orgs/:orgId/skills/:skillId/draft", async (c) => {
    const who = await caller(c, true);
    if (who instanceof Response) return who;
    return c.json(await getDraft(who.orgId, skillIdParam(c)));
  });

  // #8 replace all / #9 upsert + remove. Drafts are never delivered: no frame.
  routes.on(["PUT", "PATCH"], "/orgs/:orgId/skills/:skillId/draft", filesBodyLimit, async (c) => {
    const who = await caller(c, true);
    if (who instanceof Response) return who;
    const skillId = skillIdParam(c);
    const body = await jsonBody(c);
    const base = baseRevision(body);
    if (c.req.method === "PUT") {
      // A marketplace "pull update" sends the new `source` with the content it fetched.
      const files = decodeSkillFiles(body.files);
      const source = body.source === undefined ? undefined : parseSkillOrigin(body.source);
      return c.json(await writeDraft(who.orgId, skillId, who.userId, base, { kind: "replace", files, source }));
    }
    const upsert = body.upsert === undefined ? [] : decodeSkillFiles(body.upsert);
    const remove = body.remove ?? [];
    if (!Array.isArray(remove) || !remove.every((p) => typeof p === "string")) {
      return c.json({ error: "invalid_request" }, 400);
    }
    return c.json(
      await writeDraft(who.orgId, skillId, who.userId, base, { kind: "patch", upsert, remove: remove as string[] }),
    );
  });

  // #10 — draft := a published version.
  routes.post("/orgs/:orgId/skills/:skillId/draft/reset", async (c) => {
    const who = await caller(c, true);
    if (who instanceof Response) return who;
    const skillId = skillIdParam(c);
    const body = await jsonBody(c);
    const base = baseRevision(body);
    const version = body.version;
    if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
      return c.json({ error: "version_not_found" }, 404);
    }
    return c.json(await writeDraft(who.orgId, skillId, who.userId, base, { kind: "reset", version }));
  });

  // #11
  routes.post("/orgs/:orgId/skills/:skillId/publish", async (c) => {
    const who = await caller(c, true);
    if (who instanceof Response) return who;
    const skillId = skillIdParam(c);
    const body = await jsonBody(c);
    const base = baseRevision(body);
    const notes = body.notes ?? "";
    if (typeof notes !== "string") return c.json({ error: "invalid_notes" }, 400);
    const out = await publishSkill(who.orgId, skillId, who.userId, base, notes);
    await announceSkillsChanged(who.orgId);
    return c.json(out, 201);
  });

  // #12 — any published version, not only the effective one (history, zip).
  routes.get("/orgs/:orgId/skills/:skillId/versions/:version", async (c) => {
    const who = await caller(c, false);
    if (who instanceof Response) return who;
    const skillId = skillIdParam(c);
    const raw = c.req.param("version");
    if (!VERSION_RE.test(raw)) return c.json({ error: "version_not_found" }, 404);
    return c.json(await getVersion(who.orgId, skillId, Number(raw), who));
  });

  // ---- who gets a skill (migration 062). Owners/admins read and change it;
  // a change announces skills-changed, so every desktop refetches its manifest
  // and installs or removes the skill for the people it now reaches.

  routes.get("/orgs/:orgId/skills/:skillId/access", async (c) => {
    const who = await caller(c, true);
    if (who instanceof Response) return who;
    return c.json(await getSkillAccess(who.orgId, skillIdParam(c)));
  });

  // `everyone`: the Everyone row; `people`: per-person levels, `level: null`
  // to go back to the Everyone row. One transaction.
  routes.put("/orgs/:orgId/skills/:skillId/access", async (c) => {
    const who = await caller(c, true);
    if (who instanceof Response) return who;
    const skillId = skillIdParam(c);
    const body = await jsonBody(c);
    const change: SkillAccessChange = {};
    if (body.everyone !== undefined) {
      if (!isAccessLevel(body.everyone)) return c.json({ error: "invalid_request" }, 400);
      change.everyone = body.everyone;
    }
    if (body.people !== undefined) {
      const people = body.people;
      if (!Array.isArray(people) || people.length > 500) return c.json({ error: "invalid_request" }, 400);
      const parsed: NonNullable<SkillAccessChange["people"]> = [];
      for (const p of people as unknown[]) {
        const row = p as { userId?: unknown; level?: unknown } | null;
        if (!row || typeof row.userId !== "string" || !ID_RE.test(row.userId)) {
          return c.json({ error: "invalid_request" }, 400);
        }
        if (row.level !== null && !isAccessLevel(row.level)) return c.json({ error: "invalid_request" }, 400);
        parsed.push({ userId: row.userId, level: row.level === null ? null : (row.level as SkillAccessLevel) });
      }
      change.people = parsed;
    }
    const out = await setSkillAccess(who.orgId, skillId, who.userId, change);
    await announceSkillsChanged(who.orgId);
    return c.json(out);
  });

  // One person's level for every skill: their profile's Skills tab.
  // Owners/admins for anyone; a member for themselves.
  routes.get("/orgs/:orgId/members/:userId/skills", async (c) => {
    const who = await caller(c, false);
    if (who instanceof Response) return who;
    const userId = c.req.param("userId") ?? "";
    if (!ID_RE.test(userId)) return c.json({ error: "not_member" }, 404);
    if (userId !== who.userId && !isSkillAdmin(who.role)) return c.json({ error: "skills_admin_required" }, 403);
    if (!(await orgRole(who.orgId, userId))) return c.json({ error: "not_member" }, 404);
    const skills = await memberSkillAccess(who.orgId, userId);
    // A member's own list leaves out what is hidden from them.
    return c.json({ skills: isSkillAdmin(who.role) ? skills : skills.filter((s) => s.level !== "none" && s.latestVersion !== null) });
  });

  // ---- marketplace sources (Addendum — Marketplace import). A source changes
  // nothing any desktop installs; the frame only refreshes open Skills pages.

  routes.get("/orgs/:orgId/skill-sources", async (c) => {
    const who = await caller(c, false);
    if (who instanceof Response) return who;
    return c.json({ sources: await listSkillSources(who.orgId) });
  });

  routes.post("/orgs/:orgId/skill-sources", async (c) => {
    const who = await caller(c, true);
    if (who instanceof Response) return who;
    const body = await jsonBody(c);
    if (!isValidSourceRepo(body.repo)) return c.json({ error: "invalid_repo" }, 400);
    const ref = body.ref === undefined || body.ref === "" ? null : body.ref;
    if (ref !== null && (typeof ref !== "string" || !SKILL_SOURCE_REF_RE.test(ref))) {
      return c.json({ error: "invalid_ref" }, 400);
    }
    const rawLabel = body.label === undefined ? null : body.label;
    if (rawLabel !== null && (typeof rawLabel !== "string" || rawLabel.length > SKILL_SOURCE_LABEL_MAX)) {
      return c.json({ error: "invalid_label" }, 400);
    }
    const label = rawLabel?.trim() || null;
    const out = await addSkillSource(who.orgId, who.userId, { repo: body.repo, ref, label });
    await announceSkillsChanged(who.orgId);
    return c.json(out, 201);
  });

  routes.delete("/orgs/:orgId/skill-sources/:sourceId", async (c) => {
    const who = await caller(c, true);
    if (who instanceof Response) return who;
    const id = c.req.param("sourceId");
    if (!ID_RE.test(id)) return c.json({ error: "skill_source_not_found" }, 404);
    await removeSkillSource(who.orgId, id);
    await announceSkillsChanged(who.orgId);
    return c.json({ ok: true });
  });

  return routes;
}
