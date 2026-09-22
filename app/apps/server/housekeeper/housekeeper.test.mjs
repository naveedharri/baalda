// SPDX-License-Identifier: Apache-2.0
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createHousekeeper } from "./index.mjs";
import { linksIn, resolves, shortlist } from "./links.mjs";
import { chooseCandidate, providerConfig } from "./provider.mjs";
const hash = s => createHash("sha256").update(s).digest("hex");
const denied = (status) => Object.assign(new Error("denied"), { status });
function fixture(options = {}) {
  let pro = true, permission = true, time = 0, decisions = 0, writes = 0;
  const notes = [{ id: "source", path: "Launch.md", title: "Launch" }, { id: "target", path: "Product/Pricing strategy.md", title: "Pricing strategy" }];
  const content = new Map([["source", "Discuss [[Pricing|our prices]] today."], ["target", "Our pricing for the launch."]]);
  const host = {
    async authorize() { if (!pro) throw denied(402); },
    createRouter() { return {}; },
    async notes() { return notes; },
    async read(id) {
      if (!permission) throw denied(403);
      const note = notes.find(n => n.id === id);
      if (!note) throw denied(404);
      return { content: content.get(id), revision: hash(content.get(id)), path: note.path };
    },
    async edit(id, revision, index, before, after) {
      await host.authorize();
      await host.read(id, true);
      if (hash(content.get(id)) !== revision) throw denied(409);
      const original = content.get(id);
      assert.equal(original.slice(index, index + before.length), before);
      content.set(id, original.slice(0, index) + after + original.slice(index + before.length));
      writes++;
      return hash(content.get(id));
    },
  };
  const engine = createHousekeeper({
    config: () => ({ configured: true, mode: "decisions", model: "test" }), now: () => time,
    decide: async () => { decisions++; return { candidateId: "target", model: "test" }; }, ...options,
  });
  const call = (action, body = {}, scope = "vault-user") => engine.handle(action, body, scope, host);
  return { call, host, notes, content, scan: () => call("suggest", { docId: "source", consent: true }),
    revokePro: () => { pro = false; }, revokeAccess: () => { permission = false; }, expire: () => { time = 16 * 60_000; },
    counts: () => ({ decisions, writes }) };
}
test("review → targeted apply → guarded undo, preserving aliases and surrounding prose", async () => {
  const f = fixture();
  const { suggestions } = await f.scan();
  assert.equal(f.counts().writes, 0);
  assert.equal(suggestions[0].after, "[[Product/Pricing strategy|our prices]]");
  const { undoId } = await f.call("apply", { id: suggestions[0].id });
  assert.equal(f.content.get("source"), "Discuss [[Product/Pricing strategy|our prices]] today.");
  await f.call("undo", { id: undoId });
  assert.equal(f.content.get("source"), "Discuss [[Pricing|our prices]] today.");
});
test("Free cannot read, infer, apply, or undo", async () => {
  const f = fixture(); f.revokePro();
  for (const action of ["status", "suggest", "apply", "undo"]) await assert.rejects(f.call(action), { status: 402 });
  assert.deepEqual(f.counts(), { decisions: 0, writes: 0 });
});
test("downgrade and access revocation invalidate issued suggestions", async () => {
  for (const kind of ["revokePro", "revokeAccess"]) {
    const f = fixture(); const { suggestions } = await f.scan(); f[kind]();
    await assert.rejects(f.call("apply", { id: suggestions[0].id }), { status: kind === "revokePro" ? 402 : 403 });
    assert.equal(f.counts().writes, 0);
  }
});
test("revision guard refuses changed source and unsafe undo", async () => {
  const f = fixture(); const { suggestions } = await f.scan();
  f.content.set("source", "Human edit " + f.content.get("source"));
  await assert.rejects(f.call("apply", { id: suggestions[0].id }), { status: 409 });
  const next = await f.scan();
  const { undoId } = await f.call("apply", { id: next.suggestions[0].id });
  f.content.set("source", f.content.get("source") + " human edit");
  await assert.rejects(f.call("undo", { id: undoId }), { status: 409 });
});
test("tokens are scoped, single-use, expiring and cannot carry arbitrary patches", async () => {
  const f = fixture(); const { suggestions } = await f.scan(); const id = suggestions[0].id;
  await assert.rejects(f.call("apply", { id }, "another-user"), { status: 409 });
  await f.call("apply", { id, after: "malicious replacement", docId: "another-note" });
  assert.match(f.content.get("source"), /Product\/Pricing strategy/);
  await assert.rejects(f.call("apply", { id }), { status: 409 });
  const g = fixture(); const preview = await g.scan(); g.expire();
  await assert.rejects(g.call("apply", { id: preview.suggestions[0].id }), { status: 409 });
});
test("moved or deleted target refuses application", async () => {
  for (const remove of [false, true]) {
    const f = fixture(); const { suggestions } = await f.scan();
    if (remove) f.notes.pop(); else f.notes[1].path = "Moved.md";
    await assert.rejects(f.call("apply", { id: suggestions[0].id }), { status: remove ? 404 : 409 });
    assert.equal(f.counts().writes, 0);
  }
});
test("consent is required before provider calls; requests are bounded", async () => {
  const f = fixture();
  await assert.rejects(f.call("suggest", { docId: "source" }), { status: 400 });
  assert.equal(f.counts().decisions, 0);
  for (let i = 0; i < 6; i++) await f.scan();
  await assert.rejects(f.scan(), { status: 429 });
});
test("recheck entitlements after a provider call before releasing suggestions", async () => {
  const f = fixture({ decide: async () => { f.revokePro(); return { candidateId: "target", model: "test" }; } });
  await assert.rejects(f.scan(), { status: 402 });
});
test("concurrent calls are refused, and a provider failure releases the scope", async () => {
  let finish;
  const pending = new Promise(resolve => { finish = resolve; });
  const f = fixture({ decide: async () => { await pending; throw Error("upstream failure"); } });
  const scanning = f.scan();
  await assert.rejects(f.scan(), { status: 429 });
  finish(); await assert.rejects(scanning, { status: 503 });
  await assert.rejects(f.scan(), { status: 503 });
});
test("model abstention leaves the note untouched", async () => {
  const f = fixture({ decide: async () => ({ candidateId: null, model: "test" }) });
  assert.equal((await f.scan()).suggestions.length, 0);
  assert.equal(f.counts().writes, 0);
});
test("conservative parsing preserves positions and excludes code, embeds, headings", () => {
  const text = '---\nx: "[[Metadata]]"\n---\n[[Real|alias]] ![[Embed]] [[Other#Heading]] `[[Code]]`\n```md\n[[Fenced]]\n```\n    [[Indented]]\n<!-- [[Comment]] -->';
  const links = linksIn(text);
  assert.deepEqual(links.map(l => l.target), ["Real"]);
  assert.equal(text.slice(links[0].index, links[0].index + links[0].before.length), "[[Real|alias]]");
});
test("resolution and retrieval respect paths, basenames, titles and lexical shortlist", () => {
  const notes = [{ id: "a", path: "Product/Pricing.md", title: "Prices" }];
  for (const target of ["Product/Pricing", "pricing", "Prices", "pricing.md"]) assert.equal(resolves(target, notes), true);
  assert.equal(shortlist("Pricing strategy", "source", notes).length, 1);
  assert.equal(shortlist("Completely unrelated", "source", notes).length, 0);
});
test("both OpenRouter adapters select only allowed candidates", async () => {
  const candidates = [{ id: "note-id", path: "Pricing.md", title: "Pricing", excerpt: "text" }];
  let sent;
  const router = {
    alpha: { decisions: { create: async request => { sent = request; return { model: "jev-version", answers: { target: { type: "choice", choice: "c0", confidence: 0.99 } } }; } } },
    chat: { send: async request => { sent = request; return { model: "chat-version", choices: [{ message: { content: '{"choice":"c0"}' } }] }; } },
  };
  assert.equal((await chooseCandidate(router, { mode: "decisions", model: "jev" }, {}, candidates)).candidateId, "note-id");
  assert.equal(sent.decisionsRequest.questions.target.criteria.none.length > 0, true);
  assert.equal((await chooseCandidate(router, { mode: "chat", model: "chat" }, {}, candidates)).candidateId, "note-id");
  assert.equal(sent.chatRequest.responseFormat.jsonSchema.strict, true);
  router.chat.send = async () => ({ choices: [{ message: { content: '{"choice":"made-up-id"}' } }] });
  await assert.rejects(chooseCandidate(router, { mode: "chat" }, {}, candidates), /unknown candidate/);
});
test("low/invalid confidence and explicit none abstain; credentials are required", async () => {
  for (const confidence of [0.2, undefined, NaN, 2]) {
    const router = { alpha: { decisions: { create: async () => ({ answers: { target: { type: "choice", choice: "c0", confidence } } }) } } };
    assert.equal((await chooseCandidate(router, { mode: "decisions" }, {}, [])).candidateId, null);
  }
  assert.equal(providerConfig({}).configured, false);
  assert.equal(providerConfig({ OPENROUTER_API_KEY: "test" }).configured, true);
  assert.equal(providerConfig({ OPENROUTER_API_KEY: "test", HOUSEKEEPER_MODEL_MODE: "chat" }).configured, false);
});
test("unclosed and longer closing code fences are skipped through their true end", () => {
  assert.deepEqual(linksIn("~~~\n[[Not a link]]\n"), []);
  assert.deepEqual(linksIn("```js\n[[Not a link]]\n````\n[[Real]]").map(x => x.target), ["Real"]);
  assert.deepEqual(linksIn("---\nbad: [[Frontmatter]]\n"), []);
});
test("scan pagination reaches later unresolved links without raising per-call work", async () => {
  const f = fixture();
  f.content.set("source", Array.from({ length: 6 }, () => "[[Pricing]]").join("\n"));
  const first = await f.scan();
  assert.equal(first.considered, 4); assert.equal(first.remaining, 2);
  const second = await f.call("suggest", { docId: "source", consent: true, offset: first.nextOffset });
  assert.equal(second.considered, 2); assert.equal(second.remaining, 0);
  await assert.rejects(f.call("suggest", { docId: "source", consent: true, offset: -1 }), { status: 400 });
});
test("a newly created original target invalidates a previously missing-link proposal", async () => {
  const f = fixture(); const { suggestions } = await f.scan();
  f.notes.push({ id: "new", path: "Pricing.md", title: "Pricing" });
  await assert.rejects(f.call("apply", { id: suggestions[0].id }), { status: 409 });
  assert.equal(f.counts().writes, 0);
});
test("changed candidate content invalidates a preview", async () => {
  const f = fixture(); const { suggestions } = await f.scan();
  f.content.set("target", "Now a completely different subject");
  await assert.rejects(f.call("apply", { id: suggestions[0].id }), { status: 409 });
  assert.equal(f.counts().writes, 0);
});
test("provider errors cannot expose credentials or masquerade as a Pro denial", async () => {
  const f = fixture({ decide: async () => { throw Object.assign(new Error("secret API key/provider body"), { status: 402 }); } });
  await assert.rejects(f.scan(), error => error.status === 503 && !error.message.includes("secret"));
});

