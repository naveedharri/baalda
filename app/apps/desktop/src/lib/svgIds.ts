// SPDX-License-Identifier: Apache-2.0

/** Scope generated inline SVG resources to one mounted instance. SVG fragment
 * references resolve across the HTML document, so DiceBear's shared mask IDs
 * can otherwise bind a large character to a small vault-icon mask. */
export function scopeSvgIds(svg: string, instance: string): string {
  const prefix = `baalda-svg-${instance.replace(/[^A-Za-z0-9_-]/g, "")}--`;
  const ids = new Map<string, string>();
  for (const match of svg.matchAll(/\bid="([^"]+)"/g)) {
    ids.set(match[1], prefix + match[1]);
  }
  return svg
    .replace(/\bid="([^"]+)"/g, (_, id: string) => `id="${ids.get(id)}"`)
    .replace(/url\(#([^\)]+)\)/g, (match, id: string) =>
      ids.has(id) ? `url(#${ids.get(id)})` : match)
    .replace(/\b((?:xlink:)?href)="#([^"]+)"/g, (match, attribute: string, id: string) =>
      ids.has(id) ? `${attribute}="#${ids.get(id)}"` : match);
}
