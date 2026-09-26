// SPDX-License-Identifier: Apache-2.0
// Client for the optional commercial service. All entitlement and edit authority is server-side.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useStore } from "../store";
import { authManager } from "../lib/auth/authManager";
import { syncManager } from "../lib/sync/docSession";
import { CHECK_DEFINITIONS } from "../lib/health/checks";
import { ApiError } from "../lib/api";
import type { AssistantProvider, DiagnosticInput, DiagnosticReview, HousekeeperScan, HousekeeperStatus } from "../lib/housekeeper";
import type { NoteTitle } from "../lib/ipc";
import "./housekeeper.css";
import { AssistantProviderSettings } from "./AssistantProviderSettings";

interface AssistantProps {
  identity?: string;
  onPrepareFix?: (id: string) => Promise<void>;
  localFindings?: ReactNode;
  collectDiagnostics?: () => Promise<DiagnosticInput>;
  renderFindingDetails?: (id: string) => ReactNode;
  onInspectFinding?: (id?: string) => void;
  onDiagnosticAction?: (id: string, action: string) => Promise<string>;
  repairNotes?: Record<string, { path: string; docId?: string | null }[]>;
  brokenLinkNotes?: { path: string; docId?: string | null; detail?: string | null }[];
  diagnostics?: DiagnosticInput | null;
  onOpenHealth?: () => void;
  onGoToGeneral?: () => void;
}
export function HousekeeperPanel({ onUpgrade, ...assistant }: AssistantProps & { onUpgrade: () => void }) {
  const path = useStore(s => s.vault?.path);
  const server = useStore(s => s.serverUrl);
  const user = useStore(s => s.session?.user.id);
  const synced = useStore(s => s.syncEnabled);
  const titles = useStore(s => s.titles);
  const vaultId = synced ? syncManager.registry.vaultId : null;
  const canUpgrade = useStore(s => s.billingConfig?.enabled === true);
  // Remount on every identity boundary; old async results cannot appear in another vault.
  return <HousekeeperView key={JSON.stringify([server, user, path, vaultId])}
    {...assistant} identity={JSON.stringify([server, user])} vaultId={user ? vaultId : null} notes={titles} onUpgrade={canUpgrade ? onUpgrade : undefined} />;
}

