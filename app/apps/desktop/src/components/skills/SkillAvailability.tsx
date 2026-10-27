// A team skill on THIS computer, in two parts on its page:
// - `InstallControl`, in the header's control group (the way Claude shows
//   Install on a plugin page): Install · ✓ Installed ▾ · ✓ Installed for
//   everyone · Fix… for a problem;
// - `SkillAvailability`, the line under the header that only explains:
//   "Use /x in … on this computer" · "Installed for you in [logos]" ·
//   "Installed for everyone in [logos]". Faded logos keep their reasons.

import { useEffect, useState } from "react";
import { revealInFileManager, revealLabel, type SkillTarget } from "../../lib/ipc";
import { skillDisplayName } from "../../lib/skills/display";
import {
  AI_TOOL_NAME,
  detectedAiTools,
  stateLines,
  targetStates,
  teamAvailability,
  type TargetState,
  type ToolAvailability,
} from "../../lib/skills/installState";
import { loadSkillsPrefs, onSkillsPrefsChanged } from "../../lib/skills/prefs";
import { useDeviceScan, type DeviceScan } from "../../lib/skills/deviceScan";
import { CODEX_NEW_CHAT_HINT } from "../../lib/skills/syncEngine";
import {
  applyTeamSkillVersion,
  checkSkillsNow,
  getSkillsDeviceState,
  isSkillOnThisDevice,
  keepMySkill,
  replaceNameTakenSkill,
  quietNextAdd,
  setSkillOnThisDevice,
  useSkillsDeviceState,
} from "../../lib/skills/syncHost";
import type { SkillDetail } from "../../lib/skills/types";
import { toast } from "../../lib/toast";
import { useStore } from "../../store";
import { ConfirmDialog } from "../ConfirmDialog";
import { BusyButton } from "./parts";
import { RequiredBadge } from "./SquareTip";
import { SkillsMenuButton } from "./SkillsMenuButton";
import { ToolMarks } from "./ToolLogos";

const INSTALL_WAIT_MS = 20_000;

function firstTarget(states: Record<SkillTarget, TargetState>, state: TargetState): SkillTarget | null {
  return (Object.keys(states) as SkillTarget[]).find((t) => states[t] === state) ?? null;
}

/** Show the folder that holds this skill's name in one AI tool's skills folder. */
function revealSkillFolder(target: SkillTarget, name: string): void {
  const root = getSkillsDeviceState().targets.find((t) => t.target === target)?.root;
  if (root) void revealInFileManager(`${root.replace(/[\\/]+$/, "")}/${name}`);
}

/** Is the folder holding this name in that target a symlink (never replaced)? */
function isLinkedFolder(scan: DeviceScan, target: SkillTarget, name: string): boolean {
  if (scan.status !== "ready") return false;
  const location = target === "claude" ? "claudePersonal" : "agentsPersonal";
  return scan.entries.some((e) => e.location === location && e.isSymlink && e.name.toLowerCase() === name.toLowerCase());
}

