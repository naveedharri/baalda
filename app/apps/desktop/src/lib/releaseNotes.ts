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

/**
 * A `video: https://youtu.be/<id> "Title"` line in a release section: the
 * video What's New offers above the notes. Never a note line itself.
 */
const VIDEO_LINE = /^[ \t]*video:[ \t]*(\S+)(?:[ \t]+"([^"]*)")?[ \t]*$/i;

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
    .filter((line) => !VIDEO_LINE.test(line))
    .map((line) => line.replace(/^[-*•]\s+/, ""))
    .map((line) => line.replace(/\*\*(.+?)\*\*/g, "$1"))
    .slice(0, max);
}

/**
 * The same lines as `releaseNoteLines`, split into a title and a detail when
 * the line opens with a bold phrase ("**Encrypted vaults.** New vaults…").
 * A line without one is all detail.
 */
export function releaseNoteItems(
  notes: string | null | undefined,
  max = 5,
): { title: string; detail: string }[] {
  if (!notes) return [];
  return stripHtmlComments(notes)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .filter((line) => !line.startsWith("See the assets below"))
    .filter((line) => !VIDEO_LINE.test(line))
    .map((line) => line.replace(/^[-*•]\s+/, ""))
    .slice(0, max)
    .map((line) => {
      const m = /^\*\*(.+?)\*\*[\s,.:]*(.*)$/.exec(line);
      const strip = (t: string) => t.replace(/\*\*(.+?)\*\*/g, "$1").trim();
      if (!m) return { title: "", detail: strip(line) };
      return { title: strip(m[1]).replace(/[.:]$/, ""), detail: strip(m[2]) };
    });
}

/** A YouTube video a release section offers in What's New. */
export type ReleaseVideo = { id: string; url: string; title: string };

const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;

/**
 * The video id of a YouTube link: youtu.be/<id>, youtube.com/watch?v=<id>,
 * /embed/, /shorts/ and /live/, on youtube.com, its www./m. hosts and
 * youtube-nocookie.com. Anything else is null, so a typo shows no video
 * rather than a broken player.
 */
export function youtubeVideoId(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const host = url.hostname.toLowerCase().replace(/^(www|m)\./, "");
  let id: string | null = null;
  if (host === "youtu.be") id = url.pathname.split("/")[1] ?? null;
  else if (host === "youtube.com" || host === "youtube-nocookie.com") {
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts[0] === "watch") id = url.searchParams.get("v");
    else if (["embed", "shorts", "live", "v"].includes(parts[0] ?? "")) id = parts[1] ?? null;
  }
  return id && YOUTUBE_ID.test(id) ? id : null;
}

/**
 * The video a release section offers, from its first `video:` line:
 * `video: https://youtu.be/AbC123xyz_0 "Access groups in two minutes"`.
 * The title is optional. Null when there is none or the link is not YouTube.
 */
export function releaseNoteVideo(notes: string | null | undefined): ReleaseVideo | null {
  if (!notes) return null;
  for (const line of stripHtmlComments(notes).split(/\r?\n/)) {
    const m = VIDEO_LINE.exec(line);
    if (!m) continue;
    const id = youtubeVideoId(m[1]);
    if (!id) continue;
    return { id, url: `https://www.youtube.com/watch?v=${id}`, title: (m[2] ?? "").trim() };
  }
  return null;
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
  const section = notesForVersion(body, version);
  return releaseNoteLines(section).length === 0 && releaseNoteVideo(section) == null;
}
