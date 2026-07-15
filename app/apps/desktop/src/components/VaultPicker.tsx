import { useEffect, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import type { VaultInfo } from "../lib/ipc";
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

export function VaultPicker() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recent, setRecent] = useState<VaultInfo | null>(null);
  const reduceMotion = useReducedMotion();

  // Surface the last-opened vault as a one-tap "reopen" affordance.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const last = await ipc.getLastVault();
        if (alive) setRecent(last);
      } catch {
        /* no recent vault — ignore */
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

  async function pick() {
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

  async function reopenRecent() {
    if (!recent) return;
    setBusy(true);
    setError(null);
    try {
      await ipc.openVault(recent.path);
      await openVault(recent);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

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
          <motion.button
            className="primary hero"
            disabled={busy}
            onClick={pick}
            whileHover={reduceMotion ? undefined : { scale: 1.04, y: -1 }}
            whileTap={reduceMotion ? undefined : { scale: 0.96 }}
            transition={SPRING}
          >
            {busy ? "Opening…" : "Open vault"}
          </motion.button>

          {recent && (
            <motion.button
              className="recent-vault"
              disabled={busy}
              onClick={reopenRecent}
              title={recent.path}
              whileHover={reduceMotion ? undefined : { scale: 1.03, y: -1 }}
              whileTap={reduceMotion ? undefined : { scale: 0.97 }}
              transition={SPRING}
            >
              <span className="recent-label">Reopen</span>
              <strong>{recent.name}</strong>
            </motion.button>
          )}
        </motion.div>

        {error && <p className="error">{error}</p>}

        <motion.p
          className="hint"
          initial={reduceMotion ? false : { opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={
            reduceMotion ? undefined : revealTransition(REVEAL_DELAY + 0.15)
          }
        >
          Choose any folder of <code>.md</code> files.
        </motion.p>
      </div>
    </div>
  );
}
