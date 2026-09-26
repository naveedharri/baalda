/* Vault Settings → Health. The page that answers, in this order: is my work
   safe, where exactly does the pipeline stop, WHY, what do I do about it, what
   did Baalda verify about these files, and what is in this vault.

   Split in two on purpose. `HealthTab` is the container: it owns the hook, the
   note list the inspector completes against, and the upgrade dialog.
   `HealthView` is pure — hand it a `VaultHealthSnapshot` and it renders, which
   is what lets a fixture drive it without a vault, a server or a Tauri host
   underneath.

   The sections live in `HealthIssues`, `HealthChecks`, `HealthInspector`,
   `HealthTimeline` and `HealthStats`; this file owns the layout, the page
   actions, the inventory comparison and every destructive confirm. The
   confirms live HERE rather than inside the row that raised them, so a row
   unmounting mid-dialog — a refresh landing, a filter changing — cannot take
   the dialog with it.

   The whole page has to survive a vault that has never synced: `report.counts`
   is null, the last two pipeline stages are `off`, and the analytics below are
   still the point. Nothing here may assume a server. */
import { useEffect, useMemo, useState } from "react";
import { useStore } from "../store";
import type { NoteTitle } from "../lib/ipc";
import type {
  HealthInventory,
  ServerStorage,
  VaultHealthSnapshot,
} from "../lib/health/types";
import { useVaultHealth } from "../lib/health/useVaultHealth";
import { demoSnapshot, healthDemoEnabled } from "../lib/health/demoFixture";
import { formatBytes } from "../lib/health/format";
import { dedupeDifferences, localFilesBytes, runEach } from "../lib/health/attention";
import { toast } from "../lib/toast";
import { AsyncButton } from "./AsyncButton";
import { ConfirmDialog } from "./ConfirmDialog";
import { UpgradeDialog } from "./UpgradeDialog";
import { LocalOnlyGroup, RemoteOnlyGroup } from "./HealthPlaceGroups";
import { HealthIssues } from "./HealthIssues";
import { HealthChecks, type CheckFocus } from "./HealthChecks";
import { useHealthIgnores } from "../lib/health/useHealthIgnores";
import { HealthInspector } from "./HealthInspector";
import { HealthTimeline } from "./HealthTimeline";
import { HealthActivity, HealthLargest } from "./HealthStats";
import { AttachmentSyncNotice } from "./AttachmentSyncNotice";
import { HealthReconciled, HealthTrash } from "./HealthReconcile";
import {
  Glyph,
  Section,
  type CheckRun,
  type ConfirmState,
  type HealthHandlers,
  type LeftBehindRun,
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
  const liveSnapshot = useVaultHealth({
    onOpenUpgrade: onOpenUpgrade ?? (() => setUpgradeOpen(true)),
    onRequestSignIn,
  });
  // DEV-only fixture mode (see `lib/health/demoFixture.ts`). `import.meta.env.DEV`
  // folds to false in production, so the fixture never replaces live data there.
  const demo = import.meta.env.DEV && healthDemoEnabled();
  const demoData = useMemo(() => (demo ? demoSnapshot() : null), [demo]);
  const snapshot = demoData ?? liveSnapshot;
  // The one store read on this page, and it stays in the CONTAINER so
  // `HealthView` keeps rendering from nothing but its props — a fixture, in the
  // tests.
  const notes = useStore((s) => s.titles);
  const vaultPath = useStore((s) => s.vault?.path ?? null);
  const standaloneFileSyncBlocked = useStore((s) => s.attachmentSyncBlocked) || demo;
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
        title="Health"
        demo={demo}
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
  title,
  demo = false,
  findingId,
  requestedCheck,
  snapshot,
  notes = [],
  vaultPath = null,
  standaloneFileSyncBlocked = false,
  showAttachmentUpgrade = false,
  onGoToGeneral,
  onClose,
}: {
  mode?: "all" | "overview" | "diagnostics" | "finding";
  /** The page title, set beside the page actions. The settings dialog skips its
   *  own heading for this tab so the two sit on one row. */
  title?: string;
  /** DEV-only fixture mode: labels the page so nobody reads it as real. */
  demo?: boolean;
  findingId?: string;
  requestedCheck?: CheckFocus | null;
  /** Kept for callers. The overview's stat strip used it to jump to a flagged
   *  check; the checks themselves now live only under diagnostics. */
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
  const { report, stats, checks, loading, log, refresh, actions } = snapshot;
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

  // The Left-on-disk group's bulk run. Page-owned for the same reason as
  // `checkRuns`: every success removes a row, and the last one removes the
  // group — the result has to outlive both.
  const [leftBehindRun, setLeftBehindRun] = useState<LeftBehindRun | null>(null);
  const startLeftBehind = async (verb: LeftBehindRun["verb"], paths: string[]): Promise<void> => {
    if (leftBehindRun?.running || paths.length === 0) return;
    setLeftBehindRun({ verb, running: true, done: 0, total: paths.length, failed: [] });
    const outcome = await runEach(
      paths,
      (path) => (verb === "delete" ? actions.deleteNote(path) : actions.reregister(path)),
      (done, total) =>
        setLeftBehindRun((r) => (r?.running ? { ...r, done, total } : r)),
    );
    setLeftBehindRun({ verb, running: false, ...outcome });
    if (outcome.failed.length === 0) {
      toast(
        verb === "delete"
          ? `Deleted ${outcome.done.toLocaleString()} local ${outcome.done === 1 ? "copy" : "copies"}`
          : `Re-registered ${outcome.done.toLocaleString()} ${outcome.done === 1 ? "file" : "files"} — content is uploading now`,
      );
    }
    refresh();
  };

  // A path with an issue is listed once, under the issue; see `dedupeDifferences`.
  const attentionInventory = dedupeDifferences(snapshot.inventory, report.issues);

  const handlers: HealthHandlers = {
    actions,
    now,
    leftBehind: {
      run: leftBehindRun,
      start: (verb, paths) => startLeftBehind(verb, paths),
    },
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
  };

  if (mode === "finding" && findingId) {
    const check = checks?.results.find(c => c.id === findingId);
    const issues = findingId.startsWith("issue-") ? report.issues.filter(i => i.kind === findingId.slice(6)) : report.issues;
    return <div className="health-tab assistant-finding-tools">
      {check ? <HealthChecks checks={checks} loading={loading} handlers={handlers} onlyIds={[findingId]} focus={{ id: check.id, n: 1 }} /> :
        findingId === "vault-storage" ? stats && <HealthLargest stats={stats} handlers={handlers} /> :
        ["remote-files", "local-files"].includes(findingId) ? <InventoryComparison inventory={snapshot.inventory} report={report} handlers={handlers} standaloneFileSyncBlocked={standaloneFileSyncBlocked} showAttachmentUpgrade={showAttachmentUpgrade} localBytes={localFilesBytes(stats)} serverStorage={snapshot.serverStorage ?? null} /> :
        issues.length ? <HealthIssues issues={issues} handlers={handlers} syncEnabled={report.counts != null} focusKey={issues.length === 1 ? issues[0].key : undefined} /> :
        <><p>{report.detail}</p><HealthTimeline log={log} now={now} onInspect={path => setInspectRequest({ path, n: Date.now() })} /></>}
      {inspectRequest && <HealthInspector notes={notes} handlers={handlers} request={inspectRequest} onShowIssue={setFocusIssue} />}
      <Confirms confirming={confirming} onDone={() => setConfirming(null)} actions={actions} onRunCheckAction={startCheckAction} onDeleteLeftBehind={(paths) => startLeftBehind("delete", paths)} />
    </div>;
  }

  return (
    <div className="health-tab">
      {mode !== "diagnostics" && <>
      <div className="health-page-head">
        {title && <h2 className="settings-section-title">{title}</h2>}
        {demo && <span className="health-pill health-demo-chip" data-tone="warn">Demo data</span>}
        <PageActions
          snapshot={snapshot}
          onRefresh={refresh}
          loading={loading}
          onGoToGeneral={onGoToGeneral}
        />
      </div>

      <InventoryComparison
        inventory={snapshot.inventory}
        report={report}
        handlers={handlers}
        standaloneFileSyncBlocked={standaloneFileSyncBlocked}
        showAttachmentUpgrade={showAttachmentUpgrade}
        localBytes={localFilesBytes(stats)}
        serverStorage={snapshot.serverStorage ?? null}
        part="cards"
      />

      <Section
        title="Needs attention"
      >
        <HealthIssues
          before={
            <InventoryComparison
              inventory={attentionInventory}
              report={report}
              handlers={handlers}
              standaloneFileSyncBlocked={standaloneFileSyncBlocked}
              showAttachmentUpgrade={showAttachmentUpgrade}
              part="differences"
            />
          }
          hasOtherItems={differenceGroupsShown(attentionInventory, report)}
          issues={report.issues}
          handlers={handlers}
          syncEnabled={report.counts != null}
          focusKey={focusIssue}
          dismissed={ignores.issues}
          onDismiss={ignores.dismissIssue}
          onRestore={ignores.restoreIssue}
        />
      </Section>

      <HealthReconciled now={now} />
      {!demo && <HealthTrash now={now} />}

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
        onDeleteLeftBehind={(paths) => startLeftBehind("delete", paths)}
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
  localBytes = null,
  serverStorage = null,
  part = "all",
}: {
  /** "cards" = only the two copies; "differences" = only what needs attention
   *  (rendered under Needs attention); "all" = both, for a focused finding. */
  part?: "all" | "cards" | "differences";
  inventory: HealthInventory;
  report: VaultHealthSnapshot["report"];
  handlers: HealthHandlers;
  standaloneFileSyncBlocked: boolean;
  showAttachmentUpgrade: boolean;
  /** Attachment + standalone-file bytes on disk; null while unknown. */
  localBytes?: number | null;
  /** The Remote Vault's file/attachment bytes; null when unknown. */
  serverStorage?: ServerStorage | null;
}) {
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
  // Only a bulk run that is actually moving puts the comparison on hold. A
  // socket that is merely (re)connecting is not updating anything yet, and
  // saying it was left the page claiming work that never happened.
  const comparisonUpdating = report.verdict === "syncing";
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
      ? `${inventory.deviceOnlyFiles.length.toLocaleString()} ${inventory.deviceOnlyFiles.length === 1 ? "file is" : "files are"} missing from the Remote Vault`
      : null,
    inventory.serverOnlyFiles.length > 0
      ? `${inventory.serverOnlyFiles.length.toLocaleString()} ${inventory.serverOnlyFiles.length === 1 ? "file is" : "files are"} missing from this computer`
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

  // The quiet "everything matches" case says nothing the two equal cards do not
  // already show, so the strip only appears when it has something to report.
  const resultTone =
    !inventory.server || comparisonUpdating
      ? "muted"
      : comparisonWarn
        ? "warn"
        : localOnlyFormatNotes > 0 || comparisonStale || comparisonPending
          ? "muted"
          : "good";
  // A sync in progress is not something to attend to — the pill and the
  // "Updating Remote Vault view" chip already say it — so it never earns a strip.
  const resultIsPlainMatch =
    comparisonUpdating ||
    (resultTone === "good" &&
      differenceSummaries.length === 0 &&
      !countsDiffer &&
      restrictedNotes === 0);
  // The groups below name every difference themselves; a strip restating
  // them above was clutter. It stays only for states with no list to show.
  const groupsShown = differenceGroupsShown(inventory, report);

  const differencesUi = (
    <>
      {!resultIsPlainMatch && !groupsShown && (
      <div
        className="health-inventory-result"
        data-tone={resultTone}
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
                    ? `${localOnlyFormatNotes.toLocaleString()} ${localOnlyFormatNotes === 1 ? "file stays" : "files stay"} on this computer`
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
        {!comparisonUpdating && inventory.server && countsDiffer && (
          <div className="health-inventory-actions">
            <AsyncButton className="primary sm" onClick={() => handlers.actions.syncNow()}>
              Check again
            </AsyncButton>
          </div>
        )}
      </div>
      )}

      {groupsShown && (
        <div className="health-differences">
          <LocalOnlyGroup
            inventory={inventory}
            actions={handlers.actions}
            filesBlocked={standaloneFileSyncBlocked}
            onOpen={handlers.openNote}
            onShow={(path) => void handlers.actions.reveal(path)}
            stale={comparisonStale}
          />
          <RemoteOnlyGroup
            inventory={inventory}
            actions={handlers.actions}
            downloadsBlocked={standaloneFileSyncBlocked}
            showCheckAgain={inventory.serverOnlyNotes.length + inventory.serverOnlyFolders.length > 0}
            stale={comparisonStale}
          />
        </div>
      )}
    </>
  );
  if (part === "differences") {
    return resultIsPlainMatch && !groupsShown ? null : <div className="health-inventory-differences">{differencesUi}</div>;
  }

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
          bytes={localBytes == null ? "—" : formatBytes(localBytes)}
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
            bytes={
              serverStorage == null
                ? "—"
                : serverStorage.limitBytes == null
                  ? formatBytes(serverStorage.usedBytes)
                  : `${formatBytes(serverStorage.usedBytes)} of ${formatBytes(serverStorage.limitBytes)}`
            }
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

      {part === "all" && differencesUi}
    </section>
  );
}

