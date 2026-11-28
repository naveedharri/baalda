// SPDX-License-Identifier: Apache-2.0
import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import * as ipc from "../lib/ipc";
import { useStore } from "../store";
import {
  DASHBOARD_TEMPLATES,
  copyDashboardPrompt,
} from "../lib/dashboard/templates";
import { dashboardPath } from "../lib/dashboard/bridge";
import { internetShortcut } from "../lib/dashboard/links";
import { detectInstalledAgents, type InstalledAgent } from "../lib/dashboard/agent";
import { requestDashboardAgent } from "../lib/dashboard/agentLaunch";
import "./HomeDashboardDialog.css";
import { VaultDashboardsTab } from "./VaultDashboardsTab";
import { DashboardTemplateGallery, templateHtml } from "./DashboardTemplateGallery";
import { CheckIcon } from "./CheckIcon";

function existingPaths(): Set<string> {
  const state = useStore.getState();
  const paths = new Set(state.titles.map((note) => note.path.toLowerCase()));
  const collect = (node: ipc.TreeNode) => {
    if (node.path) paths.add(node.path.toLowerCase());
    node.children?.forEach(collect);
  };
  if (state.tree) collect(state.tree);
  return paths;
}

function defaultDashboardFolder(): string {
  return useStore.getState().tree?.children?.find((node) => node.isDir && node.path.toLowerCase() === "dashboards")?.path ?? "Dashboards";
}

function availableName(
  base: string,
  folder: string,
  kind: "html" | "link",
): string {
  const paths = existingPaths();
  const extension = kind === "html" ? ".html" : ".url";
  const prefix = folder ? `${folder}/` : "";
  let candidate = base;
  for (
    let suffix = 2;
    paths.has(`${prefix}${candidate}${extension}`.toLowerCase());
    suffix++
  ) {
    candidate = `${base} ${suffix}`;
  }
  return candidate;
}

/** A template title as a file name: "Orbit: Agentic OS" → "Orbit - Agentic OS". A colon (and the
 *  other characters no file system accepts everywhere) would only be refused on Create. */
