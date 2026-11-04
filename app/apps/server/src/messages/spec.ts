// In-app message specs (docs/MESSAGES.md). The desktop mirror is
// `apps/desktop/src/lib/messages/types.ts`; the targeting fields below
// (audience, condition, startsAt, endsAt) are server-only and never sent.
// Admin writes go through `validateMessageSpec`, which is strict: an unknown
// key or value is refused, so a typo cannot ship a message nobody sees.

export type MessageActionKind = "dismiss" | "remind-later" | "done" | "open-settings" | "open-url" | "save-vault-key";
export type MessageRole = "owner" | "admin" | "member";

export interface MessageAction {
  id: string;
  label: string;
  kind: MessageActionKind;
  style?: "primary" | "secondary" | "quiet" | "danger";
  hours?: number;
  target?: string;
  url?: string;
  then?: "done" | "snooze" | "close";
}

export interface MessageAudience {
  roles?: MessageRole[];
  userIds?: string[];
  emails?: string[];
  orgIds?: string[];
  encryptedVaults?: boolean;
  minVersion?: string;
  maxVersion?: string;
  signedUpBefore?: string;
  signedUpAfter?: string;
}

export interface MessageSpec {
  id: string;
  title: string;
  body: string;
  icon?: string;
  tone?: string;
  display?: { kind?: "popup" | "banner" | "toast"; size?: "small" | "medium" | "large"; dismissible?: boolean };
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
  audience?: MessageAudience;
  condition?: string;
  startsAt?: string;
  endsAt?: string;
}

/** The spec a desktop receives: targeting stripped. */
export type PublicMessageSpec = Omit<MessageSpec, "audience" | "condition" | "startsAt" | "endsAt">;

export function publicSpec(spec: MessageSpec): PublicMessageSpec {
  const { audience: _a, condition: _c, startsAt: _s, endsAt: _e, ...rest } = spec;
  return rest;
}

export const MESSAGE_ID_RE = /^[a-z0-9][a-z0-9-]{2,79}$/;

const ICONS = ["key", "lock", "shield", "info", "sparkle", "warning", "bell", "gift"];
const TONES = ["info", "important", "warning", "success"];
const ACTION_KINDS: MessageActionKind[] = ["dismiss", "remind-later", "done", "open-settings", "open-url", "save-vault-key"];
const ROLES: MessageRole[] = ["owner", "admin", "member"];
const VERSION_RE = /^v?\d{1,6}\.\d{1,6}\.\d{1,6}$/;

export class MessageSpecError extends Error {}

type Obj = Record<string, unknown>;

function fail(msg: string): never {
  throw new MessageSpecError(msg);
}

function obj(v: unknown, where: string): Obj {
  if (!v || typeof v !== "object" || Array.isArray(v)) fail(`${where} must be an object`);
  return v as Obj;
}

function onlyKeys(o: Obj, allowed: string[], where: string): void {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) fail(`${where}: unknown field "${k}"`);
}

function str(o: Obj, key: string, where: string, min: number, max: number, required = false): string | undefined {
  const v = o[key];
  if (v === undefined) {
    if (required) fail(`${where}.${key} is required`);
    return undefined;
  }
  if (typeof v !== "string" || v.trim().length < min || v.length > max) {
    fail(`${where}.${key} must be text of ${min} to ${max} characters`);
  }
  return v;
}

function int(o: Obj, key: string, where: string, min: number, max: number): number | undefined {
  const v = o[key];
  if (v === undefined) return undefined;
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) {
    fail(`${where}.${key} must be a whole number from ${min} to ${max}`);
  }
  return v;
}

function oneOf<T extends string>(o: Obj, key: string, where: string, values: readonly T[]): T | undefined {
  const v = o[key];
  if (v === undefined) return undefined;
  if (typeof v !== "string" || !values.includes(v as T)) fail(`${where}.${key} must be one of ${values.join(", ")}`);
  return v as T;
}

