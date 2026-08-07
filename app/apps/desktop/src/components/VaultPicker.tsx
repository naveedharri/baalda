import { useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence, useReducedMotion } from "motion/react";
import type { VaultInfo, RecentVault } from "../lib/ipc";
import * as ipc from "../lib/ipc";
import {
  readKnownVaults,
  readOrgVaults,
  requestOpenVault,
  useStore,
} from "../store";
import { AuthDialog } from "./AccountMenu";
import { Wordmark } from "./Logo";
import { Spinner } from "./Spinner";

/**
 * A row in the welcome-screen list: either a plain local folder (a recent vault
 * on disk) or a synced *remote* vault (an org). Remote rows carry the org id
 * so a click can reopen + resync them — prompting sign-in first if signed out.
 */
type PickerEntry =
  | { kind: "local"; key: string; name: string; path: string; openedAt: number }
  | { kind: "remote"; key: string; name: string; path: string | null; orgId: string };

// Springs tuned for small UI: snappy but soft-landing (no rubber-banding).
const SPRING = { type: "spring", stiffness: 300, damping: 24 } as const;
const EASE_OUT = [0.16, 1, 0.3, 1] as const;

/** Splash entrance: the wordmark resolves out of a blur, rising and settling
 *  in ~550ms. Everything else waits, then fades in quietly underneath. */
const logoVariants = {
  hidden: { opacity: 0, y: 20, scale: 0.92, filter: "blur(14px)" },
  show: {
    opacity: 1,
    y: 0,
    scale: 1,
    filter: "blur(0px)",
    transition: { duration: 0.55, ease: EASE_OUT },
  },
};

// Delayed reveal for the actions + hint, after the logo has landed.
const REVEAL_DELAY = 1.1;
const revealTransition = (delay: number) => ({
  delay,
  duration: 0.7,
  ease: EASE_OUT,
});

/** Slow ambient drift for one aurora blob; each gets its own phase. */
function auroraDrift(dx: number, dy: number, duration: number) {
  return {
    x: [0, dx, -dx * 0.6, 0],
    y: [0, -dy, dy * 0.5, 0],
    scale: [1, 1.12, 0.94, 1],
    transition: { duration, repeat: Infinity, ease: "easeInOut" as const },
  };
}

