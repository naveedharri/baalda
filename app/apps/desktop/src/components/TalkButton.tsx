import { useEffect, useRef } from "react";
import { useStore } from "../store";
import "./talk.css";

// Megaphone — reads as "broadcast to the team" in a way a bare microphone
// doesn't. A mic glyph says "record me"; this says "everyone hears this".
const MEGAPHONE_ICON = (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="m3 11 18-5v12L3 14v-3z" />
    <path d="M11.6 16.8a3 3 0 1 1-5.8-1.6" />
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
  const clearVoiceError = useStore((s) => s.clearVoiceError);

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

  // The notice is transient, like the mention toast — it says its piece and
  // leaves rather than sitting in the chrome as a permanent red mark.
  useEffect(() => {
    if (!voiceError) return;
    const t = window.setTimeout(() => clearVoiceError(), 4000);
    return () => window.clearTimeout(t);
  }, [voiceError, clearVoiceError]);

  const speaker = speakers[0];
  const extra = speakers.length - 1;

  return (
    <>
      {voiceError && (
        <span className="talk-note" role="status">
          {voiceError}
        </span>
      )}

      {speaker && (
        <span className="talk-note talking" role="status" aria-live="polite">
          <span
            className="talk-dot"
            style={{ background: speaker.color || "var(--accent)" }}
            aria-hidden="true"
          />
          {extra > 0 ? `${speaker.name} +${extra} talking` : `${speaker.name} is talking`}
        </span>
      )}

      <button
        type="button"
        className={`icon-btn talk-btn${broadcasting ? " live" : ""}`}
        disabled={!voiceReady}
        aria-pressed={broadcasting}
        aria-label="Push to talk"
        title={
          voiceReady
            ? "Press and hold to talk to everyone in this vault"
            : "Connect to a synced vault to use push-to-talk"
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
        {MEGAPHONE_ICON}
      </button>
    </>
  );
}
