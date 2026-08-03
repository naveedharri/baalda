// VaultScope — the generation token every vault-scoped async operation runs
// under. This is the fix for a whole class of data-corrupting vault-switch bugs.
//
// The problem it solves: `syncManager`, its `VaultRegistry`, `VaultDocStore`,
// `AttachmentSync` and their debounced timers are process singletons, while
// Rust holds ONE global vault slot. So any async work started for vault A that
// is still in flight when the user switches to vault B lands on B's folder with
// A's server ids — creating A's folders/notes on B's server rows, merging A's
// doc-id map into B's `.context/config.json`, materializing A's note paths as
// empty files inside B. Switching back merges the other direction.
//
// The rule: capture the scope you began under, and bail the moment
// `isCurrent()` is false — silently, no throw, because "the user moved on" is
// not an error. Belt and braces on top of correct teardown ordering, because a
// future call site WILL get the ordering wrong.
//
// This mirrors `BridgeManager.generation` (src/lib/bridge/adapter.ts), which
// already guards note switches the same way — same pattern, vault-wide.
//
// Deliberately a pure leaf module: no imports at all, so it is trivially
// testable and can be read by any layer (including `bridge/adapter.ts`) without
// creating a cycle.

export interface VaultScope {
  /** Bumped on EVERY vault switch / disable. Identity of this scope. */
  readonly generation: number;
  /**
   * Better Auth organization id (the user-facing vault). Empty string for a
   * plain local folder that isn't bound to any vault — a local vault still gets
   * a scope so the Rust epoch guard applies to it.
   */
  readonly orgId: string;
  /** Absolute local folder this scope is bound to. */
  readonly vaultPath: string;
  /**
   * The Rust `vault_epoch` this scope opened under (see `ipc.VaultInfo.epoch`),
   * or null when unknown. Pass it as `expectedEpoch` to every vault-relative
   * IPC write so Rust rejects the call instead of writing into another vault.
   */
  readonly vaultEpoch: number | null;
  /** Aborted when this scope stops being current. */
  readonly signal: AbortSignal;
  /** Postgres `vaults` row id (the note collection), once reconcile resolves it. */
  serverVaultId: string | null;
  /** False as soon as any vault switch / disable happened after this scope began. */
  isCurrent(): boolean;
}

/** The subset of the manager consumers need; injectable in tests. */
export interface VaultScopeSource {
  current(): VaultScope | null;
}

class Scope implements VaultScope {
  readonly signal: AbortSignal;
  serverVaultId: string | null = null;
  private readonly controller = new AbortController();

  constructor(
    readonly generation: number,
    readonly orgId: string,
    readonly vaultPath: string,
    readonly vaultEpoch: number | null,
    private readonly manager: VaultScopeManager,
  ) {
    this.signal = this.controller.signal;
  }

  isCurrent(): boolean {
    return this.manager.current() === this;
  }

  /** Internal: retire this scope. Aborting is what unblocks anything awaiting it. */
  abort(): void {
    if (!this.controller.signal.aborted) this.controller.abort();
  }
}

/**
 * Owns the one current scope. `begin` retires the previous scope first, so there
 * is never more than one live scope — exactly like `BridgeManager` keeping one
 * note slot.
 */
export class VaultScopeManager {
  private scope: Scope | null = null;
  private gen = 0;

  /** The generation counter. Changes on every begin/end, so a captured value
   *  that no longer matches means "a vault switch happened since". */
  get generation(): number {
    return this.gen;
  }

  current(): VaultScope | null {
    return this.scope;
  }

  /** Epoch to pin vault-relative IPC to, or null when no scope is active. */
  currentEpoch(): number | null {
    return this.scope?.vaultEpoch ?? null;
  }

  /** Convenience guard: is `scope` (possibly null) still the live one? A null
   *  scope means the caller isn't scoped at all, which is treated as current so
   *  unscoped callers and tests keep working unchanged. */
  isCurrent(scope: VaultScope | null | undefined): boolean {
    return scope == null || scope.isCurrent();
  }