export function HousekeeperView({ vaultId, notes, onUpgrade, diagnostics, onOpenHealth, onGoToGeneral, identity, brokenLinkNotes = [], onInspectFinding, onDiagnosticAction, collectDiagnostics, renderFindingDetails, localFindings, onPrepareFix, repairNotes = {} }: AssistantProps & {
  vaultId: string | null;
  notes: NoteTitle[];
  onUpgrade?: () => void;
}) {
  const [pane, setPane] = useState<"diagnostics" | "settings" | null>(identity ? null : "diagnostics");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [repairFinding, setRepairFinding] = useState("broken-links");
  const [repairOpen, setRepairOpen] = useState(false);
  const [provider, setProvider] = useState<AssistantProvider | null>(null);
  const ready = identity ? provider !== null : true;
  const [status, setStatus] = useState<HousekeeperStatus | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [locked, setLocked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [docId, setDocId] = useState("");
  const [scan, setScan] = useState<HousekeeperScan | null>(null);
  const [activity, setActivity] = useState<string | null>(null);
  const [activeFinding, setActiveFinding] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [undoId, setUndoId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [review, setReview] = useState<{ fingerprint: string; result: DiagnosticReview } | null>(null);
  const fingerprint = JSON.stringify(diagnostics);
  const repairSection = useRef<HTMLDivElement>(null);
  const alive = useRef(false);
  const inFlight = useRef(false);
  const api = authManager.api;
  useEffect(() => {
    alive.current = true;
    let current = true;
    setLocked(false); setError(null); setStatus(null);
    if (vaultId) void api.housekeeperStatus(vaultId).then(result => {
      if (current) setStatus(result);
    }).catch(e => {
      if (!current) return;
      setLocked(e instanceof ApiError && e.status === 402);
      setError(e instanceof Error ? e.message : "Housekeeper is unavailable.");
    });
    return () => { current = false; alive.current = false; };
  }, [vaultId, api, refresh]);

  async function run(work: () => Promise<void>, label = "Working…") {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true); setActivity(label); setError(null); setNotice(null);
    try { await work(); }
    catch (e) {
      if (alive.current) {
        setError(e instanceof Error ? e.message : "The operation failed. Please retry.");
        if (e instanceof ApiError && [401, 402, 403].includes(e.status)) {
          setScan(null); setUndoId(null); setStatus(null); setReview(null);
          setLocked(e.status === 402);
        }
        if (e instanceof ApiError && e.status === 409) { setScan(null); setUndoId(null); }
      }
    } finally { inFlight.current = false; if (alive.current) { setBusy(false); setActivity(null); setActiveFinding(null); } }
  }
  function showRepair() {
    repairSection.current?.scrollIntoView?.({ behavior: "smooth", block: "start" });
    repairSection.current?.focus({ preventScroll: true });
  }
  async function scanNote(id: string, finding = "broken-links") {
    if (!vaultId) return;
    setRepairFinding(finding); setRepairOpen(true); setDocId(id); setScan(null); setUndoId(null);
    showRepair();
    await run(async () => {
      const result = finding === "broken-links" ? await api.housekeeperSuggest(vaultId, id, 0, provider ?? undefined) : await api.housekeeperRepair(vaultId, id, finding, provider ?? undefined);
      if (alive.current) setScan(result);
    }, "Preparing fix…");
  }
  useEffect(() => { if (repairOpen) showRepair(); }, [repairOpen]);
  const availableNotes = notes.filter(n => /\.md$/i.test(n.path));
  return <section className="housekeeper-panel" aria-label="Baalda Assistant">
    <div className="housekeeper-heading"><h3>Baalda Assistant</h3>{status?.requiresPro !== false && <span className="housekeeper-badge">Pro</span>}</div>
    <p className="housekeeper-intro">Keep your vault tidy. Review every change.</p>
    <div className="housekeeper-announcement"><span className="housekeeper-badge">NEW</span><span>TypeSafe Jev is now available in Baalda.</span></div>
    {identity && <>
      <div className="assistant-tabs" role="tablist" aria-label="AI sections">
        <button role="tab" aria-selected={pane === "diagnostics"} onClick={() => setPane("diagnostics")}>Diagnostics</button>
        <button role="tab" aria-selected={pane === "settings"} onClick={() => setPane("settings")}>Settings</button>
      </div>
      <div hidden={pane !== "settings"}><AssistantProviderSettings identity={identity} onChange={setProvider}
        onReady={hasKey => setPane(current => !hasKey ? "settings" : current ?? "diagnostics")} onSaved={() => setPane("diagnostics")} /></div>
    </>}
    <div hidden={identity !== undefined && pane !== "diagnostics"}>
    {!vaultId ? <div className="housekeeper-callout"><p>Connect this vault to sync and sign in to use Housekeeper.</p>{onGoToGeneral && <button className="secondary" onClick={onGoToGeneral}>Set up sync</button>}</div> : locked ? <div className="housekeeper-callout">
      <p>Housekeeper requires a Pro subscription for this vault.</p>
      <div className="housekeeper-actions">{onUpgrade && <button className="primary" onClick={onUpgrade}>Upgrade vault</button>}
      <button className="secondary" onClick={() => setRefresh(n => n + 1)}>Check access again</button></div>
    </div> : status?.available ? <>
      <div className="housekeeper-card">
        <div className="housekeeper-heading"><h4>Smart diagnostics</h4></div>

        {!ready ? <div className="housekeeper-callout">
          <p>Add an AI provider key to scan this vault. Keys stay in this device's keychain.</p>
          <div className="housekeeper-actions"><button className="primary" onClick={() => setPane("settings")}>Connect a provider</button></div>
        </div> : <div className="housekeeper-actions">
          <button className="primary" disabled={busy || (!diagnostics && !collectDiagnostics)} onClick={() => void run(async () => {
            setReview(null); setRepairOpen(false); setScan(null); setExpanded(null);
            const input = collectDiagnostics ? await collectDiagnostics() : diagnostics!;
            if (!alive.current) return;
            const result = await api.housekeeperDiagnose(vaultId, input, ...(provider ? [provider] : []));
            if (alive.current) setReview({ fingerprint: JSON.stringify(input), result });
          }, "Scanning vault…")}>{busy ? activity : "Scan vault"}</button>
        </div>}
        {ready && !diagnostics && <p className="housekeeper-detail">Collecting vault evidence…</p>}
        {activity && <p className="assistant-progress" role="status"><span className="assistant-spinner" aria-hidden="true" />{activity}</p>}
        {review && review.fingerprint !== fingerprint && <p role="status">Findings changed. Run the review again for current priorities.</p>}
        {review && review.fingerprint === fingerprint && <div aria-live="polite">
          <p className="housekeeper-detail">{review.result.findings.length} {review.result.findings.length === 1 ? "finding" : "findings"} · {review.result.checked} checks</p>
          {!review.result.findings.length && <p>No problems found in the completed checks.</p>}
          <ul className="housekeeper-suggestions">{review.result.findings.map((f, index) => {
            const measured = CHECK_DEFINITIONS.find(check => check.id === f.id)?.severity;
            const severity = measured === "error" || f.id.startsWith("issue-") ? "error" : measured === "info" || f.id === "vault-storage" || f.id === "vault-local" ? "info" : "warning";
            return <li key={f.id} className={`assistant-finding severity-${severity}`}>
            <div className="assistant-finding-marker"><span>{index + 1}</span><span className="assistant-severity-icon" aria-label={severity}>{severity === "error" ? "!" : severity === "warning" ? "△" : "i"}</span></div>
            <div className="assistant-finding-content">
            <div className="assistant-finding-heading"><strong>{f.title}</strong><span className="housekeeper-badge">{f.count}</span><span className={`housekeeper-priority housekeeper-priority-${f.priority}`}>{f.label}</span></div>
            {f.action && f.action !== "inspect" && <p className="housekeeper-detail">{f.actionReason}</p>}
            {["illegal-names", "case-collisions", "long-paths", "oversized-notes", "unreadable-notes", "heavy-history", "trash", "issue-no-access", "issue-no-write-access", "vault-no-access", "issue-left-behind", "remote-files"].includes(f.id) && onPrepareFix && <button className="primary" disabled={busy} onClick={() => {
              setActiveFinding(f.id);
              void run(async () => { const access = await api.housekeeperStatus(vaultId); if (!access.available || !alive.current) return; await onPrepareFix(f.id); }, "Preparing action…");
            }}>{busy && activeFinding === f.id ? "Preparing…" : "Prepare fix"}</button>}
            {["empty-notes", "bad-frontmatter", "duplicate-titles"].includes(f.id) && <button className="primary" disabled={busy || !ready} onClick={() => setExpanded(f.id)}>Prepare fixes</button>}
            {f.id === "broken-links" && brokenLinkNotes.length > 0 && <button className="primary" disabled={busy || !ready} onClick={() => {
              const first = brokenLinkNotes.map(item => availableNotes.find(note => note.id === item.docId || note.path === item.path)).find(Boolean);
              setExpanded(f.id); setActiveFinding(f.id);
              if (first) void scanNote(first.id);
            }}>{busy && activeFinding === f.id ? "Investigating…" : "Investigate & prepare fix"}</button>}
            {onDiagnosticAction && ["rebuild-index", "sync-now", "retry-files"].includes(f.action ?? "") && <button className="primary" disabled={busy} onClick={() => void run(async () => {
              const access = await api.housekeeperStatus(vaultId);
              if (!access.available) throw new Error("Assistant is currently unavailable.");
              if (!alive.current) return;
              const result = await onDiagnosticAction(f.id, f.action!);
              if (alive.current) { setReview(null); setNotice(result); }
            })}>{f.action === "rebuild-index" ? "Rebuild index" : f.action === "retry-files" ? "Retry affected files" : "Retry sync"}</button>}
            {f.action === "configure-sync" && onGoToGeneral && <button className="primary" onClick={onGoToGeneral}>Set up sync</button>}
            <button className="secondary" disabled={busy} onClick={() => setExpanded(expanded === f.id ? null : f.id)}>
              {expanded === f.id ? "Close details" : f.action === "review-links" ? "Review link fixes" : f.action === "review-storage" ? "Review storage" : f.action === "review-renames" ? "Review paths" : f.action === "review-empty" ? "Review empty files" : f.action === "review-properties" ? "Review properties" : f.action === "review-access" ? "Review access" : f.action === "review-recovery" ? "Review recovery" : "Inspect finding"}
            </button>
            {expanded === f.id && <div className="assistant-finding-details">
              {["empty-notes", "bad-frontmatter", "duplicate-titles"].includes(f.id) && (repairNotes[f.id] ?? []).map(item => {
                const note = availableNotes.find(n => n.id === item.docId || n.path === item.path);
                return <div className="assistant-affected-note" key={item.path}><strong>{item.path}</strong>
                  <button className="primary" disabled={busy || !ready || !note} onClick={() => note && void scanNote(note.id, f.id)}>{f.id === "empty-notes" ? "Find recoverable version" : "Prepare fix"}</button></div>;
              })}
              {f.action === "review-links" && brokenLinkNotes.map(item => {
                const note = availableNotes.find(n => n.id === item.docId || n.path === item.path);
                return <div className="assistant-affected-note" key={item.path}>
                  <div><strong>{item.path}</strong>{item.detail && <span className="housekeeper-detail">{item.detail}</span>}</div>
                  {note && <button className="primary" disabled={busy || !ready} onClick={() => void scanNote(note.id)}>Find a fix</button>}
                </div>;
              })}
              {renderFindingDetails ? renderFindingDetails(f.id) : <button className="secondary" onClick={() => onInspectFinding ? onInspectFinding(f.id) : onOpenHealth?.()}>Open details</button>}
            </div>}
            </div>
          </li>; })}</ul>
        </div>}
      </div>
      {repairOpen && <div className="housekeeper-card" ref={repairSection} tabIndex={-1}>
      <div className="housekeeper-heading"><h4>Suggested changes</h4><button className="secondary" disabled={busy} onClick={() => setRepairOpen(false)}>Close</button></div>
      <p className="housekeeper-detail">{availableNotes.find(note => note.id === docId)?.path}</p>
      <p className="housekeeper-detail">{repairFinding === "broken-links" ? "Last synced version · Up to 4 links per scan." : "Review the proposed edit to the last synced version."}</p>
      <button className="secondary" disabled={busy || !ready || !docId} onClick={() => void run(async () => {
        const result = repairFinding === "broken-links" ? await api.housekeeperSuggest(vaultId, docId, 0, provider ?? undefined) : await api.housekeeperRepair(vaultId, docId, repairFinding, provider ?? undefined);
        if (alive.current) { setScan(result); setUndoId(null); }
      })}>{busy ? "Working…" : "Find suggested fixes"}</button>
      {scan && <div aria-live="polite">
        <p>{scan.suggestions.length ? `${scan.suggestions.length} suggested fixes. Apply one, then scan again for the updated note.` : repairFinding !== "broken-links" ? "No confident repair available. The note may have changed, or no suitable saved version or unambiguous repair exists." : scan.considered === 0 ? "No supported unresolved links found in this synced version. Inspect the finding for local-only changes, embeds or heading links." : "No confident replacement found. The target may not exist yet; inspect the finding or choose another note."}
          {scan.remaining > 0 && ` ${scan.remaining} additional links were outside this scan.`}</p>
        {scan.remaining > 0 && <button className="secondary" disabled={busy || !ready} onClick={() => void run(async () => {
          const result = await api.housekeeperSuggest(vaultId, docId, scan.nextOffset, provider ?? undefined);
          if (alive.current) setScan(result);
        })}>Check next links</button>}
        <ul className="housekeeper-suggestions">{scan.suggestions.map(s => <li key={s.id}>
          <div className="housekeeper-diff"><del>{s.before}</del><ins>{s.after}</ins></div>
          <p className="housekeeper-detail">{s.label ?? `Suggested target: ${s.targetPath}`}</p>
          <div className="housekeeper-actions">
            <button className="primary" disabled={busy} onClick={() => void run(async () => {
              const result = await api.housekeeperEdit(vaultId, "apply", s.id);
              if (alive.current) {
                setScan(null); setReview(null); setUndoId(result.undoId);
                setNotice("Fix applied. Undo is available for 15 minutes if the note stays unchanged.");
                if (collectDiagnostics) {
                  setActivity("Verifying…");
                  try { await collectDiagnostics(); }
                  catch { if (alive.current) setNotice("Fix applied. Local checks could not refresh; scan again to verify."); }
                }
              }
            }, "Applying fix…")}>{busy ? "Applying…" : "Apply fix"}</button>
            <button className="secondary" disabled={busy} onClick={() => setScan(previous => previous ? { ...previous, suggestions: previous.suggestions.filter(x => x.id !== s.id) } : null)}>Dismiss</button>
          </div>
        </li>)}</ul>
      </div>}
      </div>}
    </> : <p>{status ? "Housekeeper is not configured on this server. Ask the server administrator to configure OpenRouter." : error ? "Housekeeper could not connect." : "Checking Pro access…"}</p>}
    {!status?.available && localFindings}
    {notice && <p role="status">{notice}</p>}
    {undoId && vaultId && <button className="secondary" disabled={busy} onClick={() => void run(async () => {
      await api.housekeeperEdit(vaultId, "undo", undoId);
      if (alive.current) { setUndoId(null); setNotice("Housekeeper change undone."); }
    }, "Undoing fix…")}>{busy ? "Undoing…" : "Undo fix"}</button>}
    {vaultId && !locked && !status?.available && <button className="secondary" disabled={busy} onClick={() => setRefresh(n => n + 1)}>Check access again</button>}
    {error && !locked && <p role="alert">{error}</p>}
    </div>
  </section>;
}
