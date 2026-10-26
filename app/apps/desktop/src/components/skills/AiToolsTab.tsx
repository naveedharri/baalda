// Account Settings → AI tools: what THIS machine does with team skills
// (docs/SKILLS.md §5.5). Which tool folders it writes, and per skill across
// every vault on this server whether the copy here is current, edited by hand,
// or blocked by another folder of the same name.

import { useEffect, useState } from "react";
import * as ipc from "../../lib/ipc";
import type { SkillTarget, SkillTargetInfo } from "../../lib/ipc";
import { loadSkillsPrefs, onSkillsPrefsChanged } from "../../lib/skills/prefs";
import { skillDisplayName } from "../../lib/skills/display";
import {
  checkSkillsNow,
  isSkillOnThisDevice,
  keepMySkill,
  setSkillOnThisDevice,
  setSkillTargetEnabled,
  useSkillsDeviceState,
  applyTeamSkillVersion,
} from "../../lib/skills/syncHost";
import { useStore } from "../../store";
import { AsyncButton } from "../AsyncButton";
import { RowActionsMenu } from "../RowActionsMenu";
import { Spinner } from "../Spinner";
import { ConfirmDialog } from "../ConfirmDialog";
import { Switch } from "../Switch";
import { ToolLogo } from "./ToolLogos";
import "../editor.css";
import { deviceDot, EmptyState, InstallButton, LoadError, ProgressBar, RowSkeletons, SkillIcon, StatusDot, Tag, TARGET_SHORT, ToolRowSkeleton } from "./parts";
import "./skills.css";

const TARGET_LABEL: Record<SkillTarget, string> = {
  claude: "Claude",
  agents: "Codex & other tools",
};

const TOOL_NAME: Record<string, string> = {
  codex: "Codex",
  cursor: "Cursor",
  gemini: "Gemini CLI",
  copilot: "Copilot",
  opencode: "OpenCode",
};


function installedText(t: SkillTargetInfo): string {
  if (t.target === "claude") return t.toolInstalled ? "Detected" : "Not installed";
  if (t.detectedTools.length === 0) return "Not installed";
  return `Detected: ${t.detectedTools.map((d) => TOOL_NAME[d] ?? d).join(", ")}`;
}

