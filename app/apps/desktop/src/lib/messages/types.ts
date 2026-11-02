// Wire types for server-driven messages (`GET /api/messages`). Mirrors the
// server's `src/messages/spec.ts`; see docs/MESSAGES.md. Every field past
// `id`/`title`/`body` is optional, and an unknown value of `display.kind`,
// `icon`, `tone` or an action `kind` is skipped, never an error, so the
// server can add options without breaking older apps.

export type MessageIcon = "key" | "lock" | "shield" | "info" | "sparkle" | "warning" | "bell" | "gift";
export type MessageTone = "info" | "important" | "warning" | "success";
export type MessageDisplayKind = "popup" | "banner" | "toast";
export type MessageActionKind =
  | "dismiss"
  | "remind-later"
  | "done"
  | "open-settings"
  | "open-url"
  | "save-vault-key";

export interface MessageAction {
  id: string;
  label: string;
  kind: MessageActionKind | string;
  style?: "primary" | "secondary" | "quiet" | "danger";
  /** remind-later: hours until it may show again. */
  hours?: number;
  /** open-settings: e.g. "vault:general#security". */
  target?: string;
  /** open-url: https only. */
  url?: string;
  /** What happens to the message after the click. */
  then?: "done" | "snooze" | "close";
}

export interface MessageSpec {
  id: string;
  title: string;
  body: string;
  icon?: MessageIcon | string;
  tone?: MessageTone | string;
  display?: { kind?: MessageDisplayKind | string; size?: "small" | "medium" | "large"; dismissible?: boolean };
  trigger?: { on?: "launch" | "vault-open" | "anytime"; delaySeconds?: number };
  frequency?: {
    mode?: "once" | "until-done" | "every";
    everyHours?: number;
    maxShows?: number;
    minHoursBetweenShows?: number;
  };
  priority?: number;
  perVault?: boolean;
  actions?: MessageAction[];
}

/** One pending message for this user, as `GET /api/messages` returns it. */
export interface DeliveredMessage {
  spec: MessageSpec;
  /** Per-vault messages: the vault (org) and its note collection; null for account-wide. */
  orgId: string | null;
  vaultId: string | null;
  vaultName: string | null;
  showCount: number;
  lastShownAt: string | null;
}

export type MessageReceiptEvent = "shown" | "snooze" | "dismiss" | "done";
