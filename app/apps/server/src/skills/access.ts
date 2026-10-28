// SPDX-License-Identifier: Apache-2.0
import type pg from "pg";
import { pool } from "../db/pool.js";
import { SkillError } from "./validate.js";
import type {
  MemberSkillAccess,
  SkillAccessLevel,
  SkillAccessList,
  SkillAudience,
  SkillDelivery,
  SkillRole,
} from "./types.js";

/**
 * Who gets a team skill (migration 062, docs/SKILLS.md "Who gets a skill").
 *
 * The Everyone row is the skill's `delivery`, or No access when
 * `everyone_access` is 'none'. A person's own `skill_member_access` row beats
 * it either way. The effective level decides everything a person receives:
 * the manifest (what installs), the catalog, a skill's page and versions, and
 * MCP. Owners and admins always see every skill to manage it, but their own
 * effective level still decides what installs on their computer.
 */

export const LEVELS: readonly SkillAccessLevel[] = ["required", "optional", "none"];
export function isAccessLevel(v: unknown): v is SkillAccessLevel {
  return typeof v === "string" && (LEVELS as readonly string[]).includes(v);
}

/** Who is asking: their own level comes from their row, else the Everyone row. */
export type SkillViewer = { userId: string; role: SkillRole };

export function everyoneLevel(row: { delivery: SkillDelivery; everyone_access: string }): SkillAccessLevel {
  return row.everyone_access === "none" ? "none" : row.delivery;
}

/** The caller's effective level, given `s` (skills) and the join below. */
export const MY_LEVEL_SQL = `COALESCE(sma.level, CASE WHEN s.everyone_access = 'none' THEN 'none' ELSE s.delivery END)`;
/** `param` names the user id placeholder; a null user matches no row. */
export function myLevelJoin(param: string): string {
  return `LEFT JOIN skill_member_access sma ON sma.skill_id = s.id AND sma.user_id = ${param}`;
}

type Db = pg.Pool | pg.PoolClient;

export type OrgMember = { id: string; name: string; email: string; image: string | null; role: SkillRole };

/** Everyone in the org, by name. */
export async function orgMembers(db: Db, orgId: string): Promise<OrgMember[]> {
  const { rows } = await db.query<{ id: string; name: string | null; email: string; image: string | null; role: string }>(
    `SELECT u.id, u.name, u.email, u.image, m.role
       FROM member m JOIN "user" u ON u.id = m."userId"
      WHERE m."organizationId" = $1
      ORDER BY lower(coalesce(u.name, u.email)), u.id`,
    [orgId],
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name ?? "",
    email: r.email,
    image: r.image,
    role: r.role === "owner" || r.role === "admin" ? r.role : "member",
  }));
}

/** Per-person rows for these skills: skill id → user id → level. */
export async function personalLevels(db: Db, skillIds: string[]): Promise<Map<string, Map<string, SkillAccessLevel>>> {
  const out = new Map<string, Map<string, SkillAccessLevel>>();
  if (skillIds.length === 0) return out;
  const { rows } = await db.query<{ skill_id: string; user_id: string; level: SkillAccessLevel }>(
    "SELECT skill_id, user_id, level FROM skill_member_access WHERE skill_id = ANY($1)",
    [skillIds],
  );
  for (const r of rows) {
    const m = out.get(r.skill_id) ?? new Map<string, SkillAccessLevel>();
    m.set(r.user_id, r.level);
    out.set(r.skill_id, m);
  }
  return out;
}

/** How many of the org's members get a skill, and the first few of them. */
export const AUDIENCE_SAMPLE = 5;
export function audienceOf(
  everyone: SkillAccessLevel,
  members: OrgMember[],
  own: Map<string, SkillAccessLevel> | undefined,
): SkillAudience {
  const having = members.filter((m) => (own?.get(m.id) ?? everyone) !== "none");
  return {
    everyone: having.length === members.length,
    count: having.length,
    total: members.length,
    people: having.slice(0, AUDIENCE_SAMPLE).map((m) => ({ id: m.id, name: m.name, image: m.image })),
  };
}

type AccessRow = { id: string; delivery: SkillDelivery; everyone_access: string };