/** True when Needs attention lists difference groups. The all-clear card
 *  must not sit beside them. */
export function differenceGroupsShown(
  inventory: HealthInventory,
  report: VaultHealthSnapshot["report"],
): boolean {
  if (report.verdict === "syncing" || !inventory.server) return false;
  return (
    inventory.deviceOnlyNotes.length +
      inventory.serverOnlyNotes.length +
      inventory.deviceOnlyFolders.length +
      inventory.serverOnlyFolders.length +
      inventory.deviceOnlyFiles.length +
      inventory.serverOnlyFiles.length >
    0
  );
}

function InventoryPlace({
  icon,
  title,
  subtitle,
  counts,
  countsReady = true,
  bytes,
}: {
  icon: "disk" | "database";
  title: string;
  subtitle: string;
  counts: NonNullable<HealthInventory["server"]>;
  countsReady?: boolean;
  /** "Files & attachments" size, already formatted; "—" when unknown. */
  bytes: string;
}) {
  const shown = (count: number) => (countsReady ? count.toLocaleString() : "—");
  return (
    <div className="health-place">
      <div className="health-place-title">
        <span className="health-place-icon"><Glyph name={icon} size={18} /></span>
        <div><strong>{title}</strong><p>{subtitle}</p></div>
      </div>
      {/* Notes means text notes (NOTE_EXTS) and nothing else; every other
          supported format is a File, counted beside it. */}
      <strong className="health-place-primary">{shown(counts.notes)}</strong>
      <span className="health-place-primary-label">Notes</span>
      <dl>
        <div>
          <dt title="PDFs, images, data, and other supported files">Files</dt>
          <dd>{shown(counts.files)}</dd>
        </div>
        <div>
          <dt>Folders</dt>
          <dd>{shown(counts.folders)}</dd>
        </div>
        <div>
          <dt title="Embedded attachments and standalone files; excludes note text, the local index and edit history">
            Files &amp; attachments
          </dt>
          <dd>{bytes}</dd>
        </div>
      </dl>
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
  onDeleteLeftBehind,
}: {
  confirming: ConfirmState | null;
  onDone: () => void;
  actions: VaultHealthSnapshot["actions"];
  /** Start a confirmed check action; the row reports on it, not a toast. */
  onRunCheckAction?: (plan: CheckActionPlan) => Promise<void>;
  /** Start the Left-on-disk group's confirmed delete; its bar reports on it. */
  onDeleteLeftBehind?: (paths: string[]) => Promise<void>;
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
    case "delete-left-behind": {
      const n = confirming.paths.length;
      return (
        <ConfirmDialog
          title={`Delete ${n.toLocaleString()} local ${n === 1 ? "copy" : "copies"}?`}
          confirmLabel="Delete all"
          onCancel={onDone}
          onConfirm={() => {
            onDone();
            void onDeleteLeftBehind?.(confirming.paths);
          }}
        >
          <p className="muted">
            {n === 1 ? "This file is" : `These ${n.toLocaleString()} files are`} no longer on the
            Remote Vault, and this device never confirmed {n === 1 ? "its" : "their"} content
            there. {n === 1 ? "It may be the only copy." : "They may be the only copies."}{" "}
            Deleting removes {n === 1 ? "it" : "them"} from this computer.
          </p>
        </ConfirmDialog>
      );
    }
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

// ── Page actions ──────────────────────────────────────────────────────────────

/** The two buttons beside the page title. "Sync now" becomes "Sign in" or
 *  "Turn on sync" when there is nothing it could start. */
function PageActions({
  snapshot,
  onRefresh,
  loading,
  onGoToGeneral,
}: {
  snapshot: VaultHealthSnapshot;
  onRefresh: () => void;
  loading: boolean;
  /** Where sync is turned on; a local vault's primary button leads there. */
  onGoToGeneral?: () => void;
}) {
  const { report, actions } = snapshot;
  const syncing = report.verdict === "syncing" || report.verdict === "connecting";
  const local = report.verdict === "local";
  // Signed out is a verdict, not an issue row (the model emits no `sign-in`
  // remedy), so the way back in lives here: there is no sync run to retry until
  // a session exists, and a disabled "Sync now" would say nothing about why.
  const signedOut = report.verdict === "signed-out";

  return (
    <div className="health-verdict-actions health-page-actions">
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
    </div>
  );
}

// ── Sync breakdown ────────────────────────────────────────────────────────────
