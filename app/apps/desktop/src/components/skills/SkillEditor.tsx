// A skill's server-side draft (docs/SKILLS.md §5.5): a collapsible file tree, a
// CodeMirror editor per file (`SkillCodeEditor`), and for SKILL.md a small
// Name / Description header that edits the frontmatter in place
// (`lib/skills/skillMdEdit.ts`). Changes save on their own about a second after
// typing stops, and on ⌘S, as one PATCH carrying only what changed. The draft
// revision guards against two admins saving over each other: a 409
// `stale_draft` stops autosave and offers Load latest.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { skillErrorCode } from "../../lib/api";
import { authManager } from "../../lib/auth/authManager";
import { buildFileTree, middleTruncate, visibleRows } from "../../lib/skills/fileTree";
import { readSkillHeader, setFrontmatterDescription } from "../../lib/skills/skillMdEdit";
import type { SkillDetail, SkillDraft, SkillFileInput } from "../../lib/skills/types";
import {
  base64ToText,
  caseDuplicate,
  checkSkillCaps,
  SKILL_MAX_DESCRIPTION_CHARS,
  SKILL_MAX_FILE_BYTES,
  skillMdProblemText,
  skillPathProblem,
  textToBase64,
  validateSkillMd, CAP_RULE_TEXT } from "../../lib/skills/validate";
import { iconForPath } from "../FileTree";
import { RowActionsMenu } from "../RowActionsMenu";
import { Spinner } from "../Spinner";
import "../editor.css";
import { EditorSkeleton, LoadError } from "./parts";
import { loadErrorText, withTimeout } from "../../lib/skills/loading";
import { SkillCodeEditor } from "./SkillCodeEditor";
import { SkillsMenuButton } from "./SkillsMenuButton";

const CAP_TEXT = {
  ...CAP_RULE_TEXT,
} as const;

const AUTOSAVE_MS = 1000;
/** Below this width the tree folds into a file picker. */
const NARROW_PX = 560;

interface WorkingFile {
  path: string;
  executable: boolean;
  size: number;
  /** null = binary (not editable here). */
  text: string | null;
  /** Text as the server last had it; undefined for a file added here. */
  savedText?: string | null;
}

