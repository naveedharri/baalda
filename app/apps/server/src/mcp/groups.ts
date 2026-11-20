// SPDX-License-Identifier: Apache-2.0
import {
  GroupError,
  addGroupMembers,
  createGroup,
  deleteGroup,
  listGroups,
  removeGroupMember,
  updateGroup,
} from "../groups/service.js";
import { announceSkillsChanged } from "../sync/member-events.js";
import { McpToolError, type McpContext } from "./service.js";

/** MCP twins of `routes/groups.ts`, through the same `groups/service.ts`. */

function groupError(error: unknown): never {
  if (error instanceof GroupError) {
    const code =
      error.status === 404 ? "not_found" : error.status === 403 ? "no_access" : error.code;
    throw new McpToolError(error.message, code);
  }
  throw error;
}

export async function listGroupsTool(ctx: McpContext) {
  try {
    return await listGroups(ctx.auth.organizationId, ctx.auth.userId);
  } catch (error) {
    groupError(error);
  }
}

const str = (args: Record<string, unknown>, key: string): string => {
  const v = args[key];
  if (typeof v !== "string" || !v) throw new McpToolError(`${key} is required`, "invalid_argument");
  return v;
};

export async function manageGroupTool(ctx: McpContext, args: Record<string, unknown>) {
  const org = ctx.auth.organizationId;
  const actor = ctx.auth.userId;
  const deps = { disconnectDoc: ctx.disconnectDoc, onAclChanged: ctx.onAclChanged };
  try {
    switch (args.action) {
      case "create":
        return await createGroup(org, actor, { name: args.name, memberIds: args.userIds }, deps);
      case "rename":
        await updateGroup(org, actor, str(args, "groupId"), { name: args.name });
        return { ok: true };
      case "delete": {
        const out = await deleteGroup(org, actor, str(args, "groupId"), deps);
        if (out.skillsChanged) await announceSkillsChanged(org);
        return { ok: true };
      }
      case "add_members": {
        const out = await addGroupMembers(org, actor, str(args, "groupId"), args.userIds, deps);
        if (out.skillsChanged) await announceSkillsChanged(org);
        return { added: out.added };
      }
      case "remove_member": {
        const out = await removeGroupMember(org, actor, str(args, "groupId"), str(args, "userId"), deps);
        if (out.skillsChanged) await announceSkillsChanged(org);
        return { removed: out.removed };
      }
      default:
        throw new McpToolError("action must be create, rename, delete, add_members or remove_member", "invalid_argument");
    }
  } catch (error) {
    groupError(error);
  }
}
