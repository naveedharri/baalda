// Vault Settings → Skills → Add from marketplace (docs/SKILLS.md "Addendum —
// Marketplace import"). Admins save GitHub repos as the vault's sources, browse
// one, and import a skill folder as a new skill (published as v1) or pull an
// upstream change into an imported skill's draft. Every GitHub call runs here,
// with the admin's own token when this device has one.

import { useCallback, useEffect, useMemo, useState } from "react";
import { skillErrorCode } from "../../lib/api";
import { authManager } from "../../lib/auth/authManager";
import * as ipc from "../../lib/ipc";
import { githubTokenKey } from "../../lib/skills/github";
import { skillDisplayName } from "../../lib/skills/display";
import {
  browseMarketplace,
  createGitHubReader,
  fetchSkillFolder,
  formatLabel,
  importNotes,
  importStatus,
  originOf,
  type MarketplaceListing,
  type MarketplaceSkill,
} from "../../lib/skills/marketplace";
import type { SkillSource, SkillSummary } from "../../lib/skills/types";
import { toast } from "../../lib/toast";
import { useStore } from "../../store";
import { AsyncButton } from "../AsyncButton";
import { ConfirmDialog } from "../ConfirmDialog";
import { AddMarketplaceDialog } from "./AddMarketplaceDialog";
import { RowActionsMenu } from "../RowActionsMenu";
import "../editor.css";
import { BusyButton, EmptyState, InstallButton, RefreshIcon, RowSkeletons, SearchToggle, SkillIcon, Tag } from "./parts";
import { withTimeout } from "../../lib/skills/loading";
import "./skills.css";

type Browse =
  | { status: "loading" }
  | { status: "ready"; listing: MarketplaceListing }
  | { status: "error"; message: string };


function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function sizeText(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * The admin's GitHub token for this vault, kept only in this computer's
 * keychain: private repositories, and more than GitHub's 60 requests an hour.
 */
function GitHubTokenRow({ serverUrl, orgId }: { serverUrl: string; orgId: string }) {
  const [saved, setSaved] = useState<boolean | null>(null);
  const [token, setToken] = useState("");
  const key = githubTokenKey(serverUrl, orgId);

  useEffect(() => {
    let cancelled = false;
    ipc.keychainGet(key).then(
      (t) => { if (!cancelled) setSaved(!!t); },
      () => { if (!cancelled) setSaved(false); },
    );
    return () => {
      cancelled = true;
    };
  }, [key]);

  const save = async () => {
    const t = token.trim();
    if (!t) return;
    await ipc.keychainSet(key, t);
    setToken("");
    setSaved(true);
    toast("GitHub token saved on this computer.");
  };

  return (
    <div className="menu-row skills-setting-row skills-token-row">
      <span className="menu-row-label">
        GitHub token
        <span className="field-hint">For private repositories. Kept in this computer's keychain only.</span>
      </span>
      {saved === null ? null : saved ? (
        <span className="skills-inline">
          <Tag tone="good">Saved</Tag>
          <AsyncButton
            className="link-btn danger"
            onClick={async () => {
              await ipc.keychainDelete(key);
              setSaved(false);
            }}
          >
            Remove
          </AsyncButton>
        </span>
      ) : (
        <span className="skills-inline">
          <span className="skills-token-field">
          <input
            className="skills-compact-input"
            type="password"
            placeholder="github_pat_…"
            aria-label="GitHub token"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void save();
            }}
          />
          </span>
          <BusyButton className="secondary skills-btn-sm" busyLabel="Saving…" disabled={!token.trim()} onClick={save}>Save</BusyButton>
        </span>
      )}
    </div>
  );
}

/** Popular public repos offered in the empty state and the Add dialog. */
const QUICK_PICKS = ["anthropics/skills", "openai/skills"];

function sourceLabel(s: SkillSource): string {
  return s.label ?? (s.ref ? `${s.repo}@${s.ref}` : s.repo);
}

export async function readerFor(serverUrl: string, orgId: string) {
  let token: string | null = null;
  try {
    token = (await ipc.keychainGet(githubTokenKey(serverUrl, orgId))) || null;
  } catch {
    /* no keychain entry: public repos still work */
  }
  return createGitHubReader({ fetchImpl: fetch, token });
}

