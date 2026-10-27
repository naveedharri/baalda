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
  ownerAvatarUrl,
  peekMarketplace,
  repoLogoUrl,
  type MarketplaceListing,
  type MarketplacePeek,
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
import { BusyButton, CardDescription, EmptyState, GitHubGlyph, InstallButton, RefreshIcon, SearchToggle, SkeletonCards, SkillCard, Tag } from "./parts";
import { ToolLogo, type ToolId } from "./ToolLogos";
import { useScrollReset } from "./useScrollReset";
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

/**
 * Marketplaces every vault sees without adding them: Anthropic's and OpenAI's
 * official public catalogs, and BenAI's. Never saved as a vault source; a vault's saved copy of one is
 * folded into its card.
 */
const BUILT_INS: readonly { repo: string; title: string; logo: ToolId | null; description: string }[] = [
  {
    repo: "anthropics/skills",
    title: "Anthropic",
    logo: "claude",
    description: "Official skills from Anthropic: Word, Excel, PowerPoint and PDF files, design, testing, building MCP servers and more.",
  },
  {
    repo: "openai/skills",
    title: "OpenAI",
    logo: "codex",
    description: "The official skills catalog for Codex from OpenAI, curated and experimental.",
  },
  {
    // No brand mark of ours: its tile shows the repo's logo file or the org's picture.
    repo: "BenAIOS/skills",
    title: "BenAI",
    logo: null,
    description: "Expert plugins that turn your AI into a specialist, by department: marketing, sales, operations, creative, product and more.",
  },
];

/** One marketplace card: a built-in catalog or a repo the vault saved. */
interface Market {
  key: string;
  repo: string;
  ref: string | null;
  title: string;
  description: string;
  logo: ToolId | null;
  /** The vault's saved source; null for a built-in it never saved. */
  source: SkillSource | null;
  builtIn: boolean;
}

