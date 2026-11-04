import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import * as ipc from "../lib/ipc";
import { exitThen } from "../lib/exitMotion";
import { MessageBody } from "../lib/messages/body";
import { currentMessage, messageShown, resolveMessage, startMessageCenter, subscribeMessage } from "../lib/messages/center";
import type { PreparedMessage } from "../lib/messages/select";
import { openTarget } from "../lib/messages/targets";
import type { MessageAction } from "../lib/messages/types";
import { saveVaultKeyToFile } from "../lib/vaultKeys/saveKeyFile";
import { AsyncButton } from "./AsyncButton";

/** The icon tile's glyphs (the Security card's tile, tinted by tone). */
const ICONS: Record<string, React.ReactNode> = {
  key: (
    <>
      <circle cx="8" cy="15" r="4" />
      <path d="M11 12l9-9M17 6l3 3M15 8l2 2" />
    </>
  ),
  lock: (
    <>
      <rect x="4" y="10.5" width="16" height="10.5" rx="2.5" />
      <path d="M8 10.5V7.5a4 4 0 0 1 8 0v3" />
    </>
  ),
  shield: <path d="M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6l8-3z" />,
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 8h.01M11 12h1v5h1" />
    </>
  ),
  sparkle: <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3z" />,
  warning: (
    <>
      <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
      <path d="M12 9v4M12 17h.01" />
    </>
  ),
  bell: (
    <>
      <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
      <path d="M10.3 21a1.9 1.9 0 0 0 3.4 0" />
    </>
  ),
  gift: (
    <>
      <rect x="3" y="8" width="18" height="4" rx="1" />
      <path d="M12 8v13M19 12v7a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-7" />
      <path d="M7.5 8a2.5 2.5 0 0 1 0-5C11 3 12 8 12 8s1-5 4.5-5a2.5 2.5 0 0 1 0 5" />
    </>
  ),
};
const TONES = ["info", "important", "warning", "success"];

export function MessageIcon({ icon }: { icon?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {ICONS[icon ?? "info"] ?? ICONS.info}
    </svg>
  );
}

/**
 * Run one action, then settle the message per its `then`. Shared with the
 * banner. A save that did not happen (cancelled dialog) leaves it open.
 */
export async function runMessageAction(m: PreparedMessage, a: MessageAction): Promise<void> {
  switch (a.kind) {
    case "save-vault-key": {
      const { vaultId, vaultName } = m.delivered;
      if (!vaultId) return;
      const saved = await saveVaultKeyToFile(vaultId, vaultName ?? "Vault");
      if (!saved) return;
      break;
    }
    case "open-settings":
      if (!a.target || !openTarget(a.target)) return;
      break;
    case "open-url":
      if (!a.url || !/^https:\/\//i.test(a.url)) return;
      void ipc.openExternal(a.url).catch((e) => console.warn("open link failed:", e));
      break;
    case "remind-later":
      return resolveMessage(m, "snooze", a.id);
    case "done":
      return resolveMessage(m, "done", a.id);
    case "dismiss":
      return resolveMessage(m, "dismiss", a.id);
  }
  const then = a.then ?? (a.kind === "save-vault-key" ? "done" : "close");
  resolveMessage(m, then === "done" ? "done" : then === "snooze" ? "snooze" : "close", a.id);
}

function buttonClass(a: MessageAction, first: boolean): string {
  const style = a.style ?? (first ? "primary" : a.kind === "remind-later" || a.kind === "done" || a.kind === "dismiss" ? "quiet" : "secondary");
  if (style === "primary") return "message-btn-primary";
  if (style === "danger") return "danger";
  if (style === "quiet") return "link-btn message-btn-quiet";
  return "secondary";
}

/** A server-driven message as a dialog in Baalda's own modal shell. Mounted
 * once (App), it also runs the message center. */
export function MessagePopup() {
  useEffect(() => startMessageCenter(), []);
  const m = useSyncExternalStore(subscribeMessage, currentMessage, currentMessage);
  const popup = m && m.display === "popup" ? m : null;
  return popup ? <MessageDialog key={popup.key} m={popup} /> : null;
}

function MessageDialog({ m }: { m: PreparedMessage }) {
  const [busy, setBusy] = useState(false);
  const dismissible = m.spec.display?.dismissible !== false;
  const size = m.spec.display?.size ?? "medium";
  const tone = TONES.includes(m.spec.tone ?? "") ? m.spec.tone : "info";
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    messageShown(m);
    // Focus the main action, so Enter does the one thing the message asks.
    const btn = ref.current?.querySelector<HTMLButtonElement>(".message-btn-primary") ?? ref.current;
    btn?.focus({ preventScroll: true });
  }, [m]);

  // × always closes (a dismiss: the message comes back after its own gap until
  // it is answered); `dismissible: false` only stops Escape and a click outside
  // from closing it by accident.
  const dismiss = () => {
    if (busy) return;
    exitThen(() => resolveMessage(m, "dismiss"));
  };
  const dismissSoft = () => {
    if (dismissible) dismiss();
  };

  useEffect(() => {
    if (!dismissible) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") dismiss();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const act = async (a: MessageAction) => {
    setBusy(true);
    try {
      await runMessageAction(m, a);
    } catch (e) {
      console.warn("message action failed:", e);
    } finally {
      setBusy(false);
    }
  };

  const actions = m.actions;
  const dialog = (
    <div className="modal-backdrop message-backdrop" onClick={dismissSoft}>
      <div
        ref={ref}
        tabIndex={-1}
        className={`modal message-popup size-${size} tone-${tone}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="message-popup-title"
        onClick={(e) => e.stopPropagation()}
      >
        <button type="button" className="message-close" aria-label="Close" onClick={dismiss}>
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <path d="M6 6l12 12M18 6 6 18" />
          </svg>
        </button>
        <span className="message-tile" aria-hidden="true">
          <MessageIcon icon={m.spec.icon} />
        </span>
        <h2 id="message-popup-title" className="message-title">
          {m.spec.title}
        </h2>
        <div className="message-body">
          <MessageBody
            text={m.spec.body}
            onOpenLink={(url) => void ipc.openExternal(url).catch((e) => console.warn("open link failed:", e))}
          />
        </div>
        {actions.length > 0 && (
          <div className="message-actions">
            {/* Quiet text choices on the left, real buttons on the right; the
                listed main action first, reversed so it sits rightmost. */}
            <div className="message-actions-quiet">
              {actions.map((a, i) =>
                buttonClass(a, i === 0).includes("message-btn-quiet") ? (
                  <AsyncButton key={a.id} type="button" className={buttonClass(a, i === 0)} disabled={busy} onClick={() => act(a)}>
                    {a.label}
                  </AsyncButton>
                ) : null,
              )}
            </div>
            <div className="message-actions-main">
              {actions.map((a, i) =>
                buttonClass(a, i === 0).includes("message-btn-quiet") ? null : (
                  <AsyncButton key={a.id} type="button" className={buttonClass(a, i === 0)} disabled={busy} onClick={() => act(a)}>
                    {a.label}
                  </AsyncButton>
                ),
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
  return typeof document === "undefined" ? dialog : createPortal(dialog, document.body);
}