function fromDraft(draft: SkillDraft): WorkingFile[] {
  return draft.files.map((f) => {
    const text = f.size <= SKILL_MAX_FILE_BYTES ? base64ToText(f.contentBase64) : null;
    return { path: f.path, executable: f.executable, size: f.size, text, savedText: text };
  });
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB` : `${(bytes / 1048576).toFixed(1)} MB`;
}

const byteLength = (f: WorkingFile) => (f.text === null ? f.size : new TextEncoder().encode(f.text).length);
const isChanged = (f: WorkingFile) => f.text !== null && f.text !== f.savedText;

type SaveState =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "saved" }
  | { kind: "error"; message: string }
  | { kind: "stale" };

const folderIcon = (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
  </svg>
);

/** A textarea that grows with its content. */
function GrowingTextarea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement> & { value: string }) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [props.value]);
  return <textarea ref={ref} rows={1} {...props} />;
}

export function SkillEditor({
  orgId,
  skill,
  onSaved,
  focus,
  onToggleFocus,
  flushRef,
  publishError,
}: {
  orgId: string;
  skill: SkillDetail;
  /** After a successful save (the detail's draftDiffers may have changed). */
  onSaved: (draft: SkillDraft) => void;
  focus: boolean;
  onToggleFocus: () => void;
  /** Set to a function that saves anything pending; resolves false if it couldn't. */
  flushRef?: React.MutableRefObject<(() => Promise<boolean>) | null>;
  /** Why the last Publish was refused, shown in the footer. */
  publishError?: string | null;
}) {
  const [draft, setDraft] = useState<SkillDraft | null>(null);
  const [files, setFiles] = useState<WorkingFile[]>([]);
  const [removed, setRemoved] = useState<string[]>([]);
  const [selected, setSelected] = useState("SKILL.md");
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [adding, setAdding] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [save, setSave] = useState<SaveState>({ kind: "idle" });
  const [narrow, setNarrow] = useState(false);
  const [descFocused, setDescFocused] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // Saves read the latest values through refs: autosave fires from a timer.
  const draftRef = useRef(draft);
  const filesRef = useRef(files);
  const removedRef = useRef(removed);
  draftRef.current = draft;
  filesRef.current = files;
  removedRef.current = removed;
  const savingRef = useRef(false);
  const againRef = useRef(false);
  const staleRef = useRef(false);

  const load = useCallback(async () => {
    const d = await withTimeout(authManager.api.getSkillDraft(orgId, skill.id));
    staleRef.current = false;
    setDraft(d);
    setFiles(fromDraft(d));
    setRemoved([]);
    setSave({ kind: "idle" });
    setError(null);
    return d;
  }, [orgId, skill.id]);

  useEffect(() => {
    load().catch((e) => setError(loadErrorText(e)));
  }, [load]);

  useEffect(() => {
    const el = rootRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([entry]) => setNarrow(entry.contentRect.width < NARROW_PX));
    ro.observe(el);
    return () => ro.disconnect();
  }, [draft !== null]);

  const changedPaths = useMemo(() => new Set(files.filter(isChanged).map((f) => f.path)), [files]);
  const dirty = changedPaths.size > 0 || removed.length > 0;
  const current = files.find((f) => f.path === selected) ?? null;

  const problems = useMemo(() => {
    const out: string[] = [];
    const md = files.find((f) => f.path === "SKILL.md");
    const reason = validateSkillMd(md ? md.text : null, skill.name);
    if (reason) out.push(skillMdProblemText(reason, skill.name));
    const cap = checkSkillCaps(files.map((f) => ({ size: byteLength(f) })));
    if (cap) out.push(CAP_TEXT[cap]);
    return out;
  }, [files, skill.name]);

  const saveNow = useCallback(async () => {
    const d = draftRef.current;
    if (!d || staleRef.current) return;
    if (savingRef.current) {
      againRef.current = true;
      return;
    }
    const sent = filesRef.current.filter(isChanged).map((f) => ({ path: f.path, text: f.text ?? "", executable: f.executable }));
    const gone = removedRef.current;
    if (sent.length === 0 && gone.length === 0) return;
    savingRef.current = true;
    setSave({ kind: "saving" });
    const upsert: SkillFileInput[] = sent.map((f) => ({ path: f.path, contentBase64: textToBase64(f.text), executable: f.executable }));
    try {
      const next = await authManager.api.patchSkillDraft(orgId, skill.id, d.revision, {
        ...(upsert.length ? { upsert } : {}),
        ...(gone.length ? { remove: gone } : {}),
      });
      setDraft(next);
      // What was sent is now the server's; anything typed meanwhile stays unsaved.
      const sentText = new Map(sent.map((f) => [f.path, f.text]));
      setFiles((list) =>
        list.map((f) => (sentText.has(f.path) ? { ...f, savedText: sentText.get(f.path), size: new TextEncoder().encode(sentText.get(f.path)!).length } : f)),
      );
      setRemoved((r) => r.filter((p) => !gone.includes(p)));
      setSave({ kind: "saved" });
      okRef.current = true;
      onSaved(next);
    } catch (e) {
      if (skillErrorCode(e) === "stale_draft") {
        staleRef.current = true;
        setSave({ kind: "stale" });
      } else {
        setSave({ kind: "error", message: e instanceof Error ? e.message : String(e) });
      }
      okRef.current = false;
    } finally {
      savingRef.current = false;
      if (againRef.current) {
        againRef.current = false;
        void saveNowRef.current();
      }
    }
  }, [orgId, skill.id, onSaved]);
  const saveNowRef = useRef(saveNow);
  saveNowRef.current = saveNow;
  const okRef = useRef(true);

  // Publish asks for this first: wait out a save in flight, then save the rest.
  useEffect(() => {
    if (!flushRef) return;
    flushRef.current = async () => {
      const settle = async () => {
        while (savingRef.current) await new Promise((r) => setTimeout(r, 80));
      };
      await settle();
      const pending = filesRef.current.some(isChanged) || removedRef.current.length > 0;
      if (pending) {
        await saveNowRef.current();
        await settle();
      }
      return okRef.current && !staleRef.current;
    };
    return () => {
      flushRef.current = null;
    };
  }, [flushRef]);

  // Autosave about a second after the last change.
  useEffect(() => {
    if (!dirty || staleRef.current) return;
    const t = setTimeout(() => void saveNowRef.current(), AUTOSAVE_MS);
    return () => clearTimeout(t);
  }, [files, removed, dirty]);

  const setText = (path: string, text: string) =>
    setFiles((list) => list.map((f) => (f.path === path ? { ...f, text } : f)));

  const addFile = (raw: string) => {
    const path = raw.trim().replace(/^\/+/, "");
    if (path.endsWith("/")) return setError("Add a file name after the folder, like scripts/run.py.");
    const problem = skillPathProblem(path);
    if (problem) return setError(`That name ${problem}.`);
    if (caseDuplicate([...files.map((f) => f.path), path])) return setError("A file with that name already exists.");
    setError(null);
    setFiles((list) => [...list, { path, executable: false, size: 0, text: "" }]);
    setRemoved((r) => r.filter((p) => p.toLowerCase() !== path.toLowerCase()));
    setCollapsed((c) => new Set([...c].filter((d) => !path.startsWith(`${d}/`))));
    setSelected(path);
    setAdding(null);
  };

  const removePaths = (paths: string[]) => {
    const drop = new Set(paths);
    setFiles((list) => list.filter((f) => !drop.has(f.path)));
    const known = new Set(draft?.files.map((f) => f.path) ?? []);
    setRemoved((r) => [...r, ...paths.filter((p) => known.has(p) && !r.includes(p))]);
    if (drop.has(selected)) setSelected("SKILL.md");
  };

  const discard = () => {
    if (!draft) return;
    setFiles(fromDraft(draft));
    setRemoved([]);
    setSave({ kind: "idle" });
  };

  if (!draft) {
    return error ? (
      <LoadError
        message={`Couldn't load the draft: ${error}`}
        onRetry={() => {
          setError(null);
          load().catch((e) => setError(loadErrorText(e)));
        }}
      />
    ) : (
      <EditorSkeleton />
    );
  }

  const tree = buildFileTree(files.map((f) => f.path), changedPaths);
  const rows = visibleRows(tree, collapsed);
  const header = current?.path === "SKILL.md" && current.text !== null ? readSkillHeader(current.text) : null;
  const status =
    save.kind === "saving" ? (
      <span className="skills-save-status"><Spinner size="xs" /> Saving…</span>
    ) : save.kind === "error" ? (
      <span className="skills-save-status is-bad" title={save.message}>
        Couldn't save ·{" "}
        <button className="link-btn" onClick={() => void saveNow()}>Retry</button>
      </span>
    ) : save.kind === "stale" ? (
      <span className="skills-save-status is-bad">
        Someone else changed this draft ·{" "}
        <button className="link-btn" onClick={() => void load()}>Load latest</button>
      </span>
    ) : dirty ? (
      <span className="skills-save-status">Unsaved</span>
    ) : save.kind === "saved" ? (
      <span className="skills-save-status">Saved</span>
    ) : null;

  const treeView = (
    <div className="skills-tree">
      <div className="skills-tree-head">
        <span>Files</span>
        <SkillsMenuButton
          label="+"
          caret={false}
          className="icon-btn skills-tree-add"
          ariaLabel="Add"
          title="Add a file or folder"
          actions={[
            { key: "file", label: "New file", onSelect: () => setAdding("") },
            { key: "folder", label: "New folder", onSelect: () => setAdding("new-folder/") },
          ]}
        />
      </div>
      {adding !== null && (
        <div className="skills-tree-input-wrap">
          <input
            autoFocus
            className="skills-tree-input"
            placeholder="name.md or folder/name.md"
            defaultValue={adding}
            onKeyDown={(e) => {
              if (e.key === "Enter") addFile(e.currentTarget.value);
              if (e.key === "Escape") {
                e.stopPropagation();
                setAdding(null);
              }
            }}
            onBlur={(e) => {
              if (!e.currentTarget.value.trim() || e.currentTarget.value === adding) setAdding(null);
            }}
          />
        </div>
      )}
      <ul className="skills-tree-list" role="tree">
        {rows.map(({ node, depth }) => {
          const pad = { paddingLeft: `${6 + depth * 14}px` };
          if (node.kind === "folder") {
            const open = !collapsed.has(node.path);
            const under = files.filter((f) => f.path.startsWith(`${node.path}/`)).map((f) => f.path);
            return (
              <li key={`d:${node.path}`} role="treeitem" aria-expanded={open} className="skills-tree-row is-folder" style={pad}>
                <button
                  type="button"
                  className="skills-tree-btn"
                  title={node.path}
                  onClick={() =>
                    setCollapsed((c) => {
                      const next = new Set(c);
                      if (open) next.add(node.path);
                      else next.delete(node.path);
                      return next;
                    })
                  }
                >
                  <svg className={`skills-caret${open ? "" : " is-closed"}`} viewBox="0 0 10 10" aria-hidden="true">
                    <path d="M2 3.5 5 6.5 8 3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                  <span className="skills-tree-icon">{folderIcon}</span>
                  <span className="skills-tree-name">{middleTruncate(node.name)}</span>
                  {!open && node.changed && <span className="skills-tree-dot" aria-label="Unsaved changes" />}
                </button>
                <RowActionsMenu
                  ariaLabel={`Actions for ${node.name}`}
                  actions={[{ key: "del", label: `Delete folder (${under.length})`, danger: true, onSelect: () => removePaths(under) }]}
                />
              </li>
            );
          }
          return (
            <li
              key={node.path}
              role="treeitem"
              aria-selected={node.path === selected}
              className={`skills-tree-row${node.path === selected ? " is-active" : ""}`}
              style={pad}
            >
              <button type="button" className="skills-tree-btn" title={node.path} onClick={() => setSelected(node.path)}>
                <span className="skills-caret-space" aria-hidden="true" />
                <span className="skills-tree-icon">{iconForPath(node.path)}</span>
                <span className="skills-tree-name">{middleTruncate(node.name)}</span>
                {node.changed && <span className="skills-tree-dot" aria-label="Unsaved changes" />}
              </button>
              {node.path !== "SKILL.md" && (
                <RowActionsMenu
                  ariaLabel={`Actions for ${node.name}`}
                  actions={[{ key: "del", label: "Delete file", danger: true, onSelect: () => removePaths([node.path]) }]}
                />
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );

  const picker = (
    <select className="skills-file-picker" value={selected} onChange={(e) => setSelected(e.target.value)} aria-label="File">
      {files
        .map((f) => f.path)
        .sort((a, b) => (a === "SKILL.md" ? -1 : b === "SKILL.md" ? 1 : a.localeCompare(b)))
        .map((p) => (
          <option key={p} value={p}>
            {changedPaths.has(p) ? `• ${p}` : p}
          </option>
        ))}
    </select>
  );

  return (
    <div ref={rootRef} className={`skills-editor${narrow ? " is-narrow" : ""}`}>
      {!narrow && treeView}
      <div className="skills-pane">
        <div className="skills-pane-head">
          {narrow ? picker : (
            <span className="skills-pane-path" title={current?.path}>
              {current?.path ?? ""}
              {current && <span className="skills-pane-size"> · {formatSize(byteLength(current))}</span>}
            </span>
          )}
          <span className="skills-actions">
            {status}
            <RowActionsMenu
              ariaLabel="Draft actions"
              actions={[
                ...(narrow ? [{ key: "add", label: "New file", onSelect: () => setAdding("") }] : []),
                ...(narrow && current && current.path !== "SKILL.md"
                  ? [{ key: "del", label: "Delete this file", danger: true, onSelect: () => removePaths([current.path]) }]
                  : []),
                ...(dirty ? [{ key: "discard", label: "Discard unsaved changes", danger: true, onSelect: discard }] : []),
                { key: "save", label: "Save now (⌘S)", onSelect: () => void saveNow() },
              ]}
            />
            <button
              type="button"
              className="icon-btn skills-expand"
              onClick={onToggleFocus}
              aria-label={focus ? "Exit full view" : "Expand editor"}
              title={focus ? "Exit full view (Esc)" : "Expand editor"}
            >
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                {focus ? (
                  <path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7" />
                ) : (
                  <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />
                )}
              </svg>
            </button>
          </span>
        </div>
        {narrow && adding !== null && (
          <div className="skills-tree-input-wrap">
            <input
              autoFocus
              className="skills-tree-input"
              placeholder="name.md or folder/name.md"
              defaultValue={adding}
              onKeyDown={(e) => {
                if (e.key === "Enter") addFile(e.currentTarget.value);
                if (e.key === "Escape") setAdding(null);
              }}
            />
          </div>
        )}

        {header && current && (
          <div className="skills-md-header">
            <span className="skills-md-label">Name</span>
            <span className="skills-md-name" title="A skill's name can't be changed">
              {header.name ?? skill.name}
              <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <rect x="5" y="11" width="14" height="10" rx="2" />
                <path d="M8 11V7a4 4 0 0 1 8 0v4" />
              </svg>
            </span>
            <span className="skills-md-label">Description</span>
            <span className="skills-md-desc">
              <GrowingTextarea
                className={`skills-md-input${descFocused ? "" : " is-collapsed"}`}
                onFocus={() => setDescFocused(true)}
                onBlur={() => setDescFocused(false)}
                value={header.description ?? ""}
                placeholder="When should an AI use this skill?"
                aria-label="Description"
                onChange={(e) => {
                  const fm = setFrontmatterDescription(header.parts.frontmatter, e.target.value);
                  if (fm !== null) setText("SKILL.md", fm + header.parts.body);
                }}
              />
              {(descFocused || (header.description ?? "").length > 900) && (
                <span
                  className={`skills-md-count${(header.description ?? "").length > SKILL_MAX_DESCRIPTION_CHARS ? " is-over" : ""}`}
                >
                  {(header.description ?? "").length} / {SKILL_MAX_DESCRIPTION_CHARS}
                </span>
              )}
            </span>
          </div>
        )}

        <div className="skills-pane-body">
          {!current ? (
            <div className="skills-quiet field-hint">Pick a file.</div>
          ) : current.text === null ? (
            <div className="skills-quiet field-hint">
              {current.path} isn't a text file ({formatSize(current.size)}). Upload the skill again to change it.
            </div>
          ) : (
            <SkillCodeEditor
              path={header ? "SKILL.md#body" : current.path}
              value={header ? header.parts.body : current.text}
              onChange={(text) =>
                setText(current.path, header ? header.parts.frontmatter + text : text)
              }
              onSave={() => void saveNow()}
            />
          )}
        </div>

        {(problems.length > 0 || error || publishError) && (
          <div className="skills-pane-foot">
            <span className="skills-hint-bad">{error ?? publishError ?? problems[0]}</span>
          </div>
        )}
      </div>
    </div>
  );
}
