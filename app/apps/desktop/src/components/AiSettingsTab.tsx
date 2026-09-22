// SPDX-License-Identifier: Apache-2.0
import { useEffect, useRef, useState } from "react";
import { useVaultHealth } from "../lib/health/useVaultHealth";
import { assistantObservations } from "../lib/assistantObservations";
import type { DiagnosticInput } from "../lib/housekeeper";
import { HousekeeperPanel } from "./HousekeeperPanel";
import { HealthView } from "./HealthTab";
import { useStore } from "../store";
import type { CheckFocus } from "./HealthChecks";
import type { VaultCheckId } from "../lib/health/types";
import { AssistantLocalRepair } from "./AssistantLocalRepair";
import { UpgradeDialog } from "./UpgradeDialog";

export function AiSettingsTab({ onOpenHealth, onGoToGeneral, onClose, requestedCheck }: { onOpenHealth: () => void; onGoToGeneral: () => void; onClose: () => void; requestedCheck?: CheckFocus | null }) {
  const notes = useStore(s => s.titles);
  const path = useStore(s => s.vault?.path ?? null);
  const [proposal, setProposal] = useState<string | null>(null);
  const [focus, setFocus] = useState<CheckFocus | null>(null);
  const tools = useRef<HTMLDivElement>(null);
  useEffect(() => { if (requestedCheck) { setFocus(requestedCheck); tools.current?.scrollIntoView({ block: "start" }); } }, [requestedCheck]);
  const inspect = (id?: string) => {
    if (id && id !== "sync") setFocus({ id: id as VaultCheckId, n: Date.now() });
    tools.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  const [upgrade, setUpgrade] = useState(false);
  const snapshot = useVaultHealth({ onOpenUpgrade: () => setUpgrade(true) });
  const counts = snapshot.report.counts;
  const diagnostics = assistantObservations(snapshot);
  const waiting = useRef<{ resolve: (value: DiagnosticInput) => void; reject: (error: Error) => void; at: number | undefined; timeout: ReturnType<typeof setTimeout> } | null>(null);
  useEffect(() => {
    const pending = waiting.current;
    if (pending && !snapshot.loading && snapshot.checks?.computedAt !== pending.at) {
      clearTimeout(pending.timeout); waiting.current = null;
      const input = assistantObservations(snapshot);
      if (input) pending.resolve(input); else pending.reject(new Error("Some checks could not finish. Retry the scan."));
    }
  }, [snapshot]);
  useEffect(() => () => { if (waiting.current) { clearTimeout(waiting.current.timeout); waiting.current.reject(new Error("Vault changed.")); waiting.current = null; } }, [path]);
  const collect = () => new Promise<DiagnosticInput>((resolve, reject) => {
    const timeout = setTimeout(() => { waiting.current = null; reject(new Error("Vault checks took too long. Retry the scan.")); }, 30000);
    waiting.current = { resolve, reject, at: snapshot.checks?.computedAt, timeout };
    snapshot.refresh();
  });
  const brokenLinkNotes = snapshot.checks?.results.find(c => c.id === "broken-links")?.items ?? [];
  const localIds = [...(snapshot.checks?.results.filter(check => check.count > 0).map(check => check.id) ?? []), ...new Set(snapshot.report.issues.map(issue => `issue-${issue.kind}`))];
  return <>
    <HousekeeperPanel repairNotes={Object.fromEntries((snapshot.checks?.results ?? []).map(c => [c.id, c.items]))} onPrepareFix={async id => { setProposal(id); }} localFindings={<details className="assistant-local-findings"><summary>{localIds.length} local findings · Manual tools</summary>{localIds.map(id => <HealthView key={`${path}:${id}`} mode="finding" findingId={id} snapshot={snapshot} notes={notes} vaultPath={path} onGoToGeneral={onGoToGeneral} onClose={onClose} />)}</details>} collectDiagnostics={collect} renderFindingDetails={id => <HealthView key={`${path}:${id}`} mode="finding" findingId={id} snapshot={snapshot} notes={notes} vaultPath={path} onGoToGeneral={onGoToGeneral} onClose={onClose} />}
      onInspectFinding={inspect} onDiagnosticAction={async (id, action) => {
      // Revalidate the capability against the latest local observation, never model text.
      if (["stale-index", "unindexed-markdown"].includes(id) && action === "rebuild-index" && snapshot.checks?.results.some(c => c.id === id && c.count > 0)) {
        await snapshot.actions.rebuildIndex(); return "Search index rebuilt. Refreshing checks…";
      }
      if (["sync", "vault-offline", "vault-connecting"].includes(id) && action === "sync-now" && counts && (counts.failed || counts.unsynced || ["offline", "connecting"].includes(snapshot.report.verdict))) {
        await snapshot.actions.syncNow(); snapshot.refresh(); return "Sync retry requested. Refreshing checks…";
      }
      if (["issue-upload-failed", "issue-register-failed"].includes(id) && action === "retry-files") {
        const affected = snapshot.report.issues.filter(issue => `issue-${issue.kind}` === id && issue.docId && issue.remedies.includes("retry"));
        if (affected.length) {
          let done = 0;
          for (const issue of affected) { try { await snapshot.actions.retryDoc(issue.docId!); done++; } catch { /* Report partial success. */ } }
          snapshot.refresh(); return `Retried ${done} of ${affected.length} files. Scan again to verify.`;
        }
      }
      throw new Error("This finding changed. Run diagnostics again.");
    }} brokenLinkNotes={brokenLinkNotes} diagnostics={diagnostics} onUpgrade={() => setUpgrade(true)} onOpenHealth={onOpenHealth} onGoToGeneral={onGoToGeneral} />
    {focus && <div ref={tools}><button className="secondary" onClick={() => setFocus(null)}>Close finding</button><HealthView key={`${path}:${focus.id}`} mode="finding" findingId={focus.id} snapshot={snapshot} notes={notes} vaultPath={path} onGoToGeneral={onGoToGeneral} onClose={onClose} /></div>}
    {proposal && <AssistantLocalRepair key={`${path}:${proposal}`} id={proposal} snapshot={snapshot} onClose={() => setProposal(null)} />}
    {upgrade && <UpgradeDialog onClose={() => setUpgrade(false)} />}
  </>;
}
