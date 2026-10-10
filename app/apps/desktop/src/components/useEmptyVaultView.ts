import { useStore } from "../store";
import { emptyVaultState, type EmptyVaultState } from "../lib/emptyVaultState";

/** The store's inputs to `emptyVaultState`, plus the names its copy needs. */
export function useEmptyVaultView(): {
  state: EmptyVaultState;
  ownerName: string | null;
  vaultName: string | null;
  canCreateRoot: boolean | null;
} {
  const session = useStore((s) => s.session);
  const syncEnabled = useStore((s) => s.syncEnabled);
  const vaultSyncStatus = useStore((s) => s.vaultSyncStatus);
  const visibility = useStore((s) => s.vaultVisibility);
  const members = useStore((s) => s.members);
  const organizations = useStore((s) => s.organizations);
  const myId = session?.user.id ?? null;
  const orgId = session?.activeOrganizationId ?? null;
  const state = emptyVaultState({
    signedIn: session !== null,
    synced: syncEnabled && visibility !== null,
    live: vaultSyncStatus === "synced" || vaultSyncStatus === "read-only",
    readableItems: visibility?.readableItems ?? null,
    hiddenContent: visibility?.hiddenContent ?? null,
    isOwner: members.some((m) => m.userId === myId && m.role === "owner"),
  });
  const owner = members.find((m) => m.role === "owner");
  return {
    state,
    ownerName: owner?.user?.name || null,
    vaultName: organizations.find((o) => o.id === orgId)?.name ?? null,
    canCreateRoot: visibility?.canCreateRoot ?? null,
  };
}
