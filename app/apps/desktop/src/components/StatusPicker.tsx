/* Status moments picker (redesign preview): one row of status buttons and a
   clear-after choice, at the top of the account menu. Icons are drawn, not
   emoji, so they look the same on macOS, Windows and Linux. */
import { useState } from "react";
import { useStore } from "../store";
import { STATUS_CLEAR_AFTER, STATUS_MOMENTS, statusUntilFrom, type ActivityStatus } from "../lib/prefs";

const ICONS: Record<string, string> = {
  online: '<circle cx="12" cy="12" r="5" fill="currentColor" stroke="none"/>',
  smoke: '<rect x="3" y="13" width="15" height="4" rx="1"/><path d="M18 13v4M21 13v4M17 9c0-2 2-2 2-4M20 9c0-2 2-2 2-4"/>',
  coffee: '<path d="M4 9h12v6a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4z"/><path d="M16 11h1.5a2.5 2.5 0 0 1 0 5H16M8 3c0 2 1 2 1 4M12 3c0 2 1 2 1 4"/>',
  lunch: '<path d="M3 12h18a9 9 0 0 1-18 0zM8 8 14 3M11 9l6-5"/>',
  meeting: '<path d="M4 15v-3a8 8 0 0 1 16 0v3"/><rect x="2" y="14" width="5" height="7" rx="2"/><rect x="17" y="14" width="5" height="7" rx="2"/>',
  focus: '<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/>',
  brb: '<circle cx="12" cy="13" r="8"/><path d="M12 9v4l3 2M9 2h6"/>',
};

export function StatusPicker() {
  const status = useStore((s) => s.activityStatus);
  const until = useStore((s) => s.activityStatusUntil);
  const [clearAfter, setClearAfter] = useState<number | null>(60);
  const items: Array<{ id: ActivityStatus; label: string }> = [
    { id: "online", label: "Online" },
    ...STATUS_MOMENTS.map((m) => ({ id: m.id, label: m.label })),
  ];
  const set = (id: ActivityStatus, minutes: number | null) =>
    useStore.getState().setActivityStatus(id, id === "online" ? null : statusUntilFrom(minutes));
  const current = items.find((i) => i.id === status);
  const left = until ? Math.max(0, Math.round((until - Date.now()) / 60_000)) : null;
  const [open, setOpen] = useState(false);
  const isOnline = status === "online" || !current;
  return (
    <div className={`rd-status${open ? " is-open" : ""}`}>
      {isOnline ? (
        <div className="rd-status-field">
          <button type="button" className="rd-status-field-main" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="12" cy="12" r="9" /><path d="M8 14s1.5 2 4 2 4-2 4-2M9 9.5h.01M15 9.5h.01" />
            </svg>
            Update your status
          </button>
          {(["smoke", "coffee", "focus"] as const).map((id) => (
            <button key={id} type="button" className={`rd-status-quick s-${id}`} title={items.find((i) => i.id === id)?.label} onClick={() => set(id, clearAfter)}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" dangerouslySetInnerHTML={{ __html: ICONS[id] }} />
            </button>
          ))}
        </div>
      ) : (
        <div className="rd-status-field is-set">
          <button type="button" className="rd-status-field-main" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
            <svg className={`rd-status-set-icon s-${status}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" dangerouslySetInnerHTML={{ __html: ICONS[status] ?? ICONS.online }} />
            <span className="rd-status-set-text">
              <b>{current!.label}</b>
              {left !== null && <small> · {left >= 60 ? `${Math.round(left / 60)} h` : `${left} min`}</small>}
            </span>
          </button>
          <button type="button" className="rd-status-quick" title="Clear status" onClick={() => { set("online", null); setOpen(false); }}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>
          </button>
        </div>
      )}
      {open && (<>
      <div className="rd-status-row" role="radiogroup" aria-label="Status">
        {items.map((i) => (
          <button
            key={i.id}
            type="button"
            role="radio"
            aria-checked={status === i.id}
            title={i.label}
            className={`rd-status-btn s-${i.id}${status === i.id ? " on" : ""}`}
            onClick={() => set(i.id, clearAfter)}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" dangerouslySetInnerHTML={{ __html: ICONS[i.id] }} />
          </button>
        ))}
      </div>
      <div className="rd-status-clear">
        {STATUS_CLEAR_AFTER.map((c) => (
          <button
            key={c.label}
            type="button"
            className={clearAfter === c.minutes ? "on" : ""}
            onClick={() => {
              setClearAfter(c.minutes);
              if (status !== "online") set(status, c.minutes);
            }}
          >
            {c.label}
          </button>
        ))}
      </div>
      </>)}
    </div>
  );
}
