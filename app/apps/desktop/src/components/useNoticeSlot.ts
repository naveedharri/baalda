import { useEffect, useRef, useSyncExternalStore } from "react";
import {
  NOTICE_FADE_MS,
  currentNotice,
  setNoticeWanted,
  subscribeNotice,
  type NoticeId,
} from "../lib/noticeSlot";

/**
 * Claim the notice slot (`lib/noticeSlot.ts`). Returns whether THIS notice is
 * the one to show. With `onFade`, a shown notice fades after `NOTICE_FADE_MS`
 * by calling it (the same as its Dismiss); `hold` pauses that, e.g. while the
 * notice's own action is in flight. Without `onFade` it stays until its
 * condition clears: that is the notice with a pending choice.
 */
export function useNoticeSlot(
  id: NoticeId,
  wants: boolean,
  opts: { onFade?: () => void; hold?: boolean } = {},
): boolean {
  useEffect(() => {
    setNoticeWanted(id, wants);
  }, [id, wants]);
  useEffect(() => () => setNoticeWanted(id, false), [id]);
  const top = useSyncExternalStore(subscribeNotice, currentNotice, currentNotice);
  const visible = wants && top === id;

  const fadeRef = useRef(opts.onFade);
  fadeRef.current = opts.onFade;
  const fades = opts.onFade != null;
  const hold = opts.hold === true;
  useEffect(() => {
    if (!visible || !fades || hold) return;
    const timer = window.setTimeout(() => fadeRef.current?.(), NOTICE_FADE_MS);
    return () => window.clearTimeout(timer);
  }, [visible, fades, hold]);
  return visible;
}
