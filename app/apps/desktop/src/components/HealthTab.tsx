/* Vault Settings → Health. The page that answers, in this order: is my work
   safe, where exactly does the pipeline stop, WHY, what do I do about it, what
   did Baalda verify about these files, and what is in this vault.

   Split in two on purpose. `HealthTab` is the container: it owns the hook, the
   note list the inspector completes against, and the upgrade dialog.
   `HealthView` is pure — hand it a `VaultHealthSnapshot` and it renders, which
   is what lets a fixture drive it without a vault, a server or a Tauri host
   underneath.

   The sections live in `HealthIssues`, `HealthChecks`, `HealthInspector`,
   `HealthTimeline` and `HealthStats`; this file owns the layout, the verdict
   card, the pipeline strip, the sync bar and every destructive confirm. The
   confirms live HERE rather than inside the row that raised them, so a row
   unmounting mid-dialog — a refresh landing, a filter changing — cannot take
   the dialog with it.

   The whole page has to survive a vault that has never synced: `report.counts`
   is null, the last two pipeline stages are `off`, and the analytics below are
   still the point. Nothing here may assume a server. */
import { useEffect, useState } from "react";
import { useStore } from "../store";
import type { NoteTitle } from "../lib/ipc";
import type {
  HealthInventory,
  VaultHealthSnapshot,
} from "../lib/health/types";
import { useVaultHealth } from "../lib/health/useVaultHealth";
import { formatBytes, verdictLabel, verdictTone } from "../lib/health/format";
import { toast } from "../lib/toast";
import { AsyncButton } from "./AsyncButton";
import { ConfirmDialog } from "./ConfirmDialog";
import { UpgradeDialog } from "./UpgradeDialog";
import { MissingFileActions } from "./MissingFileActions";
import { LocalOnlyFileActions } from "./LocalOnlyFileActions";
import { HealthIssues } from "./HealthIssues";
import { HealthChecks, type CheckFocus } from "./HealthChecks";
import { useHealthIgnores } from "../lib/health/useHealthIgnores";
import { HealthInspector } from "./HealthInspector";
import { HealthTimeline } from "./HealthTimeline";
import { HealthActivity, HealthLargest, HealthStats } from "./HealthStats";
import { AttachmentSyncNotice } from "./AttachmentSyncNotice";
import {
  Glyph,
  PathText,
  Section,
  type CheckRun,
  type ConfirmState,
  type HealthHandlers,
} from "./HealthShared";
import type { CheckActionPlan } from "../lib/health/checkActions";
import type { VaultCheckId } from "../lib/health/types";
import "./health.css";

export interface HealthTabProps {
  /** Open the plan dialog. Omitted ⇒ this tab raises its own, like Billing. */
  onOpenUpgrade?: () => void;
  onRequestSignIn?: () => void;
  /** Jump to General, where sync is turned on. */
  onGoToGeneral?: () => void;
  /** Close settings — opening a note has to get the dialog out of the way. */
  onClose?: () => void;
  onOpenDiagnostics?: (id?: VaultCheckId) => void;
}

export function HealthTab({
  onOpenUpgrade,
  onRequestSignIn,
  onGoToGeneral,
  onClose,
  onOpenDiagnostics,
}: HealthTabProps) {
  // Same shape as the Billing and Members tabs: the dialog is rendered by the
  // tab that needs it rather than hoisted into VaultSettingsDialog, so the
  // upgrade path is self-contained wherever it is raised from. A caller may
  // still pass its own opener.
  const [upgradeOpen, setUpgradeOpen] = useState(false);
  const snapshot = useVaultHealth({
    onOpenUpgrade: onOpenUpgrade ?? (() => setUpgradeOpen(true)),
    onRequestSignIn,
  });
  // The one store read on this page, and it stays in the CONTAINER so
  // `HealthView` keeps rendering from nothing but its props — a fixture, in the
  // tests.
  const notes = useStore((s) => s.titles);
  const vaultPath = useStore((s) => s.vault?.path ?? null);
  const standaloneFileSyncBlocked = useStore((s) => s.attachmentSyncBlocked);
  const showAttachmentUpgrade = useStore((s) => s.billingConfig?.enabled === true);

  return (
    <>
      <AttachmentSyncNotice
        surface="health"
        detected={snapshot.inventory.local.files > 0 || snapshot.inventory.serverOnlyFiles.length > 0}
      />
      <HealthView
        key={vaultPath}
        mode="overview"
        onOpenDiagnostics={onOpenDiagnostics}
        snapshot={snapshot}
        notes={notes}
        vaultPath={vaultPath}
        standaloneFileSyncBlocked={standaloneFileSyncBlocked}
        showAttachmentUpgrade={showAttachmentUpgrade}
        onGoToGeneral={onGoToGeneral}
        onClose={onClose}
      />
      {upgradeOpen && <UpgradeDialog onClose={() => setUpgradeOpen(false)} />}
    </>
  );
}

// ── The page ──────────────────────────────────────────────────────────────────

