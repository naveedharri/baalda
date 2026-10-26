// Experimental: an "Agent Skills" row at the bottom of the sidebar, just above the
// profile section (outside it, styled like Home's row), so people find the feature. One quiet
// row (glyph, label, the vault's team skill count) that opens Vault Settings →
// Skills; a "New" chip instead of the count until the shortcut itself has been
// clicked once on this computer, then a small accent dot when something here
// wants a look. To drop it, set SHOW_SKILLS_SHORTCUT to false.

import { useEffect, useState } from "react";
import { authManager } from "../../lib/auth/authManager";
import { useCatalog } from "../../lib/skills/catalogCache";
import { markShortcutSeen, onShortcutSeen, shortcutAttention, shortcutSeen } from "../../lib/skills/shortcut";
import { isSkillOnThisDevice, useSkillsDeviceState } from "../../lib/skills/syncHost";
import { useStore } from "../../store";
import { AgentSkillsGlyph } from "./parts";
import "./SkillsShortcut.css";

export const SHOW_SKILLS_SHORTCUT = true;

export function SkillsShortcut() {
  const device = useSkillsDeviceState();
  const [seen, setSeen] = useState(shortcutSeen);
  useEffect(() => onShortcutSeen(() => setSeen(true)), []);
  const serverUrl = useStore((s) => s.serverUrl);
  const orgId = useStore((s) => (s.syncEnabled ? s.session?.activeOrganizationId ?? null : null));
  // Signed in to a server with skills, on a synced vault: otherwise no row.
  const visible = device.active && !device.unsupported && !!orgId;
  const catalog = useCatalog(authManager.api, orgId, visible);
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
    markShortcutSeen();
    try { localStorage.setItem("context.skills.scope", "team"); } catch { /* storage unavailable */ }
    useStore.getState().requestSettings("skills");
  };

  return (
    <div className="skills-shortcut">
      <button
        type="button"
        className="skills-shortcut-row"
        title={!seen ? "New: your team's Agent Skills, in Claude, Codex, Cursor and Gemini" : attention ?? "Your team's Agent Skills"}
        onClick={open}
      >
        <AgentSkillsGlyph size={18} />
        <span className="skills-shortcut-label">Agent Skills</span>
        {!seen ? (
          <span className="skills-shortcut-new">
            <span aria-hidden="true">✦</span> New
          </span>
        ) : (
          <>
            {attention && <span className="skills-shortcut-dot" aria-label={attention} role="img" />}
            {count !== null && <span className="skills-shortcut-count">{count}</span>}
          </>
        )}
      </button>
    </div>
  );
}
