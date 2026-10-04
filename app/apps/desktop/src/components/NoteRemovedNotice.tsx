import { Banner } from "./Banner";
import { useStore } from "../store";
import { useNoticeSlot } from "./useNoticeSlot";

/**
 * A teammate (or an AI) deleted the note that was open, or the user's access to
 * it was removed, and we applied it here.
 *
 * Separate from the on-disk "was deleted" notice: that one means "the file
 * vanished from under us" and can only offer to close the note. This one knows
 * the server confirmed a deliberate deletion or access removal. It fades like
 * Dismiss; the removal stays in Activity.
 */
export function NoteRemovedNotice() {
  const removed = useStore((s) => s.noteRemovedByTeammate);
  const dismiss = () => useStore.setState({ noteRemovedByTeammate: null });
  const visible = useNoticeSlot("note-removed", removed != null, { onFade: dismiss });
  return (
    <Banner show={visible}>
      <span>
        {removed?.reason === "revoked" ? (
          <>Your access to this note was removed. It is no longer on this device.</>
        ) : (
          <>A teammate deleted this note. It was permanently removed from this device.</>
        )}
      </span>
      <div className="banner-actions">
        <button className="primary" onClick={dismiss}>
          Dismiss
        </button>
      </div>
    </Banner>
  );
}