export function HealthView({
  mode = "all",
  findingId,
  requestedCheck,
  onOpenDiagnostics,
  snapshot,
  notes = [],
  vaultPath = null,
  standaloneFileSyncBlocked = false,
  showAttachmentUpgrade = false,
  onGoToGeneral,
  onClose,
}: {
  mode?: "all" | "overview" | "diagnostics" | "finding";
  findingId?: string;
  requestedCheck?: CheckFocus | null;
  onOpenDiagnostics?: (id?: VaultCheckId) => void;
  snapshot: VaultHealthSnapshot;
  notes?: NoteTitle[];
  /** Keys the per-vault ignore list; null ⇒ nothing is remembered. */
  vaultPath?: string | null;
  /** The Remote Vault explicitly refused standalone binary sync at the plan boundary. */
  standaloneFileSyncBlocked?: boolean;
  /** Whether this server exposes a checkout path for that plan boundary. */
  showAttachmentUpgrade?: boolean;
  onGoToGeneral?: () => void;
  onClose?: () => void;
}) {
  const { report, stats, checks, statsError, loading, log, refresh, actions } = snapshot;
  // Relative times go stale while the dialog sits open; a slow tick is enough
  // and costs one render a minute.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);

  const [confirming, setConfirming] = useState<ConfirmState | null>(null);
  const [focusIssue, setFocusIssue] = useState<string | null>(null);
  const [focusCheck, setFocusCheck] = useState<CheckFocus | null>(null);
  const ignores = useHealthIgnores(vaultPath);
  useEffect(() => {
    if (requestedCheck) { ignores.restoreCheck(requestedCheck.id); setFocusCheck(requestedCheck); }
  }, [requestedCheck]);
  const [inspectRequest, setInspectRequest] = useState<{ path: string; n: number } | null>(
    null,
  );
  // A check's heal / bulk run lives HERE, beside the confirms and for the same
  // reason: the row that started it collapses the moment the checks re-run, and
  // a result that vanished with it would leave the reader guessing whether the
  // twelve deletes landed.
  const [checkRuns, setCheckRuns] = useState<Partial<Record<VaultCheckId, CheckRun>>>({});

  const startCheckAction = async (plan: CheckActionPlan): Promise<void> => {
    setCheckRuns((r) => ({
      ...r,
      [plan.checkId]: {
        plan,
        running: true,
        done: 0,
        total: plan.wholeVault ? 0 : plan.targets.length,
        outcome: null,
      },
    }));
    const outcome = await actions.applyCheckAction(plan, (done, total) => {
      setCheckRuns((r) => {
        const cur = r[plan.checkId];
        if (!cur?.running) return r;
        return { ...r, [plan.checkId]: { ...cur, done, total } };
      });
    });
    setCheckRuns((r) => ({
      ...r,
      [plan.checkId]: {
        plan,
        running: false,
        done: outcome.done,
        total: outcome.total,
        outcome,
      },
    }));
    // The census and the checks both describe a vault this just changed.
    if (!outcome.cancelled) refresh();
  };

  const handlers: HealthHandlers = {
    actions,
    now,
    confirm: setConfirming,
    openNote(path) {
      actions.openNote(path);
      // The note is behind the settings card; leaving it open would look like
      // nothing happened.
      onClose?.();
    },
    checkRuns,
    runCheck(plan) {
      // A plan with a confirm never runs until the dialog says so; everything
      // else is a button press away, because it is either reversible or
      // additive.
      if (plan.confirm) setConfirming({ kind: "check-action", plan });
      else void startCheckAction(plan);
    },
    async reclaim() {
      const { docsRemoved, bytesReclaimed } = await actions.reclaimOrphans();
      toast(
        docsRemoved === 0
          ? "Nothing to reclaim"
          : `Reclaimed ${formatBytes(bytesReclaimed)} from ${docsRemoved.toLocaleString()} ` +
              `orphan ${docsRemoved === 1 ? "doc" : "docs"}`,
      );
    },
  };

  if (mode === "finding" && findingId) {
    const check = checks?.results.find(c => c.id === findingId);
    const issues = findingId.startsWith("issue-") ? report.issues.filter(i => i.kind === findingId.slice(6)) : report.issues;
    return <div className="health-tab assistant-finding-tools">
      {check ? <HealthChecks checks={checks} loading={loading} handlers={handlers} onlyIds={[findingId]} focus={{ id: check.id, n: 1 }} /> :
        findingId === "vault-storage" ? stats && <HealthLargest stats={stats} handlers={handlers} /> :
        ["remote-files", "local-files"].includes(findingId) ? <InventoryComparison inventory={snapshot.inventory} report={report} handlers={handlers} standaloneFileSyncBlocked={standaloneFileSyncBlocked} showAttachmentUpgrade={showAttachmentUpgrade} /> :
        issues.length ? <HealthIssues issues={issues} handlers={handlers} syncEnabled={report.counts != null} focusKey={issues.length === 1 ? issues[0].key : undefined} /> :
        <><p>{report.detail}</p><HealthTimeline log={log} now={now} onInspect={path => setInspectRequest({ path, n: Date.now() })} /></>}
      {inspectRequest && <HealthInspector notes={notes} handlers={handlers} request={inspectRequest} onShowIssue={setFocusIssue} />}
      <Confirms confirming={confirming} onDone={() => setConfirming(null)} actions={actions} onRunCheckAction={startCheckAction} />
    </div>;
  }

  return (
    <div className="health-tab">
      {mode !== "diagnostics" && <>
      <HealthStats
        stats={stats}
        syncing={report.verdict === "syncing" || report.verdict === "connecting"}
        noteCount={
          snapshot.inventory.localReady
            ? snapshot.inventory.local.notes + snapshot.inventory.local.files
            : null
        }
        folderCount={
          snapshot.inventory.localReady ? snapshot.inventory.local.folders : null
        }
        loading={loading}
        statsError={statsError}
        handlers={handlers}
        onFlag={(id) => {
          if (mode === "overview" && onOpenDiagnostics) { onOpenDiagnostics(id); return; }
          ignores.restoreCheck(id);
          setFocusCheck((f) => ({ id, n: (f?.n ?? 0) + 1 }));
        }}
      />

      <VerdictCard
        snapshot={snapshot}
        standaloneFileSyncBlocked={standaloneFileSyncBlocked}
        onRefresh={refresh}
        loading={loading}
        onGoToGeneral={onGoToGeneral}
      />


      <InventoryComparison
        inventory={snapshot.inventory}
        report={report}
        handlers={handlers}
        standaloneFileSyncBlocked={standaloneFileSyncBlocked}
        showAttachmentUpgrade={showAttachmentUpgrade}
      />


      <Section
        title="Needs attention"
        description="Open a row for the full reasoning."
      >
        {report.issues.length === 0 && snapshot.inventory.serverOnlyFiles.length > 0 ? (
          <p>Files are missing from this computer. Review the differences above to download them or see what is blocking them.</p>
        ) : <HealthIssues
          issues={report.issues}
          handlers={handlers}
          syncEnabled={report.counts != null}
          focusKey={focusIssue}
          dismissed={ignores.issues}
          onDismiss={ignores.dismissIssue}
          onRestore={ignores.restoreIssue}
        />}
      </Section>

      </>}
      {mode !== "overview" && <details className="health-advanced" open={mode === "diagnostics" ? true : undefined}>
        <summary>
          <span>
            <strong>{mode === "diagnostics" ? "Checks & repair tools" : "Advanced diagnostics"}</strong>
            <small>Inspect one note, verify local files, and review sync history</small>
          </span>
          <span className="health-advanced-summary-meta">
            <AdvancedSummary snapshot={snapshot} />
            <Glyph name="chevron" />
          </span>
        </summary>
        <div className="health-advanced-body">
          <DiagnosticsToolbar snapshot={snapshot} />
          {mode === "diagnostics" && report.issues.length > 0 && <Section title="Sync findings">
            <HealthIssues issues={report.issues} handlers={handlers} syncEnabled={report.counts != null} focusKey={focusIssue}
              dismissed={ignores.issues} onDismiss={ignores.dismissIssue} onRestore={ignores.restoreIssue} />
          </Section>}

          <div className="health-diagnostic-card health-diagnostic-inspector">
            <DiagnosticHeading
              eyebrow="Single note"
              title="Inspect a note"
              description="Search by name or path to see its local and Remote Vault state."
            />
            <HealthInspector
              notes={notes}
              handlers={handlers}
              request={inspectRequest}
              onShowIssue={setFocusIssue}
            />
          </div>

          <div className="health-diagnostic-card health-diagnostic-checks">
            <DiagnosticHeading
              eyebrow="Vault files"
              title="Integrity checks"
              description="Review what Baalda verified on this computer and fix individual findings."
            />
            <HealthChecks
              checks={checks}
              loading={loading}
              handlers={handlers}
              ignored={ignores.checks}
              onIgnore={ignores.ignoreCheck}
              onRestore={ignores.restoreCheck}
              focus={focusCheck}
            />
          </div>

          {stats && (
            <div className="health-diagnostic-grid">
              <div className="health-diagnostic-card">
                <DiagnosticHeading
                  eyebrow="Local activity"
                  title="Editing activity"
                  description="See when notes in this vault changed."
                />
                <HealthActivity activity={stats.activity} />
              </div>
              <div className="health-diagnostic-card">
                <DiagnosticHeading
                  eyebrow="Local storage"
                  title="Largest items"
                  description="Find files and history using the most space."
                />
                <HealthLargest stats={stats} handlers={handlers} />
              </div>
            </div>
          )}

          <div className="health-diagnostic-card">
            <DiagnosticHeading
              eyebrow="This app session"
              title="Recent sync activity"
              description="Review connection, upload, and retry events since Baalda launched. Select a note path to inspect it."
            />
            <HealthTimeline
              log={log}
              now={now}
              onInspect={(path) =>
                setInspectRequest((r) => ({ path, n: (r?.n ?? 0) + 1 }))
              }
            />
          </div>
        </div>
      </details>}

      <Confirms
        confirming={confirming}
        onDone={() => setConfirming(null)}
        actions={actions}
        onRunCheckAction={startCheckAction}
      />
    </div>
  );
}

