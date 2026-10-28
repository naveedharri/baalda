// A member profile's "Skills" tab (owners/admins): this person's level for
// every team skill, from their own row or the Everyone row, changed in place
// with the same menu as a skill's Shared with tab.

import { useCallback, useEffect, useState } from "react";
import { authManager } from "../../lib/auth/authManager";
import { ACCESS_LABEL, accessLevelClass, personAccessOptions, type PersonAccessChoice } from "../../lib/skills/access";
import { skillDisplayName } from "../../lib/skills/display";
import { loadErrorText, withTimeout } from "../../lib/skills/loading";
import { checkSkillsNow, useSkillsChanged } from "../../lib/skills/syncHost";
import type { MemberSkillAccess, SkillAccessLevel } from "../../lib/skills/types";
import { toast } from "../../lib/toast";
import { ConfirmDialog } from "../ConfirmDialog";
import { MenuSelect } from "../MenuSelect";
import { LoadError } from "./parts";
import "./skills.css";

export function MemberSkillsTab({ orgId, userId, name }: { orgId: string; userId: string; name: string }) {
  const [skills, setSkills] = useState<MemberSkillAccess[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<MemberSkillAccess | null>(null);

  const load = useCallback(async () => {
    try {
      setSkills(await withTimeout(authManager.api.getMemberSkills(orgId, userId)));
      setError(null);
    } catch (e) {
      setError(loadErrorText(e));
    }
  }, [orgId, userId]);
  useEffect(() => {
    void load();
  }, [load]);
  useSkillsChanged(orgId, () => void load());

  /** `level: null` = back to the Everyone row. */
  const apply = async (s: MemberSkillAccess, level: SkillAccessLevel | null) => {
    setBusy(true);
    try {
      const out = await authManager.api.putSkillAccess(orgId, s.skillId, { people: [{ userId, level }] });
      const now = out.people.find((p) => p.userId === userId)?.level ?? "none";
      toast(
        now === "none"
          ? `${name} no longer gets ${skillDisplayName(s.name)}.`
          : `${name} now gets ${skillDisplayName(s.name)} as ${ACCESS_LABEL[now].toLowerCase()}.`,
      );
      checkSkillsNow();
      await load();
    } catch (e) {
      toast(`Couldn't change ${skillDisplayName(s.name)} for ${name}: ${e instanceof Error ? e.message : String(e)}`, "error");
    } finally {
      setBusy(false);
    }
  };

  if (error && !skills) return <LoadError message={`Couldn't load ${name}'s skills: ${error}`} onRetry={() => void load()} />;
  if (!skills) return <div className="skills-access-skel" aria-busy="true" aria-label={`Loading ${name}'s skills`} />;
  if (skills.length === 0) return <div className="muted skills-quiet">This vault has no team skills yet.</div>;

  return (
    <div className="skills-access">
      <p className="field-hint skills-access-note">
        What {name}'s AI tools get from this vault. Their own setting beats the Everyone default either way.
      </p>
      <ul className="skills-access-people">
        {skills.map((s) => {
          return (
            <li key={s.skillId} className="skills-access-person">
              <span className="members-table-names">
                <span className="members-table-name">{skillDisplayName(s.name)}</span>
                <span className="muted">
                  {s.latestVersion === null ? "Not published · " : ""}
                  {s.own ? "Set for them" : "Same as everyone"}
                </span>
              </span>
              <MenuSelect<PersonAccessChoice>
                value={s.level}
                options={personAccessOptions(s.own, s.everyone)}
                onSelect={(c) => {
                  if (c === "everyone") return void apply(s, null);
                  if (!s.own && c === s.level) return;
                  if (c === "none") setConfirm(s);
                  else void apply(s, c);
                }}
                disabled={busy}
                ariaLabel={`${skillDisplayName(s.name)} for ${name}`}
                triggerClassName={`members-access-trigger is-level ${accessLevelClass(s.level)}`}
                menuClassName="access-menu"
                triggerContent={ACCESS_LABEL[s.level]}
              />
            </li>
          );
        })}
      </ul>

      {confirm && (
        <ConfirmDialog
          title={`Take ${skillDisplayName(confirm.name)} away from ${name}?`}
          confirmLabel="Take away"
          onCancel={() => setConfirm(null)}
          onConfirm={async () => {
            const s = confirm;
            setConfirm(null);
            await apply(s, "none");
          }}
        >
          They won't see it anywhere, and their AI tools lose it. An untouched copy is removed from their computer; one they
          edited stays as their own skill.
        </ConfirmDialog>
      )}
    </div>
  );
}
