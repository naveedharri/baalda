// SPDX-License-Identifier: Apache-2.0
// Generate bounded, lossless candidates. Models select candidates; they never supply patches.
export function propertyRepair(content) {
  const eol = content.startsWith('---\r\n') ? '\r\n' : '\n';
  if (!content.startsWith(`---${eol}`)) return null;
  const lines = content.split(eol);
  const end = lines.findIndex((line, i) => i > 0 && line === '---');
  if (end < 0) {
    // A blank line is an explicit boundary. Only simple key/value lines qualify;
    // ambiguous prose, nested YAML, multiline scalars and empty blocks abstain.
    const boundary = lines.findIndex((line, i) => i > 0 && line === '');
    if (boundary < 2 || boundary >= lines.length - 1 || boundary > 100) return null;
    if (!lines.slice(1, boundary).every(line => /^[A-Za-z_][\w-]*: [^\r\n]+$/.test(line) && !/[>|]\s*$/.test(line))) return null;
    const before = lines.slice(0, boundary).join(eol) + eol;
    return { index: 0, before, after: before + '---' + eol, label: 'Close the properties block before the blank line' };
  }
  if (end > 100) return null;
  // Preserve malformed lines verbatim as a literal property. Never guess their keys.
  const block = lines.slice(1, end);
  const invalid = block.filter(line => line.trim() && !/^\s|^#|^- |^[^:]+:/.test(line));
  if (block.some(line => /^\s+\S|^- /.test(line))) return null;
  if (!invalid.length || block.some(line => /^recovered_properties\s*:/.test(line))) return null;
  const before = lines.slice(0, end + 1).join(eol);
  const kept = block.filter(line => !invalid.includes(line));
  const after = ['---', ...kept, 'recovered_properties: |', ...invalid.map(line => `  ${line}`), '---'].join(eol);
  return { index: 0, before, after, label: 'Keep malformed property lines under recovered_properties; preserve their text' };
}

export function titleRepair(source, notes, docId) {
  const note = notes.find(n => n.id === docId);
  if (!note?.title || !notes.some(n => n.id !== docId && n.title.toLowerCase() === note.title.toLowerCase())) return null;
  const qualifier = source.path.replace(/\.md$/i, '').replaceAll('/', ' · ');
  const used = new Set(notes.map(n => n.title.toLowerCase()));
  let title = `${note.title} — ${qualifier}`;
  for (let i = 2; used.has(title.toLowerCase()); i++) title = `${note.title} — ${qualifier} (${i})`;
  if (title.length > 400) return null;
  // Only change the actual title source: simple frontmatter title or the first H1.
  const fm = source.content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  const field = fm?.[0].match(/^title:[^\r\n]*$/m);
  if (field) return { index: field.index, before: field[0], after: `title: ${JSON.stringify(title)}`, label: `Use a distinct title: ${title}` };
  const start = fm?.[0].length ?? 0;
  const heading = source.content.slice(start).match(/^# [^\r\n]+/m);
  if (heading) return { index: start + heading.index, before: heading[0], after: `# ${title}`, label: `Use a distinct title: ${title}` };
  return { index: start, before: '', after: `# ${title}\n\n`, label: `Add a distinct title: ${title}` };
}