function AdvancedSummary({ snapshot }: { snapshot: VaultHealthSnapshot }) {
  const reported = snapshot.checks?.results.length ?? 0;
  const findings =
    snapshot.checks?.results.reduce((sum, result) => sum + result.count, 0) ?? 0;

  return (
    <>
      {snapshot.loading ? (
        <span className="health-advanced-summary-pill">Checking…</span>
      ) : snapshot.checks ? (
        <span
          className="health-advanced-summary-pill"
          data-tone={findings > 0 ? "warn" : "good"}
        >
          {findings > 0
            ? `${findings.toLocaleString()} ${findings === 1 ? "finding" : "findings"}`
            : `${reported.toLocaleString()} checks passed`}
        </span>
      ) : (
        <span className="health-advanced-summary-pill">Checks unavailable</span>
      )}
    </>
  );
}

function DiagnosticsToolbar({ snapshot }: { snapshot: VaultHealthSnapshot }) {
  const [feedback, setFeedback] = useState<{
    tone: "good" | "bad";
    message: string;
  } | null>(null);
  const { actions, loading, refresh, report, statsError } = snapshot;
  const syncAvailable =
    report.counts != null && report.verdict !== "signed-out" && report.verdict !== "no-access";

  const run = async (task: () => Promise<unknown>, success: string) => {
    setFeedback(null);
    try {
      await task();
      setFeedback({ tone: "good", message: success });
    } catch (error) {
      setFeedback({
        tone: "bad",
        message: error instanceof Error ? error.message : "That action could not be completed.",
      });
      throw error;
    }
  };

  return (
    <div className="health-diagnostics-toolbar">
      <div className="health-diagnostics-toolbar-copy">
        <span className="health-kicker">Diagnostic tools</span>
        <h3>Run a fresh check or share a report</h3>
        <p>
          Checks read this vault without changing your notes. Sync retry uses the normal safe
          Remote Vault reconciliation flow.
        </p>
      </div>
      <div className="health-diagnostics-actions">
        <button
          type="button"
          className="primary sm"
          disabled={loading}
          aria-busy={loading || undefined}
          onClick={() => {
            setFeedback(null);
            refresh();
          }}
        >
          {loading ? "Running checks…" : "Run all checks"}
        </button>
        <AsyncButton
          className="ghost-pill sm"
          disabled={!syncAvailable}
          onClick={() =>
            run(async () => {
              await actions.syncNow();
              refresh();
            }, "Sync check started. Results will update as notes are confirmed.")
          }
        >
          Retry sync
        </AsyncButton>
        <AsyncButton
          className="ghost-pill sm"
          confirm
          onClick={() => run(() => actions.copyDiagnostics(), "Diagnostic report copied.")}
        >
          Copy report
        </AsyncButton>
      </div>
      {!syncAvailable && (
        <p className="health-diagnostics-hint">
          {report.verdict === "local"
            ? "Sync retry is unavailable because this vault is local only."
            : report.verdict === "signed-out"
              ? "Sign in before retrying sync."
              : report.verdict === "no-access"
                ? "Sync retry is unavailable until access is restored."
                : "Sync retry is not available yet."}
        </p>
      )}
      {feedback && (
        <p className="health-diagnostics-feedback" data-tone={feedback.tone} aria-live="polite">
          <Glyph name={feedback.tone === "good" ? "check" : "alert"} size={14} />
          {feedback.message}
        </p>
      )}
      {!feedback && statsError && (
        <p className="health-diagnostics-feedback" data-tone="bad" role="alert">
          <Glyph name="alert" size={14} />
          Checks could not finish: {statsError}
        </p>
      )}
    </div>
  );
}