export function MarketplaceBrowser({
  orgId,
  vaultSkills,
  preload,
  onBack,
  onOpenSkill,
  onCatalogChanged,
  onImported,
}: {
  orgId: string;
  vaultSkills: SkillSummary[];
  /** A repo to open straight away (the empty state's quick picks), added as a source if new. */
  preload?: string;
  onBack: () => void;
  onOpenSkill: (skillId: string) => void;
  onCatalogChanged: () => Promise<void> | void;
  /** A skill was imported: ring it on the grid when they go back. */
  onImported?: (skillId: string) => void;
}) {
  const serverUrl = useStore((s) => s.serverUrl);
  const [sources, setSources] = useState<SkillSource[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [browse, setBrowse] = useState<Record<string, Browse>>({});
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<SkillSource | null>(null);
  /** Rows whose import or pull is running: their square spins. */
  const [importing, setImporting] = useState<ReadonlySet<string>>(new Set());
  const track = async (key: string, run: () => Promise<void>) => {
    setImporting((s) => new Set(s).add(key));
    try {
      await run();
    } finally {
      setImporting((s) => {
        const next = new Set(s);
        next.delete(key);
        return next;
      });
    }
  };
  const [filter, setFilter] = useState("");
  const [error, setError] = useState<string | null>(null);

  const open = useCallback(
    async (source: SkillSource, force = false) => {
      setSelected(source.id);
      setFilter("");
      if (!force && browse[source.id] && browse[source.id].status !== "error") return;
      setBrowse((b) => ({ ...b, [source.id]: { status: "loading" } }));
      try {
        const reader = await readerFor(serverUrl, orgId);
        // Rows show as soon as the repo's shape is known; descriptions fill in.
        const listing = await withTimeout(
          browseMarketplace(reader, { repo: source.repo, ref: source.ref }, (partial) =>
            setBrowse((b) => ({ ...b, [source.id]: { status: "ready", listing: partial } })),
          ),
          120_000,
          "GitHub is taking too long to answer. Try again in a moment.",
        );
        setBrowse((b) => ({ ...b, [source.id]: { status: "ready", listing } }));
      } catch (e) {
        setBrowse((b) => ({ ...b, [source.id]: { status: "error", message: message(e) } }));
      }
    },
    [browse, serverUrl, orgId],
  );

  useEffect(() => {
    let cancelled = false;
    authManager.api
      .listSkillSources(orgId)
      .then((list) => {
        if (cancelled) return;
        setSources(list);
        const wanted = preload
          ? list.find((s) => s.repo.toLowerCase() === preload.toLowerCase() && s.ref === null)
          : undefined;
        if (preload && !wanted) {
          void addSource(preload, null, list);
          return;
        }
        const first = wanted ?? list[list.length - 1];
        if (first) void open(first);
      })
      .catch((e) => {
        if (!cancelled) {
          setSources([]);
          setError(message(e));
        }
      });
    return () => {
      cancelled = true;
    };
    // Load once per vault; `open` changes as listings land.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId]);

  /** Save and open a source; answers why not, or null when done. */
  async function addSource(repo: string, ref: string | null, known: SkillSource[] | null): Promise<string | null> {
    try {
      const source = await authManager.api.addSkillSource(orgId, repo, ref);
      setSources((list) => [...(list ?? []), source]);
      void open(source);
      return null;
    } catch (e) {
      if (skillErrorCode(e) === "skill_source_exists") {
        const existing = known?.find(
          (s) => s.repo.toLowerCase() === repo.toLowerCase() && (s.ref ?? "") === (ref ?? ""),
        );
        if (existing) void open(existing);
        return null;
      }
      return skillErrorCode(e) === "skill_source_limit_reached" ? "This vault has the most sources it can hold (100)." : message(e);
    }
  }

  const openAdd = () => setAdding(true);

  const remove = async (source: SkillSource) => {
    await authManager.api.removeSkillSource(orgId, source.id);
    setSources((list) => (list ?? []).filter((s) => s.id !== source.id));
    setBrowse(({ [source.id]: _gone, ...rest }) => rest);
    if (selected === source.id) setSelected(null);
    toast(`Removed ${source.repo}. Skills you imported stay.`, "neutral");
  };

  const importSkill = async (skill: MarketplaceSkill) => {
    if (!skill.name) return;
    const name = skill.name;
    try {
      const reader = await readerFor(serverUrl, orgId);
      const files = await fetchSkillFolder(reader, skill);
      const detail = await authManager.api.createSkill(orgId, name, files, originOf(skill));
      onImported?.(detail.id);
      try {
        const v = await authManager.api.publishSkill(orgId, detail.id, detail.draftRevision, importNotes(skill));
        toast(`Imported ${skillDisplayName(name)} v${v.version}.`);
      } catch (e) {
        toast(`Imported ${skillDisplayName(name)} as a draft: ${message(e)}`, "neutral");
      }
      await onCatalogChanged();
    } catch (e) {
      const code = skillErrorCode(e);
      toast(
        code === "skill_name_taken"
          ? `A skill named ${skillDisplayName(name)} already exists in this vault.`
          : `Couldn't import ${name}: ${message(e)}`,
        "error",
      );
    }
  };

  const pullUpdate = async (skill: MarketplaceSkill, skillId: string) => {
    try {
      const reader = await readerFor(serverUrl, orgId);
      const files = await fetchSkillFolder(reader, skill);
      const detail = await authManager.api.getSkill(orgId, skillId);
      await authManager.api.putSkillDraft(orgId, skillId, detail.draftRevision, files, originOf(skill));
      toast(`Pulled ${skillDisplayName(skill.name ?? "")} into its draft. Review, then publish.`);
      await onCatalogChanged();
      onOpenSkill(skillId);
    } catch (e) {
      toast(
        skillErrorCode(e) === "stale_draft"
          ? `Someone changed the draft of ${skill.name}. Try again.`
          : `Couldn't pull ${skill.name}: ${message(e)}`,
        "error",
      );
    }
  };

  const current = sources?.find((s) => s.id === selected) ?? null;
  const state = current ? browse[current.id] : undefined;
  const listing = state?.status === "ready" ? state.listing : null;
  const total = listing ? listing.groups.reduce((n, g) => n + g.skills.length, 0) : 0;
  const describing = !!listing?.groups.some((g) => g.skills.some((s) => s.pending));
  const needle = filter.trim().toLowerCase();
  const groups = useMemo(
    () =>
      (listing?.groups ?? [])
        .map((g) => ({
          ...g,
          skills: needle
            ? g.skills.filter((s) => `${s.title} ${s.description}`.toLowerCase().includes(needle))
            : g.skills,
        }))
        .filter((g) => g.skills.length > 0 || (!needle && g.unsupported)),
    [listing, needle],
  );

  const row = (skill: MarketplaceSkill) => {
    const status = importStatus(skill, vaultSkills);
    const busy = importing.has(skill.key);
    let side: React.ReactNode;
    if (busy) {
      side = <InstallButton large kind="busy" title="Working…" />;
    } else if (status.kind === "imported") {
      side = <InstallButton large kind="installed" title="In this vault · open" onClick={() => onOpenSkill(status.skillId)} />;
    } else if (status.kind === "update") {
      side = (
        <InstallButton
          large
          kind="update"
          title="Update available · pull"
          onClick={() => void track(skill.key, () => pullUpdate(skill, status.skillId))}
        />
      );
    } else if (status.kind === "nameTaken") {
      side = <InstallButton large kind="blocked" title={`A skill named ${skillDisplayName(skill.name ?? "")} already exists in this vault.`} />;
    } else if (skill.problem || !skill.name) {
      side = <InstallButton large kind="blocked" title={skill.problem ?? "Its name can't be used for a skill."} />;
    } else if (skill.pending) {
      side = <InstallButton large kind="busy" title="Reading…" />;
    } else {
      side = <InstallButton large kind="add" title="Import to this vault" onClick={() => void track(skill.key, () => importSkill(skill))} />;
    }
    const meta = `${skill.files.length} ${skill.files.length === 1 ? "file" : "files"} · ${sizeText(skill.totalBytes)}`;
    return (
      <li key={skill.key} className="skills-list-row is-static">
        <SkillIcon />
        <span className="skills-row-main">
          <span className="skills-row-name">{skillDisplayName(skill.name ?? skill.title)}</span>
          <span className="skills-meta-line">{meta}</span>
          {skill.pending ? (
            <span className="skel-line skills-skel-sub" style={{ width: "60%" }} aria-hidden="true" />
          ) : skill.problem && status.kind === "new" ? (
            <span className="skills-row-reason">{skill.problem}</span>
          ) : (
            <span className="skills-row-desc" title={skill.description || undefined}>
              {skill.description || "No description."}
            </span>
          )}
        </span>
        <span className="skills-row-action">{side}</span>
      </li>
    );
  };

  return (
    <section className="member-profile" aria-label="Browse marketplace">
      <button type="button" className="link-btn member-profile-back" onClick={onBack}>
        ← Agent Skills
      </button>
      <h2 className="settings-section-title">Browse marketplace</h2>
      <p className="members-access-intro">Import skills from a GitHub repository. They start as Optional.</p>

      {error && <div className="auth-error">{error}</div>}

      {sources === null ? (
        <RowSkeletons count={3} label="Loading sources" />
      ) : sources.length === 0 ? (
        <EmptyState
          title="No sources yet"
          actions={<button className="primary" onClick={openAdd}>Add a repository</button>}
        >
          Add a GitHub repository, or start with one of these.
          <span className="skills-chips">
            {QUICK_PICKS.map((repo) => (
              <button
                key={repo}
                type="button"
                className="skills-chip"
                onClick={() => void addSource(repo, null, sources).then((err) => err && setError(err))}
              >
                {repo}
              </button>
            ))}
          </span>
        </EmptyState>
      ) : (
        <>
          <div className="member-profile-tabs" role="tablist" aria-label="Sources">
            {sources.map((s) => (
              <button
                key={s.id}
                type="button"
                role="tab"
                aria-selected={s.id === selected}
                className={`member-profile-tab${s.id === selected ? " active" : ""}`}
                onClick={() => void open(s)}
              >
                {sourceLabel(s)}
              </button>
            ))}
            <button type="button" className="member-profile-tab skills-tab-add" onClick={openAdd} title="Add a marketplace">
              + Add
            </button>
          </div>

          {current && (
            <div className="skills-source-bar">
              <span className="field-hint">
                {listing
                  ? `${formatLabel(listing.format)} · ${total} ${total === 1 ? "skill" : "skills"}${describing ? " · loading details…" : ""}`
                  : state?.status === "loading"
                    ? `Reading ${current.repo}…`
                    : current.repo}
              </span>
              <span className="skills-actions">
                {listing && total > 0 && (
                  <SearchToggle value={filter} onChange={setFilter} placeholder={`Search ${total} skills`} />
                )}
                <button
                  type="button"
                  className={`icon-btn skills-icon-btn${state?.status === "loading" || describing ? " is-spinning" : ""}`}
                  disabled={state?.status === "loading" || describing}
                  onClick={() => void open(current, true)}
                  aria-label="Refresh"
                  title="Refresh"
                >
                  <RefreshIcon />
                </button>
                <RowActionsMenu
                  ariaLabel={`More for ${current.repo}`}
                  actions={[{ key: "remove", label: "Remove source", danger: true, onSelect: () => setRemoving(current) }]}
                />
              </span>
            </div>
          )}

          {!current ? (
            <div className="muted">Pick a source.</div>
          ) : !state || state.status === "loading" ? (
            <RowSkeletons count={5} label="Loading skills" />
          ) : state.status === "error" ? (
            <EmptyState
              title="Couldn't read this repository"
              actions={<button className="secondary" onClick={() => void open(current, true)}>Try again</button>}
            >
              {state.message}
            </EmptyState>
          ) : total === 0 && groups.every((g) => !g.unsupported) ? (
            <EmptyState title="No skills found">{current.repo} has no SKILL.md folders.</EmptyState>
          ) : (
            <>
              {groups.length === 0 && <div className="muted">No skills match.</div>}
              {groups.map((g) => (
                <div key={g.pluginName ?? "root"} className="skills-group">
                  {g.pluginName && (
                    <div className="skills-group-head">
                      {g.pluginName}
                      {g.skills.length > 0 && <span className="skills-group-count">{g.skills.length}</span>}
                    </div>
                  )}
                  {g.unsupported ? (
                    <div className="field-hint">Not supported yet: {g.unsupported}</div>
                  ) : (
                    <ul className="skills-list">{g.skills.map(row)}</ul>
                  )}
                </div>
              ))}
            </>
          )}
        </>
      )}

      <div className="menu-sep" />
      <GitHubTokenRow serverUrl={serverUrl} orgId={orgId} />

      {adding && (
        <AddMarketplaceDialog
          quickPicks={QUICK_PICKS.filter((r) => !sources?.some((x) => x.repo.toLowerCase() === r && x.ref === null))}
          reader={() => readerFor(serverUrl, orgId)}
          onAdd={(repo, ref) => addSource(repo, ref, sources)}
          onClose={() => setAdding(false)}
        />
      )}

      {removing && (
        <ConfirmDialog
          title={`Remove ${removing.repo}?`}
          confirmLabel="Remove"
          onCancel={() => setRemoving(null)}
          onConfirm={async () => {
            await remove(removing);
            setRemoving(null);
          }}
        >
          Skills you already imported from it stay in the vault.
        </ConfirmDialog>
      )}
    </section>
  );
}
