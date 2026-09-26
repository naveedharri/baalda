/**
 * Release-note parsing for the What's New modal.
 *
 * The GitHub release body arrives as `latest.json`'s `notes` and is whatever
 * `.github/workflows/release.yml` put there — normally the ONE `## <version>`
 * section of `docs/RELEASE_NOTES.md` that matches the version being released.
 * `notesForVersion` is the belt to that workflow's braces: a body that still
 * carries several sections (an older release, a hand-edited body, a staging
 * build whose notes append the queued section under the tester warning) is
 * narrowed to the version the user actually received, so an update can never
 * show points from a release they installed weeks ago.
 */

/** A `## 0.1.61` heading line, with any surrounding whitespace. */
const HEADING = /^[ \t]*##[ \t]+(.+?)[ \t]*$/;

/** Strip `<!-- … -->` blocks, including multi-line ones. */
function stripHtmlComments(body: string): string {
  return body.replace(/<!--[\s\S]*?-->/g, "");
}

/** `0.1.61`, `v0.1.61` and `## 0.1.61` all name the same release. */
function normalizeVersion(raw: string): string {
  return raw.trim().replace(/^v/i, "").toLowerCase();
}

/**
 * Narrow a release body to the section for `version`.
 *
 * - No `## ` heading anywhere → the body is already one release's notes, so it
 *   comes back whole.
 * - A heading matches → only that section's lines.
 * - No heading matches (or no version given) → the FIRST section, which is the
 *   newest one by the file's newest-first rule.
 *
 * Lines before the first heading are preamble, never part of a section.
 */
export function notesForVersion(
  body: string | null | undefined,
  version?: string | null,
): string {
  if (!body) return "";
  const lines = stripHtmlComments(body).split(/\r?\n/);
  const want = version ? normalizeVersion(version) : null;

  const sections: { name: string; lines: string[] }[] = [];
  let current: { name: string; lines: string[] } | null = null;
  let sawHeading = false;
  for (const line of lines) {
    const m = HEADING.exec(line);
    if (m) {
      sawHeading = true;
      current = { name: normalizeVersion(m[1]), lines: [] };
      sections.push(current);
      continue;
    }
    if (current) current.lines.push(line);
  }

  if (!sawHeading) return stripHtmlComments(body);
  if (sections.length === 0) return "";

  const picked =
    (want != null ? sections.find((s) => s.name === want) : undefined) ??
    sections[0];
  return picked.lines.join("\n");
}

/**
 * The release body as display lines: bullets and bold markers unwrapped,
 * headings and the shippable-fallback placeholder dropped, capped at `max`.
 *
 * Five is deliberate. A release section is written as 2–5 combined points, so
 * the cap is a guard against a hand-written body rather than a summary of a
 * long list — a modal that scrolls is a modal nobody reads.
 */
export function releaseNoteLines(
  notes: string | null | undefined,
  max = 5,
): string[] {
  if (!notes) return [];
  return stripHtmlComments(notes)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .filter((line) => !line.startsWith("See the assets below"))
    .map((line) => line.replace(/^[-*•]\s+/, ""))
    .map((line) => line.replace(/\*\*(.+?)\*\*/g, "$1"))
    .slice(0, max);
}

/**
 * The release workflows append this to a release body whose version section in
 * `docs/RELEASE_NOTES.md` was left empty: "ship it, but don't announce it". It
 * is an HTML comment, so the GitHub release page never shows it.
 */
export const SILENT_RELEASE_MARKER = "<!-- baalda:silent -->";

/**
 * Should the What's New modal stay closed for this update? Yes when the
 * workflow marked it silent, and yes when there is nothing to list anyway — a
 * modal that says "here's what changed" over an empty list tells the user an
 * update happened and nothing else.
 */
export function isSilentRelease(
  body: string | null | undefined,
  version?: string | null,
): boolean {
  if (body?.includes(SILENT_RELEASE_MARKER)) return true;
  return releaseNoteLines(notesForVersion(body, version)).length === 0;
}
