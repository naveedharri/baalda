// "Remove from team": the server's soft delete of a team skill, from the skill
// page's ⋯ or a card's ⋯. It leaves every teammate's AI tools on their next
// check; nobody's own local folder (the original of a skill added from a
// computer) is touched.

import { useState } from "react";
import { authManager } from "../../lib/auth/authManager";
import { skillDisplayName } from "../../lib/skills/display";
import type { SkillSummary } from "../../lib/skills/types";
import { toast } from "../../lib/toast";
import { ConfirmDialog } from "../ConfirmDialog";

/** Did this skill come from someone's computer ("Added from …'s computer")? */
function fromAComputer(skill: SkillSummary & { versions?: { notes: string }[] }): boolean {
  return !skill.source && !!skill.versions?.some((v) => /^(Added|Shared) from .+ computer$/.test(v.notes));
}

export function RemoveFromTeamDialog({
  orgId,
  skill,
  onCancel,
  onRemoved,
  ownFolderHere = false,
}: {
  orgId: string;
  skill: SkillSummary & { versions?: { notes: string }[] };
  /** A folder of the same name on this computer that isn't a team copy (the original). */
  ownFolderHere?: boolean;
  onCancel: () => void;
  /** After the server removed it (the caller fades the card or leaves the page). */
  onRemoved: () => void;
}) {
  const name = skillDisplayName(skill.name);
  const [busy, setBusy] = useState(false);
  return (
    <ConfirmDialog
      title={`Remove ${name} from the team?`}
      confirmLabel={busy ? "Removing…" : "Remove from team"}
      onCancel={onCancel}
      onConfirm={async () => {
        setBusy(true);
        try {
          await authManager.api.deleteSkill(orgId, skill.id);
        } catch {
          setBusy(false);
          toast(`Couldn't remove ${name} from the team. Try again.`, "error");
          return;
        }
        toast(`Removed ${name} from the team`);
        onRemoved();
      }}
    >
      Removes it from everyone's AI tools.{" "}
      {ownFolderHere || fromAComputer(skill)
        ? "Your original folder on your computer stays as it is."
        : "Your own local copy isn't touched."}
    </ConfirmDialog>
  );
}
