// Experimental: an "Agent Skills" row at the bottom of the sidebar, just above the
// profile section (outside it, styled like Home's row), so people find the feature. One quiet
// row (glyph, label, the vault's team skill count) that opens Vault Settings →
// Skills; a glowing "New" chip beside the count for 14 days from its first
// showing on this computer, and a small accent dot when something here wants
// a look. To drop it, set SHOW_SKILLS_SHORTCUT to false.

import { useEffect, useState } from "react";
import { authManager } from "../../lib/auth/authManager";
import { useCatalog } from "../../lib/skills/catalogCache";
import { shortcutAttention, showNewChip } from "../../lib/skills/shortcut";
import { isSkillOnThisDevice, useSkillsDeviceState } from "../../lib/skills/syncHost";
import { useStore } from "../../store";
import { AgentSkillsGlyph } from "./parts";
import "./SkillsShortcut.css";

export const SHOW_SKILLS_SHORTCUT = true;

/**
 * Nine tiny sparkles over the label and the "New" tag, placed by hand (inside
 * the 32px row, so nothing shifts) on staggered 1.6–2.6s loops: two or three
 * are lit at any moment, at varying strength.
 */
const SPARKLES: ReadonlyArray<{ left: string; top: number; size: number; dur: number; delay: number; peak: number }> = [
  { left: "4%", top: -5, size: 7, dur: 2.2, delay: 0, peak: 0.9 },
  { left: "22%", top: 13, size: 6, dur: 1.8, delay: 0.5, peak: 0.6 },
  { left: "38%", top: -6, size: 5, dur: 2.5, delay: 1.1, peak: 0.75 },
  { left: "53%", top: 14, size: 7, dur: 2.0, delay: 0.3, peak: 0.85 },
  { left: "66%", top: -4, size: 6, dur: 1.6, delay: 1.4, peak: 0.7 },
  { left: "76%", top: 12, size: 5, dur: 2.4, delay: 0.8, peak: 0.6 },
  { left: "84%", top: -6, size: 7, dur: 2.6, delay: 1.9, peak: 1 },
  { left: "93%", top: 13, size: 6, dur: 1.9, delay: 1.2, peak: 0.8 },
  { left: "99%", top: -2, size: 5, dur: 2.3, delay: 0.2, peak: 0.65 },
];

export function SkillsShortcut() {
  const device = useSkillsDeviceState();
  // Decided once per mount, and only once the row actually shows (that first
  // showing starts the 14 days).
  const [chip, setChip] = useState<boolean | null>(null);
  const serverUrl = useStore((s) => s.serverUrl);
  const orgId = useStore((s) => (s.syncEnabled ? s.session?.activeOrganizationId ?? null : null));
  // Signed in to a server with skills, on a synced vault: otherwise no row.
  const visible = device.active && !device.unsupported && !!orgId;
  const catalog = useCatalog(authManager.api, orgId, visible);
  useEffect(() => {
    if (visible && chip === null) setChip(showNewChip());
  }, [visible, chip]);
  if (!visible || !orgId) return null;

  const count = catalog?.skills.length ?? device.manifest?.orgs.find((o) => o.orgId === orgId)?.skills.length ?? null;
  const attention = shortcutAttention({
    orgId,
    skills: catalog?.skills ?? null,
    results: device.results,
    recentUpdates: device.recentUpdates,
    isOn: (id) => isSkillOnThisDevice(serverUrl, orgId, id),
  });

  const open = () => {
    try { localStorage.setItem("context.skills.scope", "team"); } catch { /* storage unavailable */ }
    useStore.getState().requestSettings("skills");
  };

  return (
    <div className="skills-shortcut">
      <button
        type="button"
        className="skills-shortcut-row"
        title={chip ? "New: your team's Agent Skills, in Claude, Codex, Cursor and Gemini" : attention ?? "Your team's Agent Skills"}
        onClick={open}
      >
        <AgentSkillsGlyph size={18} />
        <span className="skills-shortcut-name">
          <span className="skills-shortcut-label">Agent Skills</span>
          {chip && (
            <>
              <span className="skills-shortcut-new">
                <span className="skills-shortcut-new-text">New</span>
              </span>
              <span className="skills-sparkles" aria-hidden="true">
                {SPARKLES.map((sp, i) => (
                  <span
                    key={i}
                    className="skills-sparkle"
                    style={{
                      left: sp.left,
                      top: sp.top,
                      fontSize: sp.size,
                      animationDuration: `${sp.dur}s`,
                      animationDelay: `${sp.delay}s`,
                      ["--sparkle-peak" as string]: sp.peak,
                    }}
                  >
                    ✦
                  </span>
                ))}
              </span>
            </>
          )}
        </span>
        {attention && <span className="skills-shortcut-dot" aria-label={attention} role="img" />}
        {count !== null && <span className="skills-shortcut-count">{count}</span>}
      </button>
    </div>
  );
}
