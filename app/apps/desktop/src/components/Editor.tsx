import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import "./editor.css";
import { convertFileSrc } from "@tauri-apps/api/core";
import { keymap, EditorView } from "@codemirror/view";
import { Compartment, EditorState } from "@codemirror/state";
import { yCollab, yUndoManagerKeymap } from "y-codemirror.next";
import type { Awareness } from "y-protocols/awareness";
import { createEditorState } from "../lib/editor";
import { bridgeManager } from "../lib/bridge";
import { effectiveLockForPath, lockScopesByPath } from "../lib/locks";
import { playPingSound } from "../lib/presence/ping";
import { syncManager } from "../lib/sync/docSession";
import { colorForUser, PRESENCE_OFFLINE } from "../lib/presence/color";
import { useStore } from "../store";
import * as ipc from "../lib/ipc";
import { HtmlView } from "./HtmlView";
import { relativeAgo, characterSvg } from "./Identity";

interface Peer {
  id: string;
  name: string;
  color: string;
  /** Line their cursor is on (from the `activity` awareness field), if known. */
  line: number | null;
  /** Timestamp (ms) of their last activity update — powers "last active". */
  lastActive: number | null;
}

interface AwarenessPeerState {
  user?: { id?: string; name?: string; color?: string };
  activity?: { line?: number; at?: number };
  ping?: { to?: string; name?: string; at?: number };
}

/** Derive the unique peers currently present in a doc from awareness states. */
function readPeers(awareness: Awareness): Peer[] {
  const seen = new Map<string, Peer>();
  awareness.getStates().forEach((state) => {
    const s = state as AwarenessPeerState;
    const u = s.user;
    if (!u?.id) return;
    const prev = seen.get(u.id);
    const line = typeof s.activity?.line === "number" ? s.activity.line : null;
    const at = typeof s.activity?.at === "number" ? s.activity.at : null;
    if (!prev) {
      seen.set(u.id, {
        id: u.id,
        name: u.name ?? "Someone",
        color: u.color ?? colorForUser(u.id),
        line,
        lastActive: at,
      });
    } else {
      if (prev.line == null && line != null) prev.line = line;
      if (at != null && (prev.lastActive == null || at > prev.lastActive)) {
        prev.lastActive = at;
      }
    }
  });
  return [...seen.values()];
}

/**
 * Build the image-`src` resolver the editor hands to live preview. Local vault
 * paths (relative to the note, or vault-root when prefixed with `/`) become
 * `asset:` URLs the webview can stream; already-loadable URLs pass through. The
 * vault dir is granted to the asset-protocol scope on open (Rust side).
 */
function makeResolveAsset(vaultPath: string | null, notePath: string) {
  return (src: string): string => {
    if (!src || /^(https?:|data:|blob:|asset:|tauri:|mailto:)/i.test(src)) return src;
    if (!vaultPath) return src;
    const noteDir = notePath.includes("/")
      ? notePath.slice(0, notePath.lastIndexOf("/"))
      : "";
    const rootRelative = src.startsWith("/");
    const segs = rootRelative || !noteDir ? [] : noteDir.split("/");
    for (const part of src.split("/")) {
      if (part === "" || part === ".") continue;
      if (part === "..") segs.pop();
      else segs.push(part);
    }
    const abs = `${vaultPath.replace(/\/$/, "")}/${segs.join("/")}`;
    return convertFileSrc(abs);
  };
}

/**
 * Save pasted/dropped image bytes under the vault's `attachments/` dir, named by
 * a short content hash so identical images de-dupe, and return the vault-root
 * markdown `src` to embed. `makeResolveAsset` turns that `/attachments/…` path
 * back into a loadable `asset:` URL for rendering.
 */
async function saveAttachment(bytes: Uint8Array, ext: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hash = Array.from(new Uint8Array(digest))
    .slice(0, 8)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const rel = `attachments/${hash}.${ext}`;
  await ipc.writeBinaryFile(rel, bytes);
  return `/${rel}`;
}

/** CodeMirror extensions that make the view non-editable (view-only / locked). */
function editableExtensions(readOnly: boolean) {
  return readOnly
    ? [EditorState.readOnly.of(true), EditorView.editable.of(false)]
    : [];
}

/** Max slots in the stacked avatar row before the rest collapse into "+N". */
const MAX_AVATARS = 4;

/**
 * A single presence avatar: the peer's illustrated character (the same DiceBear
 * "notionists" art used for profile avatars, seeded by their name so it matches
 * their account avatar) framed by a ring in their unique presence colour. The
 * colour arrives as `--user-color` so the CSS owns the ring/glow treatment.
 */
