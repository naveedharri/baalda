// Account-level, device-local preferences that follow the app rather than any
// one vault: the user's activity status and the mention chime. Persisted in
// localStorage (device-local, like the theme). Profile fields (display name,
// avatar) are NOT here — those are server-backed via Better Auth so they follow
// the account across devices; see `ApiClient.updateUser`.

export type ActivityStatus = "online" | "away" | "busy" | "invisible";

export const ACTIVITY_STATUSES: Array<{
  id: ActivityStatus;
  label: string;
  hint: string;
}> = [
  { id: "online", label: "Online", hint: "Active and available" },
  { id: "away", label: "Away", hint: "Not at the keyboard right now" },
  { id: "busy", label: "Busy", hint: "Please do not disturb" },
  { id: "invisible", label: "Invisible", hint: "Appear offline to teammates" },
];

const STATUS_KEY = "context.activityStatus";
const MENTION_SOUND_KEY = "context.mentionSound";

function isActivityStatus(v: unknown): v is ActivityStatus {
  return v === "online" || v === "away" || v === "busy" || v === "invisible";
}

export function readActivityStatus(): ActivityStatus {
  try {
    const v = localStorage.getItem(STATUS_KEY);
    return isActivityStatus(v) ? v : "online";
  } catch {
    return "online";
  }
}

export function writeActivityStatus(status: ActivityStatus): void {
  try {
    localStorage.setItem(STATUS_KEY, status);
  } catch {
    /* localStorage unavailable — status stays in-memory only */
  }
}

/** The mention chime is on by default; only an explicit opt-out disables it. */
export function readMentionSound(): boolean {
  try {
    return localStorage.getItem(MENTION_SOUND_KEY) !== "off";
  } catch {
    return true;
  }
}

export function writeMentionSound(enabled: boolean): void {
  try {
    localStorage.setItem(MENTION_SOUND_KEY, enabled ? "on" : "off");
  } catch {
    /* localStorage unavailable — preference stays in-memory only */
  }
}