function sameRepo(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** Built-ins first, then the vault's own in the order they were added. */
function marketsOf(sources: readonly SkillSource[]): Market[] {
  const builtIns: Market[] = BUILT_INS.map((b) => {
    const saved = sources.find((s) => sameRepo(s.repo, b.repo) && s.ref === null) ?? null;
    return { key: `builtin:${b.repo}`, repo: b.repo, ref: null, title: b.title, description: b.description, logo: b.logo, source: saved, builtIn: true };
  });
  const own: Market[] = sources
    .filter((s) => !BUILT_INS.some((b) => sameRepo(s.repo, b.repo) && s.ref === null))
    .map((s) => ({
      key: s.id,
      repo: s.repo,
      ref: s.ref,
      title: s.label ?? s.repo.split("/")[1] ?? s.repo,
      description: s.ref ? `${s.repo} · ${s.ref}` : s.repo,
      logo: null,
      source: s,
      builtIn: false,
    }));
  return [...builtIns, ...own];
}

/**
 * A card's mark: a built-in's brand logo; else the repo's own logo file; else
 * its GitHub owner's picture; and the GitHub glyph if that picture won't load.
 */
function MarketTile({ logo, repo, logoUrl }: { logo: ToolId | null; repo: string; logoUrl?: string | null }) {
  const [failed, setFailed] = useState(false);
  const src = logoUrl ?? ownerAvatarUrl(repo);
  useEffect(() => setFailed(false), [src]);
  return (
    <span className={`skills-icon is-lg skills-market-tile${!logo && !failed ? " has-image" : ""}`} aria-hidden="true">
      {logo ? (
        <ToolLogo tool={logo} size={20} title="" />
      ) : failed ? (
        <GitHubGlyph />
      ) : (
        <img src={src} alt="" draggable={false} onError={() => setFailed(true)} />
      )}
    </span>
  );
}

/** How many skills a card shows before it is opened (two cheap GitHub calls each). */
const PEEK_LIMIT = 12;

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
  /** A repo to open straight away, added as a source when it is neither built in nor saved. */
  preload?: string;
  onBack: () => void;
  onOpenSkill: (skillId: string) => void;
  onCatalogChanged: () => Promise<void> | void;
  /** A skill was imported: ring it on the grid when they go back. */
  onImported?: (skillId: string) => void;
}) {
  const serverUrl = useStore((s) => s.serverUrl);
  const [sources, setSources] = useState<SkillSource[] | null>(null);
  /** The open marketplace's key; null is the overview of cards. */
  const [selected, setSelected] = useState<string | null>(null);
  const [browse, setBrowse] = useState<Record<string, Browse>>({});
  /** Skill counts for the overview cards, from a cheap peek. */
  const [peeks, setPeeks] = useState<Record<string, MarketplacePeek | "error">>({});
  /** Each card's own logo file as a `blob:` URL, once read. */
  const [logos, setLogos] = useState<Record<string, string>>({});
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<Market | null>(null);
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
  const markets = useMemo(() => marketsOf(sources ?? []), [sources]);
  useScrollReset(selected ?? "overview", false);

  const open = useCallback(
    async (market: Market, force = false) => {
      setSelected(market.key);
      setFilter("");
      if (!force && browse[market.key] && browse[market.key].status !== "error") return;
      setBrowse((b) => ({ ...b, [market.key]: { status: "loading" } }));
      try {
        const reader = await readerFor(serverUrl, orgId);
        // Cards show as soon as the repo's shape is known; descriptions fill in.
        const listing = await withTimeout(
          browseMarketplace(reader, { repo: market.repo, ref: market.ref }, (partial) =>
            setBrowse((b) => ({ ...b, [market.key]: { status: "ready", listing: partial } })),
          ),
          120_000,
          "GitHub is taking too long to answer. Try again in a moment.",
        );
        setBrowse((b) => ({ ...b, [market.key]: { status: "ready", listing } }));
      } catch (e) {
        setBrowse((b) => ({ ...b, [market.key]: { status: "error", message: message(e) } }));
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
        if (!preload) return;
        const wanted = marketsOf(list).find((m) => sameRepo(m.repo, preload) && m.ref === null);
        if (wanted) void open(wanted);
        else void addSource(preload, null, list);
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

  // The overview's skill counts: one peek per card, cached per repo.
  useEffect(() => {
    if (sources === null) return;
    let cancelled = false;
    const todo = markets.slice(0, PEEK_LIMIT).filter((m) => !(m.key in peeks));
    if (todo.length === 0) return;
    void readerFor(serverUrl, orgId).then((reader) => {
      for (const m of todo) {
        peekMarketplace(reader, { repo: m.repo, ref: m.ref }).then(
          (p) => {
            if (cancelled) return;
            setPeeks((x) => ({ ...x, [m.key]: p }));
            if (p.logo && !m.logo) {
              repoLogoUrl(reader, p.logo).then(
                (url) => !cancelled && setLogos((x) => ({ ...x, [m.key]: url })),
                () => {},
              );
            }
          },
          () => !cancelled && setPeeks((x) => ({ ...x, [m.key]: "error" })),
        );
      }
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [markets, serverUrl, orgId]);

  /** Open a built-in, or save and open a repo; answers why not, or null when done. */
  async function addSource(repo: string, ref: string | null, known: SkillSource[] | null): Promise<string | null> {
    const builtIn = ref === null ? marketsOf(known ?? []).find((m) => m.builtIn && sameRepo(m.repo, repo)) : undefined;
    if (builtIn) {
      void open(builtIn);
      return null;
    }
    try {
      const source = await authManager.api.addSkillSource(orgId, repo, ref);
      setSources((list) => [...(list ?? []), source]);
      void open(marketsOf([source]).find((m) => m.key === source.id)!);
      return null;
    } catch (e) {
      if (skillErrorCode(e) === "skill_source_exists") {
        const existing = marketsOf(known ?? []).find(
          (m) => sameRepo(m.repo, repo) && (m.ref ?? "") === (ref ?? ""),
        );
        if (existing) void open(existing);
        return null;
      }
      return skillErrorCode(e) === "skill_source_limit_reached" ? "This vault has the most marketplaces it can hold (100)." : message(e);
    }
  }

  const remove = async (market: Market) => {
    if (!market.source) return;
    await authManager.api.removeSkillSource(orgId, market.source.id);
    setSources((list) => (list ?? []).filter((s) => s.id !== market.source!.id));
    setBrowse(({ [market.key]: _gone, ...rest }) => rest);
    setSelected(null);
    toast(`Removed ${market.repo}. Skills you imported stay.`, "neutral");
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

  const current = markets.find((m) => m.key === selected) ?? null;
  const state = current ? browse[current.key] : undefined;
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

  /** A card's count line: the full listing once opened, else the peek. */
  const countOf = (m: Market): string | null => {
    const b = browse[m.key];
    if (b?.status === "ready") {
      const n = b.listing.groups.reduce((x, g) => x + g.skills.length, 0);
      return `${n} ${n === 1 ? "skill" : "skills"}`;
    }
    const p = peeks[m.key];
    if (!p || p === "error") return null;
    return p.skills > 0 ? `${p.skills} ${p.skills === 1 ? "skill" : "skills"}` : formatLabel(p.format);
  };

  const card = (skill: MarketplaceSkill) => {
    const status = importStatus(skill, vaultSkills);
    const busy = importing.has(skill.key);
    let side: React.ReactNode;
    if (busy) {
      side = <InstallButton kind="busy" title="Working…" />;
    } else if (status.kind === "imported") {
      side = <InstallButton kind="installed" title="In this vault · open" onClick={() => onOpenSkill(status.skillId)} />;
    } else if (status.kind === "update") {
      side = (
        <InstallButton
          kind="update"
          title="Update available · pull"
          onClick={() => void track(skill.key, () => pullUpdate(skill, status.skillId))}
        />
      );
    } else if (status.kind === "nameTaken") {
      side = <InstallButton kind="blocked" title={`A skill named ${skillDisplayName(skill.name ?? "")} already exists in this vault.`} />;
    } else if (skill.problem || !skill.name) {
      side = <InstallButton kind="blocked" title={skill.problem ?? "Its name can't be used for a skill."} />;
    } else if (skill.pending) {
      side = <InstallButton kind="busy" title="Reading…" />;
    } else {
      side = <InstallButton kind="add" title="Import to this vault" onClick={() => void track(skill.key, () => importSkill(skill))} />;
    }
    const meta = `${skill.files.length} ${skill.files.length === 1 ? "file" : "files"} · ${sizeText(skill.totalBytes)}`;
    const description = skill.pending
      ? "Reading…"
      : skill.problem && status.kind === "new"
        ? skill.problem
        : skill.description || "No description.";
    return (
      <SkillCard
        key={skill.key}
        name={skill.name ?? skill.title}
        byline={<span className="skills-meta-line">{meta}</span>}
        description={description}
        action={side}
        className={skill.pending ? "is-pending" : ""}
        li={status.kind === "imported" ? { onClick: () => onOpenSkill(status.skillId) } : undefined}
      />
    );
  };

  if (current) {
    return (
      <section className="member-profile skills-market" aria-label={current.title}>
        <button type="button" className="link-btn member-profile-back" onClick={() => setSelected(null)}>
          ← Marketplaces
        </button>
        <div className="skills-detail-head">
          <MarketTile logo={current.logo} repo={current.repo} logoUrl={logos[current.key]} />
          <div className="skills-detail-title">
            <div className="skills-title-row">
              <h2 className="settings-section-title">{current.title}</h2>
              <span className="skills-source-pill">{current.builtIn ? "Built in" : "Added by your team"}</span>
            </div>
            <span className="skills-market-sub">
              <GitHubGlyph />
              {current.ref ? `${current.repo} · ${current.ref}` : current.repo}
              {listing && (
                <>
                  <span aria-hidden="true">·</span>
                  {formatLabel(listing.format)} · {total} {total === 1 ? "skill" : "skills"}
                  {describing && " · loading details…"}
                </>
              )}
            </span>
          </div>
          <div className="skills-detail-controls">
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
            {current.source && !current.builtIn && (
              <RowActionsMenu
                ariaLabel={`More for ${current.repo}`}
                actions={[{ key: "remove", label: "Remove marketplace", danger: true, onSelect: () => setRemoving(current) }]}
              />
            )}
          </div>
        </div>

        {!state || state.status === "loading" ? (
          <SkeletonCards count={6} label="Loading skills" />
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
          <div className="skills-grid-host">
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
                  <ul className="skills-grid">{g.skills.map(card)}</ul>
                )}
              </div>
            ))}
          </div>
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

  return (
    <section className="member-profile skills-market" aria-label="Marketplaces">
      <button type="button" className="link-btn member-profile-back" onClick={onBack}>
        ← Agent Skills
      </button>
      <div className="skills-market-head">
        <div>
          <h2 className="settings-section-title">Marketplaces</h2>
          <p className="members-access-intro">Import skills from GitHub. Anything you import starts as Optional.</p>
        </div>
        <button type="button" className="primary skills-hdr-btn" onClick={() => setAdding(true)}>
          Add marketplace
        </button>
      </div>

      {error && <div className="auth-error">{error}</div>}

      <div className="skills-grid-host">
        {sources === null ? (
          <SkeletonCards count={3} label="Loading marketplaces" />
        ) : (
          <ul className="skills-grid skills-market-grid">
            {markets.map((m) => {
              const count = countOf(m);
              return (
                <li
                  key={m.key}
                  className="skills-card skills-market-card"
                  role="button"
                  tabIndex={0}
                  onClick={() => void open(m)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      void open(m);
                    }
                  }}
                >
                  <MarketTile logo={m.logo} repo={m.repo} logoUrl={logos[m.key]} />
                  <span className="skills-card-main">
                    <span className="skills-card-title-row">
                      <span className="skills-row-name">{m.title}</span>
                    </span>
                    <span className="skills-card-byline">
                      <span className="skills-meta-line">
                        {m.builtIn ? "Built in" : m.source?.addedBy ? `Added by ${m.source.addedBy.name}` : "Added by your team"}
                        {count ? ` · ${count}` : ""}
                      </span>
                    </span>
                    <CardDescription text={m.description} />
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="skills-market-foot">
        <GitHubTokenRow serverUrl={serverUrl} orgId={orgId} />
      </div>

      {adding && (
        <AddMarketplaceDialog
          reader={() => readerFor(serverUrl, orgId)}
          onAdd={(repo, ref) => addSource(repo, ref, sources)}
          onClose={() => setAdding(false)}
        />
      )}
    </section>
  );
}