function DiagnosticHeading({
  eyebrow,
  title,
  description,
}: {
  eyebrow: string;
  title: string;
  description: string;
}) {
  return (
    <div className="health-diagnostic-heading">
      <span className="health-kicker">{eyebrow}</span>
      <h3>{title}</h3>
      <p>{description}</p>
    </div>
  );
}

// ── Device and server inventory ─────────────────────────────────────────────

function InventoryComparison({
  inventory,
  report,
  handlers,
  standaloneFileSyncBlocked,
  showAttachmentUpgrade,
}: {
  inventory: HealthInventory;
  report: VaultHealthSnapshot["report"];
  handlers: HealthHandlers;
  standaloneFileSyncBlocked: boolean;
  showAttachmentUpgrade: boolean;
}) {
  const [open, setOpen] = useState(false);
  const differences =
    inventory.deviceOnlyNotes.length +
    inventory.serverOnlyNotes.length +
    inventory.deviceOnlyFolders.length +
    inventory.serverOnlyFolders.length +
    inventory.deviceOnlyFiles.length +
    inventory.serverOnlyFiles.length;
  const localOnlyFormatNotes = standaloneFileSyncBlocked
    ? inventory.deviceOnlyFiles.length
    : 0;
  const comparisonPending = !inventory.localReady;
  const unexpectedDifferences = differences - localOnlyFormatNotes;
  const countsDiffer =
    inventory.localReady &&
    inventory.server != null &&
    (inventory.local.notes !== inventory.server.notes ||
      inventory.local.folders !== inventory.server.folders ||
      inventory.local.files !== inventory.server.files + localOnlyFormatNotes);
  const stored = inventory.serverStored;
  const restrictedNotes = stored && inventory.server
    ? Math.max(0, stored.notes + stored.files - inventory.server.notes - inventory.server.files) : 0;
  const comparisonWarn = unexpectedDifferences > 0 || countsDiffer;
  const comparisonStale = inventory.serverState === "last-known";
  const comparisonUpdating = inventory.serverState === "updating" ||
    report.verdict === "syncing" || report.verdict === "connecting";
  const differenceSummaries = [
    inventory.deviceOnlyNotes.length > 0
      ? `${inventory.deviceOnlyNotes.length.toLocaleString()} text ${inventory.deviceOnlyNotes.length === 1 ? "note is" : "notes are"} missing from the Remote Vault`
      : null,
    inventory.serverOnlyNotes.length > 0
      ? `${inventory.serverOnlyNotes.length.toLocaleString()} text ${inventory.serverOnlyNotes.length === 1 ? "note is" : "notes are"} missing from this computer`
      : null,
    inventory.deviceOnlyFolders.length > 0
      ? `${inventory.deviceOnlyFolders.length.toLocaleString()} ${inventory.deviceOnlyFolders.length === 1 ? "folder is" : "folders are"} missing from the Remote Vault`
      : null,
    inventory.serverOnlyFolders.length > 0
      ? `${inventory.serverOnlyFolders.length.toLocaleString()} ${inventory.serverOnlyFolders.length === 1 ? "folder is" : "folders are"} missing from this computer`
      : null,
    !standaloneFileSyncBlocked && inventory.deviceOnlyFiles.length > 0
      ? `${inventory.deviceOnlyFiles.length.toLocaleString()} ${inventory.deviceOnlyFiles.length === 1 ? "note in another format is" : "notes in other formats are"} missing from the Remote Vault`
      : null,
    inventory.serverOnlyFiles.length > 0
      ? `${inventory.serverOnlyFiles.length.toLocaleString()} ${inventory.serverOnlyFiles.length === 1 ? "note in another format is" : "notes in other formats are"} missing from this computer`
      : null,
  ].filter((summary): summary is string => summary != null);
  const confirmed = report.counts?.synced ?? 0;
  const totalTextNotes = report.counts?.total ?? inventory.local.notes;
  const stateLabel =
    comparisonUpdating
      ? "Updating"
      : inventory.serverState === "current"
      ? "Current"
      : inventory.serverState === "last-known"
        ? "Last known"
        : "Unavailable";
  const issueWhy = new Map(
    report.issues
      .filter((issue) => issue.path != null)
      .map((issue) => [issue.path!.toLowerCase(), issue.why] as const),
  );

  return (
    <section className="health-inventory" aria-labelledby="health-inventory-title">
      <div className="health-inventory-head">
        <div>
          <span className="health-kicker">Your copies</span>
          <h3 id="health-inventory-title">This computer and the Remote Vault</h3>
          <p>
            {stored ? "Server totals include private notes." : "Remote counts include only notes you can access."}
          </p>
        </div>
        {inventory.server && (
          <span className="health-freshness" data-state={inventory.serverState}>
            {stateLabel} Remote Vault view
          </span>
        )}
      </div>

      <div className="health-inventory-grid">
        <InventoryPlace
          icon="disk"
          title="This computer"
          subtitle="Stored locally"
          counts={inventory.local}
          countsReady={inventory.localReady}
        />
        <div className="health-inventory-bridge" aria-hidden="true">
          <span className="health-inventory-line" />
          <Glyph
            name={comparisonUpdating ? "info" : comparisonWarn ? "alert" : comparisonStale || comparisonPending ? "info" : "check"}
            size={16}
          />
          <span className="health-inventory-line" />
        </div>
        {inventory.server ? (
          <InventoryPlace
            icon="database"
            title="Remote Vault"
            subtitle={stored ? "Stored on server" : "Accessible to you"}
            counts={stored ?? inventory.server}
          />
        ) : (
          <div className="health-place is-unavailable">
            <span className="health-place-icon"><Glyph name="database" size={18} /></span>
            <div>
              <strong>Remote Vault</strong>
              <p>
                {report.verdict === "local"
                  ? "Sync is off for this vault."
                  : "No Remote Vault inventory has been received yet."}
              </p>
            </div>
          </div>
        )}
      </div>

      <div
        className="health-inventory-result"
        data-tone={
          !inventory.server || comparisonUpdating
              ? "muted"
            : comparisonWarn
              ? "warn"
              : localOnlyFormatNotes > 0 || comparisonStale || comparisonPending
                ? "muted"
                : "good"
        }
      >
        <div className="health-inventory-result-icon" aria-hidden="true">
          <Glyph
            name={
              comparisonUpdating
                ? "info"
                : !inventory.server
                ? "database"
                : comparisonWarn
                  ? "alert"
                  : comparisonStale || comparisonPending || restrictedNotes > 0
                    ? "info"
                    : "check"
            }
            size={16}
          />
        </div>
        <div className="health-inventory-result-copy">
          <strong>
            {comparisonUpdating
              ? "Sync is still updating your local copy"
              : !inventory.server
              ? "A Remote Vault comparison is not available"
              : comparisonPending
                ? "Still counting notes on this computer"
                : differenceSummaries.length > 0
                ? `${differenceSummaries.join(" · ")}${comparisonStale ? " (based on the last known Remote Vault view)" : ""}`
                : countsDiffer
                  ? "The latest note and folder counts do not match yet"
                  : localOnlyFormatNotes > 0
                    ? `${localOnlyFormatNotes.toLocaleString()} ${localOnlyFormatNotes === 1 ? "note in another format stays" : "notes in other formats stay"} on this computer`
                  : comparisonStale
                    ? "The current Remote Vault contents cannot be confirmed"
                  : restrictedNotes > 0
                    ? `${restrictedNotes.toLocaleString()} notes are private or restricted`
                    : "Notes and folders match"}
          </strong>
          <p>
            {comparisonUpdating
              ? "Counts are provisional until sync finishes."
              : inventory.server
              ? comparisonPending
                ? "The comparison will appear when the supported vault file list is ready."
                : standaloneFileSyncBlocked && inventory.serverOnlyFiles.length > 0
                ? "This server requires Pro to download files, including previously uploaded files. Review differences for available actions."
                : localOnlyFormatNotes > 0
                ? comparisonStale
                  ? "Syncing these file types requires Pro. The Remote Vault view is last known and may be out of date."
                  : "Syncing these file types requires Pro. They remain available to preview locally."
                : comparisonStale
                  ? "The Remote Vault is unavailable, so this last-known comparison may be out of date."
                : restrictedNotes > 0
                  ? `${restrictedNotes.toLocaleString()} private or restricted notes remain on the server.`
                  : `${confirmed.toLocaleString()} of ${totalTextNotes.toLocaleString()} text notes have confirmed content on the Remote Vault.`
              : "Your local files remain available on this computer."}
          </p>
        </div>
        {!comparisonUpdating && inventory.server && (differences > 0 || countsDiffer) && (
          <div className="health-inventory-actions">
            {differences > 0 && (
              <button type="button" className="ghost-pill sm" onClick={() => setOpen((v) => !v)}>
                {open ? "Hide differences" : "Review differences"}
              </button>
            )}
            {comparisonWarn && (
              <AsyncButton className="primary sm" onClick={() => handlers.actions.syncNow()}>
                Check again
              </AsyncButton>
            )}

          </div>
        )}
      </div>

      {!comparisonUpdating && inventory.server && differences > 0 && (
        <div className="health-difference-breakdown" aria-label="Difference breakdown">
          <DifferenceSide
            title={
              comparisonStale
                ? "Missing from the Remote Vault (last known view)"
                : "Missing from the Remote Vault"
            }
            textNotes={inventory.deviceOnlyNotes.length}
            otherFormats={inventory.deviceOnlyFiles.length}
            folders={inventory.deviceOnlyFolders.length}
            note={
              localOnlyFormatNotes > 0
                ? showAttachmentUpgrade
                  ? "Other-format notes stay local on this plan. Preview them here or upgrade to sync them."
                  : "Other-format notes stay local on this plan and remain available to preview here."
                : unexpectedDifferences > 0
                  ? "Check again to retry anything that has not synced yet."
                  : undefined
            }
          />
          <DifferenceSide
            title={
              comparisonStale
                ? "Missing from this computer (last known view)"
                : "Missing from this computer"
            }
            textNotes={inventory.serverOnlyNotes.length}
            otherFormats={inventory.serverOnlyFiles.length}
            folders={inventory.serverOnlyFolders.length}
            note={
              inventory.serverOnlyNotes.length +
                inventory.serverOnlyFiles.length +
                inventory.serverOnlyFolders.length >
              0
                ? standaloneFileSyncBlocked && inventory.serverOnlyFiles.length > 0
                  ? "File downloads are blocked by this vault’s Pro requirement. Review differences for options."
                  : "Review differences to download missing files. Check again refreshes text notes and folders."
                : undefined
            }
          />
        </div>
      )}

      {!comparisonUpdating && open && differences > 0 && (
        <div className="health-differences">
          <DifferenceList
            title="Text notes missing from the Remote Vault"
            description="These notes have no matching Remote Vault path yet. Open one to review it, or check again to retry sync."
            paths={inventory.deviceOnlyNotes}
            details={issueWhy}
            actionLabel="Open"
            onAction={handlers.openNote}
          />
          <DifferenceList
            title="Folders missing from the Remote Vault"
            description="These folders have no matching Remote Vault path yet. Check again to retry sync."
            paths={inventory.deviceOnlyFolders}
            actionLabel="Show"
            onAction={(path) => void handlers.actions.reveal(path)}
          />
          {inventory.deviceOnlyFiles.length > 0 && <LocalOnlyFileActions
            paths={inventory.deviceOnlyFiles}
            actions={handlers.actions}
            blocked={standaloneFileSyncBlocked}
            onShow={(path) => void handlers.actions.reveal(path)}
          />}
          <DifferenceList
            title="Text notes missing from this computer"
            description="The Remote Vault knows these paths but this computer has no matching note. Check again to download anything you can access."
            paths={inventory.serverOnlyNotes}
            details={issueWhy}
          />
          <DifferenceList
            title="Folders missing from this computer"
            description="The Remote Vault knows these folders but this computer has no matching folders. Check again to download anything you can access."
            paths={inventory.serverOnlyFolders}
          />
          {inventory.serverOnlyFiles.length > 0 && <MissingFileActions
            paths={inventory.serverOnlyFiles}
            actions={handlers.actions}
            blocked={standaloneFileSyncBlocked}
            showUpgrade={showAttachmentUpgrade}
          />}
        </div>
      )}
    </section>
  );
}

