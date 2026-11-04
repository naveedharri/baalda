// Where an `open-settings` action may go. A fixed map: a message names a
// target, never a route, so a server cannot point the app anywhere it was not
// built to go. An unknown target hides the action (`select.ts knownTarget`).

import type { AccountSettingsTab, SettingsTab } from "../settingsTabs";
import { useStore } from "../../store";

const VAULT_TABS: readonly SettingsTab[] = [
  "general",
  "dashboards",
  "members",
  "billing",
  "mcp",
  "skills",
  "versioning",
  "import-export",
  "appearance",
];
const ACCOUNT_TABS: readonly AccountSettingsTab[] = [
  "profile",
  "status",
  "appearance",
  "notifications",
  "ai-tools",
  "connection",
  "plan",
  "vaults",
  "about",
];
/** Sections a vault tab can scroll to (`data-settings-section`). */
const VAULT_SECTIONS: Readonly<Record<string, readonly string[]>> = { general: ["security"] };

type Parsed = { scope: "vault"; tab: SettingsTab; section?: string } | { scope: "account"; tab: AccountSettingsTab };

export function parseTarget(target: string): Parsed | null {
  const m = /^(vault|account):([a-z-]+)(?:#([a-z-]+))?$/.exec(target ?? "");
  if (!m) return null;
  const [, scope, tab, section] = m;
  if (scope === "vault") {
    if (!VAULT_TABS.includes(tab as SettingsTab)) return null;
    if (section && !VAULT_SECTIONS[tab]?.includes(section)) return null;
    return { scope, tab: tab as SettingsTab, ...(section ? { section } : {}) };
  }
  if (section || !ACCOUNT_TABS.includes(tab as AccountSettingsTab)) return null;
  return { scope: "account", tab: tab as AccountSettingsTab };
}

export function isKnownTarget(target: string): boolean {
  return parseTarget(target) != null;
}

/** Open the target. False when it is not one this build knows. */
export function openTarget(target: string): boolean {
  const parsed = parseTarget(target);
  if (!parsed) return false;
  const s = useStore.getState();
  if (parsed.scope === "account") s.requestAccountSettings(parsed.tab);
  else s.requestSettings(parsed.tab, parsed.section);
  return true;
}
