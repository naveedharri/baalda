// SPDX-License-Identifier: Apache-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { propertyRepair, titleRepair } from './repairs.mjs';

test('closes an unambiguous property block without losing body bytes', () => {
  for (const eol of ['\n', '\r\n']) {
    const original = ['---', 'title: Example', '', '# Body', 'Keep all text'].join(eol);
    const patch = propertyRepair(original);
    assert.ok(patch);
    assert.equal(patch.after + original.slice(patch.before.length), ['---', 'title: Example', '---', '', '# Body', 'Keep all text'].join(eol));
  }
});
test('property repairs abstain on ambiguous boundaries and preserve malformed text', () => {
  for (const text of ['---\nplain prose\n\nBody', '---\nbody: |\n\n prose', '---\ntitle: A\n', 'no properties']) assert.equal(propertyRepair(text), null);
  const patch = propertyRepair('---\ntitle: Good\nbroken text\n: orphan\n---\nBody');
  assert.equal(patch.after, '---\ntitle: Good\nrecovered_properties: |\n  broken text\n  : orphan\n---');
  assert.equal(propertyRepair(patch.after + '\nBody'), null);
});
test('duplicate title repairs preserve body and choose a distinct title', () => {
  const notes = [{ id: 'a', path: 'Work/Plan.md', title: 'Plan' }, { id: 'b', path: 'Home/Plan.md', title: 'Plan' }];
  const source = { path: notes[0].path, content: '---\ntitle: Plan\n---\n# Keep this\nBody' };
  const patch = titleRepair(source, notes, 'a');
  assert.equal(source.content.slice(patch.index, patch.index + patch.before.length), 'title: Plan');
  assert.equal(patch.after, 'title: "Plan — Work · Plan"');
  assert.equal(titleRepair(source, [notes[0]], 'a'), null);
});