function DifferenceSide({
  title,
  textNotes,
  otherFormats,
  folders,
  note,
}: {
  title: string;
  textNotes: number;
  otherFormats: number;
  folders: number;
  note?: string;
}) {
  if (textNotes === 0 && otherFormats === 0 && folders === 0) return null;

  return (
    <div className="health-difference-side">
      <strong>{title}</strong>
      <dl>
        {textNotes > 0 && (
          <div>
            <dt>Text notes</dt>
            <dd>{textNotes.toLocaleString()}</dd>
          </div>
        )}
        {otherFormats > 0 && (
          <div>
            <dt title="PDFs, images, data, and other supported files">
              Notes in other formats
            </dt>
            <dd>{otherFormats.toLocaleString()}</dd>
          </div>
        )}
        {folders > 0 && (
          <div>
            <dt>Folders</dt>
            <dd>{folders.toLocaleString()}</dd>
          </div>
        )}
      </dl>
      {note && <p>{note}</p>}
    </div>
  );
}

function InventoryPlace({
  icon,
  title,
  subtitle,
  counts,
  countsReady = true,
}: {
  icon: "disk" | "database";
  title: string;
  subtitle: string;
  counts: NonNullable<HealthInventory["server"]>;
  countsReady?: boolean;
}) {
  const shown = (count: number) => (countsReady ? count.toLocaleString() : "—");
  return (
    <div className="health-place">
      <div className="health-place-title">
        <span className="health-place-icon"><Glyph name={icon} size={18} /></span>
        <div><strong>{title}</strong><p>{subtitle}</p></div>
      </div>
      <strong className="health-place-primary">
        {countsReady ? (counts.notes + counts.files).toLocaleString() : "—"}
      </strong>
      <span className="health-place-primary-label">Notes</span>
      <dl>
        <div>
          <dt>Text notes</dt>
          <dd>{shown(counts.notes)}</dd>
        </div>
        <div>
          <dt>Other formats</dt>
          <dd>{shown(counts.files)}</dd>
        </div>
        <div>
          <dt>Folders</dt>
          <dd>{shown(counts.folders)}</dd>
        </div>
      </dl>
    </div>
  );
}

