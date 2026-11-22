/* Vault Settings → Sync (#401): what syncs in this vault. One setting for the
   whole vault: owners and admins change it, every computer in the vault
   follows it, members read it. Nothing here ever deletes a file: what stops
   syncing stays where it is, on each computer and on the server.

   Switches and the "Don't sync" list apply the moment they change (nothing
   destructive happens, so nothing asks first); the raw text editor is behind
   "Edit as text" and saves with its own button. */
import { useEffect, useMemo, useRef, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { api, authManager } from "../lib/auth/authManager";
import { serverFeatures } from "../lib/serverFeatures";
import { Switch } from "./Switch";
import * as ipc from "../lib/ipc";
import { toast } from "../lib/toast";
import { useStore } from "../store";
import { syncManager } from "../lib/sync/docSession";
import {
  normalizeFolders,
  normalizeTypes,
  patternsProblem,
  SyncRuleSet,
  type SyncFolders,
  type SyncTypes,
} from "../lib/syncRules/match";
import { unsupportedLines } from "../lib/syncRules/lineNotes";
import { SkillCodeEditor } from "./skills/SkillCodeEditor";
import { AsyncButton } from "./AsyncButton";

const TYPE_SWITCHES: Array<{ key: keyof SyncTypes; title: string; hint: string }> = [
  {
    key: "code",
    title: "Code and text files",
    hint: "Source code, config files, logs and other plain text (.js, .ts, .py, .rb, .swift, .ini, .log…). They open in the code viewer. If two people change the same file, the latest saved version wins.",
  },
  {
    key: "extra",
    title: "More file types",
    hint: "Fonts, Photoshop and Illustrator files, older and open Office formats (.doc, .xls, .odt…), .mkv, .avi and more archives.",
  },
];

const FOLDER_SWITCHES: Array<{ key: keyof SyncFolders; title: string; hint: string }> = [
  {
    key: "hidden",
    title: "Hidden folders and files",
    hint: "Names that start with a dot, like .github or .obsidian.",
  },
  {
    key: "build",
    title: "Build and dependency folders",
    hint: "node_modules, dist, build, target, vendor, venv and __pycache__. These often hold thousands of files.",
  },
];

/** Server features that accept each group of switches. */
const MORE_FILE_TYPES = "more-file-types";
const FOLDER_SWITCHES_FEATURE = "sync-folder-switches";

type Rules = { patterns: string; types: SyncTypes; folders: SyncFolders };
type Loaded =
  | { kind: "loading" }
  | ({ kind: "ready"; revision: number } & Rules)
  | { kind: "unsupported" }
  | { kind: "error"; message: string };

/** One rule line of the text, with its 1-based line number. */
function ruleLines(patterns: string): Array<{ line: number; text: string }> {
  const out: Array<{ line: number; text: string }> = [];
  patterns.split("\n").forEach((raw, i) => {
    const t = raw.trim();
    if (t !== "" && !t.startsWith("#")) out.push({ line: i + 1, text: t });
  });
  return out;
}

const plural = (n: number, one: string, many = one + "s") => `${n.toLocaleString()} ${n === 1 ? one : many}`;

function FolderGlyph() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M1.75 4.25c0-.69.56-1.25 1.25-1.25h3.1l1.4 1.5H13c.69 0 1.25.56 1.25 1.25v6.5c0 .69-.56 1.25-1.25 1.25H3c-.69 0-1.25-.56-1.25-1.25v-8Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function PatternGlyph() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M4 1.75h5.25L12.5 5v9.25H4V1.75Z M9 1.75V5.25h3.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function SyncRulesTab({ canManage, isSynced }: { canManage: boolean; isSynced: boolean }) {
  const orgId = useStore((s) => (isSynced ? s.session?.activeOrganizationId ?? null : null));
  const vaultPath = useStore((s) => s.vault?.path ?? null);
  const serverUrl = useStore((s) => s.serverUrl);
  const [loaded, setLoaded] = useState<Loaded>({ kind: "loading" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hiddenHere, setHiddenHere] = useState<number | null>(null);
  const [newPath, setNewPath] = useState("");
  const [textOpen, setTextOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const canEdit = isSynced ? canManage : true;

  // Which switches this server accepts. A local-only vault has no server.
  const [features, setFeatures] = useState<{ types: boolean; folders: boolean }>({
    types: !isSynced,
    folders: !isSynced,
  });
  useEffect(() => {
    if (!isSynced) {
      setFeatures({ types: true, folders: true });
      return;
    }
    let live = true;
    void serverFeatures(serverUrl, () => authManager.api.getHealth(serverUrl)).then((f) => {
      if (live) setFeatures({ types: f.has(MORE_FILE_TYPES), folders: f.has(FOLDER_SWITCHES_FEATURE) });
    });
    return () => {
      live = false;
    };
  }, [isSynced, serverUrl]);

  const refreshCount = async (r: Rules) => {
    try {
      const p = await ipc.previewSyncRules(r.patterns, r.types, r.folders);
      setHiddenHere(p.current.files);
    } catch {
      setHiddenHere(null);
    }
  };

  const load = async () => {
    setError(null);
    try {
      let next: Rules & { revision: number };
      if (orgId) {
        const res = await api.getSyncRules(orgId);
        next = { ...res.rules, revision: res.revision };
      } else {
        const doc = await ipc.getSyncRules();
        next = {
          patterns: doc?.patterns ?? "",
          types: normalizeTypes(doc?.types),
          folders: normalizeFolders(doc?.folders),
          revision: doc?.revision ?? 0,
        };
      }
      setLoaded({ kind: "ready", ...next });
      setDraft(next.patterns);
      void refreshCount(next);
    } catch (e) {
      if ((e as { status?: number } | null)?.status === 404) setLoaded({ kind: "unsupported" });
      else setLoaded({ kind: "error", message: e instanceof Error ? e.message : String(e) });
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId, vaultPath]);

  /** Save the whole rule set, apply it on this computer at once, and say what
   *  changed here. Everyone else's computer follows on the vault's frame. */
  const commit = async (next: Rules): Promise<boolean> => {
    if (loaded.kind !== "ready" || busy) return false;
    const problem = patternsProblem(next.patterns);
    if (problem) {
      setError(problem);
      return false;
    }
    setBusy(true);
    setError(null);
    // What this change does on THIS computer, measured before it lands.
    let delta = 0;
    try {
      const p = await ipc.previewSyncRules(next.patterns, next.types, next.folders);
      delta = p.current.files - p.candidate.files;
    } catch {
      /* the count is a courtesy */
    }
    try {
      let revision = loaded.revision;
      let saved: Rules = next;
      if (orgId) {
        const res = await api.putSyncRules(orgId, next.patterns, loaded.revision, next.types, next.folders);
        revision = res.revision;
        saved = { patterns: res.rules.patterns, types: res.rules.types, folders: res.rules.folders };
        await syncManager.applySyncRulesNow({ version: 1, ...saved, revision });
      } else {
        await ipc.setSyncRules({ version: 1, ...next });
        syncManager.registry.setSyncRules(new SyncRuleSet(next.patterns, next.types, next.folders));
        void useStore.getState().refreshTree();
      }
      setLoaded({ kind: "ready", ...saved, revision });
      setDraft(saved.patterns);
      void refreshCount(saved);
      toast(
        delta > 0
          ? `Saved. ${plural(delta, "more file")} sync now.`
          : delta < 0
            ? `Saved. ${plural(-delta, "file")} stop syncing. Nothing was deleted.`
            : "Saved.",
        "success",
      );
      return true;
    } catch (e) {
      const body = (e as { body?: { error?: string; message?: string } })?.body;
      if (body?.error === "stale_sync_rules") {
        toast("Someone else changed these settings a moment ago. Showing theirs.", "error");
        await load();
        return false;
      }
      setError(body?.message ?? (e instanceof Error ? e.message : String(e)));
      return false;
    } finally {
      setBusy(false);
    }
  };

  // The text editor's live preview: what the typed text would change here.
  const [textPreview, setTextPreview] = useState<ipc.SyncRulesPreview | null>(null);
  const previewSeq = useRef(0);
  useEffect(() => {
    if (!textOpen || loaded.kind !== "ready") return;
    const seq = ++previewSeq.current;
    const t = window.setTimeout(() => {
      void ipc
        .previewSyncRules(draft, loaded.types, loaded.folders)
        .then((p) => seq === previewSeq.current && setTextPreview(p))
        .catch(() => seq === previewSeq.current && setTextPreview(null));
    }, 350);
    return () => window.clearTimeout(t);
  }, [draft, textOpen, loaded]);

  const ready = loaded.kind === "ready" ? loaded : null;
  const rows = useMemo(() => (ready ? ruleLines(ready.patterns) : []), [ready]);
  const notes = useMemo(
    () => new Map((ready ? unsupportedLines(ready.patterns, ready.types) : []).map((n) => [n.line, n.message])),
    [ready],
  );
  const draftProblem = useMemo(() => patternsProblem(draft), [draft]);
  const draftNotes = useMemo(() => (ready ? unsupportedLines(draft, ready.types) : []), [draft, ready]);

  if (loaded.kind === "loading") return <div className="muted perm-empty">Loading…</div>;
  if (loaded.kind === "unsupported") {
    return (
      <p className="versioning-lede">
        This vault's server can't choose what syncs yet. Whoever runs it needs to update it first.
      </p>
    );
  }
  if (loaded.kind === "error") {
    return (
      <div className="versioning-tab">
        <div className="auth-error">{loaded.message}</div>
        <AsyncButton className="checkpoint-ink-btn" onClick={load}>
          Try again
        </AsyncButton>
      </div>
    );
  }

  const current: Rules = { patterns: loaded.patterns, types: loaded.types, folders: loaded.folders };
  const locked = !canEdit || busy;
  const lockedTitle = canEdit ? undefined : "Only owners and admins can change this";

  const addPattern = async (raw: string) => {
    const line = raw.trim().replace(/^\.\//, "");
    if (!line) return;
    if (rows.some((r) => r.text === line)) {
      toast(`${line} is already on the list.`, "neutral");
      return;
    }
    const base = current.patterns.replace(/\n*$/, "");
    if (await commit({ ...current, patterns: base ? `${base}\n${line}\n` : `${line}\n` })) setNewPath("");
  };

  const removeLine = (line: number) => {
    const lines = current.patterns.split("\n");
    lines.splice(line - 1, 1);
    void commit({ ...current, patterns: lines.join("\n").replace(/^\n+/, "") });
  };

  const chooseFolder = async () => {
    if (!vaultPath) return;
    const picked = await openDialog({ directory: true, multiple: false, defaultPath: vaultPath });
    if (typeof picked !== "string") return;
    const root = vaultPath.replace(/[\\/]+$/, "");
    const norm = picked.replace(/\\/g, "/");
    const rootNorm = root.replace(/\\/g, "/");
    if (!norm.toLowerCase().startsWith(rootNorm.toLowerCase() + "/")) {
      toast("Choose a folder inside this vault.", "error");
      return;
    }
    // A leading slash anchors it at the vault root: a picked `docs` must not
    // also hide every other folder named docs, and a name like `#inbox` or
    // `!x` stays a path rather than a comment or a negation.
    await addPattern(`/${norm.slice(rootNorm.length + 1)}/`);
  };

  const switchRow = <K extends string>(
    s: { key: K; title: string; hint: string },
    checked: boolean,
    onChange: (next: boolean) => void,
  ) => (
    <div key={s.key} className="profile-row">
      <div className="profile-row-label sync-rules-label">
        <span className="profile-row-title">{s.title}</span>
        <span className="profile-row-hint">{s.hint}</span>
      </div>
      <Switch checked={checked} disabled={locked} ariaLabel={s.title} title={lockedTitle} onChange={onChange} />
    </div>
  );

  const textDelta = textPreview ? textPreview.current.files - textPreview.candidate.files : 0;

  return (
    <div className="versioning-tab sync-rules-tab">
      <p className="versioning-lede">
        {isSynced
          ? "Choose what syncs in this vault. Every computer in the vault follows these settings. Nothing is ever deleted: a file that stops syncing stays where it is, on each computer and on the server."
          : "Choose what Baalda shows and syncs in this vault. A file that's left out stays in the folder; Baalda just doesn't show or search it."}
        {!canEdit && " Only owners and admins can change them."}
      </p>
      {error && <div className="auth-error">{error}</div>}

      <div className="sync-rules-group-label">File types</div>
      <div className="profile-rows">
        <div className="profile-row">
          <div className="profile-row-label sync-rules-label">
            <span className="profile-row-title">Notes, images, PDFs, Office files, audio and video</span>
            <span className="profile-row-hint">Plus spreadsheets, CSV and JSON data, and zip archives.</span>
          </div>
          <span className="sync-rules-always">Always</span>
        </div>
        {features.types &&
          TYPE_SWITCHES.map((s) =>
            switchRow(s, current.types[s.key], (on) => void commit({ ...current, types: { ...current.types, [s.key]: on } })),
          )}
      </div>

      {features.folders && (
        <>
          <div className="sync-rules-group-label">Folders</div>
          <div className="profile-rows">
            {FOLDER_SWITCHES.map((s) =>
              switchRow(s, current.folders[s.key], (on) =>
                void commit({ ...current, folders: { ...current.folders, [s.key]: on } }),
              ),
            )}
          </div>
        </>
      )}

      <div className="sync-rules-group-label">Don't sync</div>
      <div className="profile-rows sync-rules-list">
        {rows.length === 0 && (
          <div className="profile-row sync-rules-empty">
            Nothing is left out. Add a folder to keep it on each computer only, like a code folder in a project.
          </div>
        )}
        {rows.map((r) => {
          const isFolder = r.text.endsWith("/") && !/[*?]/.test(r.text) && !r.text.startsWith("!");
          return (
            <div key={`${r.line}:${r.text}`} className="profile-row sync-rules-item">
              <span className="sync-rules-glyph">{isFolder ? <FolderGlyph /> : <PatternGlyph />}</span>
              <div className="sync-rules-item-text">
                <span className="sync-rules-path">{r.text}</span>
                {notes.get(r.line) && <span className="profile-row-hint">{notes.get(r.line)}</span>}
              </div>
              {canEdit && (
                <button
                  type="button"
                  className="sync-rules-remove"
                  aria-label={`Sync ${r.text} again`}
                  title="Sync it again"
                  disabled={busy}
                  onClick={() => removeLine(r.line)}
                >
                  <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
                    <path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                  </svg>
                </button>
              )}
            </div>
          );
        })}
        {canEdit && (
          <div className="profile-row sync-rules-add">
            <button type="button" className="checkpoint-ink-btn" disabled={busy || !vaultPath} onClick={() => void chooseFolder()}>
              Choose folder…
            </button>
            <form
              className="sync-rules-add-form"
              onSubmit={(e) => {
                e.preventDefault();
                void addPattern(newPath);
              }}
            >
              <input
                type="text"
                value={newPath}
                placeholder="or type a path, like projects/app/code/ or *.log"
                spellCheck={false}
                disabled={busy}
                onChange={(e) => setNewPath(e.target.value)}
              />
              <button type="submit" className="link-btn" disabled={busy || newPath.trim() === ""}>
                Add
              </button>
            </form>
          </div>
        )}
      </div>

      <div className="sync-rules-foot">
        {hiddenHere !== null && hiddenHere > 0 && (
          <span>The list keeps {plural(hiddenHere, "file")} on this computer out of sync. </span>
        )}
        <button type="button" className="link-btn" onClick={() => setTextOpen((o) => !o)}>
          {textOpen ? "Hide the text" : canEdit ? "Edit as text" : "Show as text"}
        </button>
      </div>

      {textOpen && (
        <div className="sync-rules-text">
          <div className="sync-rules-editor">
            <SkillCodeEditor
              path=".baaldaignore"
              value={draft}
              onChange={setDraft}
              onSave={() => void commit({ ...current, patterns: draft })}
              readOnly={!canEdit}
            />
          </div>
          <div className="muted checkpoint-note">
            One path or pattern per line, like a .gitignore file. A line ending in / is a folder, * matches any name,
            and ! brings a path back.
          </div>
          {draftProblem && <div className="auth-error">{draftProblem}</div>}
          {draftNotes.map((n) => (
            <div key={n.line} className="muted checkpoint-note">
              Line {n.line}: {n.message}
            </div>
          ))}
          {canEdit && draft !== current.patterns && (
            <div className="sync-rules-actions">
              <AsyncButton
                className="checkpoint-ink-btn"
                onClick={() => commit({ ...current, patterns: draft })}
                disabled={!!draftProblem || busy}
              >
                Save
              </AsyncButton>
              <button type="button" className="link-btn" onClick={() => setDraft(current.patterns)}>
                Discard changes
              </button>
              {textPreview && textDelta !== 0 && (
                <span className="muted checkpoint-note">
                  {textDelta < 0
                    ? `Stops syncing ${plural(-textDelta, "file")} here. Nothing is deleted.`
                    : `Syncs ${plural(textDelta, "more file")} here.`}
                </span>
              )}
            </div>
          )}
        </div>
      )}

      <p className="sync-rules-never">
        Never synced: Baalda's own data (.context), Git's internal folder (.git), app lock files and system files like
        .DS_Store. Syncing those would corrupt them.
      </p>
    </div>
  );
}

