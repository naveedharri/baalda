/**
 * Which empty state a vault with no visible content should show.
 *
 * `nothing-shared` is the member who joined under "New members: No access"
 * (owner decision 2026-10-09): their sidebar is empty because nothing is
 * shared with them, not because the vault is empty, and "press ⌘N" would be
 * refused at the root. Every input has to agree before we say so; any doubt
 * (signed out, local vault, channel not live, an older server that never
 * answered `hiddenContent`) falls back to `none`, the ordinary prompt.
 */
export type EmptyVaultState = "none" | "empty-vault" | "nothing-shared";

export interface EmptyVaultInput {
  signedIn: boolean;
  /** The open folder is a synced vault and a registry pull has answered. */
  synced: boolean;
  /** The vault channel is connected and converged. */
  live: boolean;
  /** Readable folders + notes in the last listing; null = no listing yet. */
  readableItems: number | null;
  /** Server: the vault holds content this user cannot read. null = not said. */
  hiddenContent: boolean | null;
  isOwner: boolean;
}

export function emptyVaultState(input: EmptyVaultInput): EmptyVaultState {
  if (!input.signedIn || !input.synced || !input.live) return "none";
  if (input.readableItems === null || input.readableItems > 0) return "none";
  if (input.hiddenContent === null) return "none";
  if (input.hiddenContent && !input.isOwner) return "nothing-shared";
  if (!input.hiddenContent) return "empty-vault";
  return "none";
}

export const NOTHING_SHARED_TITLE = "Nothing is shared with you yet.";

export function nothingSharedBody(ownerName: string | null | undefined, vaultName: string | null | undefined): string {
  const owner = ownerName?.trim() || "The owner";
  const vault = vaultName?.trim() || "this vault";
  return `${owner} hasn't given you access to any folders or notes in ${vault}. Ask them to share something with you.`;
}

/** The editor's resting prompt; never mentions ⌘N when a root create would be refused. */
export function editorEmptyPrompt(canCreateRoot: boolean | null): string {
  return canCreateRoot === false ? "Select a note." : "Select a note, or press ⌘N to create one.";
}