function DifferenceList({
  title,
  description,
  paths,
  details,
  actionLabel,
  onAction,
}: {
  title: string;
  description: string;
  paths: string[];
  details?: ReadonlyMap<string, string>;
  actionLabel?: string;
  onAction?: (path: string) => void;
}) {
  if (paths.length === 0) return null;
  const shown = paths.slice(0, 20);
  return (
    <div className="health-difference-group">
      <h4>{title} <span>{paths.length.toLocaleString()}</span></h4>
      <p>{description}</p>
      <ul>
        {shown.map((path) => (
          <li key={path}>
            <span className="health-difference-rowcopy">
              <PathText path={path} />
              {details?.get(path.toLowerCase()) && (
                <small>{details.get(path.toLowerCase())}</small>
              )}
            </span>
            {actionLabel && onAction && (
              <button type="button" className="link-btn" onClick={() => onAction(path)}>
                {actionLabel}
              </button>
            )}
          </li>
        ))}
      </ul>
      {paths.length > shown.length && (
        <p className="muted">And {(paths.length - shown.length).toLocaleString()} more.</p>
      )}
    </div>
  );
}

// ── Confirms ──────────────────────────────────────────────────────────────────

/** Every irreversible action on the page, in one place. Each one names what it
 *  will do to the file in front of the reader rather than to "the document". */
