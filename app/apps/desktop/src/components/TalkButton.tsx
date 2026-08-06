import { useEffect, useRef } from "react";
import { useStore } from "../store";
import "./talk.css";

const MIC_ICON = (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M12 2a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
    <path d="M19 10v1a7 7 0 0 1-14 0v-1" />
    <path d="M12 18v4" />
  </svg>
);

/**
 * Push-to-talk. Hold to broadcast live audio to everyone in the vault; release
 * and it stops. Nothing is recorded or kept — this is a walkie-talkie, not a
 * voice-note feature, and there is deliberately nothing to play back.
 *
 * Hold, never toggle: a toggle makes "am I live right now?" a thing the user has
 * to remember, and getting that wrong means an open mic. Holding a key is its
 * own reminder.
 */
export function TalkButton() {
  const broadcasting = useStore((s) => s.broadcasting);
  const speakers = useStore((s) => s.voiceSpeakers);
  const voiceError = useStore((s) => s.voiceError);
  const voiceReady = useStore((s) => s.voiceReady);
  const startBroadcast = useStore((s) => s.startBroadcast);
  const stopBroadcast = useStore((s) => s.stopBroadcast);

  // Tracks whether WE started the current press, so a stray pointerup elsewhere
  // in the window can't stop a broadcast we never began.
  const held = useRef(false);

  const start = () => {
    if (held.current) return;
    held.current = true;
    void startBroadcast();
  };
  const stop = () => {
    if (!held.current) return;
    held.current = false;
    void stopBroadcast();
  };

  // A pointer released outside the button, a lost window, or a tab hidden
  // mid-press must all end the transmission. Without these the mic can stay
  // open after the user believes they let go.
  useEffect(() => {
    const onUp = () => stop();
    const onHide = () => {
      if (document.hidden) stop();
    };
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    window.addEventListener("blur", onUp);
    document.addEventListener("visibilitychange", onHide);
    return () => {
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      window.removeEventListener("blur", onUp);
      document.removeEventListener("visibilitychange", onHide);
      stop(); // unmounting while live must not leave the mic open
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const offline = !voiceReady;
  const listening = speakers.length > 0;

  return (
    <div className="talk">
      <button
        type="button"
        className={`talk-btn${broadcasting ? " live" : ""}`}
        disabled={offline}
        aria-pressed={broadcasting}
        title={
          offline
            ? "Connect to a synced vault to use push-to-talk"
            : "Hold to talk to everyone in this vault"
        }
        onPointerDown={(e) => {
          // Primary button only; a right-click shouldn't open the mic.
          if (e.button !== 0) return;
          e.preventDefault(); // don't start a text selection drag
          start();
        }}
        // Keyboard parity: hold Space/Enter while focused. `repeat` is ignored
        // because key repeat would otherwise fire start() many times a second.
        onKeyDown={(e) => {
          if (e.repeat || (e.key !== " " && e.key !== "Enter")) return;
          e.preventDefault();
          start();
        }}
        onKeyUp={(e) => {
          if (e.key !== " " && e.key !== "Enter") return;
          stop();
        }}
      >
        <span className="talk-icon">{MIC_ICON}</span>
        <span className="talk-label">{broadcasting ? "On air" : "Hold to talk"}</span>
      </button>

      {listening && (
        <div className="talk-speakers" role="status" aria-live="polite">
          {speakers.map((s) => (
            <span key={s.userId} className="talk-speaker">
              <span
                className="talk-speaker-dot"
                style={{ background: s.color || "var(--accent)" }}
                aria-hidden="true"
              />
              {s.name}
            </span>
          ))}
        </div>
      )}

      {voiceError && !broadcasting && (
        <p className="talk-error" role="status">
          {voiceError}
        </p>
      )}
    </div>
  );
}