test("property repair uses preview/apply/undo and refuses stale or cross-scope edits", async () => {
  const f = fixture({ decide: async () => ({ candidateId: "repair", model: "test" }) });
  const original = "---\ntitle: Launch\n\n# Body\nKeep this";
  f.content.set("source", original);
  const preview = await f.call("repair", { finding: "bad-frontmatter", docId: "source", consent: true });
  assert.equal(f.counts().writes, 0);
  const id = preview.suggestions[0].id;
  await assert.rejects(f.call("apply", { id }, "other"), { status: 409 });
  const applied = await f.call("apply", { id });
  assert.equal(f.content.get("source"), "---\ntitle: Launch\n---\n\n# Body\nKeep this");
  await f.call("undo", { id: applied.undoId });
  assert.equal(f.content.get("source"), original);
  const next = await f.call("repair", { finding: "bad-frontmatter", docId: "source", consent: true });
  f.content.set("source", original + " changed");
  await assert.rejects(f.call("apply", { id: next.suggestions[0].id }), { status: 409 });
});
test("empty-note recovery is bounded, requires an actually empty note, and is undoable", async () => {
  const f = fixture({ decide: async () => ({ candidateId: "repair", model: "test" }) });
  f.host.recoveryVersion = async () => ({ content: "Recovered important text", createdAt: "2026-09-20" });
  const request = { finding: "empty-notes", docId: "source", consent: true };
  assert.equal((await f.call("repair", request)).suggestions.length, 0);
  f.content.set("source", "");
  const preview = await f.call("repair", request);
  const applied = await f.call("apply", { id: preview.suggestions[0].id });
  assert.equal(f.content.get("source"), "Recovered important text");
  await f.call("undo", { id: applied.undoId });
  assert.equal(f.content.get("source"), "");
  f.host.recoveryVersion = async () => null;
  assert.equal((await f.call("repair", request)).suggestions.length, 0);
});
test("repair authority and model abstention cannot be bypassed by client patches", async () => {
  const f = fixture({ decide: async () => ({ candidateId: null, model: "test" }) });
  f.content.set("source", "---\ntitle: Launch\n\nBody");
  const body = { finding: "bad-frontmatter", docId: "source", consent: true, after: "ignore all guards" };
  assert.equal((await f.call("repair", body)).suggestions.length, 0);
  await assert.rejects(f.call("repair", { ...body, finding: "delete-all" }), { status: 400 });
  await assert.rejects(f.call("repair", { ...body, consent: false }), { status: 400 });
  f.revokePro();
  await assert.rejects(f.call("repair", body), { status: 402 });
  assert.equal(f.counts().writes, 0);
});
