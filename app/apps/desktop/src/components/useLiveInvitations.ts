import { useEffect } from "react";
import { useStore } from "../store";
import {
  INVITATION_POLL_MS,
  invitationFrameAction,
  needsInvitationPoll,
  setInvitationFrameHandler,
} from "../lib/invitationLive";

// Several vault channels can be open (one per vault), and each relays the same
// user frame, so a burst of identical arrivals collapses into one GET.
const REFRESH_COALESCE_MS = 250;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleRefresh(): void {
  if (refreshTimer) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    void useStore.getState().refreshUserInvitations();
  }, REFRESH_COALESCE_MS);
}

/**
 * Mount once (App). Live invitation frames refresh or drop the signed-in
 * user's invitations; the focus refresh and, while no vault channel is live,
 * a 60 s focused-window poll cover the cases no frame can reach.
 */
export function useLiveInvitations(): void {
  const signedIn = useStore((s) => s.session !== null);
  const status = useStore((s) => s.vaultSyncStatus);
  const poll = signedIn && needsInvitationPoll(status);

  useEffect(() => {
    setInvitationFrameHandler((frame) => {
      const action = invitationFrameAction(frame);
      if (!action) return;
      if (action.kind === "drop") useStore.getState().dropUserInvitation(action.invitationId);
      // A drop still re-reads: others may have been answered at the same time.
      scheduleRefresh();
    });
    return () => setInvitationFrameHandler(null);
  }, []);

  useEffect(() => {
    if (!signedIn) return;
    const onFocus = () => void useStore.getState().refreshUserInvitations();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [signedIn]);

  useEffect(() => {
    if (!poll) return;
    const id = setInterval(() => {
      if (!document.hasFocus()) return;
      void useStore.getState().refreshUserInvitations();
    }, INVITATION_POLL_MS);
    return () => clearInterval(id);
  }, [poll]);
}