export function fileNameFromTitle(title: string): string {
  const safe = title
    .replace(/\s*:\s*/g, " - ")
    .replace(/[\\/*?"<>|\x00-\x1f]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[\s.]+|[\s.]+$/g, "");
  return safe || "Dashboard";
}

function templateName(id: string): string {
  if (id === "daily") return "Home";
  if (id === "blank") return "Dashboard";
  return fileNameFromTitle(
    DASHBOARD_TEMPLATES.find((template) => template.id === id)?.name ?? "Home",
  );
}

function FolderIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10H3V7Z" />
    </svg>
  );
}

/** Local picker: native button semantics, roving option focus, and no OS styling. */
function DashboardFolderPicker({
  value,
  folders,
  disabled,
  onChange,
}: {
  value: string;
  folders: string[];
  disabled: boolean;
  onChange: (folder: string) => void;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [menuHeight, setMenuHeight] = useState(200);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const options = useRef<Array<HTMLButtonElement | null>>([]);
  useEffect(() => {
    if (open) options.current[active]?.focus();
  }, [open, active]);
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);
  const show = () => {
    const bounds = trigger.current?.getBoundingClientRect();
    const dialogBounds = root.current
      ?.closest(".dashboard-dialog")
      ?.getBoundingClientRect();
    if (bounds && dialogBounds)
      setMenuHeight(
        Math.max(64, Math.min(200, bounds.top - dialogBounds.top - 14)),
      );
    setActive(Math.max(0, folders.indexOf(value)));
    setOpen(true);
  };
  const dismiss = () => {
    setOpen(false);
    trigger.current?.focus();
  };
  return (
    <div
      className="dashboard-folder-picker"
      ref={root}
      onBlur={(event) => {
        if (!root.current?.contains(event.relatedTarget as Node | null))
          setOpen(false);
      }}
      onKeyDown={(event) => {
        if (!open) return;
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          dismiss();
        }
        if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
          event.preventDefault();
          event.stopPropagation();
          setActive((index) =>
            event.key === "Home"
              ? 0
              : event.key === "End"
                ? folders.length - 1
                : (index +
                    (event.key === "ArrowDown" ? 1 : -1) +
                    folders.length) %
                  folders.length,
          );
        }
      }}
    >
      <button
        ref={trigger}
        type="button"
        className="dashboard-folder-trigger"
        disabled={disabled}
        aria-label={`Folder: ${value || "Vault root"}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => (open ? dismiss() : show())}
        onKeyDown={(event) => {
          if (!open && ["ArrowDown", "ArrowUp"].includes(event.key)) {
            event.preventDefault();
            show();
          }
        }}
      >
        <FolderIcon />
        <span>{value || "Vault root"}</span>
        <svg
          className="dashboard-folder-chevron"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          aria-hidden="true"
        >
          <path d="m4 6 4 4 4-4" />
        </svg>
      </button>
      {open && (
        <div
          id={id}
          className="dashboard-folder-options"
          style={{ maxHeight: menuHeight }}
          role="listbox"
          aria-label="Folder"
        >
          {folders.map((path, index) => (
            <button
              key={path}
              ref={(node) => {
                options.current[index] = node;
              }}
              type="button"
              role="option"
              aria-selected={value === path}
              tabIndex={active === index ? 0 : -1}
              title={path || "Vault root"}
              onFocus={() => setActive(index)}
              onClick={() => {
                onChange(path);
                dismiss();
              }}
            >
              <FolderIcon />
              <span>{path || "Vault root"}</span>
              <span className="dashboard-folder-check" aria-hidden="true">
                {value === path ? <CheckIcon /> : null}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function HomeDashboardDialog() {
  const vault = useStore((s) => s.vault);
  const tree = useStore((s) => s.tree);
  const titles = useStore((s) => s.titles);
  const [manage, setManage] = useState(false);
  const [configuring, setConfiguring] = useState(false);
  const [kind, setKind] = useState<"html" | "link" | null>(null);
  const [templateId, setTemplateId] = useState<string>(DASHBOARD_TEMPLATES[0].id);
  const [name, setName] = useState("Home");
  const [nameCustomized, setNameCustomized] = useState(false);
  const [folder, setFolder] = useState("");
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [agents, setAgents] = useState<InstalledAgent[] | null>(null);
  const [setAsHome, setSetAsHome] = useState(false);
  const [created, setCreated] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const epoch = useRef<number | null>(null);
  const generation = useRef(0);
  const busyRef = useRef(false);
  busyRef.current = busy;
  const dialog = useRef<HTMLDivElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const fieldId = useId();
  useEffect(() => {
    const open = (event: Event) => {
      const current = useStore.getState().vault;
      if (!current || busyRef.current) return;
      ++generation.current;
      useStore.setState({ homePickerOpen: false });
      epoch.current = current.epoch;
      previousFocus.current = document.activeElement as HTMLElement;
      const nextKind =
        (event as CustomEvent).detail?.kind === "link" ? "link" : "html";
      setKind(nextKind);
      setConfiguring(!!(event as CustomEvent).detail?.templateId || nextKind === "link");
      setManage((event as CustomEvent).detail?.manage === true);
      setSetAsHome((event as CustomEvent).detail?.setAsHome === true);
      setTemplateId(DASHBOARD_TEMPLATES.find((t) => t.id === (event as CustomEvent).detail?.templateId)?.id ?? DASHBOARD_TEMPLATES[0].id);
      const destination = defaultDashboardFolder();
      setName(availableName("Home", destination, nextKind));
      setNameCustomized(false);
      setFolder(destination);
      setUrl("");
      setError(null);
      setNameError(null);
      setCreated(null);
      setBusy(false);
      setCopied(false);
    };
    window.addEventListener("baalda:new-dashboard", open);
    return () => window.removeEventListener("baalda:new-dashboard", open);
  }, []);
  useEffect(() => {
    if (!kind) return;
    let cancelled = false;
    void detectInstalledAgents().then((installed) => {
      if (!cancelled) setAgents(installed.filter((agent) => agent.runnable));
    }).catch(() => { if (!cancelled) setAgents([]); });
    return () => { cancelled = true; };
  }, [kind]);
  useEffect(() => {
    if (kind && configuring) nameInput.current?.focus();
  }, [kind, configuring]);
  useEffect(() => {
    if (kind && !created && !nameCustomized) {
      setName(
        availableName(
          kind === "link" ? "Home" : templateName(templateId),
          folder,
          kind,
        ),
      );
      setNameError(null);
    }
  }, [kind, created, nameCustomized, templateId, folder, titles, tree]);
  useEffect(() => {
    ++generation.current;
    setKind(null);
    setCreated(null);
    setBusy(false);
    busyRef.current = false;
  }, [vault?.epoch]);
  useEffect(() => {
    if (nameError && !busy) nameInput.current?.focus();
  }, [nameError, busy]);
  const close = () => {
    if (!busyRef.current) {
      ++generation.current;
      setKind(null);
      if (previousFocus.current?.isConnected) previousFocus.current.focus();
    }
  };
  const folderSet = new Set<string>(["", defaultDashboardFolder()]);
  const walk = (node: ipc.TreeNode) => {
    if (node.isDir && node.path) folderSet.add(node.path);
    node.children?.forEach(walk);
  };
  if (tree) walk(tree);
  // The sidebar is lazy; index paths expose folders not expanded on this device.
  for (const note of titles) {
    const parts = note.path.split("/");
    for (let i = 1; i < parts.length; i++)
      folderSet.add(parts.slice(0, i).join("/"));
  }
  const folders = [...folderSet].sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: "base" }),
  );
  const selected =
    DASHBOARD_TEMPLATES.find((template) => template.id === templateId) ??
    DASHBOARD_TEMPLATES[0];
  const create = async () => {
    if (
      !vault ||
      kind == null ||
      epoch.current !== vault.epoch ||
      busyRef.current
    )
      return;
    const request = generation.current;
    const requestEpoch = vault.epoch;
    const current = () =>
      generation.current === request &&
      useStore.getState().vault?.epoch === requestEpoch;
    setError(null);
    setNameError(null);
    if (/[\\/:*?"<>|\x00-\x1f]/.test(name)) {
      setNameError('A file name can\'t contain \\ / : * ? " < > |');
      nameInput.current?.focus();
      return;
    }
    if (!name.trim() || name.trim().startsWith(".")) {
      setNameError("Choose a valid file name.");
      nameInput.current?.focus();
      return;
    }
    const extension = kind === "link" ? ".url" : ".html";
    const fileName =
      name.trim().replace(/\.(html|htm|url|webloc)$/i, "") + extension;
    let path: string;
    try {
      path = dashboardPath(folder ? `${folder}/${fileName}` : fileName);
    } catch (error) {
      setNameError(error instanceof Error ? error.message : "Choose a valid file name.");
      nameInput.current?.focus();
      return;
    }
    if (!created && existingPaths().has(path.toLowerCase())) {
      setNameError(
        "A file with this name already exists in this folder. Choose another name.",
      );
      nameInput.current?.focus();
      return;
    }
    path = created ?? path;
    busyRef.current = true;
    setBusy(true);
    try {
      if (!created) {
        if (!folder && useStore.getState().rootFrozen)
          throw new Error("This vault’s root is frozen. Choose a folder.");
        const content = kind === "link" ? internetShortcut(url) : await templateHtml(selected);
        if (!current()) return;
        if (folder.toLowerCase() === "dashboards") {
          if (useStore.getState().rootFrozen && !useStore.getState().tree?.children?.some((node) => node.isDir && node.path.toLowerCase() === folder.toLowerCase()))
            throw new Error("This vault’s root is frozen. Choose an existing folder.");
          if (!current()) return;
          await ipc.ensureFolder(folder, requestEpoch);
          if (!current()) return;
        }
        const wasCreated = await ipc.writeNoteIfMissing(
          path,
          content,
          vault.epoch,
        );
        if (!current()) return;
        if (!wasCreated) {
          setNameError(
            "A file with this name already exists in this folder. Choose another name.",
          );
          nameInput.current?.focus();
          return;
        }
        setCreated(path);
      }
      await useStore.getState().refreshTree();
      if (!current()) return;
      await useStore.getState().refreshTitles();
      if (!current()) return;
      if (setAsHome) {
        await useStore.getState().setHome(path, "personal");
        if (!current()) return;
        await useStore.getState().openNoteByPath(path);
        if (!current()) return;
        setKind(null);
      } else {
        await useStore.getState().openNoteByPath(path);
        if (current() && kind === "link") setKind(null);
      }
    } catch (e) {
      if (current()) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (current()) {
        busyRef.current = false;
        setBusy(false);
      }
    }
  };
  if (!kind || !vault) return null;
  return createPortal(
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <div
        ref={dialog}
        className={`dashboard-dialog${kind === "html" && !created && !configuring ? " dashboard-gallery-dialog" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-dashboard-title"
        onKeyDown={(event) => {
          event.stopPropagation();
          if (
            (event.metaKey || event.ctrlKey) &&
            ["n", "w", "h", "r", "g", "f", "k", "p", "s"].includes(
              event.key.toLowerCase(),
            )
          )
            event.preventDefault();
          if (event.key === "Escape") {
            event.preventDefault();
            close();
          }
          if (event.key === "Tab") {
            const controls = Array.from(
              dialog.current?.querySelectorAll<HTMLElement>(
                "button:not(:disabled), input:not(:disabled), a[href]",
              ) ?? [],
            ).filter(
              (control) =>
                control.tabIndex >= 0 && control.getClientRects().length > 0,
            );
            const first = controls[0],
              last = controls[controls.length - 1];
            if (event.shiftKey && document.activeElement === first) {
              event.preventDefault();
              last?.focus();
            }
            if (!event.shiftKey && document.activeElement === last) {
              event.preventDefault();
              first?.focus();
            }
          }
        }}
      >
        <div className="dashboard-dialog-heading">
          <h2 id="new-dashboard-title">
            {created
              ? "Your dashboard is ready"
              : kind === "link"
                ? "Add dashboard from link"
                : manage ? "Home & dashboards" : configuring ? `Set up ${selected.name}` : "New dashboard"}
          </h2>
          <button
            type="button"
            className="icon-btn"
            aria-label="Close"
            disabled={busy}
            onClick={close}
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              aria-hidden="true"
            >
              <path d="m6 6 12 12M18 6 6 18" />
            </svg>
          </button>
        </div>
        {manage ? <VaultDashboardsTab onClose={close} onNew={(id) => { if (id) setTemplateId(id); setManage(false); setConfiguring(true); }} /> : created && setAsHome ? (
          <>
            <p className="dashboard-dialog-description">
              {busy ? "Setting up your Home…" : `${created} was created. Finish setting it as your Home.`}
            </p>
            <div className="dashboard-dialog-footer">
              <button type="button" className="primary" disabled={busy} onClick={() => void create()}>
                {busy ? "Setting Home…" : "Retry setting Home"}
              </button>
            </div>
          </>
        ) : created ? (
          <>
            <p className="dashboard-dialog-description">
              <strong>{created}</strong> is an ordinary file in your vault.{" "}
              {kind === "html"
                ? "Ask your agent to replace the examples using your notes."
                : "Share and pin it like any note. Some sites open in your browser."}
            </p>
            <div className="dashboard-dialog-footer">
              {agents?.map((agent) => (
                <button key={agent.agent} type="button" className="secondary" disabled={busy}
                  onClick={() => {
                    const expectedEpoch = epoch.current;
                    if (expectedEpoch == null || useStore.getState().vault?.epoch !== expectedEpoch) return;
                    ++generation.current;
                    setKind(null);
                    requestDashboardAgent({ agent: agent.agent, path: created, expectedEpoch });
                  }}>
                  Update with {agent.agent === "claude" ? "Claude" : "Codex"}
                </button>
              ))}
              {agents?.length === 0 && kind === "html" && (
                <button
                  type="button"
                  className="secondary"
                  disabled={busy}
                  onClick={() =>
                    void copyDashboardPrompt(
                      created,
                      vault.path,
                      selected.prompt,
                    )
                      .then(() => setCopied(true))
                      .catch((e) => setError(String(e)))
                  }
                >
                  {copied ? "Prompt copied" : "Copy agent prompt"}
                </button>
              )}
              <button
                type="button"
                className="secondary"
                disabled={busy}
                onClick={() =>
                  void useStore
                    .getState()
                    .setHome(created, "personal")
                    .then(close)
                    .catch((e) => setError(String(e)))
                }
              >
                Set as my home
              </button>
              <button type="button" className="primary" disabled={busy} onClick={close}>
                Done
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="dashboard-dialog-description">
              {kind === "html"
                ? configuring ? "Give your dashboard a name and choose where to save it." : "Choose an original dashboard design. Preview it, then let Claude or Codex connect it to your vault."
                : "Save a link to a dashboard or artifact in your vault."}
            </p>
            {kind === "html" && !configuring && (
              <DashboardTemplateGallery selectedId={templateId} disabled={busy} onUse={(template) => { setTemplateId(template.id); setConfiguring(true); }} />
            )}
            {configuring && <div className="dashboard-file-fields">
              <div className="dashboard-field">
                <label htmlFor={`${fieldId}-name`}>File name</label>
                <div
                  className={`dashboard-name-input${nameError ? " is-invalid" : ""}`}
                >
                  <input
                    id={`${fieldId}-name`}
                    ref={nameInput}
                    value={name}
                    maxLength={150}
                    disabled={busy}
                    aria-invalid={!!nameError}
                    aria-describedby={
                      nameError ? `${fieldId}-error` : undefined
                    }
                    onChange={(event) => {
                      setName(event.target.value);
                      setNameCustomized(true);
                      setNameError(null);
                    }}
                  />
                  <span aria-hidden="true">
                    {kind === "html" ? ".html" : ".url"}
                  </span>
                </div>
                {nameError && (
                  <p
                    id={`${fieldId}-error`}
                    role="alert"
                    className="dashboard-name-error"
                  >
                    {nameError}
                  </p>
                )}
              </div>
              <div className="dashboard-field">
                <span className="dashboard-field-label">Folder</span>
                <DashboardFolderPicker
                  value={folder}
                  folders={folders}
                  disabled={busy}
                  onChange={(path) => {
                    setFolder(path);
                    setNameError(null);
                  }}
                />
              </div>
            </div>
            }
            {kind === "link" && (
              <div className="dashboard-field dashboard-url-field">
                <label htmlFor={`${fieldId}-url`}>Dashboard URL</label>
                <input
                  id={`${fieldId}-url`}
                  type="url"
                  value={url}
                  placeholder="https://…"
                  maxLength={4096}
                  disabled={busy}
                  onChange={(event) => setUrl(event.target.value)}
                />
              </div>
            )}
            {error && (
              <p role="alert" className="dashboard-dialog-error">
                {error}
              </p>
            )}
            <div className="dashboard-dialog-footer">
              <button
                type="button"
                className="secondary"
                disabled={busy}
                onClick={close}
              >
                Cancel
              </button>
              {configuring && <button
                type="button"
                className="primary"
                disabled={
                  busy || !name.trim() || (kind === "link" && !url.trim())
                }
                onClick={() => void create()}
              >
                {busy ? "Adding…" : setAsHome ? "Set as Home" : "Add to vault"}
              </button>}
            </div>
          </>
        )}
        {created && error && (
          <p role="alert" className="dashboard-dialog-error">
            {error}
          </p>
        )}
      </div>
    </div>,
    document.body,
  );
}