async function liveSkill(db: Db, orgId: string, skillId: string, lock: boolean): Promise<AccessRow> {
  const { rows } = await db.query<AccessRow>(
    `SELECT id, delivery, everyone_access FROM skills
      WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL ${lock ? "FOR UPDATE" : ""}`,
    [skillId, orgId],
  );
  if (!rows[0]) throw new SkillError(404, { error: "skill_not_found" });
  return rows[0];
}

/** A skill's Shared with list: the Everyone row and every member's level. */
export async function getSkillAccess(orgId: string, skillId: string, db: Db = pool): Promise<SkillAccessList> {
  const row = await liveSkill(db, orgId, skillId, false);
  const everyone = everyoneLevel(row);
  const members = await orgMembers(db, orgId);
  const own = (await personalLevels(db, [skillId])).get(skillId);
  return {
    everyone,
    people: members.map((m) => ({
      userId: m.id,
      name: m.name,
      email: m.email,
      image: m.image,
      role: m.role,
      level: own?.get(m.id) ?? everyone,
      own: own?.has(m.id) ?? false,
    })),
  };
}

export type SkillAccessChange = {
  everyone?: SkillAccessLevel;
  /** `null` = back to the Everyone row. */
  people?: { userId: string; level: SkillAccessLevel | null }[];
};

/**
 * One transaction: the Everyone row and any per-person rows. Everyone
 * Required/Optional sets `delivery` and opens the skill; No access keeps
 * `delivery` for when it opens again. People must be members of the org.
 */
export async function setSkillAccess(
  orgId: string,
  skillId: string,
  actorId: string,
  change: SkillAccessChange,
): Promise<SkillAccessList> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await liveSkill(client, orgId, skillId, true);
    if (change.everyone) {
      if (change.everyone === "none") {
        await client.query("UPDATE skills SET everyone_access = 'none', updated_at = now() WHERE id = $1", [skillId]);
      } else {
        await client.query(
          "UPDATE skills SET everyone_access = 'on', delivery = $2, updated_at = now() WHERE id = $1",
          [skillId, change.everyone],
        );
      }
    }
    const people = change.people ?? [];
    if (people.length > 0) {
      const ids = [...new Set(people.map((p) => p.userId))];
      const { rows } = await client.query<{ userId: string }>(
        `SELECT "userId" FROM member WHERE "organizationId" = $1 AND "userId" = ANY($2)`,
        [orgId, ids],
      );
      if (rows.length !== ids.length) throw new SkillError(400, { error: "not_member" });
      for (const p of people) {
        if (p.level === null) {
          await client.query("DELETE FROM skill_member_access WHERE skill_id = $1 AND user_id = $2", [skillId, p.userId]);
        } else {
          await client.query(
            `INSERT INTO skill_member_access (skill_id, user_id, level, set_by)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (skill_id, user_id) DO UPDATE SET level = EXCLUDED.level, set_by = EXCLUDED.set_by, set_at = now()`,
            [skillId, p.userId, p.level, actorId],
          );
        }
      }
    }
    const out = await getSkillAccess(orgId, skillId, client);
    await client.query("COMMIT");
    return out;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/** One person's level for every live skill of the org (a member's Skills tab). */
export async function memberSkillAccess(orgId: string, userId: string): Promise<MemberSkillAccess[]> {
  const { rows } = await pool.query<{
    id: string;
    name: string;
    description: string | null;
    latest_version: number | null;
    level: SkillAccessLevel;
    own: boolean;
    everyone: SkillAccessLevel;
  }>(
    `SELECT s.id, s.name, coalesce(lv.description, s.draft_description) AS description, s.latest_version,
            ${MY_LEVEL_SQL} AS level, sma.level IS NOT NULL AS own,
            CASE WHEN s.everyone_access = 'none' THEN 'none' ELSE s.delivery END AS everyone
       FROM skills s
       LEFT JOIN skill_versions lv ON lv.skill_id = s.id AND lv.version = s.latest_version
       ${myLevelJoin("$2")}
      WHERE s.organization_id = $1 AND s.deleted_at IS NULL
      ORDER BY s.name`,
    [orgId, userId],
  );
  return rows.map((r) => ({
    skillId: r.id,
    name: r.name,
    description: r.description ?? "",
    latestVersion: r.latest_version,
    level: r.level,
    own: r.own,
    everyone: r.everyone,
  }));
}
