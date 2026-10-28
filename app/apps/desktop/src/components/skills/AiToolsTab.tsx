// Account Settings → AI tools: what THIS machine does with team skills
// (docs/SKILLS.md §5.5). Which tool folders it writes, and per skill across
// every vault on this server whether the copy here is current, edited by hand,
// or blocked by another folder of the same name.

import { useEffect, useState } from "react";
import * as ipc from "../../lib/ipc";
import { authManager } from "../../lib/auth/authManager";
import { toast } from "../../lib/toast";
import type { SkillTarget, SkillTargetInfo } from "../../lib/ipc";
import { loadSkillsPrefs, onSkillsPrefsChanged } from "../../lib/skills/prefs";
import { skillDisplayName } from "../../lib/skills/display";
import {
  checkSkillsNow,
  isSkillOnThisDevice,
  keepMySkill,
  replaceNameTakenSkill,
  setSkillOnThisDevice,
  setSkillTargetEnabled,
  showDeliveryNow,
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
import { EmptyState, InstallButton, LoadError, ProgressBar, SkeletonCards, SkillCard, TARGET_SHORT, ToolRowSkeleton, WarnMark } from "./parts";
import { SkillsMenuButton } from "./SkillsMenuButton";
import { TipAnchor } from "./SquareTip";
import { overallState, stateLines, targetStates } from "../../lib/skills/installState";
import type { ManifestSkill } from "../../lib/skills/types";
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

  const rows = (state.manifest?.orgs ?? []).flatMap((org) =>
    org.skills.map((skill) => ({ org, skill })),
  );
  const multiVault = (state.manifest?.orgs.length ?? 0) > 1;

  /**
   * The Skills tab's install square for one skill on this computer: + to use
   * it, ✓ when here (Required can't be removed), and the amber "!" with its
   * choices when a copy here was edited, its name is taken, or it failed.
   */
  const square = (orgId: string, role: string, skill: ManifestSkill) => {
    const optional = skill.delivery === "optional";
    const on = !optional || isSkillOnThisDevice(serverUrl, orgId, skill.skillId);
    const states = targetStates(results, prefs.targets, orgId, skill.skillId);
    const overall = overallState(states);
    const lines = stateLines(states, skill.version).join("\n");
    if (on && (overall === "warn" || overall === "bad")) {
      const targetsIn = (state: string) => (Object.keys(states) as SkillTarget[]).filter((t) => states[t] === state);
      const edited = targetsIn("edited");
      const conflict = targetsIn("conflict");
      const which = (t: SkillTarget, many: boolean, label: string) => (many ? `${label} (${TARGET_SHORT[t]})` : label);
      const actions = [
        ...edited.flatMap((t) => [
          { key: `keep-${t}`, label: which(t, edited.length > 1, "Keep mine"), hint: "Leave your edited copy as it is", onSelect: () => keepMySkill(orgId, skill.skillId, t) },
          { key: `team-${t}`, label: which(t, edited.length > 1, "Use team version"), hint: "Your copy is backed up first", onSelect: () => applyTeamSkillVersion(orgId, skill.skillId, t) },
        ]),
        ...conflict.flatMap((t) => {
          const own = results.find((r) => r.orgId === orgId && r.skillId === skill.skillId && r.target === t)?.conflict === "unmanaged";
          return own
            ? [
                { key: `nt-team-${t}`, label: which(t, conflict.length > 1, "Use team version"), hint: "Your copy is backed up first", onSelect: () => replaceNameTakenSkill(orgId, skill.skillId, t) },
                { key: `nt-keep-${t}`, label: which(t, conflict.length > 1, "Keep my own"), hint: "Leave your folder as it is on this computer", onSelect: () => keepMySkill(orgId, skill.skillId, t) },
              ]
            : [
                // Another vault's, server's or account's copy: backed up, then replaced.
                { key: `nt-team-${t}`, label: which(t, conflict.length > 1, "Use team version"), hint: "The other copy is backed up first", onSelect: () => replaceNameTakenSkill(orgId, skill.skillId, t) },
              ];
        }),
        { key: "check", label: "Check again", onSelect: () => checkSkillsNow() },
      ];
      return (
        <TipAnchor content={{ heading: overall === "bad" ? "Couldn't install on this computer" : "Needs a look on this computer", lines: lines.split("\n"), note: "Click to choose what to do" }}>
          <SkillsMenuButton
            label={<WarnMark />}
            caret={false}
            className={`skills-install is-${overall}`}
            ariaLabel={`Fix ${skillDisplayName(skill.name)}. ${lines.split("\n").join(". ")}`}
            actions={actions}
          />
        </TipAnchor>
      );
    }
    if (!optional) {
      const canManage = role === "owner" || role === "admin";
      return (
        <InstallButton
          kind="required"
          title={`Required by your team\n${lines}`}
          name={skill.name}
          canManage={canManage}
          onMakeOptional={
            canManage
              ? async () => {
                  const undo = showDeliveryNow(orgId, skill.skillId, "optional");
                  try {
                    await authManager.api.patchSkill(orgId, skill.skillId, { delivery: "optional" });
                  } catch (e) {
                    undo();
                    throw e;
                  }
                  toast(`${skillDisplayName(skill.name)} is now optional. People can remove it from their computer.`);
                  checkSkillsNow();
                }
              : undefined
          }
        />
      );
    }
    if (on) {
      return (
        <InstallButton
          kind="installed"
          title={`On this computer · click to remove\n${lines}`}
          onClick={() => setRemoving({ orgId, skillId: skill.skillId, name: skill.name })}
        />
      );
    }
    return <InstallButton kind="install" title="Use on this computer" onClick={() => setSkillOnThisDevice(orgId, skill.skillId, true)} />;
  };

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
        <div className="skills-grid-host">
          <SkeletonCards count={3} label="Checking for skills" />
        </div>
      ) : rows.length === 0 ? (
        <EmptyState title="No skills yet">Your vaults haven't published any skills.</EmptyState>
      ) : (
        <div className="skills-grid-host">
          <ul className="skills-grid">
            {rows.map(({ org, skill }) => (
              <SkillCard
                key={`${org.orgId}:${skill.skillId}`}
                name={skill.name}
                byline={
                  <span className="skills-meta-line">
                    {multiVault ? `${org.orgName} · ` : ""}v{skill.version} · {skill.delivery === "optional" ? "Optional" : "Required"}
                  </span>
                }
                description={skill.description || "No description yet."}
                action={square(org.orgId, org.role, skill)}
              />
            ))}
          </ul>
        </div>
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
