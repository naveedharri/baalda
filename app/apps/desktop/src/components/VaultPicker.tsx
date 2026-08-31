import { useEffect, useMemo, useState } from "react";
import { motion, AnimatePresence, useReducedMotion } from "motion/react";
import type { VaultInfo, RecentVault } from "../lib/ipc";
import * as ipc from "../lib/ipc";
import {
  readKnownVaults,
  readOrgVaults,
  requestJoinWithCode,
  requestOpenVault,
  useStore,
} from "../store";
import { AuthDialog } from "./AccountMenu";
import { Wordmark } from "./Logo";
import { Spinner } from "./Spinner";
import { configOrgId } from "../lib/vault/rediscover";

/**
 * A row in the welcome-screen list: either a local folder (a recent vault on
 * disk) or a synced *remote* vault (an org). Remote rows carry the org id so a
 * click can reopen + resync them — prompting sign-in first if signed out.
 *
 * A local row additionally knows whether its folder IS some vault's synced
 * folder (`syncedOrgId`, read from the folder's own `.context/config.json`).
 * The localStorage caches that used to be the only classification signal are
 * per-device and easy to lose — which left a synced folder listed as if it
 * were plain local, openable (and editable) with no hint that it syncs.
 */
type PickerEntry =
  | {
      kind: "local";
      key: string;
      name: string;
      path: string;
      openedAt: number;
      syncedOrgId: string | null;
    }
  | { kind: "remote"; key: string; name: string; path: string | null; orgId: string };

