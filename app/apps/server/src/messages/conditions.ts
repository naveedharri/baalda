// Server-side conditions a message can require (spec `condition`). Each
// evaluator answers the vaults the condition holds for, from the context
// `service.ts` already loaded, so a condition adds no queries. An unknown
// name matches nobody: a typo must never show a message to everyone.
import type { MessageOrg, MessageUserContext } from "./audience.js";

export interface ConditionTarget {
  orgId: string;
  vaultId: string;
  vaultName: string;
}

type Evaluator = (ctx: MessageUserContext) => ConditionTarget[];

function target(org: MessageOrg): ConditionTarget {
  return { orgId: org.orgId, vaultId: org.vaultId as string, vaultName: org.orgName };
}

const REGISTRY: Record<string, Evaluator> = {
  // An owner of a keyed vault who has not saved (or confirmed holding) the
  // current key generation. A new generation asks again.
  "vault-key-not-saved": (ctx) =>
    ctx.orgs.filter((o) => o.role === "owner" && o.keyed && o.vaultId && !o.keySaved).map(target),
};

export function isKnownCondition(name: string): boolean {
  return Object.hasOwn(REGISTRY, name);
}

export function evaluateCondition(name: string, ctx: MessageUserContext): ConditionTarget[] {
  return isKnownCondition(name) ? REGISTRY[name](ctx) : [];
}
