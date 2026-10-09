/**
 * What the last registry pull said about the caller's view of the open vault:
 * how many folders and notes they can read, whether the server is hiding
 * anything from them, and whether a root create would be allowed.
 *
 * Written by `registry.ts` after each listing, mirrored into the store
 * (`store.vaultVisibility`) for the empty states (`lib/emptyVaultState.ts`).
 * Dependency-free so the registry does not import the store.
 */
export interface VaultVisibility {
  /** The server collection id the pull was for. */
  vaultId: string;
  /** Readable folders + notes in that listing. */
  readableItems: number;
  /** null = the server did not answer (older server). */
  hiddenContent: boolean | null;
  /** null = the server did not answer (older server). */
  canCreateRoot: boolean | null;
}

type Listener = (v: VaultVisibility | null) => void;

let current: VaultVisibility | null = null;
const listeners = new Set<Listener>();

export const vaultVisibility = {
  get(): VaultVisibility | null {
    return current;
  },
  publish(next: VaultVisibility | null): void {
    if (
      current === next ||
      (current &&
        next &&
        current.vaultId === next.vaultId &&
        current.readableItems === next.readableItems &&
        current.hiddenContent === next.hiddenContent &&
        current.canCreateRoot === next.canCreateRoot)
    ) {
      return;
    }
    current = next;
    for (const l of listeners) l(current);
  },
  subscribe(l: Listener): () => void {
    listeners.add(l);
    return () => listeners.delete(l);
  },
};