  /**
   * Start a scope for a freshly-opened vault. Retires (aborts) the previous one
   * and bumps the generation, so every in-flight operation from the old vault
   * sees `isCurrent() === false` on its next checkpoint.
   */
  begin(input: {
    orgId: string | null;
    vaultPath: string;
    vaultEpoch?: number | null;
  }): VaultScope {
    this.end();
    const scope = new Scope(
      ++this.gen,
      input.orgId ?? "",
      input.vaultPath,
      input.vaultEpoch ?? null,
      this,
    );
    this.scope = scope;
    return scope;
  }

  /**
   * `begin`, but a no-op when the current scope is ALREADY for exactly this vault
   * (same folder and same Rust epoch) — it returns that scope untouched.
   *
   * This is what makes "a vault is now open" safe to signal more than once for a
   * single open, which the app genuinely does: Rust emits `vault-opened` *and*
   * returns the `VaultInfo` from `open_vault`, and Tauri does not guarantee which
   * of the two reaches JS first. A plain `begin` on the later one would retire a
   * richer scope — one `syncManager.enable` had already bound to an org — leaving
   * every sync guard reading stale and sync silently inert.
   *
   * `orgId` is deliberately NOT part of the comparison: a scope that has since
   * been bound to an org describes the same vault, and is the one worth keeping.
   */
  ensure(input: {
    orgId: string | null;
    vaultPath: string;
    vaultEpoch?: number | null;
  }): VaultScope {
    const cur = this.scope;
    if (
      cur &&
      cur.vaultPath === input.vaultPath &&
      cur.vaultEpoch === (input.vaultEpoch ?? null)
    ) {
      return cur;
    }
    return this.begin(input);
  }

  /**
   * Retire the current scope without starting a new one (sign-out, closing a
   * vault, `syncManager.disable()`). Bumps the generation so nothing from the
   * retired scope is ever "current" again.
   */
  end(): void {
    const prev = this.scope;
    this.scope = null;
    if (prev) {
      this.gen++;
      prev.abort();
    }
  }
}

/** Process-wide singleton (parallels `bridgeManager` / `syncManager`). */
export const vaultScopes = new VaultScopeManager();

/** Epoch of the current vault scope — the `expectedEpoch` to pin IPC to. */
export function currentVaultEpoch(): number | null {
  return vaultScopes.currentEpoch();
}

// ---------------------------------------------------------------------------
// Vault-scoped sync progress
// ---------------------------------------------------------------------------
// These describe the *observable* half of a vault's sync run. They live here,
// next to the scope, because they share its lifetime exactly: both are only ever
// meaningful for the vault that is current, and both MUST be dropped the instant
// it changes (see `vaultScopedSyncReset` in `store.ts`). Declared in this
// leaf module so the sync layer (which emits them) and the store (which mirrors
// them for React) can both import the types without an import cycle — the sync
// layer never imports the store, it pushes through listeners.

/**
 * Where a vault's sync run has got to.
 * - `registering` — reconciling structure with the server (folders/notes rows).
 * - `uploading` / `downloading` — moving doc content in the corresponding direction.
 * - `done` / `error` — terminal; `idle` means nothing has started.
 */
export type SyncProgressPhase =
  | "idle"
  | "registering"
  | "uploading"
  | "downloading"
  | "done"
  | "error";

/** Counted progress for the current vault's sync run. `null` when none is running. */
export interface SyncProgress {
  phase: SyncProgressPhase;
  /** Units finished (successfully or not) out of `total`. */
  done: number;
  total: number;
  /** Subset of `done` that failed — surfaced so a partial run isn't reported clean. */
  failed: number;
}

/**
 * Per-document sync state, for the sidebar badge.
 *
 * Always keyed by `docId`, NEVER by path: a note keeps one id across its `.md`
 * file, the local CRDT store, the SQLite row and the server row, while its path
 * changes on every rename/move. Keying by path would fork the state on rename
 * and — worse — collide across vaults, since two vaults both have `Welcome.md`.
 */
export type DocSyncState = "unsynced" | "queued" | "syncing" | "synced" | "error";
