// One skill, as a page inside Vault Settings → Skills with a back link (the
// MemberProfilePage pattern). Admins edit the draft, publish, choose Required or
// Optional and pin a version; everyone sees the version history and can
// download any version as a .zip.

import { useCallback, useEffect, useRef, useState } from "react";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { ApiError, skillErrorCode } from "../../lib/api";
import { authManager } from "../../lib/auth/authManager";
import * as ipc from "../../lib/ipc";
import type { SkillDelivery, SkillDetail as SkillDetailData, SkillVersionSummary } from "../../lib/skills/types";
import { skillMdProblemText, skillNameNeedsWarning, type SkillMdReason, CAP_RULE_TEXT } from "../../lib/skills/validate";
import { publishNotes } from "../../lib/skills/publishNotes";
import { skillDisplayName } from "../../lib/skills/display";
import { toast } from "../../lib/toast";
import { ConfirmDialog } from "../ConfirmDialog";
import { MenuSelect } from "../MenuSelect";
import { RowActionsMenu } from "../RowActionsMenu";
import "../editor.css";
import { AvailableSkeleton, BusyButton, EditorSkeleton, LoadError, SkillByline, SkillHeaderSkeleton, SkillIcon, Tag } from "./parts";
import { loadErrorText, withTimeout } from "../../lib/skills/loading";
import { InstallControl, SkillAvailability } from "./SkillAvailability";
import { useSkillsDeviceState } from "../../lib/skills/syncHost";
import { SkillEditor } from "./SkillEditor";
import { SkillSourceRow } from "./SkillSourceRow";
import { RemoveFromTeamDialog } from "./RemoveFromTeamDialog";

type Section = "draft" | "versions";

const DELIVERY_OPTIONS = [
  { value: "required" as const, label: "Required", hint: "Installed for everyone" },
  { value: "optional" as const, label: "Optional", hint: "Each person turns it on" },
];