/** Compact "time since" label for a recent vault, e.g. "just now", "3h ago". */
function relativeTime(ms: number): string {
  if (!ms) return "";
  const sec = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (sec < 45) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  const mo = Math.floor(day / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(mo / 12)}y ago`;
}

/** Collapse a home-prefixed path for display: /Users/x/Notes → ~/Notes. */
function tidyPath(path: string): string {
  const m = path.match(/^(\/Users\/[^/]+|\/home\/[^/]+|C:\\Users\\[^\\]+)(.*)$/);
  return m ? "~" + m[2] : path;
}

export function VaultPicker() {
  const authStatus = useStore((s) => s.authStatus);
  // Sign-in succeeded and a vault is being resolved/created. There's no vault
  // yet, so App still renders this screen — and without saying so, a sign-in
  // that is working looks identical to one that silently did nothing.
  const landingVault = useStore((s) => s.landingVault);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recents, setRecents] = useState<RecentVault[]>([]);
  // When a signed-out user clicks a remote vault we open the sign-in modal;
  // the vault to land in afterwards is stashed via requestOpenVault().
  const [signInOpen, setSignInOpen] = useState(false);
  // New-vault flow: null = idle; a string = chosen parent, awaiting a name.
  const [newParent, setNewParent] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  // Which recent-vault card is being opened, by its key. A single boolean would
  // only tell the list to grey out; the point is to mark the row you clicked.
  const [opening, setOpening] = useState<string | null>(null);
  // Recents are collapsed to the 3 most recent; "Load more" reveals the rest
  // inside a scroll area locked to the collapsed height so the logo/buttons
  // above never shift (the vault-picker card is vertically centered).
  const [showAllRecents, setShowAllRecents] = useState(false);
  const recentScrollRef = useRef<HTMLDivElement>(null);
  const [lockedHeight, setLockedHeight] = useState<number | null>(null);
  const reduceMotion = useReducedMotion();

  // Surface recently opened vaults as one-tap "reopen" affordances.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const list = await ipc.getRecentVaults();
        if (alive) setRecents(list);
      } catch {
        /* no recents — ignore */
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  async function openVault(vault: VaultInfo | null) {
    if (!vault) return;
    // Rust already opened it (these are the picker/create commands), so the store
    // retires the previous vault's sync and reloads view state from the new one.
    await useStore.getState().adoptOpenedVault(vault);
  }

  // "Open existing": native folder picker → open the chosen vault.
  async function pickExisting() {
    setBusy(true);
    setError(null);
    try {
      const vault = await ipc.pickVault();
      await openVault(vault);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  // "New vault": ask for a name, nothing else.
  //
  // It used to open a folder picker first, which was a question with one
  // sensible answer — every vault we create lives under the vaults root
  // anyway, so choosing its parent was ceremony. Adopting a folder you already
  // have is what "Open existing" is for, and that one keeps the folder exactly
  // where you picked it.
  async function startNewVault() {
    setError(null);
    try {
      setNewParent(await ipc.getVaultsRoot());
      setNewName("");
    } catch (e) {
      setError(String(e));
    }
  }

  // "New vault" step 2: create <vaults root>/<name> and open it.
  async function confirmNewVault() {
    if (!newParent || !newName.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const vault = await ipc.createVault(newParent, newName.trim());
      await openVault(vault);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  function cancelNewVault() {
    setNewParent(null);
    setNewName("");
    setError(null);
  }

  async function reopenLocal(path: string) {
    setBusy(true);
    setError(null);
    try {
      await useStore.getState().openLocalVault(path);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  // Open a vault row. Local folders open in place. A remote (synced)
  // vault needs a session: if we still have one, switch straight to it
  // (opening its folder + resyncing); if we're signed out, remember it and
  // prompt sign-in — landInLastVault opens it once the session lands.
  async function openEntry(e: PickerEntry) {
    setOpening(e.key);
    try {
      if (e.kind === "local") {
        await reopenLocal(e.path);
        return;
      }
      if (authStatus === "signed-in") {
        setBusy(true);
        setError(null);
        try {
          await useStore.getState().setActiveOrganization(e.orgId);
        } catch (err) {
          setError(String(err));
        } finally {
          setBusy(false);
        }
      } else {
        requestOpenVault(e.orgId);
        setSignInOpen(true);
      }
    } finally {
      setOpening(null);
    }
  }

  async function forget(path: string) {
    setRecents((rs) => rs.filter((r) => r.path !== path));
    try {
      await ipc.removeRecentVault(path);
    } catch {
      /* best-effort; UI already updated */
    }
  }

  // Freeze the scroll box at the collapsed 3-card height before revealing the
  // rest, so the list scrolls internally instead of growing the (centered) card.
  function expandRecents() {
    setLockedHeight(recentScrollRef.current?.offsetHeight ?? null);
    setShowAllRecents(true);
  }
  function collapseRecents() {
    setShowAllRecents(false);
    setLockedHeight(null);
  }

  const naming = newParent !== null;
  // The naming step or the post-sign-in landing is showing — hide the
  // recents/hint/sign-in behind it. Offering "New vault" while we are already
  // making one is how you end up with two.
  const inFlow = naming || landingVault;

  // Merge synced (remote) vaults with local recents into one list. Remote
  // vaults come from the locally-cached org list (survives sign-out) and are
  // shown first; their bound folder — if any — comes from the org→folder map.
  // Local recents backing a synced vault are folded into the remote row (by
  // path) so nothing shows twice.
  const entries = useMemo<PickerEntry[]>(() => {
    const known = readKnownVaults();
    const orgVaults = readOrgVaults();
    const boundPaths = new Set(Object.values(orgVaults));
    const remote: PickerEntry[] = known.map((w) => ({
      kind: "remote",
      key: `org:${w.id}`,
      name: w.name,
      path: orgVaults[w.id] ?? null,
      orgId: w.id,
    }));
    const local: PickerEntry[] = recents
      .filter((r) => !boundPaths.has(r.path))
      .map((r) => ({
        kind: "local",
        key: r.path,
        name: r.name,
        path: r.path,
        openedAt: r.openedAt,
      }));
    return [...remote, ...local];
  }, [recents]);

  // Show the 3 most recent by default; the rest hide behind "Load more".
  const RECENT_LIMIT = 3;
  const shownRecents = showAllRecents ? entries : entries.slice(0, RECENT_LIMIT);
  const hiddenRecents = entries.length - RECENT_LIMIT;

  return (
    <div className="vault-picker">
      {/* Ambient aurora — three blurred color fields drifting very slowly. */}
      {!reduceMotion && (
        <div className="aurora" aria-hidden="true">
          <motion.span className="aurora-blob a1" animate={auroraDrift(60, 40, 26)} />
          <motion.span className="aurora-blob a2" animate={auroraDrift(-50, 55, 32)} />
          <motion.span className="aurora-blob a3" animate={auroraDrift(45, -35, 38)} />
        </div>
      )}

      <div className="vault-picker-card">
        <motion.h1
          className="product-name"
          variants={logoVariants}
          initial={reduceMotion ? false : "hidden"}
          animate="show"
          whileHover={reduceMotion ? undefined : { scale: 1.02 }}
          transition={SPRING}
        >
          <Wordmark />
        </motion.h1>

        <motion.div
          className="vault-actions"
          initial={reduceMotion ? false : { opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={reduceMotion ? undefined : revealTransition(REVEAL_DELAY)}
        >
          <AnimatePresence mode="wait" initial={false}>
            {landingVault ? (
              // ---- Signed in, opening (or creating) their vault. This screen
              //      is still up only because there is no vault yet; say so,
              //      or a working sign-in is indistinguishable from one that
              //      dropped the user straight back here. ----
              <motion.div
                key="landing"
                className="picker-landing"
                initial={reduceMotion ? false : { opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={reduceMotion ? undefined : { opacity: 0, y: -8 }}
                transition={SPRING}
              >
                <Spinner size="sm" tone="accent" />
                <p className="picker-landing-label" role="status">
                  Opening your vault…
                </p>
              </motion.div>
            ) : naming ? (
              // ---- Naming step: only reached via "Create inside" an existing
              //      vault, where a nested vault does need its own folder name.
              //      The normal "New vault" flow skips this — the picked folder
              //      is the vault. ----
              <motion.form
                key="naming"
                className="new-vault-form"
                initial={reduceMotion ? false : { opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={reduceMotion ? undefined : { opacity: 0, y: -8 }}
                transition={SPRING}
                onSubmit={(e) => {
                  e.preventDefault();
                  void confirmNewVault();
                }}
              >
                <label className="new-vault-label">Name your vault</label>
                {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
                <input
                  className="new-vault-input"
                  autoFocus
                  value={newName}
                  disabled={busy}
                  onChange={(e) => setNewName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") cancelNewVault();
                  }}
                  placeholder="Untitled Vault"
                  spellCheck={false}
                />
                <p className="new-vault-loc" title={newParent ?? undefined}>
                  in <code>{tidyPath(newParent ?? "")}</code>
                </p>
                <div className="new-vault-buttons">
                  <button
                    type="button"
                    className="ghost-pill"
                    disabled={busy}
                    onClick={cancelNewVault}
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className={`primary sm${busy ? " is-busy" : ""}`}
                    disabled={busy || !newName.trim()}
                    aria-busy={busy || undefined}
                  >
                    {/* Creating a vault writes the folder, opens it, and seeds
                        ~20 starter notes — comfortably past the point where a
                        static label reads as a stuck button. */}
                    <span className="async-btn-label">
                      {busy ? "Creating…" : "Create vault"}
                    </span>
                    {busy && <Spinner size="xs" tone="on-accent" />}
                  </button>
                </div>
              </motion.form>
            ) : (
              // ---- Default: two primary actions ----
              <motion.div
                key="actions"
                className="vault-primary-actions"
                initial={reduceMotion ? false : { opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={reduceMotion ? undefined : { opacity: 0 }}
                transition={SPRING}
              >
                <motion.button
                  className="primary hero"
                  disabled={busy}
                  onClick={startNewVault}
                  whileHover={reduceMotion ? undefined : { scale: 1.04, y: -1 }}
                  whileTap={reduceMotion ? undefined : { scale: 0.96 }}
                  transition={SPRING}
                >
                  New vault
                </motion.button>
                <motion.button
                  className={`ghost-pill lg${busy ? " is-busy" : ""}`}
                  disabled={busy}
                  aria-busy={busy || undefined}
                  onClick={pickExisting}
                  whileHover={reduceMotion ? undefined : { scale: 1.03, y: -1 }}
                  whileTap={reduceMotion ? undefined : { scale: 0.97 }}
                  transition={SPRING}
                >
                  <span className="async-btn-label">
                    {busy ? "Opening…" : "Open existing"}
                  </span>
                  {busy && <Spinner size="xs" tone="neutral" />}
                </motion.button>
              </motion.div>
            )}
          </AnimatePresence>
        </motion.div>

        {error && <p className="error">{error}</p>}

        {!inFlow && entries.length > 0 && (
          <motion.div
            className="recent-list"
            initial={reduceMotion ? false : { opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={
              reduceMotion ? undefined : revealTransition(REVEAL_DELAY + 0.15)
            }
          >
            <p className="recent-heading">Recent vaults</p>
            <div
              ref={recentScrollRef}
              className={`recent-scroll${showAllRecents ? " expanded" : ""}`}
              style={
                showAllRecents && lockedHeight ? { height: lockedHeight } : undefined
              }
            >
              {shownRecents.map((e) => (
                <div
                  className={`recent-card${opening === e.key ? " is-opening" : ""}`}
                  key={e.key}
                >
                  <button
                    className="recent-open"
                    disabled={busy}
                    aria-busy={opening === e.key || undefined}
                    onClick={() => void openEntry(e)}
                    title={e.path ?? e.name}
                  >
                    <span className="recent-name">{e.name}</span>
                    {/* The card the user clicked reports for itself. A single
                        shared `busy` flag only greyed every row out, which says
                        "the list is disabled" rather than "this one is opening"
                        — and opening a vault is seconds of work. */}
                    {opening === e.key ? (
                      <Spinner size="xs" tone="accent" className="recent-badge" />
                    ) : e.kind === "remote" ? (
                      <span className="ws-badge synced recent-badge">Remote</span>
                    ) : e.openedAt > 0 ? (
                      <span className="recent-time">{relativeTime(e.openedAt)}</span>
                    ) : null}
                    <span className="recent-path">
                      {opening === e.key
                        ? "Opening…"
                        : e.path
                          ? tidyPath(e.path)
                          : "Synced · sign in to open"}
                    </span>
                  </button>
                  {e.kind === "local" && (
                    <button
                      className="recent-remove"
                      aria-label={`Remove ${e.name} from recents`}
                      title="Remove from recents"
                      disabled={busy}
                      onClick={() => forget(e.path)}
                    >
                      ×
                    </button>
                  )}
                </div>
              ))}
            </div>
            {hiddenRecents > 0 && (
              <button
                className="recent-more"
                disabled={busy}
                onClick={showAllRecents ? collapseRecents : expandRecents}
              >
                {showAllRecents ? "Show less" : `Load more (${hiddenRecents})`}
              </button>
            )}
          </motion.div>
        )}

        {!inFlow && (
          <motion.p
            className="hint"
            initial={reduceMotion ? false : { opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={
              reduceMotion ? undefined : revealTransition(REVEAL_DELAY + 0.3)
            }
          >
            A vault is any folder of <code>.md</code> files.
          </motion.p>
        )}

        {/*
          Sign-in lives with the hint text, under the primary actions, because
          that is where someone looks after deciding the two buttons above
          aren't what they came for.

          Before this existed the ONLY route to an account from this screen was
          clicking a "Remote" vault card — and those come from a locally-cached
          org list, so a fresh install had none and therefore no route at all.
          Signing in meant first creating a local vault you didn't want, purely
          to reach the sidebar menu: exactly backwards for a teammate whose
          whole reason for opening the app is to join a shared vault.

          A quiet link rather than a third button beside "New vault" / "Open
          existing": an account is optional in a local-first app and shouldn't
          compete with the primary choice.
        */}
        {!inFlow && authStatus !== "signed-in" && (
          <motion.p
            className="hint picker-signin"
            initial={reduceMotion ? false : { opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={
              reduceMotion ? undefined : revealTransition(REVEAL_DELAY + 0.36)
            }
          >
            Have an account?{" "}
            <button
              type="button"
              className="linkish"
              // "unknown" is the pre-restore state — the session is still being
              // read from the keychain, so offering sign-in would flash a
              // control that's about to become unnecessary.
              disabled={busy || authStatus === "unknown"}
              onClick={() => setSignInOpen(true)}
            >
              Sign in
            </button>{" "}
            to sync and collaborate.
          </motion.p>
        )}
      </div>

      {signInOpen && (
        <AuthDialog
          // Success: keep the pending open target — the store's post-sign-in
          // landing opens exactly that vault. Just dismiss the modal.
          onSignedIn={() => setSignInOpen(false)}
          // Cancel: drop the pending target so a later sign-in from elsewhere
          // doesn't surprise-open this vault.
          onClose={() => {
            requestOpenVault(null);
            setSignInOpen(false);
          }}
        />
      )}
    </div>
  );
}
