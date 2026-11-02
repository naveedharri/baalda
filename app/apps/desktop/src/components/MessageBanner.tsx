import { useEffect, useSyncExternalStore } from "react";
import * as ipc from "../lib/ipc";
import { MessageBody } from "../lib/messages/body";
import { currentMessage, messageShown, resolveMessage, subscribeMessage } from "../lib/messages/center";
import type { PreparedMessage } from "../lib/messages/select";
import { toast } from "../lib/toast";
import { Banner, type BannerTone } from "./Banner";
import { useNoticeSlot } from "./useNoticeSlot";
import { runMessageAction } from "./MessagePopup";

const BANNER_TONE: Record<string, BannerTone> = {
  info: "neutral",
  important: "action",
  warning: "danger",
  success: "good",
};

/**
 * A server-driven message as a banner (in the shared notice slot) or a toast,
 * exactly like every other notice. Popups are `MessagePopup`'s.
 */
export function MessageBanner() {
  const m = useSyncExternalStore(subscribeMessage, currentMessage, currentMessage);
  useMessageToast(m?.display === "toast" ? m : null);
  const banner = m?.display === "banner" ? m : null;
  const dismissible = banner?.spec.display?.dismissible !== false;
  const visible = useNoticeSlot("message", banner != null, dismissible && banner ? { onFade: () => resolveMessage(banner, "close") } : {});

  useEffect(() => {
    if (visible && banner) messageShown(banner);
  }, [visible, banner]);

  return (
    <Banner show={visible} className="message-banner" role="status" tone={BANNER_TONE[banner?.spec.tone ?? "info"] ?? "neutral"}>
      {banner && (
        <>
          <span className="message-banner-text">
            <b>{banner.spec.title}</b>{" "}
            <MessageBody text={banner.spec.body} onOpenLink={(url) => void ipc.openExternal(url).catch(() => {})} />
          </span>
          <div className="banner-actions">
            {banner.actions.map((a, i) => (
              <button
                key={a.id}
                className={i === 0 ? "primary" : a.style === "quiet" ? "link-btn" : undefined}
                onClick={() => void runMessageAction(banner, a).catch((e) => console.warn("message action failed:", e))}
              >
                {a.label}
              </button>
            ))}
            {dismissible && <button onClick={() => resolveMessage(banner, "dismiss")}>Dismiss</button>}
          </div>
        </>
      )}
    </Banner>
  );
}

/** A toast message: one line (title, then body), its first action as the toast's. */
function useMessageToast(m: PreparedMessage | null): void {
  useEffect(() => {
    if (!m) return;
    messageShown(m);
    const first = m.actions[0];
    const text = `${m.spec.title} ${m.spec.body.replace(/\*\*/g, "").replace(/\s+/g, " ")}`.trim();
    toast(text, m.spec.tone === "warning" ? "error" : m.spec.tone === "success" ? "success" : "neutral", {
      ...(first ? { action: { label: first.label, run: () => void runMessageAction(m, first).catch(() => {}) } } : {}),
    });
    // A toast is seen once per session; the server's frequency decides the rest.
    resolveMessage(m, "close");
  }, [m]);
}
