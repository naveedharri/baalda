// Which server-driven message to show next. PURE: the message center feeds it
// what `GET /api/messages` returned plus a little local context, and it picks
// one. The server already filtered by audience, condition, receipts and
// frequency; this only applies what the server cannot know (which vault is
// open, whether THIS computer can reveal the vault key) and drops options this
// build does not understand, so a newer message never breaks an older app.

import type { DeliveredMessage, MessageAction, MessageDisplayKind, MessageSpec } from "./types";

const DISPLAY_KINDS: readonly string[] = ["popup", "banner", "toast"] satisfies MessageDisplayKind[];
const ACTION_KINDS: readonly string[] = [
  "dismiss",
  "remind-later",
  "done",
  "open-settings",
  "open-url",
  "save-vault-key",
];

/** A message ready to render: placeholders filled, unknown actions gone. */
export interface PreparedMessage {
  delivered: DeliveredMessage;
  spec: MessageSpec;
  display: MessageDisplayKind;
  actions: MessageAction[];
  /** Stable per (message, vault): what the center remembers it by. */
  key: string;
}

export interface SelectContext {
  /** The open vault's org id, or null when none is open. */
  openOrgId: string | null;
  /** Can this computer reveal that vault's key (keyed here, owner's device)? */
  canRevealKey: (vaultId: string) => boolean;
  /** The signed-in person's name, for `{name}`. */
  userName?: string | null;
  /** Keys handled this session (closed, acted on): never picked again. */
  skip?: ReadonlySet<string>;
  /** Only messages whose action targets this build understands (open-settings). */
  knownTarget?: (target: string) => boolean;
}

export function messageKey(m: Pick<DeliveredMessage, "orgId"> & { spec: Pick<MessageSpec, "id"> }): string {
  return `${m.spec.id}|${m.orgId ?? ""}`;
}

/** `{vaultName}` and `{name}`; any other `{…}` is left as written. */
export function fillPlaceholders(text: string, vars: { vaultName?: string | null; name?: string | null }): string {
  return text.replace(/\{(vaultName|name)\}/g, (_whole, key: "vaultName" | "name") => {
    const v = vars[key];
    if (key === "vaultName") return v?.trim() || "This vault";
    return v?.trim() || "there";
  });
}

function usableAction(a: MessageAction, knownTarget?: (target: string) => boolean): boolean {
  if (!a || typeof a.id !== "string" || typeof a.label !== "string" || !a.label.trim()) return false;
  if (!ACTION_KINDS.includes(a.kind)) return false;
  if (a.kind === "open-url") return typeof a.url === "string" && /^https:\/\//i.test(a.url);
  if (a.kind === "open-settings") return typeof a.target === "string" && (knownTarget ? knownTarget(a.target) : true);
  return true;
}

/** Prepare one delivered message, or null when this build cannot show it here. */
export function prepareMessage(m: DeliveredMessage, ctx: SelectContext): PreparedMessage | null {
  const spec = m?.spec;
  if (!spec || typeof spec.id !== "string" || typeof spec.title !== "string" || typeof spec.body !== "string") return null;
  const display = (spec.display?.kind ?? "popup") as string;
  if (!DISPLAY_KINDS.includes(display)) return null;
  const key = messageKey(m);
  if (ctx.skip?.has(key)) return null;
  // A per-vault message belongs to the vault it names, and only while it is open.
  if (spec.perVault || m.orgId) {
    if (!m.orgId || m.orgId !== ctx.openOrgId) return null;
  }
  const raw = Array.isArray(spec.actions) ? spec.actions : [];
  // The vault-key message is only worth showing where the key can be saved.
  if (raw.some((a) => a?.kind === "save-vault-key")) {
    if (!m.vaultId || !ctx.canRevealKey(m.vaultId)) return null;
  }
  const vars = { vaultName: m.vaultName, name: ctx.userName };
  const actions = raw
    .filter((a) => usableAction(a, ctx.knownTarget))
    .map((a) => ({ ...a, label: fillPlaceholders(a.label, vars) }));
  return {
    delivered: m,
    spec: { ...spec, title: fillPlaceholders(spec.title, vars), body: fillPlaceholders(spec.body, vars) },
    display: display as MessageDisplayKind,
    actions,
    key,
  };
}

/** The one message to show next: highest priority first, then server order. */
export function selectMessage(messages: readonly DeliveredMessage[], ctx: SelectContext): PreparedMessage | null {
  const ranked = messages
    .map((m, i) => ({ m, i, p: typeof m?.spec?.priority === "number" ? m.spec.priority : 0 }))
    .sort((a, b) => b.p - a.p || a.i - b.i);
  for (const { m } of ranked) {
    const prepared = prepareMessage(m, ctx);
    if (prepared) return prepared;
  }
  return null;
}