export function AiToolsTab() {
  const state = useSkillsDeviceState();
  const serverUrl = useStore((s) => s.serverUrl);
  const [prefs, setPrefs] = useState(loadSkillsPrefs);
  const [targets, setTargets] = useState<SkillTargetInfo[]>(state.targets);
  const [removing, setRemoving] = useState<{ orgId: string; skillId: string; name: string } | null>(null);

  useEffect(() => onSkillsPrefsChanged(setPrefs), []);
  useEffect(() => {
    if (state.targets.length > 0) {
      setTargets(state.targets);
      return;
    }
    // Before the first run finishes the paths still deserve to be shown.
    let cancelled = false;
    ipc.skillsTargets().then(
      (t) => {
        if (!cancelled) setTargets(t);
      },
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, [state.targets]);

  if (state.unsupported) {
    return <div className="muted">This server needs an update before skills can sync here.</div>;
  }

  const results = state.results;
  const stateOf = (orgId: string, skillId: string, target: SkillTarget) =>
    results.find((r) => r.orgId === orgId && r.skillId === skillId && r.target === target) ?? null;

  const rows = (state.manifest?.orgs ?? []).flatMap((org) =>
    org.skills.map((skill) => ({ org, skill })),
  );
  const multiVault = (state.manifest?.orgs.length ?? 0) > 1;

  const openBackups = async () => {
    const dir = await ipc.skillsBackupsDir();
    await ipc.openInFileManager(dir);
  };

  return (
    <>
      <div className="muted">Your vaults' skills install into these folders.</div>

      {targets.length === 0 && <ToolRowSkeleton />}
      {targets.map((t) => (
        <label key={t.target} className="menu-row toggle-row">
          <span className="menu-row-label">
            <span className="skills-tool-row-title">
              <span className="skills-tool-cluster">
                {(t.target === "claude" ? (["claude"] as const) : (["codex", "cursor", "gemini"] as const)).map((tool) => (
                  <ToolLogo key={tool} tool={tool} size={15} />
                ))}
              </span>
              {TARGET_LABEL[t.target]}
            </span>
            <span className="field-hint">
              {installedText(t)}
              <code className="skills-target-path">{t.root}</code>
            </span>
          </span>
          <Switch
            checked={prefs.targets[t.target]}
            ariaLabel={`Install skills for ${TARGET_LABEL[t.target]}`}
            onChange={(next) => setSkillTargetEnabled(t.target, next)}
          />
        </label>
      ))}

      <div className="skills-section-head">
        <div className="subhead">Agent Skills</div>
        <span className="skills-actions">
          <RowActionsMenu
            ariaLabel="More"
            actions={[{ key: "backups", label: "Open backups folder", onSelect: openBackups }]}
          />
          <AsyncButton
            className="secondary skills-btn-sm"
            disabled={!state.active || state.running}
            onClick={() => checkSkillsNow()}
          >
            {state.running ? (
              <span className="skills-inline">
                <Spinner size="xs" /> Checking…
              </span>
            ) : (
              "Check now"
            )}
          </AsyncButton>
        </span>
      </div>
      <ProgressBar active={state.running && !!state.manifest} />
      {state.lastError && (
        <LoadError message={`Couldn't check for skills: ${state.lastError}`} onRetry={() => checkSkillsNow()} />
      )}

      {!state.active ? (
        <div className="muted">Sign in to get your team's skills.</div>
      ) : !state.manifest ? (
        <RowSkeletons count={3} square={false} label="Checking for skills" />
      ) : rows.length === 0 ? (
        <EmptyState title="No skills yet">Your vaults haven't published any skills.</EmptyState>
      ) : (
        <ul className="skills-list">
          {rows.map(({ org, skill }) => {
            const optional = skill.delivery === "optional";
            const on = !optional || isSkillOnThisDevice(serverUrl, org.orgId, skill.skillId);
            const active = targets.filter((t) => prefs.targets[t.target]);
            const edited = active.filter((t) => stateOf(org.orgId, skill.skillId, t.target)?.state === "edited");
            const kept = active.some((t) => stateOf(org.orgId, skill.skillId, t.target)?.state === "keptMine");
            const conflict = active.some((t) => stateOf(org.orgId, skill.skillId, t.target)?.state === "conflict");
            const dot = deviceDot(results, org.orgId, skill.skillId);
            return (
              <li key={`${org.orgId}:${skill.skillId}`} className="skills-list-row is-static">
                <SkillIcon />
                <span className="skills-row-main">
                  <span className="skills-row-name">{skillDisplayName(skill.name)}</span>
                  <span className="skills-row-desc">
                    {multiVault ? `${org.orgName} · ` : ""}v{skill.version} · {optional ? "Optional" : "Required"}
                  </span>
                </span>
                <span className="skills-row-side">
                  {on && edited.length > 0 ? (
                    <>
                      <Tag tone="warn" title={edited.map((t) => TARGET_SHORT[t.target]).join(", ")}>Edited here</Tag>
                      <RowActionsMenu
                        ariaLabel={`Choose for ${skill.name}`}
                        actions={edited.flatMap((t) => [
                          {
                            key: `keep-${t.target}`,
                            label: edited.length > 1 ? `Keep mine (${TARGET_SHORT[t.target]})` : "Keep mine",
                            onSelect: () => keepMySkill(org.orgId, skill.skillId, t.target),
                          },
                          {
                            key: `team-${t.target}`,
                            label: edited.length > 1 ? `Use team version (${TARGET_SHORT[t.target]})` : "Use team version",
                            onSelect: () => applyTeamSkillVersion(org.orgId, skill.skillId, t.target),
                          },
                        ])}
                      />
                    </>
                  ) : on && conflict ? (
                    <Tag tone="warn" title="Another folder on this computer uses this name">Name taken</Tag>
                  ) : on && kept ? (
                    <Tag>Kept yours</Tag>
                  ) : on ? (
                    <StatusDot tone={dot.tone} label={dot.label} />
                  ) : null}
                  {optional ? (
                    on ? (
                      <InstallButton
                        kind="installed"
                        title="On this computer · click to remove"
                        onClick={() => setRemoving({ orgId: org.orgId, skillId: skill.skillId, name: skill.name })}
                      />
                    ) : (
                      <InstallButton
                        kind="add"
                        title="Use on this computer"
                        onClick={() => setSkillOnThisDevice(org.orgId, skill.skillId, true)}
                      />
                    )
                  ) : (
                    <InstallButton kind="required" title="Required by your team" />
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      )}

      {removing && (
        <ConfirmDialog
          title={`Remove ${skillDisplayName(removing.name)} from this computer?`}
          confirmLabel="Remove"
          onCancel={() => setRemoving(null)}
          onConfirm={() => {
            setSkillOnThisDevice(removing.orgId, removing.skillId, false);
            setRemoving(null);
          }}
        >
          It stays in the vault; you can add it back any time. A copy you edited is kept, not deleted.
        </ConfirmDialog>
      )}
    </>
  );
}