function PresenceAvatar({
  peer,
  className,
  online = true,
}: {
  peer: Peer;
  className?: string;
  /** When false the ring goes neutral gray — the peer isn't live. */
  online?: boolean;
}) {
  const svg = useMemo(() => characterSvg(peer.name || peer.id || "?"), [peer.name, peer.id]);
  return (
    <span
      className={`presence-avatar${online ? "" : " offline"}${className ? ` ${className}` : ""}`}
      style={{ "--user-color": online ? peer.color : PRESENCE_OFFLINE } as CSSProperties}
      aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

/**
 * "Who's in this note" avatar stack (spec 04 §5). Avatars overlap; anything past
 * MAX_AVATARS collapses into a "+N" chip. Clicking anywhere on the stack toggles
 * the roster popover.
 */
function PresenceBar({
  peers,
  open,
  onToggle,
  online = true,
}: {
  peers: Peer[];
  open: boolean;
  onToggle: () => void;
  /** Live sync state — when false, avatar rings show neutral gray. */
  online?: boolean;
}) {
  if (peers.length === 0) return null;
  // Keep the row to at most MAX_AVATARS slots: when there are more, show a few
  // faces and roll the remainder into the "+N" chip (which fills the last slot).
  const shown = peers.length > MAX_AVATARS ? peers.slice(0, MAX_AVATARS - 1) : peers;
  const overflow = peers.length - shown.length;
  const names = peers.map((p) => p.name).join(", ");
  return (
    <button
      type="button"
      className={`presence-bar${open ? " open" : ""}`}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      aria-label={`${peers.length} here: ${names}`}
      aria-expanded={open}
    >
      {shown.map((p) => (
        <PresenceAvatar key={p.id} peer={p} online={online} />
      ))}
      {overflow > 0 && <span className="presence-avatar presence-overflow">+{overflow}</span>}
    </button>
  );
}

/** One row in the roster: avatar + name + status/last-active + optional Ping. */
function PeerRow({
  peer,
  isSelf,
  now,
  onPing,
}: {
  peer: Peer;
  isSelf: boolean;
  now: number;
  onPing: (peer: Peer) => void;
}) {
  const [pinged, setPinged] = useState(false);
  const editing = peer.line != null;
  return (
    <div className="peer-row">
      <PresenceAvatar peer={peer} className="sm" />
      <div className="peer-row-meta">
        <span className="peer-row-name">
          {peer.name}
          {isSelf && <span className="muted"> (you)</span>}
        </span>
        <span className="peer-row-status">
          <span className={`peer-dot${editing ? " active" : ""}`} />
          {editing ? `Editing line ${peer.line}` : "Viewing"}
          {peer.lastActive != null && (
            <span className="peer-row-ago"> · {relativeAgo(peer.lastActive, now)}</span>
          )}
        </span>
      </div>
      {!isSelf && (
        <button
          type="button"
          className="peer-ping"
          disabled={pinged}
          title="Send a ping"
          onClick={(e) => {
            e.stopPropagation();
            onPing(peer);
            setPinged(true);
          }}
        >
          {pinged ? "✓" : "Ping"}
        </button>
      )}
    </div>
  );
}

/**
 * Roster popover: the quick list of everyone in the note, each with their live
 * status ring, where they are, and how long since they were last active. Opens
 * on a click of the presence stack; closes on any outside click.
 */
function PeerRoster({
  peers,
  selfId,
  onPing,
  onClose,
}: {
  peers: Peer[];
  selfId: string | null;
  onPing: (peer: Peer) => void;
  onClose: () => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(id);
  }, []);
  useEffect(() => {
    const close = () => onClose();
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [onClose]);
  return (
    <div className="peer-roster" onClick={(e) => e.stopPropagation()}>
      <div className="peer-roster-title">
        {peers.length} {peers.length === 1 ? "person" : "people"} here
      </div>
      {peers.map((p) => (
        <PeerRow
          key={p.id}
          peer={p}
          isSelf={p.id === selfId}
          now={now}
          onPing={onPing}
        />
      ))}
    </div>
  );
}

/**
 * The note editor. CodeMirror is bound to the note's Y.Text through a
 * `y-codemirror.next` (yCollab) binding. Local keystrokes flow into the CRDT
 * (origin 'editor'); the bridge egests to disk on a debounce; external file
 * edits and remote peers merge live into the same Y.Text. When signed in and the
 * doc is shared, a HocuspocusProvider syncs it to the server and supplies live
 * cursors + presence; a view-only grant makes the editor read-only.
 */
export function Editor() {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);

  const openNote = useStore((s) => s.openNote);
  const syncEnabled = useStore((s) => s.syncEnabled);
  const locks = useStore((s) => s.locks);
  const session = useStore((s) => s.session);
  const tree = useStore((s) => s.tree);
  const syncStatus = useStore((s) => s.syncStatus);
  const notePath = openNote?.path ?? null;

  const [peers, setPeers] = useState<Peer[]>([]);
  const [readOnly, setReadOnly] = useState(false);
  // Editability is held in a Compartment so a lock applied while the note is
  // open can flip the live view read-only without rebuilding it.
  const editableRef = useRef<Compartment | null>(null);
  const [rosterOpen, setRosterOpen] = useState(false);
  const [pingFrom, setPingFrom] = useState<string | null>(null);
  const awarenessRef = useRef<Awareness | null>(null);
  // Pings already played, keyed by sender clientId + timestamp.
  const seenPingsRef = useRef<Set<string>>(new Set());
  const isHtml = notePath != null && /\.html?$/i.test(notePath);

  // Is this note (or a containing folder) locked? Refines the read-only badge
  // copy — a lock is deliberate protection, not a missing grant.
  const lockScope =
    notePath && syncEnabled
      ? effectiveLockForPath(lockScopesByPath(tree, locks, session?.user.id), notePath)
      : null;

  useEffect(() => {
    if (!hostRef.current || notePath == null || /\.html?$/i.test(notePath)) return;
    const docId = useStore.getState().openNote?.id ?? null;
    if (docId == null) return; // wait until the note's doc_id (meta) is known
    const myUserId = useStore.getState().session?.user.id ?? null;

    let cancelled = false;
    let view: EditorView | null = null;
    let awareness: Awareness | null = null;
    let onAwarenessChange: (() => void) | null = null;

    const navigate = async (target: string) => {
      try {
        const resolved = await ipc.resolveWikilink(target);
        if (resolved) {
          await useStore.getState().openNoteByPath(resolved.path);
          return;
        }
        const slash = target.lastIndexOf("/");
        const dir = slash === -1 ? "" : target.slice(0, slash);
        const name = slash === -1 ? target : target.slice(slash + 1);
        const path = await ipc.createNote(dir, name);
        await useStore.getState().refreshTree();
        await useStore.getState().refreshTitles();
        await useStore.getState().openNoteByPath(path);
      } catch (err) {
        console.error("wiki-link navigation failed", err);
      }
    };

    (async () => {
      // Open the bridge; defer the disk-seed when this doc will sync so the
      // server's canonical state is pulled first (spec 03 §5 ordering).
      const willSync = syncManager.willSync(notePath);
      const bridge = await bridgeManager.openNote(notePath, docId, {
        seedFromFile: !willSync,
      });
      if (cancelled || !hostRef.current) return;

      const opened = await syncManager.openDoc(bridge, notePath);
      if (cancelled || !hostRef.current) {
        return;
      }
      awareness = opened.awareness;
      awarenessRef.current = awareness;
      const ro = opened.readOnly;
      setReadOnly(ro);
      const editable = new Compartment();
      editableRef.current = editable;

      const state = createEditorState({
        doc: bridge.text.toString(),
        collab: true,
        getTitles: () => useStore.getState().titles,
        onNavigate: (t) => void navigate(t),
        resolveAsset: makeResolveAsset(
          useStore.getState().vault?.path ?? null,
          notePath
        ),
        saveAttachment,
        extraExtensions: [
          yCollab(bridge.text, awareness, { undoManager: bridge.undoManager }),
          keymap.of(yUndoManagerKeymap),
          // Publish "editing line N" so peers can see where everyone is.
          EditorView.updateListener.of((u) => {
            if (!u.selectionSet && !u.docChanged && !u.focusChanged) return;
            const line = u.state.doc.lineAt(u.state.selection.main.head).number;
            awareness?.setLocalStateField("activity", { line, at: Date.now() });
          }),
          // View-only grants / locks: the editor cannot be typed into (spec
          // 04 §4). Compartmented so a live lock change can reconfigure it.
          editable.of(editableExtensions(ro)),
        ],
      });

      view = new EditorView({ state, parent: hostRef.current });
      viewRef.current = view;
      if (!ro) view.focus();

      // Live "who's here" avatar row + incoming pings addressed to this user.
      onAwarenessChange = () => {
        if (cancelled || !awareness) return;
        setPeers(readPeers(awareness));
        if (!myUserId) return;
        awareness.getStates().forEach((state, clientId) => {
          if (clientId === awareness!.clientID) return;
          const ping = (state as AwarenessPeerState).ping;
          if (!ping?.at || ping.to !== myUserId) return;
          const key = `${clientId}:${ping.at}`;
          // Only fresh pings ring — stale awareness replays stay silent.
          if (seenPingsRef.current.has(key) || Date.now() - ping.at > 10_000) return;
          seenPingsRef.current.add(key);
          playPingSound();
          setPingFrom(ping.name ?? "Someone");
          window.setTimeout(() => setPingFrom(null), 4000);
        });
      };
      awareness.on("change", onAwarenessChange);
      onAwarenessChange();
    })();

    return () => {
      cancelled = true;
      if (onAwarenessChange && awareness) awareness.off("change", onAwarenessChange);
      if (view) view.destroy();
      viewRef.current = null;
      editableRef.current = null;
      awarenessRef.current = null;
      seenPingsRef.current.clear();
      setPeers([]);
      setReadOnly(false);
      setRosterOpen(false);
      setPingFrom(null);
      // Tear down the network session, then flush + close the bridge.
      syncManager.closeCurrent();
      void bridgeManager.closeCurrent();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notePath, syncEnabled]);

  // Live lock/grant changes on the OPEN note. When someone locks it "for
  // everyone," the server force-closes our socket; DocSync re-mints a read-only
  // token on reconnect and the status flips to "read-only" here — no reopen
  // needed. Also refresh the lock list so the tree badge appears for us too.
  useEffect(() => {
    if (syncStatus === "read-only") {
      setReadOnly(true);
      void useStore.getState().refreshLocks();
    } else if (syncStatus === "synced") {
      // Unlocked / edit grant restored — become editable again.
      setReadOnly(false);
    }
  }, [syncStatus]);

  // Push the current read-only state into the live CodeMirror view.
  useEffect(() => {
    const view = viewRef.current;
    const editable = editableRef.current;
    if (!view || !editable) return;
    view.dispatch({ effects: editable.reconfigure(editableExtensions(readOnly)) });
    if (!readOnly) view.focus();
  }, [readOnly]);

  if (notePath == null) {
    return (
      <div className="editor-empty">
        <p>Select a note, or press ⌘N to create one.</p>
      </div>
    );
  }

  // HTML pages render live in a sandboxed frame instead of the CRDT editor.
  if (isHtml) {
    return <HtmlView path={notePath} />;
  }

  const myId = session?.user.id ?? null;

  const sendPing = (peer: Peer) => {
    const me = useStore.getState().session?.user;
    awarenessRef.current?.setLocalStateField("ping", {
      to: peer.id,
      name: me?.name || me?.email || "Someone",
      at: Date.now(),
    });
  };

  const showToolbar = peers.length > 0;

  return (
    <div className="editor-column">
      {readOnly && (
        <div
          className={`editor-lockbanner${lockScope ? " locked" : " viewonly"}`}
          role="status"
        >
          <span className="editor-lockbanner-icon" aria-hidden="true">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <rect x="4" y="11" width="16" height="10" rx="2" />
              <path d="M8 11V7a4 4 0 0 1 8 0v4" />
            </svg>
          </span>
          <span className="editor-lockbanner-text">
            <strong>{lockScope ? "This note is locked" : "View-only access"}</strong>
            <span className="editor-lockbanner-sub">
              {lockScope
                ? "You can read it, but your changes won’t be saved or synced."
                : "You can read this note, but you can’t edit it."}
            </span>
          </span>
        </div>
      )}
      {showToolbar && (
        <div className="editor-toolbar">
          <PresenceBar
            peers={peers}
            open={rosterOpen}
            onToggle={() => setRosterOpen((o) => !o)}
            online={
              syncEnabled &&
              (syncStatus === "synced" ||
                syncStatus === "read-only" ||
                syncStatus === "connecting")
            }
          />
          {rosterOpen && (
            <PeerRoster
              peers={peers}
              selfId={myId}
              onPing={sendPing}
              onClose={() => setRosterOpen(false)}
            />
          )}
          {pingFrom && (
            <span className="ping-toast" role="status">
              🔔 {pingFrom} pinged you
            </span>
          )}
        </div>
      )}
      <div className="editor-host" ref={hostRef} />
    </div>
  );
}