function Chevron() {
  return (
    <svg className="skills-chevron" viewBox="0 0 10 10" width="10" height="10" aria-hidden="true">
      <path d="M2 3.5 5 6.5 8 3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

const REFUSAL_TEXT: Record<string, string> = {
  nothing_to_publish: "Nothing changed since the latest version.",
  stale_draft: "Someone else changed this draft. Try again.",
  ...CAP_RULE_TEXT,
};

/** A publish refusal in plain words (SKILL.md problems name what to fix). */
function publishRefusalText(e: unknown, skillName: string): string {
  const code = skillErrorCode(e);
  if (code === "invalid_skill" && e instanceof ApiError) {
    const reason = (e.body as { reason?: unknown } | undefined)?.reason;
    if (typeof reason === "string") return skillMdProblemText(reason as SkillMdReason, skillName);
  }
  return (code && REFUSAL_TEXT[code]) ?? (e instanceof Error ? e.message : String(e));
}

function dateText(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/** Download one published version as `<name>-v<N>.zip` through the save dialog. */
export async function downloadSkillZip(orgId: string, skillId: string, name: string, version: number): Promise<void> {
  const dest = await saveDialog({
    defaultPath: `${name}-v${version}.zip`,
    filters: [{ name: "Zip", extensions: ["zip"] }],
  });
  if (!dest) return;
  const v = await authManager.api.getSkillVersion(orgId, skillId, version);
  await ipc.skillsExportZip(
    dest,
    name,
    v.files.map((f) => ({ path: f.path, contentBase64: f.contentBase64, sha256: f.sha256, executable: f.executable })),
  );
  toast(`Saved ${skillDisplayName(name)} v${version}.`);
}

export function SkillDetail({
  orgId,
  skillId,
  canManage,
  onBack,
  onChanged,
}: {
  orgId: string;
  skillId: string;
  canManage: boolean;
  onBack: () => void;
  /** The catalog row changed (delivery, pin, publish, delete). */
  onChanged: () => void;
}) {
  const [skill, setSkill] = useState<SkillDetailData | null>(null);
  const [section, setSection] = useState<Section>(canManage ? "draft" : "versions");
  const [error, setError] = useState<string | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [publishError, setPublishError] = useState<string | null>(null);
  const flushRef = useRef<(() => Promise<boolean>) | null>(null);
  const device = useSkillsDeviceState();
  /** The draft editor takes the whole settings panel. */
  const [focus, setFocus] = useState(false);
  /** Bumped when the draft is replaced from outside the editor (restore). */
  const [draftEpoch, setDraftEpoch] = useState(0);
  const [confirm, setConfirm] = useState<
    | { kind: "delete" }
    | { kind: "restore"; version: SkillVersionSummary }
    | null
  >(null);

  const load = useCallback(async () => {
    try {
      setSkill(await withTimeout(authManager.api.getSkill(orgId, skillId)));
      setError(null);
    } catch (e) {
      setError(skillErrorCode(e) === "skill_not_found" ? "This skill was deleted." : loadErrorText(e));
    }
  }, [orgId, skillId]);

  useEffect(() => {
    void load();
  }, [load]);

  const patch = async (change: { delivery?: SkillDelivery; pinnedVersion?: number | null }) => {
    setError(null);
    try {
      await authManager.api.patchSkill(orgId, skillId, change);
      await load();
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const full = focus && section === "draft" && canManage;
  useEffect(() => {
    if (!full) return;
    // Capture phase on window, ahead of the settings modal's own Escape: in
    // full view Esc leaves the view, not Settings.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || confirm) return;
      e.stopPropagation();
      setFocus(false);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [full, confirm]);

  /**
   * One click: save what's pending, then publish with a note written from what
   * changed since the previous version. Refusals come back in plain words.
   */
  const publish = async () => {
    if (!skill || publishing) return;
    setPublishing(true);
    setPublishError(null);
    try {
      if (flushRef.current && !(await flushRef.current())) {
        throw new Error("The draft couldn't be saved, so it wasn't published.");
      }
      const draft = await authManager.api.getSkillDraft(orgId, skill.id);
      const previous = skill.latestVersion !== null
        ? (await authManager.api.getSkillVersion(orgId, skill.id, skill.latestVersion)).files
        : null;
      const notes = publishNotes(draft.files, previous);
      const v = await authManager.api.publishSkill(orgId, skill.id, draft.revision, notes);
      toast(`Published ${skillDisplayName(skill.name)} v${v.version} · reaches everyone on their next check`);
      await load();
      onChanged();
    } catch (e) {
      const text = publishRefusalText(e, skill.name);
      setPublishError(text);
      toast(text, "error");
    } finally {
      setPublishing(false);
    }
  };

  const back = (
    <button type="button" className="link-btn member-profile-back" onClick={onBack}>
      ← Agent Skills
    </button>
  );

  if (!skill) {
    return (
      <section className="member-profile">
        {back}
        {error ? (
          <LoadError
            message={error}
            onRetry={error === "This skill was deleted." ? undefined : () => {
              setError(null);
              void load();
            }}
          />
        ) : (
          <>
            <SkillHeaderSkeleton />
            <AvailableSkeleton />
            <EditorSkeleton />
          </>
        )}
      </section>
    );
  }

  const latest = skill.latestVersion;
  const pinOptions = [
    { value: "latest", label: latest ? `Latest (v${latest})` : "Latest" },
    ...skill.versions.map((v) => ({ value: String(v.version), label: `v${v.version}` })),
  ];
  const nextVersion = (latest ?? 0) + 1;

  return (
    <section className={`member-profile${full ? " skills-focus" : ""}`} aria-label={skill.name}>
      {full ? (
        <div className="skills-focus-bar">
          <span className="skills-row-name">{skillDisplayName(skill.name)}</span>
          <span className="skills-actions">
            {skill.draftDiffers ? (
              <BusyButton className="primary skills-btn-sm" busyLabel="Publishing…" onClick={publish}>
                Publish v{nextVersion}
              </BusyButton>
            ) : (
              <span className="skills-published">Published</span>
            )}
          </span>
        </div>
      ) : (
      <>
      {back}
      <div className="skills-detail-head">
        <SkillIcon large />
        <div className="skills-detail-title">
          <div className="skills-title-row">
            <h2 className="settings-section-title">{skillDisplayName(skill.name)}</h2>
            <span className="skills-source-pill">{skill.source ? `From ${skill.source.repo}` : "Made by your team"}</span>
          </div>
          <SkillByline skill={skill} />
          {skillNameNeedsWarning(skill.name) && (
            <span className="skills-warning">claude.ai refuses names with "claude" or "anthropic".</span>
          )}
        </div>
        <div className="skills-detail-controls">
          {device.active && skill.effectiveVersion !== null && (
            <InstallControl orgId={orgId} skill={skill} canManage={canManage} />
          )}
          {canManage ? (
            <>
              <MenuSelect
                value={skill.delivery}
                options={DELIVERY_OPTIONS}
                onSelect={(delivery) => patch({ delivery })}
                ariaLabel="Who gets this skill"
                caret={false}
                triggerClassName="secondary skills-hdr-btn skills-ctl"
                triggerContent={<>{skill.delivery === "required" ? "Required" : "Optional"}<Chevron /></>}
              />
              {skill.versions.length > 0 && (
                <MenuSelect
                  value={skill.pinnedVersion === null ? "latest" : String(skill.pinnedVersion)}
                  options={pinOptions}
                  onSelect={(v) => patch({ pinnedVersion: v === "latest" ? null : Number(v) })}
                  ariaLabel="Version everyone gets"
                  caret={false}
                  triggerClassName="secondary skills-hdr-btn skills-ctl"
                  triggerContent={
                    <>
                      {skill.pinnedVersion === null ? `Latest (v${latest})` : `v${skill.pinnedVersion}`}
                      <Chevron />
                    </>
                  }
                />
              )}
              {skill.draftDiffers ? (
                <BusyButton className="primary skills-hdr-btn skills-ctl" busyLabel="Publishing…" onClick={publish}>
                  Publish v{nextVersion}
                </BusyButton>
              ) : (
                <span className="skills-published" title="No changes since the latest version">
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M20 6 9 17l-5-5" />
                  </svg>
                  Published
                </span>
              )}
            </>
          ) : (
            <span className="skills-meta-line">
              {skill.delivery === "required" ? "Required" : "Optional"}
              {skill.pinnedVersion !== null ? ` · pinned to v${skill.pinnedVersion}` : ""}
            </span>
          )}
          <RowActionsMenu
            ariaLabel={`More for ${skillDisplayName(skill.name)}`}
            actions={[
              ...(skill.effectiveVersion !== null
                ? [{
                    key: "zip",
                    label: `Download .zip (v${skill.effectiveVersion})`,
                    onSelect: () => downloadSkillZip(orgId, skill.id, skill.name, skill.effectiveVersion!),
                  }]
                : []),
              ...(canManage
                ? [{ key: "delete", label: "Remove from team", danger: true, separated: skill.effectiveVersion !== null, onSelect: () => setConfirm({ kind: "delete" }) }]
                : []),
            ]}
          />
        </div>
      </div>

      </>
      )}

      {!full && (
      <>
      {device.active && skill.effectiveVersion !== null && <SkillAvailability orgId={orgId} skill={skill} />}
      {skill.source && (
        <SkillSourceRow
          orgId={orgId}
          skillId={skill.id}
          skillName={skill.name}
          source={skill.source}
          canManage={canManage}
          onPulled={() => {
            setSection("draft");
            setDraftEpoch((n) => n + 1);
            void load();
            onChanged();
          }}
        />
      )}

      {canManage && (
        <div className="member-profile-tabs" role="tablist" aria-label="Skill">
          {(["draft", "versions"] as const).map((s) => (
            <button
              key={s}
              type="button"
              role="tab"
              aria-selected={s === section}
              className={`member-profile-tab${s === section ? " active" : ""}`}
              onClick={() => setSection(s)}
            >
              {s === "draft" ? "Overview" : `Versions${skill.versions.length ? ` · ${skill.versions.length}` : ""}`}
            </button>
          ))}
        </div>
      )}
      </>
      )}

      {error && <div className="auth-error">{error}</div>}

      {section === "draft" && canManage ? (
        <SkillEditor
          key={draftEpoch}
          orgId={orgId}
          skill={skill}
          onSaved={() => void load()}
          focus={full}
          onToggleFocus={() => setFocus((f) => !f)}
          flushRef={flushRef}
          publishError={publishError}
        />
      ) : skill.versions.length === 0 ? (
        <div className="muted skills-quiet">Not published yet.</div>
      ) : (
        <ul className="skills-list">
          {skill.versions.map((v) => (
            <li key={v.version} className="skills-list-row is-static">
              <span className="skills-icon skills-version-badge">v{v.version}</span>
              <span className="skills-row-main">
                <span className="skills-row-name">{v.notes || `Version ${v.version}`}</span>
                <span className="skills-row-desc">
                  {dateText(v.publishedAt)}
                  {v.publishedBy ? ` · ${v.publishedBy.name}` : ""}
                  {` · ${v.fileCount} ${v.fileCount === 1 ? "file" : "files"}`}
                </span>
              </span>
              <span className="skills-row-side">
                {skill.effectiveVersion === v.version && <Tag tone="good">In use</Tag>}
                <BusyButton
                  className="link-btn skills-row-link"
                  busyLabel="Preparing…"
                  onClick={() => downloadSkillZip(orgId, skill.id, skill.name, v.version)}
                >
                  Download .zip
                </BusyButton>
                {canManage && (
                  <RowActionsMenu
                    ariaLabel={`More for v${v.version}`}
                    actions={[{ key: "restore", label: "Restore to draft", onSelect: () => setConfirm({ kind: "restore", version: v }) }]}
                  />
                )}
              </span>
            </li>
          ))}
        </ul>
      )}


      {confirm?.kind === "delete" && (
        <RemoveFromTeamDialog
          orgId={orgId}
          skill={skill}
          onCancel={() => setConfirm(null)}
          onRemoved={() => {
            setConfirm(null);
            onChanged();
            onBack();
          }}
        />
      )}

      {confirm?.kind === "restore" && (
        <ConfirmDialog
          title={`Replace the draft with v${confirm.version.version}?`}
          confirmLabel="Replace draft"
          tone="accent"
          onCancel={() => setConfirm(null)}
          onConfirm={async () => {
            try {
              await authManager.api.resetSkillDraft(orgId, skill.id, skill.draftRevision, confirm.version.version);
              toast(`The draft now matches v${confirm.version.version}.`);
            } catch (e) {
              setError(skillErrorCode(e) === "stale_draft"
                ? "Someone else changed the draft. Try again."
                : e instanceof Error ? e.message : String(e));
            }
            setConfirm(null);
            setSection("draft");
            setDraftEpoch((n) => n + 1);
            await load();
          }}
        >
          Unpublished draft changes are replaced. Published versions stay as they are.
        </ConfirmDialog>
      )}
    </section>
  );
}
