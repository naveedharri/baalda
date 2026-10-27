/* The right panel's views and the remembered last tab (per device). Versions
   is a view without a tab: only the header's Version history button opens it. */
export type RightPanelTab = "activity" | "versions";
export const RIGHT_PANEL_TABS: readonly RightPanelTab[] = ["activity", "versions"];
/** The views with a tab in the panel's strip, and the only ones the plain Panel
 *  toggle reopens. */
export type RightPanelStripTab = Extract<RightPanelTab, "activity">;
export const RIGHT_PANEL_STRIP_TABS: readonly RightPanelStripTab[] = ["activity"];
export const RIGHT_PANEL_TAB_LABEL: Record<RightPanelTab, string> = {
  activity: "Activity",
  versions: "Versions",
};
export const RIGHT_PANEL_TAB_KEY = "baalda.rightPanelTab";

export function readLastTab(): RightPanelTab {
  try {
    const v = globalThis.localStorage?.getItem(RIGHT_PANEL_TAB_KEY);
    return (RIGHT_PANEL_STRIP_TABS as readonly string[]).includes(v ?? "") ? (v as RightPanelTab) : "activity";
  } catch {
    return "activity";
  }
}

export function writeLastTab(tab: RightPanelTab): void {
  try {
    globalThis.localStorage?.setItem(RIGHT_PANEL_TAB_KEY, tab);
  } catch {
    // Remembering the tab is a convenience.
  }
}