/** Is this row a synced vault (as opposed to a local-only folder)? */
function isSyncedEntry(e: PickerEntry): boolean {
  return e.kind === "remote" || e.syncedOrgId !== null;
}

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
  // The live vault list. Signed in, this is the truth and the cache below is
  // only its mirror; signed out it is empty and the cache is all we have.
  const organizations = useStore((s) => s.organizations);
  const serverUrl = useStore((s) => s.serverUrl);
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
  // Why the sign-in modal is up. "open" is the remote-vault-card route (land in
  // that vault); "join" is the join-code route, which comes back HERE for the
  // code instead of landing anywhere.
  const [signInFor, setSignInFor] = useState<"open" | "join">("open");
  // Join-with-code step: true = the code form is showing (we already have a
  // session). null/false = idle.
  const [joining, setJoining] = useState(false);
  const [joinCode, setJoinCode] = useState("");
  const [joinError, setJoinError] = useState<string | null>(null);
  // New-vault flow: null = idle; a string = chosen parent, awaiting a name.
  const [newParent, setNewParent] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  // Which recent-vault card is being opened, by its key. A single boolean would
  // only tell the list to grey out; the point is to mark the row you clicked.
  const [opening, setOpening] = useState<string | null>(null);
  // Recents are collapsed to the 3 most recent; "Show all" opens a MODAL with
  // the full list. Expanding in place was tried twice and both ways lost:
  // locked to the collapsed height it looked like the button did nothing
  // (macOS overlay scrollbars are invisible until you scroll), and growing the
  // box reflowed the vertically-centered card, shoving the wordmark and action
  // buttons upward. A modal reveals everything and moves nothing.
  const [showAllVaults, setShowAllVaults] = useState(false);
  const reduceMotion = useReducedMotion();

  // Surface recently opened vaults as one-tap "reopen" affordances.
  //
  // Re-read whenever the vault set changes, NOT just on mount. Deleting your
  // last vaults leaves this screen mounted the whole time (App renders it as
  // soon as `vault` goes null), so a mount-only load left the deleted vaults
  // listed until the app was reloaded — the deletion looked like it hadn't
  // worked. `organizations` and `authStatus` are the store's account-level
  // signals; both change on delete, sign-out and server switch.
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
  }, [organizations, authStatus]);

  // { path → the vault (org) that folder's own `.context/config.json` is
  // stamped for }. The on-disk truth behind the row tags: the localStorage
  // caches (org list, org→folder bindings) are per-device and easy to lose,
  // and every cache miss used to demote a synced folder to a plain "recent" —
  // openable signed-out with no hint that its edits sync somewhere.
  const [stamps, setStamps] = useState<Record<string, string>>({});
  useEffect(() => {
    let alive = true;
    (async () => {
      const peeked = await Promise.all(
        recents.map(async (r) => {
          const raw = await ipc.peekVaultConfig(r.path).catch(() => null);
          return [r.path, configOrgId(raw)] as const;
        }),
      );
      if (!alive) return;
      const next: Record<string, string> = {};
      for (const [path, orgId] of peeked) if (orgId) next[path] = orgId;
      setStamps(next);
    })();
    return () => {
      alive = false;
    };
  }, [recents]);

  // If this screen goes away mid-join (a vault opened by some other route),
  // the landing suppression must not outlive it. A *successful* join disarms
  // it in the store before switching in, so this only catches abandonment.
  useEffect(() => () => requestJoinWithCode(false), []);

  async function openVault(vault: VaultInfo | null, opts?: { seed?: boolean }) {
    if (!vault) return;
    // Rust already opened it (these are the picker/create commands), so the store
    // retires the previous vault's sync and reloads view state from the new one.
    await useStore.getState().adoptOpenedVault(vault, opts);
  }

  // "Open by path": a typed/pasted absolute path, for what the native picker
  // cannot select — notably a drive root (a bare `D:\` or a mounted volume).
  // The OS folder dialog only offers folders *inside* a drive, so the only way
  // to make the drive itself the vault is to say so in text (#75).
  const [pathOpen, setPathOpen] = useState(false);
  const [manualPath, setManualPath] = useState("");
  async function openByPath() {
    const path = manualPath.trim();
    if (!path) return;
    setBusy(true);
    setError(null);
    try {
      // `openLocalVault`, not `adoptOpenedVault`: WE control this open, so the
      // store can tear down any active vault sync before Rust swaps the slot.
      await useStore.getState().openLocalVault(path);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
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
      // Creating a vault is the one flow that seeds starter content; "Open
      // existing" above adopts the picked folder untouched.
      await openVault(vault, { seed: true });
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

  // "Join a team": redeem a code a teammate shared, without first inventing a
  // vault of your own.
  //
  // The code alone can't do anything — joining is a server action, so it needs
  // an account. Signed out, we therefore run sign-up/sign-in first and come back
  // here for the code. `requestJoinWithCode` is what keeps that round trip from
  // ending somewhere else: it suppresses the post-auth landing, which would
  // otherwise hand a brand-new account an auto-created "My Vault" and drop the
  // user into it. That was the whole detour this replaces — create a vault you
  // didn't want, then hunt for the code box in Vault settings.
  function startJoin() {
    setError(null);
    setJoinError(null);
    setJoinCode("");
    requestJoinWithCode(true);
    if (authStatus === "signed-in") {
      setJoining(true);
    } else {
      setSignInFor("join");
      setSignInOpen(true);
    }
  }

  function cancelJoin() {
    requestJoinWithCode(false);
    setJoining(false);
    setJoinCode("");
    setJoinError(null);
    // Backing out AFTER the sign-up this route required would otherwise leave a
    // signed-in account holding nothing at all — the one state this screen has
    // no good answer for, since its three buttons all assume you still have a
    // choice to make. So run the landing the sign-in skipped, which makes the
    // first vault. Only for an empty account: someone who already has vaults
    // sees them listed right here, and yanking them into one they didn't click
    // would be its own surprise.
    const s = useStore.getState();
    if (s.authStatus === "signed-in" && s.organizations.length === 0) {
      void s.landAfterAuth();
    }
  }

  async function confirmJoin() {
    const code = joinCode.trim();
    if (!code) return;
    setBusy(true);
    setJoinError(null);
    try {
      // On success the store switches into the joined vault, which binds it a
      // folder and unmounts this screen — so there's nothing to do here after.
      await useStore.getState().joinVault(code);
    } catch (e) {
      setJoinError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
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

  // Open a vault row. Local-only folders open in place. A synced vault —
  // whether a cached remote row or a local folder whose own config says it
  // syncs — needs a session: if we still have one, switch straight to it
  // (opening its folder + resyncing); if we're signed out — or signed in as an
  // account that can't see it — remember it and prompt sign-in;
  // landInLastVault opens it once the right session lands. Opening
  // a synced folder *without* a session would edit it silently offline under a
  // "local" label; the escape hatch for deliberate offline work is "Open
  // existing", not a click that looks like any other.
  async function openEntry(e: PickerEntry) {
    setOpening(e.key);
    try {
      if (e.kind === "local" && !e.syncedOrgId) {
        await reopenLocal(e.path);
        return;
      }
      const orgId = e.kind === "remote" ? e.orgId : (e.syncedOrgId as string);
      if (authStatus === "signed-in") {
        setBusy(true);
        setError(null);
        try {
          if (!organizations.some((o) => o.id === orgId)) {
            // A stamped folder whose vault this account can't see. Switching
            // would 403, and adopting it would duplicate another account's
            // vault. Hand over to the right account instead of dead-ending:
            // drop this session and offer sign-in with the vault stashed, so
            // the post-auth landing opens exactly it. (The dialog needs the
            // sign-out — it dismisses itself while a session exists.)
            setError(
              `"${e.name}" was synced under a different account. Sign in with that account to open it.`,
            );
            await useStore.getState().signOut();
            requestOpenVault(orgId);
            setSignInFor("open");
            setSignInOpen(true);
            return;
          }
          await useStore.getState().setActiveOrganization(orgId);
        } catch (err) {
          setError(String(err));
        } finally {
          setBusy(false);
        }
      } else {
        requestOpenVault(orgId);
        setSignInFor("open");
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

  const naming = newParent !== null;
  // A step that owns the screen is showing (naming a new vault, entering a join
  // code, or the post-sign-in landing) — hide the recents/hint/sign-in behind
  // it. Offering "New vault" while we are already making one is how you end up
  // with two.
  const inFlow = naming || joining || landingVault;

  // Merge synced (remote) vaults with local recents into one list. Remote
  // vaults come from the locally-cached org list (survives sign-out) and are
  // shown first; their bound folder — if any — comes from the org→folder map,
  // healed by the folders' own config stamps when the map is missing. Local
  // recents backing a synced vault are folded into the remote row (by path)
  // so nothing shows twice; the ones left over carry their own stamp so a
  // synced folder is *tagged* as synced even when its vault isn't in the
  // cached list at all (other account, cleared cache, other server).
  const entries = useMemo<PickerEntry[]>(() => {
    // Signed in, the store's list is authoritative — reading the cache here
    // would resurrect a vault deleted moments ago, because the cache is only
    // rewritten by the next `refreshVault`. Signed out, the cache is the point:
    // it is what lets this screen still offer your synced vaults.
    const known =
      authStatus === "signed-in"
        ? organizations.map((o) => ({ id: o.id, name: o.name }))
        : readKnownVaults(serverUrl);
    const orgVaults = readOrgVaults();
    // Fallback folder per org from the folders' own stamps — recents are
    // newest-first, so the first stamped match wins (the one most recently
    // opened, i.e. the copy the user actually uses).
    const stampedPathByOrg: Record<string, string> = {};
    for (const r of recents) {
      const org = stamps[r.path];
      if (org && !(org in stampedPathByOrg)) stampedPathByOrg[org] = r.path;
    }
    const remote: PickerEntry[] = known.map((w) => ({
      kind: "remote",
      key: `org:${w.id}`,
      name: w.name,
      path: orgVaults[w.id] ?? stampedPathByOrg[w.id] ?? null,
      orgId: w.id,
    }));
    const consumed = new Set(remote.map((r) => r.path).filter(Boolean));
    const local: PickerEntry[] = recents
      .filter((r) => !consumed.has(r.path))
      .map((r) => ({
        kind: "local",
        key: r.path,
        name: r.name,
        path: r.path,
        openedAt: r.openedAt,
        syncedOrgId: stamps[r.path] ?? null,
      }));
    return [...remote, ...local];
  }, [recents, stamps, organizations, authStatus, serverUrl]);

  // Show the 3 most recent by default; the rest live in the "Show all" modal.
  const RECENT_LIMIT = 3;
  const shownRecents = entries.slice(0, RECENT_LIMIT);
  const hiddenRecents = entries.length - RECENT_LIMIT;

  // One vault row (used by both the inline recents and the "Show all" modal).
  // Every row carries a truthful state tag (docs' vault states): "Remote" =
  // synced, no local folder here yet; "Synced" = synced with a folder on this
  // device; "Local" = a plain folder that syncs nowhere. The tag comes from
  // the folder's own config (via `stamps`), not just the localStorage caches,
  // so signing out can't demote a synced vault to an untagged "recent".
  const renderEntry = (e: PickerEntry) => {
    const synced = isSyncedEntry(e);
    const tag = e.kind === "remote" && !e.path ? "Remote" : synced ? "Synced" : "Local";
    return (
      <div
        className={`recent-card${e.kind === "local" ? " removable" : ""}${
          opening === e.key ? " is-opening" : ""
        }`}
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
          {/* The card the user clicked reports for itself. A single shared `busy`
              flag only greyed every row out, which says "the list is disabled"
              rather than "this one is opening" — and opening a vault is seconds
              of work. */}
          {opening === e.key ? (
            <Spinner size="xs" tone="accent" className="recent-badge" />
          ) : (
            <span className="recent-meta recent-badge">
              {e.kind === "local" && e.openedAt > 0 && (
                <span className="recent-time">{relativeTime(e.openedAt)}</span>
              )}
              <span className={`ws-badge ${synced ? "synced" : "local"}`}>{tag}</span>
            </span>
          )}
          <span className="recent-path">
            {opening === e.key
              ? "Opening…"
              : e.path
                ? synced && authStatus !== "signed-in"
                  ? `${tidyPath(e.path)} · sign in to open`
                  : tidyPath(e.path)
                : "Synced · sign in to open"}
          </span>
        </button>
        {/* The remove × overlays the row's top-right corner on hover (the tag
            fades out while it shows) instead of sitting in the flow — in flow
            it reserved a column on local rows only, pushing their tag out of
            line with the synced rows'. */}
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
    );
  };

  return (
    <div className="vault-picker">
      {/* The main app is draggable by its two header rows; this screen has no
          chrome of its own, so without a strip here the window couldn't be
          moved at all before a vault is open. */}
      <div className="titlebar-drag" data-tauri-drag-region />
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
            ) : joining ? (
              // ---- Join step: the account exists (we forced sign-in first if
              //      it didn't), so all that's left is the code. Redeeming it
              //      switches straight into the team's vault — no vault of your
              //      own required, which is the entire point of this route. ----
              <motion.form
                key="joining"
                className="new-vault-form"
                initial={reduceMotion ? false : { opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={reduceMotion ? undefined : { opacity: 0, y: -8 }}
                transition={SPRING}
                onSubmit={(e) => {
                  e.preventDefault();
                  void confirmJoin();
                }}
              >
                <label className="new-vault-label">Enter your team's join code</label>
                {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
                <input
                  className="new-vault-input join-code-input"
                  autoFocus
                  value={joinCode}
                  disabled={busy}
                  // Codes are generated uppercase; typing them lowercase is not
                  // a mistake worth an error message.
                  onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") cancelJoin();
                  }}
                  placeholder="K7MPX2RA"
                  spellCheck={false}
                  autoComplete="off"
                />
                <p className="new-vault-loc">
                  Ask a teammate for it — Vault settings → Members.
                </p>
                {joinError && <p className="error join-error">{joinError}</p>}
                <div className="new-vault-buttons">
                  <button
                    type="button"
                    className="ghost-pill"
                    disabled={busy}
                    onClick={cancelJoin}
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className={`primary sm${busy ? " is-busy" : ""}`}
                    disabled={busy || !joinCode.trim()}
                    aria-busy={busy || undefined}
                  >
                    {/* Joining is a round trip plus a full vault switch — folder,
                        registry reconcile, first pull. Seconds, not a blink. */}
                    <span className="async-btn-label">
                      {busy ? "Joining…" : "Join team"}
                    </span>
                    {busy && <Spinner size="xs" tone="on-accent" />}
                  </button>
                </div>
              </motion.form>
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
                {/*
                  Third peer action: create / open / JOIN. It sits up here with
                  the other two rather than down in the quiet register with the
                  sign-in link, because for the person it's aimed at — a
                  teammate who was handed a code — it IS the primary action.
                  Reaching a team used to mean making a vault you didn't want
                  and then finding the code box in Vault settings, which reads
                  as "this app is for solo notes, and teams are a setting".
                */}
                <motion.button
                  className="ghost-pill lg"
                  disabled={busy}
                  onClick={startJoin}
                  whileHover={reduceMotion ? undefined : { scale: 1.03, y: -1 }}
                  whileTap={reduceMotion ? undefined : { scale: 0.97 }}
                  transition={SPRING}
                >
                  Join a team
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
            <div className="recent-scroll">{shownRecents.map(renderEntry)}</div>
            {hiddenRecents > 0 && (
              <button
                className="recent-more"
                disabled={busy}
                onClick={() => setShowAllVaults(true)}
              >
                {`Show all (${entries.length})`}
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
            A vault is any folder of <code>.md</code> files.{" "}
            <button
              type="button"
              className="linkish"
              disabled={busy}
              aria-expanded={pathOpen}
              onClick={() => setPathOpen((v) => !v)}
            >
              Open by path
            </button>
          </motion.p>
        )}

        {/* The escape hatch itself. Plain conditional (no enter animation): it
            appears in direct response to the link above, and motion between a
            question and its answer reads as lag. */}
        {!inFlow && pathOpen && (
          <form
            className="open-by-path"
            onSubmit={(e) => {
              e.preventDefault();
              void openByPath();
            }}
          >
            {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
            <input
              className="new-vault-input open-by-path-input"
              autoFocus
              value={manualPath}
              disabled={busy}
              onChange={(e) => setManualPath(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") setPathOpen(false);
              }}
              placeholder={"Full folder or drive path, e.g. D:\\ or /Volumes/Notes"}
              spellCheck={false}
              autoComplete="off"
            />
            <button
              type="submit"
              className={`primary sm${busy ? " is-busy" : ""}`}
              disabled={busy || !manualPath.trim()}
              aria-busy={busy || undefined}
            >
              <span className="async-btn-label">{busy ? "Opening…" : "Open"}</span>
              {busy && <Spinner size="xs" tone="on-accent" />}
            </button>
          </form>
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
              onClick={() => {
                setSignInFor("open");
                setSignInOpen(true);
              }}
            >
              Sign in
            </button>{" "}
            to sync and collaborate.
          </motion.p>
        )}
      </div>

      {/* Every vault in one scrollable list, grouped by what they ARE: synced
          vaults (they live on the server; a session opens them) versus plain
          local folders that exist only on this device. One flat list read as
          "everything here is on this device", which is exactly wrong for the
          synced half. A modal on purpose: revealing the list in place reflowed
          the centered card (see the showAllVaults comment above). Rows are the
          same recent-cards as the inline list, so opening/removing behaves
          identically. */}
      {showAllVaults && (
        <div className="modal-backdrop" onClick={() => setShowAllVaults(false)}>
          <div
            className="modal vault-list-modal"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-header">
              <span>
                All vaults <span className="muted">({entries.length})</span>
              </span>
              <button
                className="icon-btn"
                aria-label="Close"
                onClick={() => setShowAllVaults(false)}
              >
                ✕
              </button>
            </div>
            <div className="vault-list-scroll">
              {entries.some(isSyncedEntry) && (
                <>
                  <p className="vault-list-section">Synced vaults</p>
                  {entries.filter(isSyncedEntry).map(renderEntry)}
                </>
              )}
              {entries.some((e) => !isSyncedEntry(e)) && (
                <>
                  <p className="vault-list-section">On this device only</p>
                  {entries.filter((e) => !isSyncedEntry(e)).map(renderEntry)}
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {signInOpen && (
        <AuthDialog
          // Someone arriving with a join code most likely has no account yet.
          initialMode={signInFor === "join" ? "sign-up" : "sign-in"}
          // Success: for the "open" route, keep the pending open target — the
          // store's post-sign-in landing opens exactly that vault, so just
          // dismiss. For the "join" route the landing was suppressed on
          // purpose, and this screen is still up: show the code step.
          onSignedIn={() => {
            setSignInOpen(false);
            if (signInFor === "join") setJoining(true);
          }}
          // Cancel: drop whichever intent sent us here, so a later sign-in from
          // elsewhere doesn't surprise-open a vault or strand itself waiting on
          // a code that is never coming.
          onClose={() => {
            if (signInFor === "join") cancelJoin();
            else requestOpenVault(null);
            setSignInOpen(false);
          }}
        />
      )}
    </div>
  );
}