function bool(o: Obj, key: string, where: string): boolean | undefined {
  const v = o[key];
  if (v === undefined) return undefined;
  if (typeof v !== "boolean") fail(`${where}.${key} must be true or false`);
  return v;
}

function iso(o: Obj, key: string, where: string): string | undefined {
  const v = o[key];
  if (v === undefined) return undefined;
  if (typeof v !== "string" || Number.isNaN(Date.parse(v))) fail(`${where}.${key} must be an ISO date`);
  return v;
}

function strList(o: Obj, key: string, where: string, max = 1000): string[] | undefined {
  const v = o[key];
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.length > max || v.some((x) => typeof x !== "string" || x === "" || x.length > 320)) {
    fail(`${where}.${key} must be a list of up to ${max} non-empty strings`);
  }
  return v as string[];
}

function action(v: unknown, i: number): MessageAction {
  const where = `actions[${i}]`;
  const o = obj(v, where);
  onlyKeys(o, ["id", "label", "kind", "style", "hours", "target", "url", "then"], where);
  const id = str(o, "id", where, 1, 40, true)!;
  const label = str(o, "label", where, 1, 40, true)!;
  const kind = oneOf(o, "kind", where, ACTION_KINDS);
  if (!kind) fail(`${where}.kind is required`);
  const url = str(o, "url", where, 1, 2000);
  if (kind === "open-url") {
    if (!url) fail(`${where}.url is required for open-url`);
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      fail(`${where}.url must be an https:// address`);
    }
    if (parsed.protocol !== "https:") fail(`${where}.url must be an https:// address`);
  }
  const out: MessageAction = { id, label, kind };
  const style = oneOf(o, "style", where, ["primary", "secondary", "quiet", "danger"] as const);
  if (style) out.style = style;
  const hours = int(o, "hours", where, 1, 720);
  if (hours !== undefined) out.hours = hours;
  const target = str(o, "target", where, 1, 200);
  if (target !== undefined) out.target = target;
  if (url !== undefined) out.url = url;
  const then = oneOf(o, "then", where, ["done", "snooze", "close"] as const);
  if (then) out.then = then;
  return out;
}

function audience(v: unknown): MessageAudience {
  const where = "audience";
  const o = obj(v, where);
  onlyKeys(
    o,
    ["roles", "userIds", "emails", "orgIds", "encryptedVaults", "minVersion", "maxVersion", "signedUpBefore", "signedUpAfter"],
    where,
  );
  const out: MessageAudience = {};
  if (o.roles !== undefined) {
    if (!Array.isArray(o.roles) || o.roles.some((r) => !ROLES.includes(r as MessageRole))) {
      fail(`${where}.roles must list owner, admin or member`);
    }
    out.roles = o.roles as MessageRole[];
  }
  const userIds = strList(o, "userIds", where);
  if (userIds) out.userIds = userIds;
  const emails = strList(o, "emails", where);
  if (emails) out.emails = emails.map((e) => e.toLowerCase());
  const orgIds = strList(o, "orgIds", where);
  if (orgIds) out.orgIds = orgIds;
  const enc = bool(o, "encryptedVaults", where);
  if (enc !== undefined) out.encryptedVaults = enc;
  for (const k of ["minVersion", "maxVersion"] as const) {
    const ver = o[k];
    if (ver === undefined) continue;
    if (typeof ver !== "string" || !VERSION_RE.test(ver)) fail(`${where}.${k} must look like 0.1.100`);
    out[k] = ver;
  }
  const before = iso(o, "signedUpBefore", where);
  if (before) out.signedUpBefore = before;
  const after = iso(o, "signedUpAfter", where);
  if (after) out.signedUpAfter = after;
  return out;
}

