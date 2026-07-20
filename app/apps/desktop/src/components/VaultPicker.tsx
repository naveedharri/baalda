import { useEffect, useState } from "react";
import { motion, AnimatePresence, useReducedMotion } from "motion/react";
import type { VaultInfo, RecentVault } from "../lib/ipc";
import * as ipc from "../lib/ipc";
import { useStore } from "../store";
import { Wordmark } from "./Logo";

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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recents, setRecents] = useState<RecentVault[]>([]);
  // New-vault flow: null = idle; a string = chosen parent, awaiting a name.
  const [newParent, setNewParent] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  // When "New vault" lands on a folder that's already a vault, hold its path so
  // we can offer to open it instead of nesting a new empty vault inside it.
  const [alreadyVault, setAlreadyVault] = useState<string | null>(null);
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
    useStore.getState().setVault(vault);
    await useStore.getState().refreshTree();
    await useStore.getState().refreshTitles();
    // A brand-new empty vault gets first-run welcome content.
    await useStore.getState().seedLocalVaultIfEmpty();
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

  // "New vault" step 1: choose the parent location, then ask for a name. If the
  // chosen folder is ALREADY a vault, don't nest a new empty vault inside it —
  // offer to open the existing one instead.
  async function startNewVault() {
    setError(null);
    try {
      const parent = await ipc.pickFolder();
      if (!parent) return;
      if (await ipc.isVault(parent)) {
        setAlreadyVault(parent);
        return;
      }
      setNewParent(parent);
      setNewName("Untitled Vault");
    } catch (e) {
      setError(String(e));
    }
  }

  // The picked folder is already a vault → open it directly.
  async function openDetectedVault() {
    if (!alreadyVault) return;
    setBusy(true);
    setError(null);
    try {
      const info = await ipc.openVault(alreadyVault);
      await openVault(info);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  // User insists on creating a fresh vault inside the existing one anyway.
  function createInsideAnyway() {
    if (!alreadyVault) return;
    setNewParent(alreadyVault);
    setNewName("Untitled Vault");
    setAlreadyVault(null);
  }

  function cancelAlreadyVault() {
    setAlreadyVault(null);
    setError(null);
  }

  // "New vault" step 2: create <parent>/<name> and open it.
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

  async function reopen(r: RecentVault) {
    setBusy(true);
    setError(null);
    try {
      const info = await ipc.openVault(r.path);
      await openVault(info);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
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

  const naming = newParent !== null;
  const deciding = alreadyVault !== null;
  // Whether either multi-step flow (naming a new vault, or deciding what to do
  // with an already-a-vault folder) is showing — hides the recents/hint.
  const inFlow = naming || deciding;

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
            {deciding ? (
              // ---- Picked folder is already a vault: open vs nest ----
              <motion.div
                key="already"
                className="new-vault-form"
                initial={reduceMotion ? false : { opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={reduceMotion ? undefined : { opacity: 0, y: -8 }}
                transition={SPRING}
              >
                <label className="new-vault-label">This folder is already a vault</label>
                <p className="new-vault-loc" title={alreadyVault ?? undefined}>
                  <code>{tidyPath(alreadyVault ?? "")}</code> already contains notes — open
                  it instead of creating a new vault inside?
                </p>
                <div className="new-vault-buttons">
                  <button
                    type="button"
                    className="ghost-pill"
                    disabled={busy}
                    onClick={cancelAlreadyVault}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="ghost-pill"
                    disabled={busy}
                    onClick={createInsideAnyway}
                  >
                    Create inside
                  </button>
                  <button
                    type="button"
                    className="primary sm"
                    disabled={busy}
                    onClick={() => void openDetectedVault()}
                  >
                    {busy ? "Opening…" : "Open vault"}
                  </button>
                </div>
              </motion.div>
            ) : naming ? (
              // ---- New-vault naming step ----
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
                    className="primary sm"
                    disabled={busy || !newName.trim()}
                  >
                    {busy ? "Creating…" : "Create vault"}
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
                  className="ghost-pill lg"
                  disabled={busy}
                  onClick={pickExisting}
                  whileHover={reduceMotion ? undefined : { scale: 1.03, y: -1 }}
                  whileTap={reduceMotion ? undefined : { scale: 0.97 }}
                  transition={SPRING}
                >
                  {busy ? "Opening…" : "Open existing"}
                </motion.button>
              </motion.div>
            )}
          </AnimatePresence>
        </motion.div>

        {error && <p className="error">{error}</p>}

        {!inFlow && recents.length > 0 && (
          <motion.div
            className="recent-list"
            initial={reduceMotion ? false : { opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={
              reduceMotion ? undefined : revealTransition(REVEAL_DELAY + 0.15)
            }
          >
            <p className="recent-heading">Recent vaults</p>
            {recents.map((r) => (
              <div className="recent-card" key={r.path}>
                <button
                  className="recent-open"
                  disabled={busy}
                  onClick={() => reopen(r)}
                  title={r.path}
                >
                  <span className="recent-name">{r.name}</span>
                  <span className="recent-path">{tidyPath(r.path)}</span>
                  {r.openedAt > 0 && (
                    <span className="recent-time">{relativeTime(r.openedAt)}</span>
                  )}
                </button>
                <button
                  className="recent-remove"
                  aria-label={`Remove ${r.name} from recents`}
                  title="Remove from recents"
                  disabled={busy}
                  onClick={() => forget(r.path)}
                >
                  ×
                </button>
              </div>
            ))}
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
      </div>
    </div>
  );
}
