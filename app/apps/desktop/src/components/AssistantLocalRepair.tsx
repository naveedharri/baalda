// SPDX-License-Identifier: Apache-2.0
import { useEffect, useRef, useState } from "react";
import { ConfirmDialog } from "./ConfirmDialog";
import { CHECK_DEFINITIONS, type CheckAction } from "../lib/health/checks";
import { planCheckAction, suggestLegalPath, outcomeSummary, runCheckAction, type CheckActionPlan } from "../lib/health/checkActions";
import type { VaultHealthSnapshot } from "../lib/health/types";
import { distinctRepairPath } from "../lib/assistantRepairs";
import { useStore } from "../store";
import { syncManager } from "../lib/sync/docSession";
import { authManager } from "../lib/auth/authManager";
import * as ipc from "../lib/ipc";

type Plan = { title: string; description: string; label: string; paths: string[]; check?: CheckActionPlan; renames?: { from: string; to: string; docId: string }[]; action?: "access" | "register" | "download" };
export function AssistantLocalRepair({ id, snapshot, onClose }: { id: string; snapshot: VaultHealthSnapshot; onClose: () => void }) {
  const [plan, setPlan] = useState<Plan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const scope = useRef({ path: useStore.getState().vault?.path, epoch: useStore.getState().vault?.epoch, server: useStore.getState().serverUrl, user: useStore.getState().session?.user.id, vaultId: syncManager.registry.vaultId }).current;
  const finding = useRef(snapshot.checks?.results.find(c => c.id === id)).current;
  const fingerprint = JSON.stringify(finding);
  const checkScope = () => {
    const st = useStore.getState();
    if (st.vault?.path !== scope.path || st.vault?.epoch !== scope.epoch || st.serverUrl !== scope.server || st.session?.user.id !== scope.user || syncManager.registry.vaultId !== scope.vaultId) throw new Error("Vault or account changed. Prepare a new action.");
  };
  useEffect(() => {
    let live = true;
    void (async () => {
      checkScope();
      let next: Plan;
      if (["issue-no-access", "issue-no-write-access", "vault-no-access"].includes(id)) {
        next = { title: "Prepare an access request", description: "Copy a request for the vault owner. This does not send a message or change permissions.", label: "Copy access request", paths: snapshot.report.issues.filter(i => `issue-${i.kind}` === id).flatMap(i => i.path ? [i.path] : []), action: "access" };
      } else if (id === "remote-files") {
        const paths = snapshot.inventory.serverOnlyFiles.slice(0, 25);
        if (snapshot.inventory.serverState !== "current" || !paths.length) throw new Error("Wait for a current remote inventory before downloading missing files.");
        next = { title: "Download missing files", description: "Restore the listed remote files to this device using the guarded download pipeline.", label: "Download files", paths, action: "download" };
      } else if (id === "issue-left-behind") {
        const paths = snapshot.report.issues.filter(i => i.kind === "left-behind" && i.remedies.includes("reregister") && i.path).map(i => i.path!).slice(0, 25);
        if (!paths.length) throw new Error("No recoverable local files remain.");
        next = { title: "Restore local files to sync", description: "These copies were preserved after deletion or loss of access. Re-registering requests permission to upload them again. Review whether the original deletion was intentional.", label: "Re-register files", paths, action: "register" };
      } else if (["case-collisions", "long-paths"].includes(id) && finding) {
        const occupied = new Set(useStore.getState().titles.map(n => n.path.toLowerCase()));
        const renames: NonNullable<Plan["renames"]> = [];
        for (const item of finding.items) {
          const note = useStore.getState().titles.find(n => n.path === item.path);
          if (!note || !await ipc.noteExists(item.path, scope.epoch)) continue;
          const to = distinctRepairPath(item.path, occupied, id === "long-paths");
          if (!to) continue;
          occupied.add(to.toLowerCase()); renames.push({ from: item.path, to, docId: note.id });
        }
        if (!renames.length) throw new Error("These paths require a folder move or individual naming choice; no safe file-only rename was found.");
        next = { title: "Review distinct file names", description: "Preserve every file and its identity. Links using the old paths may need repair after renaming. Folders are left alone.", label: "Apply renames", paths: renames.map(r => `${r.from} → ${r.to}`), renames };
      } else {
        const action: CheckAction | undefined = ({ "illegal-names": "rename-legal", "oversized-notes": "export-all", "unreadable-notes": "export-all", "trash": "export-all", "heavy-history": "reset-history-all", "orphan-history": "reclaim" } as Record<string, CheckAction>)[id];
        const def = CHECK_DEFINITIONS.find(c => c.id === id);
        if (!action || !def || !finding?.count) throw new Error("The finding changed. Scan again.");
        const check = planCheckAction(def, finding, action, "heal");
        if (!check) throw new Error("No eligible files remain.");
        next = { title: check.confirm?.title ?? (id === "trash" ? "Save recovery copies" : check.label), description: check.confirm?.body ?? (action === "export-all" ? "Choose a folder to save the listed files. Originals stay intact. Saving a copy does not reduce their size or resolve a sync limit." : "Reclaim only orphaned history after validating the complete live note set."), label: check.confirm?.confirmLabel ?? check.label, paths: check.targets.map(t => action === "rename-legal" ? `${t.path} → ${suggestLegalPath(t.path)}` : t.path), check };
      }
      checkScope(); if (live) setPlan(next);
    })().catch(e => { if (live) setError(e instanceof Error ? e.message : "Could not prepare this action."); });
    return () => { live = false; };
  }, []);
  return <ConfirmDialog title={plan?.title ?? "Preparing action…"} confirmLabel={result ? "Done" : running ? "Applying…" : plan?.label ?? "Apply"} tone={plan?.check?.confirm?.tone ?? "accent"} confirmDisabled={!result && (!plan || running)} onCancel={() => { if (!running) onClose(); }} onConfirm={async () => {
    if (result) { onClose(); return; }
    if (!plan || running) return;
    setRunning(true); setError(null);
    try {
      checkScope();
      if (!scope.vaultId || !(await authManager.api.housekeeperStatus(scope.vaultId)).available) throw new Error("Assistant access is unavailable.");
      checkScope();
      if (finding) {
        const fresh = await ipc.vaultChecks(Object.fromEntries(Object.entries(useStore.getState().docIdByPath).map(([path, docId]) => [docId, path])), scope.epoch);
        checkScope();
        if (JSON.stringify(fresh.results.find(c => c.id === id)) !== fingerprint) throw new Error("The finding changed. Prepare a fresh action.");
      }
      let message = "";
      if (plan.check) {
        const outcome = await runCheckAction(plan.check, {
          deleteNotes: async () => { throw new Error("Deletion is not available in this repair flow."); },
          resetHistory: async docId => { checkScope(); return snapshot.actions.resetHistory(docId); },
          reclaim: async () => { checkScope(); return snapshot.actions.reclaimOrphans(); },
          emptyTrash: async () => { throw new Error("Recovery copies are preserved."); },
          rebuildIndex: async () => { checkScope(); await snapshot.actions.rebuildIndex(); },
          syncNow: async () => { checkScope(); await snapshot.actions.syncNow(); },
          pickFolder: async () => { checkScope(); const folder = await ipc.pickFolder(); checkScope(); return folder; },
          exportTo: async (path, dest) => { checkScope(); await ipc.exportPath(path, dest, scope.epoch); },
          isFile: async path => { checkScope(); return ipc.noteExists(path, scope.epoch); },
          rename: async (from, to) => {
            checkScope(); const docId = useStore.getState().docIdByPath[from];
            if (!docId) throw new Error("Wait for this file to register before renaming.");
            await authManager.api.housekeeperAuthorize(scope.vaultId!, docId, from); checkScope();
            if ((await ipc.getNoteMeta(from))?.id !== docId) throw new Error("File identity changed");
            checkScope();
            await useStore.getState().renameNoteFileExact(from, to);
          },
        });
        message = outcomeSummary(outcome, plan.check);
        if (outcome.errors.length) message += ". " + outcome.errors.map(e => `${e.path}: ${e.reason}`).join("; ");
      } else if (plan.renames) {
        let done = 0; const failures: string[] = [];
        for (const rename of plan.renames) {
          try {
            checkScope(); await authManager.api.housekeeperAuthorize(scope.vaultId, rename.docId, rename.from); checkScope();
            if ((await ipc.getNoteMeta(rename.from))?.id !== rename.docId) throw new Error("File identity changed");
            if (!await ipc.noteExists(rename.from, scope.epoch) || await ipc.noteExists(rename.to, scope.epoch)) throw new Error("Source or destination changed");
            checkScope(); await useStore.getState().renameNoteFileExact(rename.from, rename.to); done++;
          } catch (e) { failures.push(`${rename.from}: ${e instanceof Error ? e.message : "Failed"}`); }
        }
        message = `Renamed ${done} of ${plan.renames.length}. ${failures.join("; ")}`;
      } else if (plan.action === "access") {
        const request = await snapshot.actions.contactOwner(); message = `Copied access request. Send it to ${request.owner?.name ?? "the vault owner"}.`;
      } else if (plan.action === "download") {
        await snapshot.actions.downloadFiles(plan.paths); message = "Download completed. Scan again to verify.";
      } else if (plan.action === "register") {
        let done = 0; const errors: string[] = [];
        for (const path of plan.paths) { try { checkScope(); await snapshot.actions.reregister(path); done++; } catch (e) { errors.push(`${path}: ${e instanceof Error ? e.message : "Failed"}`); } }
        message = `Re-registered ${done} of ${plan.paths.length}. ${errors.join("; ")}`;
      }
      setResult(message); snapshot.refresh();
    } catch (e) { setError(e instanceof Error ? e.message : "Action failed."); }
    finally { setRunning(false); }
  }}>
    {plan && !result && <><p>{plan.description}</p><ul className="assistant-preview-paths">{plan.paths.map(path => <li key={path}><code>{path}</code></li>)}</ul>{plan.check && plan.check.unlisted > 0 && <p>{plan.check.unlisted} additional items are outside this preview.</p>}</>}
    {error && <p role="alert">{error}</p>}{result && <p role="status">{result}</p>}
  </ConfirmDialog>;
}