/** "Claude, Codex and Gemini". */
function toolList(tools: readonly ToolAvailability[]): string {
  const names = tools.map((t) => AI_TOOL_NAME[t.tool]);
  return names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** Everything both parts need about this skill on this computer. */
function useSkillHere(orgId: string, skill: SkillDetail) {
  const device = useSkillsDeviceState();
  const serverUrl = useStore((s) => s.serverUrl);
  const [prefs, setPrefs] = useState(loadSkillsPrefs);
  useEffect(() => onSkillsPrefsChanged(setPrefs), []);
  const optional = skill.delivery === "optional";
  const optedIn = !optional || isSkillOnThisDevice(serverUrl, orgId, skill.id);
  const states = targetStates(device.results, prefs.targets, orgId, skill.id);
  const detected = detectedAiTools(device.targets);
  const tools = teamAvailability(states, optedIn, detected);
  return {
    optional,
    optedIn,
    states,
    tools,
    detected,
    edited: firstTarget(states, "edited"),
    conflict: firstTarget(states, "conflict"),
    conflictKind: device.results.find(
      (r) => r.orgId === orgId && r.skillId === skill.id && r.state === "conflict",
    )?.conflict,
    failed: firstTarget(states, "failed"),
  };
}

/** The header's install control (same 34px group as Publish). */
export function InstallControl({
  orgId,
  skill,
  canManage,
  onMakeOptional,
}: {
  orgId: string;
  skill: SkillDetail;
  canManage: boolean;
  /** Admins: the Required badge's "Make optional" (the skill page's PATCH). */
  onMakeOptional?: () => Promise<void>;
}) {
  const here = useSkillHere(orgId, skill);
  const scan = useDeviceScan();
  const [removing, setRemoving] = useState(false);
  const name = skillDisplayName(skill.name);

  /** Turn it on here and wait for the run to place it (or give up after a cap). */
  const install = async () => {
    quietNextAdd(skill.id);
    setSkillOnThisDevice(orgId, skill.id, true);
    const start = Date.now();
    while (Date.now() - start < INSTALL_WAIT_MS) {
      await new Promise((r) => setTimeout(r, 300));
      const live = targetStates(getSkillsDeviceState().results, loadSkillsPrefs().targets, orgId, skill.id);
      const states = Object.values(live);
      if (states.some((s) => s === "failed" || s === "conflict" || s === "edited")) return;
      if (states.some((s) => s === "installed" || s === "keptMine")) {
        const ready = teamAvailability(live, true, detectedAiTools(getSkillsDeviceState().targets)).filter((t) => t.on);
        const codex = ready.some((t) => t.tool === "codex");
        toast(`Installed ${name}${ready.length ? ` · ready in ${toolList(ready)}` : ""}${codex ? `. ${CODEX_NEW_CHAT_HINT}` : ""}`);
        return;
      }
    }
  };

  if (here.optedIn && (here.edited || here.conflict || here.failed)) {
    const actions = here.edited
      ? [
          { key: "keep", label: "Keep mine", hint: "Leave your edited copy as it is", onSelect: () => keepMySkill(orgId, skill.id, here.edited!) },
          { key: "team", label: "Use team version", hint: "Your copy is backed up first", onSelect: () => applyTeamSkillVersion(orgId, skill.id, here.edited!) },
        ]
      : here.conflict
        ? [
            // Only the person's own real folder can be backed up and replaced:
            // never another skill's, vault's or user's, and never a symlink.
            ...(here.conflictKind === "unmanaged" && !isLinkedFolder(scan, here.conflict, skill.name)
              ? [{ key: "team", label: "Use team version", hint: "Your copy is backed up first", onSelect: () => replaceNameTakenSkill(orgId, skill.id, here.conflict!) }]
              : []),
            ...(here.conflictKind === "unmanaged"
              ? [{ key: "keep", label: "Keep my own", hint: "Leave your folder as it is on this computer", onSelect: () => keepMySkill(orgId, skill.id, here.conflict!) }]
              : []),
            { key: "reveal", label: revealLabel(), onSelect: () => revealSkillFolder(here.conflict!, skill.name) },
          ]
        : [{ key: "retry", label: "Try again", onSelect: () => checkSkillsNow() }];
    return <SkillsMenuButton label="Fix…" className="secondary skills-hdr-btn skills-ctl skills-fix-btn" actions={actions} />;
  }
  if (!here.optional) {
    return (
      <RequiredBadge
        name={name}
        lines={stateLines(here.states, skill.effectiveVersion)}
        canManage={canManage}
        onMakeOptional={canManage ? onMakeOptional : undefined}
      >
        <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="3.75" y="7.25" width="8.5" height="6" rx="1.5" />
          <path d="M5.5 7.25V5.5a2.5 2.5 0 0 1 5 0v1.75" />
        </svg>
        Installed for everyone
      </RequiredBadge>
    );
  }
  if (here.optedIn) {
    return (
      <>
        <SkillsMenuButton
          label={
            <>
              <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M20 6 9 17l-5-5" />
              </svg>
              Installed
            </>
          }
          className="secondary skills-hdr-btn skills-ctl skills-installed-btn"
          actions={[{ key: "remove", label: "Remove from this computer", onSelect: () => setRemoving(true) }]}
        />
        {removing && (
          <ConfirmDialog
            title={`Remove ${name} from this computer?`}
            confirmLabel="Remove"
            onCancel={() => setRemoving(false)}
            onConfirm={() => {
              setSkillOnThisDevice(orgId, skill.id, false);
              setRemoving(false);
            }}
          >
            It stays in the vault; you can install it again any time. A copy you edited is kept, not deleted.
          </ConfirmDialog>
        )}
      </>
    );
  }
  return (
    <BusyButton
      className={`${canManage ? "secondary skills-install-strong" : "primary"} skills-hdr-btn skills-ctl`}
      busyLabel="Installing…"
      onClick={install}
    >
      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M12 4v11M7 10l5 5 5-5M5 20h14" />
      </svg>
      Install
    </BusyButton>
  );
}

/** The explanation line under the header (no buttons: those live in the header). */
export function SkillAvailability({ orgId, skill }: { orgId: string; skill: SkillDetail }) {
  const here = useSkillHere(orgId, skill);
  const name = skillDisplayName(skill.name);

  let body: React.ReactNode;
  if (here.optedIn && here.edited) {
    body = <span className="skills-available-text is-warn">Edited here: you changed this copy. Use Fix… to keep it or take the team's.</span>;
  } else if (here.optedIn && here.conflict) {
    body = (
      <span className="skills-available-text is-warn">
        {here.conflictKind === "unmanaged"
          ? "Name taken by a folder of yours on this computer. Use Fix… to choose which one to keep."
          : "Name taken by another skill on this computer. Rename or remove that folder to use this one."}
      </span>
    );
  } else if (here.optedIn && here.failed) {
    body = <span className="skills-available-text is-bad">Couldn't install on this computer</span>;
  } else if (!here.optedIn) {
    body = (
      <>
        <span className="skills-available-text">Use {name} in {toolList(here.tools)} on this computer</span>
        <ToolMarks tools={here.tools} names={false} />
      </>
    );
  } else {
    body = (
      <>
        <span className="skills-available-text" title={here.optional ? undefined : "Required by your team, so it can't be removed"}>
          {here.optional ? "Installed for you in" : "Installed for everyone in"}
        </span>
        <ToolMarks tools={here.tools} />
      </>
    );
  }
  return <div className="skills-available">{body}</div>;
}
