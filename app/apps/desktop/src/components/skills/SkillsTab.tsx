// Vault Settings → Skills: the vault's team catalog (docs/SKILLS.md §5.5).
// Owners and admins create, upload, edit and publish; members see what is
// published and turn Optional skills on for their own computer.

import { useCallback, useEffect, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { authManager } from "../../lib/auth/authManager";
import { skillErrorCode } from "../../lib/api";
import * as ipc from "../../lib/ipc";
import { serverFeatures } from "../../lib/serverFeatures";
import { checkSkillsNow, isSkillOnThisDevice, setSkillOnThisDevice, SKILLS_FEATURE, useSkillsDeviceState } from "../../lib/skills/syncHost";
import { groupSkills, type SkillGroup } from "../../lib/skills/grouping";
import { countLive, deviceItems } from "../../lib/skills/deviceGrouping";
import { deviceSeen, useDeviceScan } from "../../lib/skills/deviceScan";
import { overallState, stateLines, targetStates } from "../../lib/skills/installState";
import { loadSkillsPrefs } from "../../lib/skills/prefs";
import { skillDisplayName } from "../../lib/skills/display";
import type { SkillFileInput, SkillsCatalog, SkillSummary } from "../../lib/skills/types";
import {
  base64ToText,
  isValidSkillName,
  parseSkillFrontmatter,
  skillNameNeedsWarning,
  suggestSkillName, CAP_RULE_TEXT } from "../../lib/skills/validate";
import { toast } from "../../lib/toast";
import { useStore } from "../../store";
import { ConfirmDialog } from "../ConfirmDialog";
import { MarketplaceBrowser } from "./MarketplaceBrowser";
import { EmptyState, SkillCard, GitHubGlyph, InstallButton, LoadError, SearchToggle, SkillGridSkeleton, skillAuthor } from "./parts";
import { Spinner } from "../Spinner";
import { withTimeout } from "../../lib/skills/loading";
import { primeCatalog } from "../../lib/skills/catalogCache";
import { WorksWith } from "./ToolLogos";
import { DeviceSkillsView } from "./DeviceSkillsView";
import { downloadSkillZip, SkillDetail } from "./SkillDetail";
import { RemoveFromTeamDialog } from "./RemoveFromTeamDialog";
import { RowActionsMenu } from "../RowActionsMenu";
import { SkillsMenuButton } from "./SkillsMenuButton";
import { useHighlightSkill } from "./useHighlightSkill";
import { useScrollReset } from "./useScrollReset";
import "./skills.css";

const ERROR_TEXT: Record<string, string> = {
  invalid_name: "Skill names use lowercase letters, digits and single hyphens.",
  skill_name_taken: "A skill with that name already exists.",
  skill_limit_reached: "This vault has the most skills it can hold (500).",
  ...CAP_RULE_TEXT,
  payload_too_large: "That skill is too large to upload.",
  invalid_path: "One of the file names can't be used.",
};

function errorText(e: unknown): string {
  const code = skillErrorCode(e);
  return (code && ERROR_TEXT[code]) ?? (e instanceof Error ? e.message : String(e));
}

interface PendingUpload {
  name: string;
  files: SkillFileInput[];
  skipped: string[];
  existing: SkillSummary | null;
}

/** Popular public sources offered as one-click starts. */
const POPULAR_SOURCES = ["anthropics/skills", "openai/skills"];

/** List or grid, remembered per device (the Members Access tab's toggle). */
/** Team catalog or this computer's skills, remembered per device. */
type SkillsScope = "team" | "device";
/** How long a removed card fades before the reload drops it (skills.css `.is-leaving`). */
const LEAVE_MS = 220;

const SCOPE_KEY = "context.skills.scope";

function readScope(): SkillsScope {
  try {
    return localStorage.getItem(SCOPE_KEY) === "device" ? "device" : "team";
  } catch {
    return "team";
  }
}

function writeScope(scope: SkillsScope) {
  try { localStorage.setItem(SCOPE_KEY, scope); } catch { /* storage unavailable */ }
}

function ScopeToggle({
  value,
  onChange,
  teamCount,
  deviceCount,
  showDot,
}: {
  value: SkillsScope;
  onChange: (v: SkillsScope) => void;
  teamCount: number | null;
  /** null while the first scan of this computer runs. */
  deviceCount: number | null;
  /** First visit not made yet on this computer. */
  showDot: boolean;
}) {
  const option = (scope: SkillsScope, label: string, count: number | null, extra?: React.ReactNode, title?: string) => (
    <button
      type="button"
      role="radio"
      aria-checked={value === scope}
      title={title}
      className={`member-access-view-btn skills-scope-btn${value === scope ? " is-active" : ""}`}
      onClick={() => { if (value !== scope) onChange(scope); }}
    >
      {label}
      {count === null ? (
        <span className="spinner spinner-xs spinner-inherit skills-scope-spin" aria-label="Counting" />
      ) : (
        <span className="skills-chip-count">{count}</span>
      )}
      {extra}
    </button>
  );
  return (
    <div className="member-access-view" role="radiogroup" aria-label="Which skills">
      {option("team", "Team", teamCount)}
      {option(
        "device",
        "On this device",
        deviceCount,
        showDot ? <span className="skills-new-dot" aria-hidden="true" /> : null,
        showDot ? "See every skill your AI tools have on this computer" : undefined,
      )}
    </div>
  );
}

export function SkillsTab({ canManage, resetToken }: { canManage: boolean; resetToken: number }) {
  const orgId = useStore((s) => s.session?.activeOrganizationId ?? null);
  const serverUrl = useStore((s) => s.serverUrl);
  const [supported, setSupported] = useState<boolean | null>(null);
  const [catalog, setCatalog] = useState<SkillsCatalog | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  /** The marketplace page, optionally opening a repo straight away. */
  const [marketplace, setMarketplace] = useState<{ preload?: string } | null>(null);
  const [scope, setScope] = useState<SkillsScope>(readScope);
  const [loadFailed, setLoadFailed] = useState(false);
  /** "Reading files…" then "Uploading…" while a .zip goes up. */
  const [uploadPhase, setUploadPhase] = useState<string | null>(null);
  // Started quietly on open, so the toggle can count this computer's skills.
  const deviceScan = useDeviceScan();
  /** A folder of this name on this computer that isn't a team copy: the original it was added from. */
  const ownFolderHere = (name: string) =>
    deviceScan.status === "ready" &&
    deviceScan.entries.some((e) => !e.managed && !e.pluginName && e.name.toLowerCase() === name.toLowerCase());
  const [seen, setSeen] = useState(deviceSeen);
  /** Optional skills just turned on here, until the run reports them. */
  const [installing, setInstalling] = useState<ReadonlySet<string>>(new Set());
  const [removing, setRemoving] = useState<SkillSummary | null>(null);
  // Admin "Remove from team" from a card's ⋯; the card fades out before the reload drops it.
  const [teamRemoving, setTeamRemoving] = useState<SkillSummary | null>(null);
  const [leaving, setLeaving] = useState<ReadonlySet<string>>(new Set());
  const [filter, setFilter] = useState("");

  // Ring and tag a just-added skill once the Team grid is showing.
  const { highlight, seen: seenNew, ringId, newIds, pending: highlightPending } = useHighlightSkill(!openId && !marketplace && scope === "team" && !!catalog);
  /** A device skill's page is open inside "On this device" (no footer there). */
  const [devicePage, setDevicePage] = useState(false);
  // Each view opens at the top; a grid comes back where it was.
  const viewKey = openId ? `skill:${openId}` : marketplace ? "marketplace" : scope === "device" && devicePage ? "device-page" : `grid:${scope}`;
  const rememberGridScroll = useScrollReset(viewKey, highlightPending);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const device = useSkillsDeviceState();
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const [pending, setPending] = useState<PendingUpload | null>(null);
  const [, setPrefsTick] = useState(0);

  useEffect(() => {
    setOpenId(null);
    setMarketplace(null);
  }, [resetToken]);

  useEffect(() => {
    let cancelled = false;
    void serverFeatures(serverUrl, () => authManager.api.getHealth(serverUrl)).then((f) => {
      // An empty set is "unknown" (unreachable): try the catalog anyway.
      if (!cancelled) setSupported(f.size === 0 || f.has(SKILLS_FEATURE));
    });
    return () => {
      cancelled = true;
    };
  }, [serverUrl]);

  const reload = useCallback(async () => {
    if (!orgId) return;
    try {
      const next = await withTimeout(authManager.api.listSkills(orgId));
      setCatalog(next);
      primeCatalog(orgId, next);
      setError(null);
      setLoadFailed(false);
    } catch (e) {
      setError(errorText(e));
      setLoadFailed(true);
    }
  }, [orgId]);

  useEffect(() => {
    if (supported) void reload();
  }, [supported, reload]);

  if (!orgId) return <div className="muted perm-empty">Skills need a synced vault.</div>;
  if (supported === false) {
    return (
      <>
        <h2 className="settings-section-title">Agent Skills</h2>
        <div className="muted">This server needs an update to manage skills.</div>
      </>
    );
  }

  const manage = canManage || catalog?.role === "owner" || catalog?.role === "admin";

  if (marketplace && !openId) {
    return (
      <MarketplaceBrowser
        orgId={orgId}
        vaultSkills={catalog?.skills ?? []}
        preload={marketplace.preload}
        onBack={() => setMarketplace(null)}
        onOpenSkill={setOpenId}
        onCatalogChanged={reload}
        onImported={highlight}
      />
    );
  }

  if (openId) {
    return (
      <SkillDetail
        orgId={orgId}
        skillId={openId}
        canManage={manage}
        onBack={() => {
          setOpenId(null);
          void reload();
        }}
        onChanged={() => void reload()}
      />
    );
  }

  const create = async () => {
    const name = newName.trim();
    if (!isValidSkillName(name)) {
      setError(ERROR_TEXT.invalid_name);
      return;
    }
    try {
      const created = await authManager.api.createSkill(orgId, name);
      setNewName("");
      setCreating(false);
      await reload();
      highlight(created.id);
      setOpenId(created.id);
    } catch (e) {
      setError(errorText(e));
    }
  };

  const uploadZip = async () => {
    setError(null);
    const picked = await openDialog({ multiple: false, filters: [{ name: "Zip", extensions: ["zip"] }] });
    if (!picked || Array.isArray(picked)) return;
    let bundle: ipc.SkillBundle;
    setUploadPhase("Reading files…");
    try {
      bundle = await ipc.skillsReadZip(picked);
    } catch (e) {
      setUploadPhase(null);
      setError(e instanceof Error ? e.message : String(e));
      return;
    }
    setUploadPhase(null);
    // The SKILL.md name wins when it is a valid one: publish requires the two to match.
    const md = bundle.files.find((f) => f.path === "SKILL.md");
    const fm = md ? parseSkillFrontmatter(base64ToText(md.contentBase64) ?? "") : null;
    const name = fm?.ok && isValidSkillName(fm.name) ? fm.name : suggestSkillName(bundle.suggestedName);
    if (!isValidSkillName(name)) {
      setError(`"${bundle.suggestedName}" can't be used as a skill name. Set name in SKILL.md.`);
      return;
    }
    const files = bundle.files.map((f) => ({
      path: f.path,
      contentBase64: f.contentBase64,
      executable: f.executable,
      sha256: f.sha256,
    }));
    const existing = catalog?.skills.find((s) => s.name === name) ?? null;
    const next = { name, files, skipped: bundle.skipped, existing };
    if (existing) setPending(next);
    else await applyUpload(next);
  };

  const applyUpload = async (u: PendingUpload) => {
    setUploadPhase("Uploading…");
    try {
      let id: string;
      if (u.existing) {
        const detail = await authManager.api.getSkill(orgId, u.existing.id);
        await authManager.api.putSkillDraft(orgId, u.existing.id, detail.draftRevision, u.files);
        id = u.existing.id;
      } else {
        id = (await authManager.api.createSkill(orgId, u.name, u.files)).id;
      }
      toast(
        u.skipped.length
          ? `Uploaded ${u.name}. Left out ${u.skipped.length} ${u.skipped.length === 1 ? "file" : "files"}: ${u.skipped.slice(0, 3).join(", ")}${u.skipped.length > 3 ? "…" : ""}`
          : `Uploaded ${u.name}. Publish it when it's ready.`,
        "neutral",
      );
      await reload();
      highlight(id);
      setOpenId(id);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setUploadPhase(null);
    }
  };

  const skills = catalog?.skills ?? [];
  const targetsOn = loadSkillsPrefs().targets;
  const groups = groupSkills(skills, filter);
  const newMenu = [
    { key: "write", label: "Write from scratch", onSelect: () => setCreating(true) },
    { key: "zip", label: "Upload .zip", onSelect: () => uploadZip() },
  ];
  const toggleGroup = (key: string) =>
    setCollapsed((c) => {
      const next = new Set(c);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  /** This computer's side of one skill: the tool cluster and the install square. */
  const install = (s: SkillSummary) => {
    if (s.effectiveVersion === null) return { button: null };
    const states = targetStates(device.results, targetsOn, orgId, s.id);
    const overall = overallState(states);
    const lines = stateLines(states, s.effectiveVersion).join("\n");
    const optional = s.delivery === "optional";
    const optedIn = !optional || isSkillOnThisDevice(serverUrl, orgId, s.id);
    let button: React.ReactNode;
    if (installing.has(s.id) && overall === "none") {
      button = <InstallButton kind="busy" title="Installing on this computer…" />;
    } else if (optedIn && (overall === "warn" || overall === "bad")) {
      button = <InstallButton kind={overall} title={`${lines}\nOpen to fix`} onClick={() => setOpenId(s.id)} />;
    } else if (!optional) {
      button = <InstallButton kind="required" title={`Required by your team\n${lines}`} />;
    } else if (optedIn) {
      button = <InstallButton kind="installed" title={`On this computer · click to remove\n${lines}`} onClick={() => setRemoving(s)} />;
    } else {
      button = (
        <InstallButton
          kind="add"
          title="Use on this computer"
          onClick={() => {
            setInstalling((p) => new Set(p).add(s.id));
            // A run that never reports (both folders off, say) stops spinning.
            setTimeout(() => setInstalling((p) => {
              const next = new Set(p);
              next.delete(s.id);
              return next;
            }), 20_000);
            setSkillOnThisDevice(orgId, s.id, true);
            setPrefsTick((n) => n + 1);
          }}
        />
      );
    }
    return { button };
  };

  /** "By Sara Lee · v2 · Required" or "anthropics/skills · v1 · Optional". */
  const metaLine = (s: SkillSummary, withAuthor: boolean) => {
    const author = skillAuthor(s);
    const who = s.source ? s.source.repo : author ? `By ${author.name}` : null;
    const parts = [
      ...(withAuthor && who ? [who] : []),
      s.effectiveVersion !== null ? `v${s.effectiveVersion}${s.pinnedVersion !== null ? " (pinned)" : ""}` : null,
      // Cards say who and which version; Required/Optional is in the ✓ tooltip.
      ...(withAuthor ? [] : [s.delivery === "required" ? "Required" : "Optional"]),
    ].filter(Boolean);
    return (
      <span className="skills-meta-line">
        {s.effectiveVersion === null && <span className="skills-meta-warn">Not published · </span>}
        {parts.join(" · ")}
      </span>
    );
  };

  const openProps = (s: SkillSummary) => ({
    role: "button" as const,
    tabIndex: 0,
    onClick: () => {
      seenNew(s.id);
      setOpenId(s.id);
    },
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === "Enter") setOpenId(s.id);
    },
  });

  const groupBody = (g: SkillGroup) => (
      <ul className="skills-grid">
        {g.skills.map((s) => (
          <SkillCard
            key={s.id}
            name={s.name}
            titleExtra={newIds.has(s.id) && <span className="skills-new-chip">New</span>}
            byline={metaLine(s, true)}
            description={s.description || "No description yet."}
            action={install(s).button}
            className={`${ringId === s.id ? "is-highlight" : ""}${leaving.has(s.id) ? " is-leaving" : ""}`.trim()}
            li={{ "data-skill-id": s.id, ...openProps(s) }}
            more={
              manage && (
                <RowActionsMenu
                  ariaLabel={`More for ${skillDisplayName(s.name)}`}
                  actions={[
                    { key: "open", label: "Open", onSelect: () => openProps(s).onClick() },
                    ...(s.effectiveVersion !== null
                      ? [{ key: "zip", label: "Download .zip", onSelect: () => downloadSkillZip(orgId, s.id, s.name, s.effectiveVersion!) }]
                      : []),
                    { key: "remove", label: "Remove from team", danger: true, separated: true, onSelect: () => setTeamRemoving(s) },
                  ]}
                />
              )
            }
          />
        ))}
      </ul>
  );

  return (
    <>
      <div className="skills-scroll" onScroll={(e) => rememberGridScroll(viewKey, e.currentTarget.scrollTop)}>
      <div className="members-access-header skills-page-head">
        <div>
          <h2 className="settings-section-title">Agent Skills</h2>
          <p className="skills-intro">Teach your team's AI tools how you work.</p>
        </div>
        {(catalog || !loadFailed) && (
          <div className="skills-actions">
            {uploadPhase && (
              <span className="skills-upload-status" role="status">
                <Spinner size="xs" /> {uploadPhase}
              </span>
            )}
            <SearchToggle
              value={filter}
              onChange={setFilter}
              placeholder={scope === "device" ? "Search this computer" : "Search skills"}
              hotkeys
            />
            <ScopeToggle
              value={scope}
              onChange={(v) => {
                setScope(v);
                writeScope(v);
                if (v === "device") setSeen(true);
              }}
              teamCount={catalog ? skills.length : null}
              deviceCount={deviceScan.status === "ready" ? countLive(deviceItems(deviceScan.entries)) : deviceScan.status === "error" ? 0 : null}
              showDot={!seen && scope !== "device"}
            />
            {manage && skills.length > 0 && scope === "team" && (
              <>
                <button className="secondary skills-hdr-btn" onClick={() => setMarketplace({})}>Browse marketplace</button>
                <SkillsMenuButton label="New skill" className="primary skills-hdr-btn" actions={newMenu} />
              </>
            )}
          </div>
        )}
      </div>

      {error && !loadFailed && <div className="auth-error">{error}</div>}

      {loadFailed && !catalog ? (
        <LoadError message={`Couldn't load this vault's skills: ${error ?? ""}`} onRetry={() => void reload()} />
      ) : scope === "device" ? (
        <DeviceSkillsView
          onPageChange={setDevicePage}
          filter={filter}
          orgId={orgId}
          canShare={manage}
          vaultSkills={skills}
          onShared={(id) => {
            // Land on the Team grid with the new card ringed, not on its page,
            // and sync now so the person's own folder is adopted at once
            // rather than showing "Name taken" until the next poll.
            void reload();
            checkSkillsNow();
            setScope("team");
            writeScope("team");
            highlight(id);
          }}
        />
      ) : !catalog && !error ? (
        <SkillGridSkeleton />
      ) : skills.length === 0 ? (
        manage ? (
          <EmptyState
            title="No skills yet"
            actions={
              <>
                <button className="primary" onClick={() => setMarketplace({})}>Browse marketplace</button>
                <SkillsMenuButton label="Create a skill" className="secondary" actions={newMenu} />
              </>
            }
          >
            Add one and it reaches everyone's Claude, Codex and Cursor.
            <span className="skills-chips">
              {POPULAR_SOURCES.map((repo) => (
                <button key={repo} type="button" className="skills-chip" onClick={() => setMarketplace({ preload: repo })}>
                  {repo}
                </button>
              ))}
            </span>
          </EmptyState>
        ) : (
          <EmptyState title="No skills yet">Your admins haven't published any skills.</EmptyState>
        )
      ) : (
        <>
          {groups.length === 0 && <div className="field-hint skills-quiet">No skills match.</div>}
          {groups.map((g) => {
            const isCollapsed = g.kind === "source" && collapsed.has(g.key);
            const label = (
              <>
                {g.kind === "source" ? <GitHubGlyph /> : null}
                <span>{g.label}</span>
                <span className="skills-group-count">{g.skills.length}</span>
              </>
            );
            return (
              <section key={g.key} className="skills-group">
                {g.kind === "source" ? (
                  <button
                    type="button"
                    className="skills-group-head is-toggle"
                    aria-expanded={!isCollapsed}
                    onClick={() => toggleGroup(g.key)}
                  >
                    <svg className={`skills-caret${isCollapsed ? " is-closed" : ""}`} viewBox="0 0 10 10" aria-hidden="true">
                      <path d="M2 3.5 5 6.5 8 3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                    {label}
                  </button>
                ) : (
                  <div className="skills-group-head">{label}</div>
                )}
                {!isCollapsed && groupBody(g)}
              </section>
            );
          })}
        </>
      )}

      </div>
      {catalog && !(scope === "device" && devicePage) && <WorksWith />}

      {teamRemoving && (
        <RemoveFromTeamDialog
          orgId={orgId}
          skill={teamRemoving}
          ownFolderHere={ownFolderHere(teamRemoving.name)}
          onCancel={() => setTeamRemoving(null)}
          onRemoved={() => {
            const id = teamRemoving.id;
            setTeamRemoving(null);
            setLeaving((prev) => new Set(prev).add(id));
            setTimeout(() => {
              void reload().finally(() =>
                setLeaving((prev) => {
                  const next = new Set(prev);
                  next.delete(id);
                  return next;
                }),
              );
            }, LEAVE_MS);
          }}
        />
      )}

      {removing && (
        <ConfirmDialog
          title={`Remove ${skillDisplayName(removing.name)} from this computer?`}
          confirmLabel="Remove"
          onCancel={() => setRemoving(null)}
          onConfirm={() => {
            setSkillOnThisDevice(orgId, removing.id, false);
            setPrefsTick((n) => n + 1);
            setRemoving(null);
          }}
        >
          It stays in the vault; you can add it back any time. A copy you edited is kept, not deleted.
        </ConfirmDialog>
      )}

      {creating && (
        <ConfirmDialog
          title="New skill"
          confirmLabel="Create"
          tone="accent"
          confirmDisabled={!isValidSkillName(newName.trim())}
          onCancel={() => {
            setCreating(false);
            setNewName("");
          }}
          onConfirm={create}
        >
          <input
            autoFocus
            className="skills-name-input"
            placeholder="skill-name"
            value={newName}
            onChange={(e) => setNewName(e.target.value.toLowerCase())}
            onKeyDown={(e) => {
              if (e.key === "Enter" && isValidSkillName(newName.trim())) void create();
            }}
          />
          <div className="field-hint">Lowercase letters, digits and hyphens. Can't be changed later.</div>
          {skillNameNeedsWarning(newName) && (
            <div className="skills-warning">claude.ai refuses names with "claude" or "anthropic".</div>
          )}
          {error && <div className="auth-error">{error}</div>}
        </ConfirmDialog>
      )}

      {pending && (
        <ConfirmDialog
          title={`Replace the draft of ${pending.name}?`}
          confirmLabel="Replace draft"
          tone="accent"
          onCancel={() => setPending(null)}
          onConfirm={async () => {
            const u = pending;
            setPending(null);
            await applyUpload(u);
          }}
        >
          The uploaded files become the new draft. Published versions are not affected until you publish.
        </ConfirmDialog>
      )}
    </>
  );
}
