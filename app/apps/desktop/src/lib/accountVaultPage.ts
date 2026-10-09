/* Account Settings → Vaults → one vault's page: which stat tiles, detail rows
   and actions it shows, from what the Vaults tab already knows. Pure, so the
   choices are tested without React. */
import type { BillingUsageVault } from "./api";
import { formatBytes } from "./billing";

export interface VaultPageTile {
  key: "people" | "notes" | "attachments" | "files";
  caption: string;
  /** null while loading (skeleton) or when the vault is not in the usage (dash). */
  value: string | null;
  sub: string;
}

/**
 * Stat tiles in the Plan & Billing "Usage on this account" style. `usage`
 * is this vault's row of `GET /api/billing/account/usage`, or null when the
 * vault is not on the caller's account (or billing is off).
 */
export function vaultPageTiles(usage: BillingUsageVault | null): VaultPageTile[] {
  const [bytesValue, bytesUnit] = usage ? formatBytes(usage.storageBytes ?? 0).split(" ") : [];
  const tiles: VaultPageTile[] = [
    {
      key: "people",
      caption: "People",
      value: usage ? String(usage.people) : null,
      sub: usage && usage.people === 1 ? "person" : "people",
    },
    {
      key: "notes",
      caption: "Notes",
      value: usage ? String(usage.notes) : null,
      sub: usage && usage.notes === 1 ? "note" : "notes",
    },
    {
      key: "attachments",
      caption: "Attachments",
      value: usage ? (bytesValue ?? "0") : null,
      sub: usage ? (bytesUnit ?? "B") : "stored",
    },
  ];
  if (usage && typeof usage.files === "number") {
    tiles.push({
      key: "files",
      caption: "Files",
      value: String(usage.files),
      sub: usage.files === 1 ? "file" : "files",
    });
  }
  return tiles;
}

export type VaultRole = "owner" | "admin" | "member";

export const ROLE_TEXT: Record<VaultRole, string> = {
  owner: "Owner",
  admin: "Admin",
  member: "Member",
};

/**
 * The caller's role, from what is known: the active vault's member list
 * names it; a vault on the caller's own billing account is one they own;
 * anything else is unknown.
 */
export function vaultPageRole(input: {
  activeRole: string | null;
  onMyAccount: boolean;
}): VaultRole | null {
  const r = input.activeRole;
  if (r === "owner" || r === "admin" || r === "member") return r;
  return input.onMyAccount ? "owner" : null;
}

/** "On your Team account" / "On Sara's account" / "On the owner's account". */
export function vaultPagePlanLine(input: {
  onMyAccount: boolean;
  accountPlan: "free" | "team" | null;
  ownerName: string | null;
}): string {
  if (input.onMyAccount) {
    return input.accountPlan === "team"
      ? "On your Team account"
      : input.accountPlan === "free"
        ? "On your Free account"
        : "On your account";
  }
  return input.ownerName ? `On ${input.ownerName}'s account` : "On the owner's account";
}

export interface VaultPageDetail {
  key: "role" | "plan" | "folder" | "created";
  label: string;
  value: string;
}

export function vaultPageDetails(input: {
  role: VaultRole | null;
  /** null when billing is off: there is no account to name. */
  planLine: string | null;
  folderPath: string | null;
  createdAt: string | null | undefined;
  formatDate: (iso: string) => string;
}): VaultPageDetail[] {
  const rows: VaultPageDetail[] = [
    { key: "role", label: "Your role", value: input.role ? ROLE_TEXT[input.role] : "—" },
  ];
  if (input.planLine) rows.push({ key: "plan", label: "Plan", value: input.planLine });
  rows.push({
    key: "folder",
    label: "Folder on this device",
    value: input.folderPath ?? "Not on this device",
  });
  if (input.createdAt && !Number.isNaN(Date.parse(input.createdAt))) {
    rows.push({ key: "created", label: "Created", value: input.formatDate(input.createdAt) });
  }
  return rows;
}

/**
 * "Open Vault Settings": the open vault opens straight away, a vault with a
 * folder here is switched to first, and one never opened on this device
 * cannot be (switching needs a folder), so the action is disabled with a hint.
 * The same rule as the Plan tab's invited-seat chips (`invitedChipAction`).
 */
export function vaultSettingsAction(input: {
  isOpen: boolean;
  boundPath: string | null;
}): "open" | "switch-then-open" | "unavailable" {
  if (input.isOpen) return "open";
  return input.boundPath ? "switch-then-open" : "unavailable";
}

export const VAULT_SETTINGS_UNAVAILABLE_HINT =
  "Switch to this vault first: it has no folder on this device yet.";

/** Keep the menu's order, but every destructive action goes last. */
export function orderPageActions<T extends { danger?: boolean }>(actions: T[]): T[] {
  return [...actions.filter((a) => !a.danger), ...actions.filter((a) => a.danger)];
}
