// The vault's skills catalog, shared for the session: the Skills tab primes it
// on every load, and the sidebar shortcut reads it (fetching once if the tab
// hasn't been opened yet). No polling: a new answer only arrives when the tab
// loads or the shortcut first asks.

import { useEffect, useState } from "react";
import type { ApiClient } from "../api";
import type { SkillsCatalog } from "./types";

const cache = new Map<string, SkillsCatalog>();
const asked = new Set<string>();
const listeners = new Set<() => void>();

export function primeCatalog(orgId: string, catalog: SkillsCatalog): void {
  cache.set(orgId, catalog);
  for (const l of listeners) l();
}

/** This vault's catalog, or null until known. One fetch per vault per session, at most. */
export function useCatalog(api: ApiClient, orgId: string | null, enabled: boolean): SkillsCatalog | null {
  const [, tick] = useState(0);
  useEffect(() => {
    const l = () => tick((n) => n + 1);
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);
  useEffect(() => {
    if (!orgId || !enabled || cache.has(orgId) || asked.has(orgId)) return;
    asked.add(orgId);
    api.listSkills(orgId).then(
      (c) => primeCatalog(orgId, c),
      () => asked.delete(orgId),
    );
  }, [api, orgId, enabled]);
  return orgId ? cache.get(orgId) ?? null : null;
}