function Confirms({
  confirming,
  onDone,
  actions,
  onRunCheckAction,
}: {
  confirming: ConfirmState | null;
  onDone: () => void;
  actions: VaultHealthSnapshot["actions"];
  /** Start a confirmed check action; the row reports on it, not a toast. */
  onRunCheckAction?: (plan: CheckActionPlan) => Promise<void>;
}) {
  if (!confirming) return null;

  switch (confirming.kind) {
    case "delete":
      return (
        <ConfirmDialog
          title="Delete this note?"
          confirmLabel="Delete"
          onCancel={onDone}
          onConfirm={async () => {
            await actions.deleteNote(confirming.path);
            onDone();
          }}
        >
          <p className="muted">
            <code>{confirming.path}</code> is removed from this vault, and from every
            device that syncs it. A vault checkpoint can bring it back.
          </p>
        </ConfirmDialog>
      );
    case "reset":
      return (
        <ConfirmDialog
          title="Reset this note's history?"
          confirmLabel="Reset history"
          onCancel={onDone}
          onConfirm={async () => {
            const { bytesFreed } = await actions.resetHistory(confirming.docId);
            onDone();
            toast(`History reset · ${formatBytes(bytesFreed)} freed`);
          }}
        >
          <p className="muted">
            {confirming.path ? <code>{confirming.path}</code> : "This document"} starts over
            from the file on disk. The text you have now is kept, but the edit history
            behind it is discarded on every device, and undo cannot reach past this point.
          </p>
        </ConfirmDialog>
      );
    case "reregister":
      return (
        <ConfirmDialog
          title="Put this file back on the Remote Vault?"
          confirmLabel="Re-register"
          tone="accent"
          onCancel={onDone}
          onConfirm={async () => {
            await actions.reregister(confirming.path);
            onDone();
            toast("Registered — its content is uploading now");
          }}
        >
          <p className="muted">
            Registers <code>{confirming.path}</code> with the Remote Vault as a note again and
            uploads its content. Everyone with access to this vault will see it.
          </p>
        </ConfirmDialog>
      );
    case "empty-trash":
      return (
        <ConfirmDialog
          title="Empty the recovery copies?"
          confirmLabel="Empty trash"
          onCancel={onDone}
          onConfirm={async () => {
            const { filesRemoved, bytesFreed } = await actions.emptyTrash();
            onDone();
            toast(
              filesRemoved === 0
                ? "Nothing to empty"
                : `Removed ${filesRemoved.toLocaleString()} ${
                    filesRemoved === 1 ? "copy" : "copies"
                  } · ${formatBytes(bytesFreed)} freed`,
            );
          }}
        >
          <p className="muted">
            These files can include unsent local edits and deleted-note copies kept by earlier
            versions. Emptying permanently removes them. Notes still in the vault are untouched.
          </p>
        </ConfirmDialog>
      );
    case "check-action": {
      // Every word of this dialog — including how many files it names — was
      // decided by `planCheckAction` from the wording in `checks.ts`, so the
      // page cannot promise something the run will not do.
      const { plan } = confirming;
      return (
        <ConfirmDialog
          title={plan.confirm?.title ?? plan.label}
          confirmLabel={plan.confirm?.confirmLabel ?? plan.label}
          tone={plan.confirm?.tone ?? "danger"}
          onCancel={onDone}
          onConfirm={() => {
            onDone();
            void onRunCheckAction?.(plan);
          }}
        >
          <p className="muted">{plan.confirm?.body}</p>
          {plan.unlisted > 0 && (
            <p className="muted">
              Only the {plan.targets.length.toLocaleString()} shown are touched —{" "}
              {plan.unlisted.toLocaleString()} more were found but not listed. Run the
              checks again afterwards to reach them.
            </p>
          )}
          {plan.skipped.length > 0 && (
            <p className="muted">
              {plan.skipped.length.toLocaleString()}{" "}
              {plan.skipped.length === 1 ? "item is" : "items are"} left alone.
            </p>
          )}
        </ConfirmDialog>
      );
    }
    case "rebuild-index":
      return (
        <ConfirmDialog
          title="Rebuild the search index?"
          confirmLabel="Rebuild"
          tone="accent"
          onCancel={onDone}
          onConfirm={async () => {
            await actions.rebuildIndex();
            onDone();
            toast("Index rebuilt");
          }}
        >
          <p className="muted">
            Reads every note again and builds search, tags and backlinks from scratch.
            Search may be briefly incomplete while it runs. Your notes are not touched.
          </p>
        </ConfirmDialog>
      );
  }
}

