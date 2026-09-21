// SPDX-License-Identifier: Apache-2.0
const normalize = (s) => s.trim().replace(/\.md$/, "").toLowerCase();
const basename = (s) => s.split("/").pop();

/** Conservative MVP: plain wikilinks only; skip embeds, code, comments and frontmatter. */
export function linksIn(content) {
  let fence = null;
  const withoutFrontmatter = content.replace(/^---\r?\n[\s\S]*?(?:\r?\n---(?:\r?\n|$)|$)/, blank);
  const masked = withoutFrontmatter.split(/(?<=\n)/).map(line => {
    const marker = line.trimEnd().match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = null;
      return blank(line);
    }
    if (marker) { fence = marker[1]; return blank(line); }
    return line;
  }).join("")
    .replace(/<!--[^]*?(?:-->|$)/g, blank)
    .replace(/(`+)[^]*?\1/g, blank)
    .replace(/^(?: {4}|\t| {0,3}>).*$/gm, blank);
  const matches = [];
  for (const match of masked.matchAll(/(?<!!)\[\[([^\]\n]+)\]\]/g)) {
    if (match.index > 0 && content[match.index - 1] === "\\") continue;
    const raw = match[1];
    const target = raw.split(/[|#]/, 1)[0].trim();
    // Preserve aliases; headings need heading validation, deferred for this MVP.
    if (raw.length > 400 || !target || raw.includes("#") || target.length > 200) continue;
    matches.push({ index: match.index, before: content.slice(match.index, match.index + match[0].length), target,
      alias: raw.includes("|") ? raw.slice(raw.indexOf("|")) : "" });
  }
  return matches;
}
function blank(s) { return s.replace(/[^\n\r]/g, " "); }

export function resolves(target, notes) {
  const name = normalize(target), base = basename(name);
  return notes.some(n => normalize(n.path) === name || normalize(basename(n.path)) === base || normalize(n.title) === name);
}
const words = s => new Set(normalize(s).split(/[^\p{L}\p{N}]+/u).filter(Boolean));
export function shortlist(target, sourceId, notes) {
  const wanted = words(target);
  return notes.filter(n => n.id !== sourceId && n.path.length <= 1000 && /\.md$/i.test(n.path) && !/[\[\]|#\r\n]/.test(n.path))
    .map(n => {
      const terms = words(`${n.path} ${n.title}`);
      let overlap = 0;
      for (const word of wanted) if (terms.has(word)) overlap++;
      return { note: n, score: overlap / Math.max(1, wanted.size) };
    }).filter(n => n.score > 0).sort((a, b) => b.score - a.score || a.note.id.localeCompare(b.note.id))
    .slice(0, 8).map(n => n.note);
}
