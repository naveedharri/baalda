// The quiet "New" chip on Vault Settings → Members and access → Access groups
// (2026-11-25): access groups are how teams give access now, so owners and
// admins are told once, gently, that the tab is worth a look. It shows from its
// first showing on this computer for NEW_CHIP_MS, or until the person has
// opened the tab, whichever comes first. No storage: shown for the session.

const KEY = "context.accessGroups.newChip.v1";
export const GROUPS_NEW_CHIP_MS = 21 * 24 * 60 * 60 * 1000;

interface ChipState {
  first: number;
  opened?: boolean;
}

function read(): ChipState | null {
  const raw = localStorage.getItem(KEY);
  if (!raw) return null;
  const parsed = JSON.parse(raw) as Partial<ChipState>;
  return typeof parsed.first === "number" && parsed.first > 0 ? { first: parsed.first, opened: !!parsed.opened } : null;
}

/** Should the Access groups tab wear its "New" chip? Stamps the first showing. */
export function showGroupsNewChip(now = Date.now()): boolean {
  try {
    const state = read();
    if (!state) {
      localStorage.setItem(KEY, JSON.stringify({ first: now }));
      return true;
    }
    return !state.opened && now - state.first < GROUPS_NEW_CHIP_MS;
  } catch {
    return true;
  }
}

/** The person opened the tab: the chip has done its job (from the next visit on). */
export function markGroupsTabOpened(now = Date.now()): void {
  try {
    const state = read() ?? { first: now };
    if (state.opened) return;
    localStorage.setItem(KEY, JSON.stringify({ first: state.first, opened: true }));
  } catch {
    /* storage unavailable */
  }
}
