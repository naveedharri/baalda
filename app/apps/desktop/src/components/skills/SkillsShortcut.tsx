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
        <span className="skills-shortcut-label">Agent Skills</span>
        {chip && (
          <span className="skills-shortcut-new">
            New
            <span className="skills-sparkle s1" aria-hidden="true">✦</span>
            <span className="skills-sparkle s2" aria-hidden="true">✦</span>
            <span className="skills-sparkle s3" aria-hidden="true">✦</span>
          </span>
        )}
        {attention && <span className="skills-shortcut-dot" aria-label={attention} role="img" />}
        {count !== null && <span className="skills-shortcut-count">{count}</span>}
      </button>
    </div>
  );
}
