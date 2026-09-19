// SPDX-License-Identifier: Apache-2.0

import type { BulkAccessAudience, BulkAccessResource, TeamAccessMode } from "./api";
import type { AccessEntry } from "./accessTree";
import { accessResourceType } from "./accessTree";

export const vaultAccessKey = (orgId: string): string => `vault:${orgId}`;

export function accessEntryKey(entry: Pick<AccessEntry, "kind" | "id">): string {
  return `${entry.kind}:${entry.id}`;
}

/** Select the authoritative flat list, including descendants of collapsed folders. */
export function selectAllAccessEntries(entries: readonly AccessEntry[]): Set<string> {
  return new Set(entries.map(accessEntryKey));
}

/** Vault scope is exclusive; item scopes may be combined freely. */
export function toggleAccessSelection(
  selected: ReadonlySet<string>,
  key: string,
  vaultKey: string,
): Set<string> {
  if (key === vaultKey) return selected.has(key) ? new Set() : new Set([key]);
  const next = new Set(selected);
  next.delete(vaultKey);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}

export function selectedBulkResources(
  selected: ReadonlySet<string>,
  entries: readonly AccessEntry[],
  orgId: string,
): BulkAccessResource[] {
  if (selected.has(vaultAccessKey(orgId))) {
    return [{ resourceType: "vault", resourceId: orgId }];
  }
  return entries
    .filter((entry) => selected.has(accessEntryKey(entry)))
    .map((entry) => ({ resourceType: accessResourceType(entry.kind), resourceId: entry.id }));
}

export function buildBulkAccessInput(input: {
  resources: BulkAccessResource[];
  audienceType: "org" | "users";
  userIds: readonly string[];
  mode: TeamAccessMode;
}): { resources: BulkAccessResource[]; audience: BulkAccessAudience; mode: TeamAccessMode } {
  return {
    resources: input.resources,
    audience:
      input.audienceType === "org"
        ? { type: "org" }
        : { type: "users", userIds: [...input.userIds] },
    mode: input.mode,
  };
}

export function bulkChangeNeedsConfirmation(input: {
  resources: readonly BulkAccessResource[];
  audienceType: "org" | "users";
  mode: TeamAccessMode;
}): boolean {
  return (
    input.mode === "private" ||
    input.audienceType === "org" ||
    input.resources.length > 1 ||
    input.resources.some((resource) => resource.resourceType !== "file")
  );
}
