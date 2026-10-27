// Skills tab → "On this device": every skill this computer's AI tools can see,
// read by Rust's `skills_scan_device` (read-only), grouped by
// `lib/skills/deviceGrouping.ts`. Clicking one opens a read-only preview of its
// SKILL.md; admins can add a personal or plugin skill to the team, which
// reads the folder (`skillsReadFolder`), uploads it and publishes v1.

import { useEffect, useState } from "react";
import { skillErrorCode } from "../../lib/api";
import { authManager } from "../../lib/auth/authManager";
import * as ipc from "../../lib/ipc";
import {
  countLive,
  deviceAvailability,
  deviceItems,
  groupDeviceSkills,
  isDisabled,
  tildePath,
  usedByText,
  type DeviceGroup,
  type DeviceItem,
} from "../../lib/skills/deviceGrouping";
import { skillDisplayName } from "../../lib/skills/display";
import { useSkillsDeviceState } from "../../lib/skills/syncHost";
import type { SkillSummary } from "../../lib/skills/types";
import { base64ToText, isValidSkillName, limitProblemText, parseSkillFrontmatter, suggestSkillName } from "../../lib/skills/validate";
import { toast } from "../../lib/toast";
import { useStore } from "../../store";
import { markDeviceSeen, scanDevice, useDeviceScan } from "../../lib/skills/deviceScan";
import { DeviceSkillFiles } from "./DeviceSkillFiles";
import { AvailableIn } from "./ToolLogos";
import { detectedAiTools } from "../../lib/skills/installState";
import { AsyncButton } from "../AsyncButton";
import { BusyButton, SkillCard, EmptyState, LoadError, ProgressBar, RefreshIcon, SkillGridSkeleton, SkillIcon, Tag, withTildes } from "./parts";


function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function filesText(item: DeviceItem): string {
  return `${item.fileCount}${item.truncated ? "+" : ""} ${item.fileCount === 1 && !item.truncated ? "file" : "files"}`;
}

/** Home folder, read off the agents root (`<home>/.agents/skills`). */
function homeOf(targets: readonly ipc.SkillTargetInfo[]): string | null {
  const root = targets.find((t) => t.target === "agents")?.root;
  return root?.endsWith("/.agents/skills") ? root.slice(0, -"/.agents/skills".length) : null;
}

