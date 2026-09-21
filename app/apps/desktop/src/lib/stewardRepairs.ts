// SPDX-License-Identifier: Apache-2.0
import { legalSegment } from "./health/checkActions";

/** Deterministic candidates; never overwrite a sibling, including case-folded names. */
export function distinctRepairPath(path: string, occupied: ReadonlySet<string>, shorten = false): string | null {
  const segments = path.split("/");
  const name = segments.pop() ?? "";
  const parent = segments.length ? segments.join("/") + "/" : "";
  if (parent.length > 140 || !name || segments.some(s => legalSegment(s) !== s)) return null;
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot) : "";
  const stem = legalSegment(dot > 0 ? name.slice(0, dot) : name);
  const max = shorten ? Math.max(12, 180 - parent.length - ext.length - 12) : 120;
  for (let i = 1; i <= 100; i++) {
    const candidate = `${parent}${Array.from(stem).slice(0, max).join("")} (${i})${ext}`;
    if (candidate !== path && !occupied.has(candidate.toLowerCase())) return candidate;
  }
  return null;
}