/** Validate an admin-supplied spec; throws `MessageSpecError` with a plain message. */
export function validateMessageSpec(input: unknown): MessageSpec {
  const o = obj(input, "message");
  onlyKeys(
    o,
    [
      "id", "title", "body", "icon", "tone", "display", "trigger", "frequency", "priority",
      "perVault", "actions", "audience", "condition", "startsAt", "endsAt",
    ],
    "message",
  );
  const id = o.id;
  if (typeof id !== "string" || !MESSAGE_ID_RE.test(id)) {
    fail("message.id must be 3 to 80 lowercase letters, digits or dashes");
  }
  const spec: MessageSpec = {
    id,
    title: str(o, "title", "message", 1, 120, true)!,
    body: str(o, "body", "message", 1, 2000, true)!,
  };
  const icon = oneOf(o, "icon", "message", ICONS);
  if (icon) spec.icon = icon;
  const tone = oneOf(o, "tone", "message", TONES);
  if (tone) spec.tone = tone;
  if (o.display !== undefined) {
    const d = obj(o.display, "display");
    onlyKeys(d, ["kind", "size", "dismissible"], "display");
    spec.display = {};
    const kind = oneOf(d, "kind", "display", ["popup", "banner", "toast"] as const);
    if (kind) spec.display.kind = kind;
    const size = oneOf(d, "size", "display", ["small", "medium", "large"] as const);
    if (size) spec.display.size = size;
    const dismissible = bool(d, "dismissible", "display");
    if (dismissible !== undefined) spec.display.dismissible = dismissible;
  }
  if (o.trigger !== undefined) {
    const t = obj(o.trigger, "trigger");
    onlyKeys(t, ["on", "delaySeconds"], "trigger");
    spec.trigger = {};
    const on = oneOf(t, "on", "trigger", ["launch", "vault-open", "anytime"] as const);
    if (on) spec.trigger.on = on;
    const delay = int(t, "delaySeconds", "trigger", 0, 600);
    if (delay !== undefined) spec.trigger.delaySeconds = delay;
  }
  if (o.frequency !== undefined) {
    const f = obj(o.frequency, "frequency");
    onlyKeys(f, ["mode", "everyHours", "maxShows", "minHoursBetweenShows"], "frequency");
    spec.frequency = {};
    const mode = oneOf(f, "mode", "frequency", ["once", "until-done", "every"] as const);
    if (mode) spec.frequency.mode = mode;
    const every = int(f, "everyHours", "frequency", 1, 8760);
    if (every !== undefined) spec.frequency.everyHours = every;
    const maxShows = int(f, "maxShows", "frequency", 1, 1000);
    if (maxShows !== undefined) spec.frequency.maxShows = maxShows;
    const gap = int(f, "minHoursBetweenShows", "frequency", 1, 8760);
    if (gap !== undefined) spec.frequency.minHoursBetweenShows = gap;
  }
  const priority = int(o, "priority", "message", -1000, 1000);
  if (priority !== undefined) spec.priority = priority;
  const perVault = bool(o, "perVault", "message");
  if (perVault !== undefined) spec.perVault = perVault;
  if (o.actions !== undefined) {
    if (!Array.isArray(o.actions) || o.actions.length > 4) fail("message.actions must be a list of at most 4");
    spec.actions = o.actions.map(action);
    const ids = new Set(spec.actions.map((a) => a.id));
    if (ids.size !== spec.actions.length) fail("message.actions ids must be unique");
  }
  if (o.audience !== undefined) spec.audience = audience(o.audience);
  const condition = str(o, "condition", "message", 1, 80);
  if (condition !== undefined) spec.condition = condition;
  const startsAt = iso(o, "startsAt", "message");
  if (startsAt) spec.startsAt = startsAt;
  const endsAt = iso(o, "endsAt", "message");
  if (endsAt) spec.endsAt = endsAt;
  if (startsAt && endsAt && Date.parse(endsAt) <= Date.parse(startsAt)) fail("message.endsAt must be after startsAt");
  return spec;
}