// ── Verdict ───────────────────────────────────────────────────────────────────

/**
 * Pull the trailing " · <host>" the model folds into `detail` back out, so the
 * card can set it as a quiet mono chip instead of ending a plain sentence in
 * "…baalda-production.up.railway.app.". The model keeps owning the wording;
 * this only decides where the host is painted.
 */
export function splitHost(
  detail: string,
  host: string | null,
): { text: string; host: string | null } {
  if (!host) return { text: detail, host: null };
  const needle = ` · ${host}`;
  const at = detail.lastIndexOf(needle);
  if (at < 0) return { text: detail, host: null };
  const text = (detail.slice(0, at) + detail.slice(at + needle.length))
    // The host sometimes sits between a sentence's own full stop and the one
    // the template adds, which leaves ".." behind once it is lifted out.
    .replace(/\s*\.\s*\.\s*$/, ".")
    .trim();
  return { text, host };
}

function VerdictCard({
  snapshot,
  standaloneFileSyncBlocked,
  onRefresh,
  loading,
  onGoToGeneral,
}: {
  snapshot: VaultHealthSnapshot;
  standaloneFileSyncBlocked: boolean;
  onRefresh: () => void;
  loading: boolean;
  /** Where sync is turned on; a local vault's primary button leads there. */
  onGoToGeneral?: () => void;
}) {
  const { report, actions } = snapshot;
  const [copied, setCopied] = useState(false);
  const syncing = report.verdict === "syncing" || report.verdict === "connecting";
  const local = report.verdict === "local";
  // Signed out is a verdict, not an issue row (the model emits no `sign-in`
  // remedy), so the way back in lives here: there is no sync run to retry until
  // a session exists, and a disabled "Sync now" would say nothing about why.
  const signedOut = report.verdict === "signed-out";
  const { text, host } = splitHost(report.detail, report.serverHost);
  const localOnlyFormatNotes = standaloneFileSyncBlocked
    ? snapshot.inventory.deviceOnlyFiles.length
    : 0;
  const planPartial = report.verdict === "healthy" && localOnlyFormatNotes > 0;
  const healthyPending = report.verdict === "healthy" && !snapshot.inventory.localReady;
  const tone = planPartial || healthyPending ? "muted" : verdictTone(report.verdict);
  const syncedTextNotes = report.counts?.synced ?? 0;
  const headline =
    report.verdict !== "healthy"
      ? report.headline
      : healthyPending
        ? `${syncedTextNotes.toLocaleString()} text notes synced · counting other formats`
        : localOnlyFormatNotes > 0
          ? `${syncedTextNotes.toLocaleString()} text notes synced · ${localOnlyFormatNotes.toLocaleString()} ${localOnlyFormatNotes === 1 ? "note in another format" : "notes in other formats"} local only`
          : report.counts?.total === 0
            ? snapshot.inventory.local.notes + snapshot.inventory.local.files === 0
              ? snapshot.inventory.serverStored && snapshot.inventory.serverStored.notes + snapshot.inventory.serverStored.files > 0
                ? "No notes accessible to this account"
                : "No accessible notes to sync"
              : "No text notes need content sync"
            : `${syncedTextNotes.toLocaleString()} text notes synced`;

  const copy = async () => {
    await actions.copyDiagnostics();
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="health-verdict" data-tone={tone}>
      <div className="health-verdict-main">
        <span className="health-pill" data-tone={tone}>
          {healthyPending
            ? "Checking notes"
            : planPartial
              ? "Partially synced"
              : verdictLabel(report.verdict)}
        </span>
        <h3 className="health-headline">{headline}</h3>
        {/* The model already folds "Last confirmed …" into `detail` (see
            `model.ts` → `describe`), so the card prints it verbatim rather than
            assembling a second, contradictory version. Only the server host is
            lifted out, and only to be set as a chip. */}
        <p className="health-detail">
          {text}
          {host && <span className="health-host">{host}</span>}
        </p>
      </div>
      <div className="health-verdict-actions">
        {signedOut ? (
          <button
            type="button"
            className="primary sm"
            onClick={() => actions.requestSignIn()}
          >
            Sign in
          </button>
        ) : local && onGoToGeneral ? (
          // A local folder has nothing to sync "now"; the useful button is the
          // one that turns sync on, which lives on the General tab.
          <button type="button" className="primary sm" onClick={onGoToGeneral}>
            Turn on sync
          </button>
        ) : (
          <AsyncButton
            className="primary sm"
            spinnerTone="on-accent"
            disabled={syncing || local}
            title={
              local ? "This folder does not sync" : syncing ? "Already syncing" : undefined
            }
            onClick={() => actions.syncNow()}
          >
            Sync now
          </AsyncButton>
        )}
        <button
          type="button"
          className="ghost-pill sm"
          disabled={loading}
          onClick={onRefresh}
        >
          Refresh
        </button>
        <AsyncButton className="ghost-pill sm" onClick={copy}>
          {copied ? "Copied ✓" : "Copy diagnostics"}
        </AsyncButton>
      </div>
    </div>
  );
}

// ── Sync breakdown ────────────────────────────────────────────────────────────