export function DeviceSkillsView({
  onPageChange,
  filter,
  orgId,
  canShare,
  vaultSkills,
  onShared,
  onBack,
}: {
  /** The Skills tab toolbar's search. */
  filter: string;
  orgId: string;
  /** Owners/admins: offer Add to team. */
  canShare: boolean;
  vaultSkills: readonly SkillSummary[];
  /** A skill was added to the vault; ring it on the Team grid. */
  onShared: (skillId: string) => void;
  /** A skill's page is open (the tab hides its footer there). */
  onPageChange?: (open: boolean) => void;
  /** Back to the Team grid (the same as the toolbar's Team toggle). */
  onBack?: () => void;
}) {
  const device = useSkillsDeviceState();
  // The session's scan (the Skills tab already started it); Refresh rescans.
  const scan = useDeviceScan();
  const [showDisabled, setShowDisabled] = useState(false);
  /** Groups flipped from their default: the first open, the rest closed. */
  const [flipped, setFlipped] = useState<ReadonlySet<string>>(new Set());
  const [open, setOpen] = useState<DeviceItem | null>(null);
  useEffect(() => {
    onPageChange?.(open !== null);
    return () => onPageChange?.(false);
  }, [open, onPageChange]);
  const [home, setHome] = useState<string | null>(homeOf(device.targets));

  const refresh = () => scanDevice(true);

  useEffect(() => {
    // The first visit to this view on this computer stops the toggle's dot.
    markDeviceSeen();
    if (!home) {
      ipc.skillsTargets().then((t) => setHome(homeOf(t)), () => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (open) {
    return (
      <DeviceSkillPreview
        item={open}
        home={home}
        orgId={orgId}
        canShare={canShare && !open.managed}
        vaultSkills={vaultSkills}
        onBack={() => setOpen(null)}
        onShared={onShared}
      />
    );
  }

  const entries = scan.status === "ready" ? scan.entries : [];
  const allItems = deviceItems(entries);
  const total = countLive(allItems);
  const disabled = allItems.filter(isDisabled).length;
  const groups = groupDeviceSkills(entries, filter, showDisabled);
  const toggle = (key: string) =>
    setFlipped((c) => {
      const next = new Set(c);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  /** "Claude · Codex · 7 files", plus where it lives when the name is shared. */
  const metaText = (item: DeviceItem) =>
    [
      item.pluginName ? `${item.pluginName}${item.pluginVersion ? ` v${item.pluginVersion}` : ""}` : null,
      usedByText(item) || null,
      item.hint,
      filesText(item),
    ]
      .filter(Boolean)
      .join(" · ");

  const itemProps = (item: DeviceItem) => ({
    role: "button" as const,
    tabIndex: 0,
    title: tildePath(item.paths[0], home),
    onClick: () => setOpen(item),
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === "Enter") setOpen(item);
    },
  });

  const body = (g: DeviceGroup) => (
      <ul className="skills-grid">
        {g.items.map((item) => (
          <SkillCard
            key={`${item.realPath}|${item.hint ?? ""}`}
            name={item.name}
            byline={
              <>
                <span className="skills-meta-line" title={metaText(item)}>{withTildes(metaText(item))}</span>
                {isDisabled(item) && <Tag>Disabled in Claude</Tag>}
              </>
            }
            description={item.description || "No description."}
            className={isDisabled(item) ? "is-disabled" : ""}
            li={itemProps(item)}
          />
        ))}
      </ul>
  );

  return (
    <>
      {/* The back link and Refresh share one row; the count is on the toggle already. */}
      <div className="skills-source-bar">
        {onBack ? (
          <button type="button" className="link-btn member-profile-back" onClick={onBack}>
            ← Team skills
          </button>
        ) : (
          <span />
        )}
        <button
          type="button"
          className={`icon-btn skills-icon-btn${scan.status === "loading" || (scan.status === "ready" && scan.refreshing) ? " is-spinning" : ""}`}
          disabled={scan.status === "loading" || (scan.status === "ready" && !!scan.refreshing)}
          onClick={() => void refresh()}
          aria-label="Refresh"
          title="Refresh"
        >
          <RefreshIcon />
        </button>
      </div>
      <ProgressBar active={scan.status === "ready" && !!scan.refreshing} />

      {scan.status === "ready" && scan.errors.length > 0 && (
        <div className="field-hint skills-quiet-line" title={scan.errors.map((e) => `${e.root}: ${e.error}`).join("\n")}>
          {scan.errors.length === 1 ? "One folder couldn't be read." : `${scan.errors.length} folders couldn't be read.`}
        </div>
      )}

      {scan.status === "loading" ? (
        <SkillGridSkeleton count={6} label="Loading this computer's skills" />
      ) : scan.status === "error" ? (
        <LoadError message={`Couldn't look at this computer's skills: ${scan.message}`} onRetry={() => void refresh()} />
      ) : total === 0 && !(showDisabled && disabled > 0) ? (
        <EmptyState
          title="No skills on this computer yet"
          actions={
            disabled > 0 && !showDisabled ? (
              <button className="secondary" onClick={() => setShowDisabled(true)}>Show disabled plugins ({disabled})</button>
            ) : undefined
          }
        >
          Skills you add to Claude, Codex or other AI tools show up here.
        </EmptyState>
      ) : (
        <>
          {groups.length === 0 && <div className="field-hint skills-quiet">No skills match.</div>}
          {groups.map((g, gi) => {
            // A search shows every match; otherwise only the first group starts open.
            const isCollapsed = !filter.trim() && (gi > 0) !== flipped.has(g.key);
            return (
              <section key={g.key} className="skills-group">
                <button
                  type="button"
                  className="skills-group-head is-toggle"
                  aria-expanded={!isCollapsed}
                  onClick={() => toggle(g.key)}
                >
                  <svg className={`skills-caret${isCollapsed ? " is-closed" : ""}`} viewBox="0 0 10 10" aria-hidden="true">
                    <path d="M2 3.5 5 6.5 8 3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                  <span>{g.label}</span>
                  {g.kind === "claudePlugin" && <Tag>Claude plugin</Tag>}
                  {g.kind === "codexPlugin" && <Tag>Codex plugin</Tag>}
                  <span className="skills-group-count">{g.items.length}</span>
                </button>
                {!isCollapsed && body(g)}
              </section>
            );
          })}
          {disabled > 0 && (
            <button type="button" className="link-btn skills-disabled-toggle" onClick={() => setShowDisabled((v) => !v)}>
              {showDisabled ? "Hide disabled plugins" : `Show disabled plugins (${disabled})`}
            </button>
          )}
        </>
      )}
    </>
  );
}

/** Where a skill on this computer comes from, for the page's source pill. */
function deviceSourceLabel(item: DeviceItem): string {
  if (item.managed) return "From your team";
  const l = item.locations;
  if (l.some((x) => x === "claudePersonal" || x === "agentsPersonal" || x === "codexPersonal")) return "Your skill";
  if (l.includes("claudePlugin")) return "Claude plugin";
  if (l.includes("codexPlugin")) return "Codex plugin";
  if (l.includes("claudeSynced")) return "Claude org";
  return "Codex built-in";
}

/** "Couldn't add /x to the team: it has more than 1000 files. Remove …" */
function addFailedText(name: string, raw: string): string {
  return `Couldn't add ${skillDisplayName(name)} to the team: ${limitProblemText(raw) ?? raw}`;
}

/** One device skill, read-only: where it lives, its SKILL.md, and Add to team. */
function DeviceSkillPreview({
  item,
  home,
  orgId,
  canShare,
  vaultSkills,
  onBack,
  onShared,
}: {
  item: DeviceItem;
  home: string | null;
  orgId: string;
  canShare: boolean;
  vaultSkills: readonly SkillSummary[];
  onBack: () => void;
  onShared: (skillId: string) => void;
}) {
  const hostTargets = useSkillsDeviceState().targets;
  const [ownTargets, setOwnTargets] = useState<ipc.SkillTargetInfo[]>([]);
  const targets = hostTargets.length > 0 ? hostTargets : ownTargets;
  useEffect(() => {
    // Signed out or not synced yet: detect the tools directly.
    if (hostTargets.length === 0) ipc.skillsTargets().then(setOwnTargets, () => {});
  }, [hostTargets.length]);
  const me = useStore((s) => s.session?.user.name || s.session?.user.email || "a teammate");


  const share = async () => {
    // Rust's folder reader (skips dot folders and build output, refuses
    // symlinks inside, holds the upload caps), on the resolved folder.
    let bundle: ipc.SkillBundle;
    try {
      bundle = await ipc.skillsReadFolder(item.realPath);
    } catch (e) {
      toast(addFailedText(item.name, message(e)), "error");
      return;
    }
    const mdFile = bundle.files.find((f) => f.path === "SKILL.md");
    const skillMd = mdFile ? base64ToText(mdFile.contentBase64) : null;
    const fm = skillMd ? parseSkillFrontmatter(skillMd) : null;
    const name = fm?.ok && isValidSkillName(fm.name) ? fm.name : suggestSkillName(bundle.suggestedName);
    if (!isValidSkillName(name)) {
      toast(`"${item.name}" can't be used as a skill name.`, "error");
      return;
    }
    if (vaultSkills.some((s) => s.name === name)) {
      toast(`A skill named ${skillDisplayName(name)} already exists in this vault.`, "error");
      return;
    }
    try {
      const files = bundle.files.map((f) => ({ path: f.path, contentBase64: f.contentBase64, executable: f.executable, sha256: f.sha256 }));
      const created = await authManager.api.createSkill(orgId, name, files);
      try {
        await authManager.api.publishSkill(orgId, created.id, created.draftRevision, `Added from ${me}'s computer`);
        toast(`Added ${skillDisplayName(name)} to the team · teammates can install it from Skills`);
      } catch (e) {
        toast(`Added ${skillDisplayName(name)} to the team as a draft: ${message(e)}`, "neutral");
      }
      onShared(created.id);
    } catch (e) {
      toast(
        skillErrorCode(e) === "skill_name_taken"
          ? `A skill named ${skillDisplayName(name)} already exists in this vault.`
          : addFailedText(name, skillErrorCode(e) ?? message(e)),
        "error",
      );
    }
  };

  const byline = [
    item.pluginName ? `${item.pluginName}${item.marketplace ? ` · ${item.marketplace}` : ""}${item.pluginVersion ? ` · v${item.pluginVersion}` : ""}` : usedByText(item) || null,
    item.pluginName ? null : tildePath(item.paths[0].slice(0, item.paths[0].lastIndexOf("/")), home),
    filesText(item),
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <section className="member-profile" aria-label={item.name}>
      <button type="button" className="link-btn member-profile-back" onClick={onBack}>
        ← On this device
      </button>
      <div className="skills-detail-head">
        <SkillIcon large />
        <div className="skills-detail-title">
          <div className="skills-title-row">
            <h2 className="settings-section-title">{skillDisplayName(item.name)}</h2>
            <span className="skills-source-pill">{deviceSourceLabel(item)}</span>
          </div>
          <p className="skills-byline" title={item.paths.map((p) => tildePath(p, home)).join("\n")}>
            {withTildes(byline)}
          </p>
        </div>
        <div className="skills-detail-controls">
          <AsyncButton className="secondary skills-hdr-btn" onClick={() => ipc.revealInFileManager(item.paths[0])}>
            {ipc.revealLabel()}
          </AsyncButton>
          {canShare && (
            <BusyButton
              className="primary skills-hdr-btn"
              busyLabel="Adding…"
              title="Adds it to your team's skills as Optional. Teammates can install it from Skills."
              onClick={share}
            >
              Add to team
            </BusyButton>
          )}
        </div>
      </div>
      <AvailableIn tools={deviceAvailability(item, detectedAiTools(targets))} />
      <DeviceSkillFiles path={item.paths[0]} />
    </section>
  );
}
