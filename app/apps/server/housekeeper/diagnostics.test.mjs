// SPDX-License-Identifier: Apache-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CHECKS, validateDiagnostics, reviewDiagnostics } from './diagnostics.mjs';
const input = () => ({ checks: Object.keys(CHECKS).map(id => ({ id, count: 0 })), sync: { pending: 0, failed: 0, unsynced: 0 } });
test('diagnostics require consent, complete checks, and strip private fields', () => {
  const diagnostics = input();
  assert.throws(() => validateDiagnostics({ diagnostics }), { status: 400 });
  assert.throws(() => validateDiagnostics({ consent: true, diagnostics: { ...diagnostics, checks: [] } }), { status: 400 });
  assert.deepEqual(validateDiagnostics({ consent: true, diagnostics: { ...diagnostics, text: 'private' } }), diagnostics);
});
test('empty diagnostics avoid inference; Jev batches findings and keeps uncertain actions as inspection', async () => {
  const config = { model: 'typesafe/jev-1.13', mode: 'decisions' };
  assert.equal((await reviewDiagnostics({}, config, input())).findings.length, 0);
  const observations = input(); observations.checks[0].count = 2;
  const router = { alpha: { decisions: { create: async ({ decisionsRequest }) => {
    assert.equal(Object.keys(decisionsRequest.questions).length, 2);
    return { model: config.model, answers: { 'empty-notes': { type: 'choice', confidence: 0.5, choice: 'now' } } };
  } } } };
  assert.equal((await reviewDiagnostics(router, config, observations)).findings[0].action, 'inspect');
});

test('actions are selected only from each finding capability list', async () => {
  const observations = input(); observations.checks.find(c => c.id === 'stale-index').count = 2;
  const router = { alpha: { decisions: { create: async () => ({ model: 'jev', answers: {
    'stale-index': { type: 'choice', confidence: .95, choice: 'soon' },
    'stale-index_action': { type: 'choice', confidence: .95, choice: 'delete-all' },
  } }) } } };
  const rejected = await reviewDiagnostics(router, { mode: 'decisions', model: 'jev' }, observations);
  assert.equal(rejected.findings[0].action, 'inspect');
  router.alpha.decisions.create = async () => ({ model: 'jev', answers: { 'stale-index_action': { type: 'choice', confidence: .95, choice: 'rebuild-index' } } });
  assert.equal((await reviewDiagnostics(router, { mode: 'decisions', model: 'jev' }, observations)).findings[0].action, 'rebuild-index');
});

test('vault context adds actual sync failures and allows ordinary storage to pass', async () => {
  const observations = input();
  observations.context = { verdict: 'attention', totalNotes: 10, totalFiles: 10, contentBytes: 1000, historyBytes: 50, indexBytes: 20, largestFileBytes: 200, serverState: 'current', serverOnlyFiles: 1, deviceOnlyFiles: 0, issues: [{ kind: 'too-large', count: 1 }] };
  const router = { alpha: { decisions: { create: async ({ decisionsRequest }) => {
    assert.ok(decisionsRequest.questions['issue-too-large']);
    assert.ok(decisionsRequest.questions['remote-files']);
    return { model: 'jev', answers: { 'vault-storage': { type: 'choice', confidence: .6, choice: 'healthy' }, 'issue-too-large': { type: 'choice', confidence: .7, choice: 'now' } } };
  } } } };
  const result = await reviewDiagnostics(router, { mode: 'decisions', model: 'jev' }, observations);
  assert.equal(result.findings[0].id, 'issue-too-large');
  assert.ok(!result.findings.some(f => f.id === 'vault-storage'));
  const clean = validateDiagnostics({ consent: true, diagnostics: { ...observations, context: { ...observations.context, rawError: 'private', path: 'secret.md' } } });
  assert.equal(clean.context.path, undefined);
  assert.equal(clean.context.rawError, undefined);
});
