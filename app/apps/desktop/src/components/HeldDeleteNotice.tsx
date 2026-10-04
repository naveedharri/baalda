import { useState } from "react";
import { Banner } from "./Banner";
import { useStore } from "../store";
import { useNoticeSlot } from "./useNoticeSlot";

/**
 * Many notes were removed from the vault folder at once with the app open
 * (#221). Past the blast-radius cap a disk delete is NEVER sent to the team:
 * deleting for everyone happens inside the app, where the creator-only rule
 * applies. So this only informs. "Restore now" brings them back at once;
 * Dismiss, or the fade, releases the hold and the next pull restores them.
 * The fade waits while Restore now is in flight.
 */
export function HeldDeleteNotice() {
  const pending = useStore((s) => s.structureNotice.pendingDelete);
  const [busy, setBusy] = useState(false);
  const release = (how: "restore" | "dismiss") => {
    setBusy(true);
    void useStore
      .getState()
      .releaseBulkDelete(how)
      .catch((e) => console.warn("[sync] bulk delete release failed", e))
      .finally(() => setBusy(false));
  };
  const visible = useNoticeSlot("held-delete", pending != null, {
    onFade: () => release("dismiss"),
    hold: busy,
  });
  const n = pending?.count ?? 0;
  return (
    <Banner show={visible} role="status">
      <span>
        You removed {n.toLocaleString()} {n === 1 ? "note" : "notes"} on this device. They stay for
        your team and will be restored here.
      </span>
      <div className="banner-actions">
        <button className="primary" disabled={busy} onClick={() => release("restore")}>
          Restore now
        </button>
        <button className="secondary" disabled={busy} onClick={() => release("dismiss")}>
          Dismiss
        </button>
      </div>
    </Banner>
  );
}
