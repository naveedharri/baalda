// The message center: fetches pending server-driven messages, picks the one to
// show (`select.ts`) and holds it for `MessagePopup` / `MessageBanner`.
// Fetches when signed in with a vault open (after the message's own delay), on
// the vault channel's `messages-changed` hint and every 10 min. Every failure is
// silent (console.warn): a message is never worth an error.

import { api } from "../auth/authManager";
import { syncManager } from "../sync/docSession";
import { currentVaultKeySession } from "../vaultKeys/runtime";
import { useStore } from "../../store";
import { onMessagesChanged } from "./live";
import { selectMessage, prepareMessage, messageKey, type PreparedMessage } from "./select";
import { isKnownTarget } from "./targets";
import type { DeliveredMessage, MessageReceiptEvent, MessageSpec } from "./types";

const POLL_MS = 10 * 60_000;
const DEFAULT_DELAY_S = 5;
/** Another dialog is open: look again this much later. */
const BUSY_RETRY_MS = 30_000;

let current: PreparedMessage | null = null;
let preview = false;
const listeners = new Set<() => void>();
/** Closed or acted on this session: not shown again until the next launch. */
const handled = new Set<string>();

export function currentMessage(): PreparedMessage | null {
  return current;
}

export function subscribeMessage(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function setCurrent(next: PreparedMessage | null): void {
  if (next === current) return;
  current = next;
  for (const l of [...listeners]) l();
}

function canRevealKey(vaultId: string): boolean {
  try {
    return currentVaultKeySession()?.revealVaultKey(vaultId) != null;
  } catch {
    return false;
  }
}

function context() {
  const s = useStore.getState();
  return {
    openOrgId: s.session?.activeOrganizationId ?? null,
    canRevealKey,
    userName: s.session?.user.name ?? null,
    skip: handled,
    knownTarget: isKnownTarget,
  };
}

/** Another modal is up (Settings, a confirm, What's new): a popup waits. */
function anotherDialogOpen(): boolean {
  return document.querySelector(".modal-backdrop:not(.message-backdrop)") != null;
}

function sendReceipt(m: PreparedMessage, event: MessageReceiptEvent, actionId?: string): void {
  if (preview) return;
  void api
    .sendMessageReceipt(m.spec.id, { orgId: m.delivered.orgId, event, ...(actionId ? { actionId } : {}) })
    .catch((e) => console.warn("message receipt failed:", e));
}

/** The message already reported as shown, so a re-run effect counts it once. */
let shownReported: PreparedMessage | null = null;

/** Called by the UI once the message is actually on screen. */
export function messageShown(m: PreparedMessage): void {
  if (shownReported === m) return;
  shownReported = m;
  sendReceipt(m, "shown");
}

/** Close the message. `event` records what the person chose; `close` records nothing. */
export function resolveMessage(m: PreparedMessage, event: MessageReceiptEvent | "close", actionId?: string): void {
  handled.add(m.key);
  if (event !== "close") sendReceipt(m, event, actionId);
  if (current?.key === m.key) setCurrent(null);
  if (!preview) schedule(2_000);
}

let timer: number | null = null;
let openedAt = 0;
let running = false;

function schedule(ms: number): void {
  if (timer != null) window.clearTimeout(timer);
  timer = window.setTimeout(() => {
    timer = null;
    void refresh();
  }, ms);
}

async function refresh(): Promise<void> {
  const s = useStore.getState();
  if (!running || preview || s.authStatus !== "signed-in" || !s.vault) return;
  let list: DeliveredMessage[];
  try {
    list = await api.listMessages(
      context().openOrgId,
      current ? { id: current.spec.id, orgId: current.delivered.orgId } : undefined,
    );
  } catch (e) {
    console.warn("messages fetch failed:", e);
    return;
  }
  if (current) {
    // Answered on another computer (or archived): take it down here too.
    const showing = current.key;
    if (!list.some((m) => messageKey(m) === showing)) setCurrent(null);
    return;
  }
  const pick = selectMessage(list, context());
  if (!pick || current) return;
  // Wait out the message's own delay, counted from when the vault opened.
  const delay = Math.max(0, Math.min(600, pick.spec.trigger?.delaySeconds ?? DEFAULT_DELAY_S)) * 1000;
  const wait = openedAt + delay - Date.now();
  if (wait > 0) return schedule(wait);
  if (pick.display === "popup" && anotherDialogOpen()) return schedule(BUSY_RETRY_MS);
  // The vault may have changed while we fetched.
  if (pick.delivered.orgId && pick.delivered.orgId !== context().openOrgId) return schedule(1_000);
  setCurrent(pick);
}

/** The built-in sample (`VITE_PREVIEW_MESSAGE=vault-key`): the plan's first message. */
export const SAMPLE_VAULT_KEY_MESSAGE: MessageSpec = {
  id: "save-vault-key-preview",
  perVault: true,
  display: { kind: "popup", size: "medium", dismissible: false },
  trigger: { on: "vault-open", delaySeconds: 8 },
  priority: 100,
  icon: "key",
  tone: "important",
  title: "Keep a copy of your vault key",
  body: "{vaultName} is protected by a key that only your team's computers hold. If you ever lose access to them, this key is the only way to get your notes back.\n\nSave it somewhere safe, like your password manager.",
  actions: [
    { id: "save", kind: "save-vault-key", label: "Save to file", style: "primary", then: "done" },
    { id: "open", kind: "open-settings", target: "vault:general#security", label: "Show key", then: "close" },
    { id: "later", kind: "remind-later", hours: 72, label: "Remind me later", style: "quiet", then: "snooze" },
    { id: "already", kind: "done", label: "I already saved it", style: "quiet", then: "done" },
  ],
};

function previewSpec(raw: string): MessageSpec | null {
  if (raw.trim() === "vault-key") return SAMPLE_VAULT_KEY_MESSAGE;
  try {
    return JSON.parse(raw) as MessageSpec;
  } catch (e) {
    console.warn("VITE_PREVIEW_MESSAGE is not JSON:", e);
    return null;
  }
}

/** Dev only: show `VITE_PREVIEW_MESSAGE` at once, no server, no receipts. */
function startPreview(raw: string): void {
  const spec = previewSpec(raw);
  if (!spec) return;
  const s = useStore.getState();
  const orgId = s.session?.activeOrganizationId ?? "preview-org";
  const prepared = prepareMessage(
    {
      spec,
      orgId: spec.perVault ? orgId : null,
      vaultId: spec.perVault ? (syncManager.registry?.vaultId ?? "preview-vault") : null,
      vaultName: spec.perVault ? (s.vault?.name ?? "My vault") : null,
      showCount: 0,
      lastShownAt: null,
    },
    // The preview always shows: no vault or key checks.
    { ...context(), openOrgId: orgId, canRevealKey: () => true, skip: undefined },
  );
  if (prepared) setCurrent(prepared);
}

/** Start the center once (App mount). Returns the stop function. */
export function startMessageCenter(): () => void {
  running = true;
  const raw = import.meta.env.DEV ? (import.meta.env.VITE_PREVIEW_MESSAGE as string | undefined) : undefined;
  if (raw) {
    preview = true;
    startPreview(raw);
    return () => {
      running = false;
    };
  }
  let lastKey: string | null = null;
  const onStore = () => {
    const s = useStore.getState();
    const key = s.authStatus === "signed-in" && s.vault ? `${s.session?.activeOrganizationId ?? ""}|${s.vault.path}` : null;
    if (key === lastKey) return;
    lastKey = key;
    // A different vault: its messages, not the last one's.
    if (current?.delivered.orgId) setCurrent(null);
    if (key) {
      openedAt = Date.now();
      schedule(1_000);
    }
  };
  const unsubStore = useStore.subscribe(onStore);
  onStore();
  const unsubLive = onMessagesChanged(() => schedule(500));
  const poll = window.setInterval(() => schedule(0), POLL_MS);
  return () => {
    running = false;
    unsubStore();
    unsubLive();
    window.clearInterval(poll);
    if (timer != null) window.clearTimeout(timer);
    timer = null;
  };
}
