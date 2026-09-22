// SPDX-License-Identifier: Apache-2.0
// Local observations are advisory input, never authority to mutate a vault.
export const CHECKS = {
  "empty-notes": ["Empty notes", "Review whether these are intentional placeholders before deleting anything."],
  "unreadable-notes": ["Unreadable notes", "Keep a recovery copy and inspect the file encoding before editing."],
  "bad-frontmatter": ["Invalid properties", "Open the affected notes and repair the YAML properties with a preview."],
  "case-collisions": ["Conflicting file names", "Compare the colliding files and choose distinct names. Preserve both copies."],
  "illegal-names": ["Unsupported file names", "Review the proposed legal names in Health before renaming."],
  "long-paths": ["Long file paths", "Shorten affected folder or note names while keeping their identities."],
  "stale-index": ["Outdated search index", "Use Health’s rebuild-index action to refresh derived search data."],
  "broken-links": ["Notes with unresolved links", "Find a suggested replacement for an affected note, then review the change before applying it."],
  "missing-embeds": ["Missing attachments", "Check whether the attachments are available remotely or in a recovery copy."],
  "duplicate-titles": ["Duplicate note titles", "Compare the notes before changing titles; matching titles do not prove duplicate content."],
  "unindexed-markdown": ["Notes missing from search", "Rebuild the local index in Health, then check whether the notes appear."],
  "oversized-notes": ["Large notes", "Review the affected notes and split large content into smaller notes if needed."],
  "heavy-history": ["Large edit history", "Inspect history size in Health. Resetting history discards undo data and needs review."],
  "orphan-history": ["Unclaimed edit history", "Use Health’s guarded reclaim action after inspecting the finding."],
  "trash": ["Recovery copies", "Review recovery copies before removing them; emptying trash is permanent."],
};
const ISSUE_KINDS = ["too-large", "no-write-access", "upload-failed", "register-failed", "limit", "unregistered", "no-access", "left-behind", "materialize-failed", "inbound-blocked", "orphan-history"];
const VERDICTS = ["local", "signed-out", "no-access", "offline", "connecting", "syncing", "attention", "healthy"];
const ISSUE_TITLES = { "too-large": "Files too large to sync", "no-write-access": "Files without write access", "upload-failed": "File uploads failed", "register-failed": "Files could not register", limit: "A plan limit is blocking sync", unregistered: "Files not registered for sync", "no-access": "Files without read access", "left-behind": "Local copies need review", "materialize-failed": "Files could not be written locally", "inbound-blocked": "Incoming changes were held for safety", "orphan-history": "Unclaimed edit history" };
const priorities = { now: "Review first", soon: "Review next", later: "When convenient", review: "Needs your judgment" };
const priorityCriteria = {
  now: "This specific finding blocks saving/syncing real changes or shows an immediate risk of losing the only copy. Unrelated failures do not make this finding urgent.",
  soon: "This specific finding impairs use, portability, or search, but current content is preserved.",
  later: "Optional housekeeping or an intentional state: empty placeholders, duplicate titles, ordinary history/storage, or a local-only vault. No demonstrated blocking fault.",
  review: "Insufficient evidence to judge this finding. Inspect it; do not invent a root cause or assume danger.",
};
export function validateDiagnostics(body) {
  if (body?.consent !== true) throw Object.assign(new Error("Confirm sharing diagnostic counts before reviewing."), { status: 400 });
  const input = body.diagnostics;
  const count = n => Number.isSafeInteger(n) && n >= 0 && n <= 1_000_000_000_000;
  if (!input || !Array.isArray(input.checks) || input.checks.length !== Object.keys(CHECKS).length ||
      new Set(input.checks.map(c => c?.id)).size !== Object.keys(CHECKS).length ||
      input.checks.some(c => !c || !Object.hasOwn(CHECKS, c.id) || !count(c.count)) ||
      !input.sync || !["pending", "failed", "unsynced"].every(k => count(input.sync[k]))) {
    throw Object.assign(new Error("Diagnostic checks are incomplete. Refresh Health and try again."), { status: 400 });
  }
  // Strip every unrecognized field: no note text, paths, identifiers or log messages leave the server.
  const result = { checks: input.checks.map(c => ({ id: c.id, count: c.count })),
    sync: { pending: input.sync.pending, failed: input.sync.failed, unsynced: input.sync.unsynced } };
  if (input.context !== undefined) {
    const c = input.context;
    const metrics = ["totalNotes", "totalFiles", "contentBytes", "historyBytes", "indexBytes", "largestFileBytes"];
    if (!c || !VERDICTS.includes(c.verdict) || !["current", "updating", "last-known", "unavailable"].includes(c.serverState) ||
        !metrics.every(k => c[k] === null || count(c[k])) || !count(c.serverOnlyFiles) || !count(c.deviceOnlyFiles) ||
        !Array.isArray(c.issues) || c.issues.length > ISSUE_KINDS.length || new Set(c.issues.map(i => i?.kind)).size !== c.issues.length ||
        c.issues.some(i => !ISSUE_KINDS.includes(i?.kind) || !count(i.count))) {
      throw Object.assign(new Error("Vault observations are incomplete. Scan again."), { status: 400 });
    }
    result.context = { verdict: c.verdict, ...Object.fromEntries(metrics.map(k => [k, c[k]])), serverState: c.serverState,
      serverOnlyFiles: c.serverOnlyFiles, deviceOnlyFiles: c.deviceOnlyFiles, issues: c.issues.map(i => ({ kind: i.kind, count: i.count })) };
  }
  return result;
}
// The model chooses a next step from a fixed capability list, never arbitrary tools.
export function diagnosticActions(id) {
  const actions = { inspect: "Inspect the finding before making changes" };
  if (["stale-index", "unindexed-markdown"].includes(id)) actions["rebuild-index"] = "Rebuild derived search data from files; preserve note content";
  if (id === "broken-links") actions["review-links"] = "Review candidate replacements for broken links; apply only after approval";
  if (["sync", "vault-offline", "vault-connecting"].includes(id)) actions["sync-now"] = "Retry the existing sync pipeline; do not reset history or overwrite content";
  if (["vault-storage", "oversized-notes", "heavy-history"].includes(id)) actions["review-storage"] = "Prepare backups for oversized files or a reviewed history reset for excessive history; never delete source files";
  if (["vault-local", "vault-signed-out"].includes(id)) actions["configure-sync"] = "Open sync settings to connect this vault";
  if (["issue-upload-failed", "issue-register-failed"].includes(id)) actions["retry-files"] = "Retry the affected files using existing permissions and sync safety checks";
  if (id === "illegal-names") actions["review-renames"] = "Preview legal file names before confirming any rename";
  if (id === "empty-notes") actions["review-empty"] = "Investigate saved nonempty versions and preview restoration; preserve intentional placeholders";
  if (id === "bad-frontmatter") actions["review-properties"] = "Prepare a bounded property repair, preserve all text, and require approval";
  if (["case-collisions", "duplicate-titles", "long-paths"].includes(id)) actions["review-renames"] = "Prepare distinct filenames or titles, preserve every file, and preview changes before approval";
  if (["issue-no-access", "issue-no-write-access", "vault-no-access"].includes(id)) actions["review-access"] = "Prepare an access request for the owner; never grant access or send messages automatically";
  if (["trash", "orphan-history", "issue-left-behind"].includes(id)) actions["review-recovery"] = "Prepare recovery downloads, preserve recovery copies, or reclaim orphaned history after approval";
  return actions;
}
export async function reviewDiagnostics(router, config, input) {
  const findings = input.checks.filter(c => c.count > 0);
  const context = input.context;
  if (context) {
    for (const issue of context.issues) if (issue.count > 0) findings.push({ id: `issue-${issue.kind}`, count: issue.count });
    if (["local", "signed-out", "offline", "no-access", "connecting"].includes(context.verdict)) findings.push({ id: `vault-${context.verdict}`, count: 1 });
    if (context.contentBytes !== null) findings.push({ id: "vault-storage", count: context.totalFiles ?? 0 });
    if (context.serverOnlyFiles > 0) findings.push({ id: "remote-files", count: context.serverOnlyFiles });
    if (context.deviceOnlyFiles > 0 && context.verdict !== "local") findings.push({ id: "local-files", count: context.deviceOnlyFiles });
  }
  if (!context?.issues.length && (input.sync.failed || input.sync.unsynced)) findings.push({ id: "sync", count: input.sync.failed + input.sync.unsynced });
  if (!findings.length) return { model: config.model, findings: [], checked: input.checks.length };
  const questions = {};
  for (const f of findings) {
    questions[f.id] = {
      type: "choice", instructions: `Judge ONLY the ${f.id} finding (${f.count} observations). Do not transfer the urgency of other findings to this one. Use the full vault context, including file counts, content/history/index bytes, largest file, sync state and failure kinds. Data preservation comes first. Do not invent capacity limits or infer a problem merely because a vault has data. For vault-storage, no capacity limit is supplied. Ordinary megabytes of content are not excessive. Choose healthy unless the measurements themselves show an unusual storage burden; do not duplicate an individual oversized-note finding. Choose review if uncertain.`, criteria: f.id === "vault-storage" ? { ...priorityCriteria, healthy: "Measured storage is ordinary; no storage issue to report" } : priorityCriteria,
    };
    questions[`${f.id}_action`] = {
      type: "choice", instructions: `Choose the most useful next step for ${f.id}. Index rebuilds are safe for stale or missing index entries. Review links when an existing target might fit. Sync retries may not solve permanent permission errors: inspect those first when uncertain. Never delete files or reset history. Choose inspect if uncertain.`, criteria: diagnosticActions(f.id),
    };
  }
  let choices, model;
  if (config.mode === "decisions") {
    const result = await router.alpha.decisions.create({ decisionsRequest: { model: config.model, state: input, questions } });
    choices = Object.fromEntries(Object.keys(questions).map(id => {
      const answer = result.answers?.[id];
      return [id, answer?.type === "choice" && Number.isFinite(answer.confidence) && answer.confidence >= (id.endsWith("_action") ? 0.8 : 0) && answer.confidence <= 1 ? answer.choice : null];
    }));
    model = result.model;
  } else {
    const result = await router.chat.send({ chatRequest: {
      model: config.model, stream: false, temperature: 0, maxCompletionTokens: 1200,
      messages: [{ role: "system", content: "Prioritize diagnostic findings and choose a safe next step from each question's allowed criteria. Counts cannot establish root causes. Choose review/inspect if uncertain. Never execute actions." },
        { role: "user", content: JSON.stringify({ observations: input, questions }) }],
      responseFormat: { type: "json_schema", jsonSchema: { name: "diagnostic_plan", strict: true, schema: {
        type: "object", properties: Object.fromEntries(Object.entries(questions).map(([id, question]) => [id, { type: "string", enum: Object.keys(question.criteria) }])), required: Object.keys(questions), additionalProperties: false,
      } } },
    } });
    choices = JSON.parse(result.choices?.[0]?.message?.content ?? ""); model = result.model;
  }
  return { model, checked: input.checks.length, findings: findings.map(f => {
    const priority = Object.hasOwn(priorities, choices?.[f.id]) ? choices[f.id] : "review";
    const allowed = diagnosticActions(f.id);
    const choice = choices?.[`${f.id}_action`];
    const action = Object.hasOwn(allowed, choice) ? choice : "inspect";
    const dynamic = f.id.startsWith("issue-") ? [ISSUE_TITLES[f.id.slice(6)], "Review the affected files and the recorded cause before taking action."] : {
      "vault-storage": ["Vault storage needs review", "Review measured file, index and history sizes before deciding what to keep."],
      "vault-local": ["This vault is not synced", "Files are stored on this device. Connect the vault if you want a remote copy."],
      "vault-signed-out": ["Sign in to resume sync", "The vault cannot confirm remote changes while signed out."],
      "vault-offline": ["The vault is offline", "Check the connection before retrying sync."],
      "vault-no-access": ["Vault access needs attention", "Review your access with the vault owner."],
      "vault-connecting": ["Sync is still connecting", "Wait for the connection or inspect recent sync errors."],
      "remote-files": ["Files are missing from this device", "Compare local and remote files before downloading."],
      "local-files": ["Files exist only on this device", "Inspect sync support, plan limits and permissions for these files."],
    }[f.id];
    const [title, guidance] = CHECKS[f.id] ?? dynamic ?? ["Sync needs attention", "Inspect failing notes and their server-reported causes before retrying."];
    return { ...f, priority, label: priorities[priority], title, guidance, action, actionReason: allowed[action] };
  }).filter(f => f.id !== "vault-storage" || choices?.[f.id] !== "healthy").sort((a, b) => Object.keys(priorities).indexOf(a.priority) - Object.keys(priorities).indexOf(b.priority) || b.count - a.count || a.id.localeCompare(b.id)) };
}
