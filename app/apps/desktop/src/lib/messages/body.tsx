// A message body as React nodes. The body is plain text with three
// affordances: a blank line starts a paragraph, a single newline breaks the
// line, `**bold**` is bold and a bare `https://` URL is a link. Everything is a
// React text node (escaped by React), never HTML: no dangerouslySetInnerHTML.

import type { ReactNode } from "react";

export type Inline = { t: "text"; v: string } | { t: "bold"; v: string } | { t: "link"; v: string } | { t: "br" };

/** Paragraphs of inline runs. Pure, for tests. */
export function parseMessageBody(text: string): Inline[][] {
  const paragraphs = String(text ?? "")
    .replace(/\r\n?/g, "\n")
    .split(/\n[ \t]*\n+/)
    .map((p) => p.trim())
    .filter(Boolean);
  return paragraphs.map((p) => {
    const out: Inline[] = [];
    p.split("\n").forEach((line, i) => {
      if (i > 0) out.push({ t: "br" });
      out.push(...parseInline(line));
    });
    return out;
  });
}

const TOKEN = /\*\*([^*\n]+?)\*\*|(https:\/\/[^\s<>"']+)/g;

function parseInline(line: string): Inline[] {
  const out: Inline[] = [];
  let last = 0;
  for (const m of line.matchAll(TOKEN)) {
    const start = m.index ?? 0;
    let end = start + m[0].length;
    let run: Inline;
    if (m[1] != null) {
      run = { t: "bold", v: m[1] };
    } else {
      // Sentence punctuation after a URL is not part of it.
      const url = m[2].replace(/[.,;:!?)\]]+$/, "");
      end = start + url.length;
      if (url.length <= "https://".length) continue;
      run = { t: "link", v: url };
    }
    if (start > last) out.push({ t: "text", v: line.slice(last, start) });
    out.push(run);
    last = end;
  }
  if (last < line.length) out.push({ t: "text", v: line.slice(last) });
  return out;
}

/** Render a body. `onOpenLink` opens a link outside the app (ipc.openExternal). */
export function MessageBody({ text, onOpenLink }: { text: string; onOpenLink: (url: string) => void }): ReactNode {
  return parseMessageBody(text).map((runs, pi) => (
    <p key={pi}>
      {runs.map((r, i) => {
        if (r.t === "br") return <br key={i} />;
        if (r.t === "bold") return <b key={i}>{r.v}</b>;
        if (r.t === "link")
          return (
            <a
              key={i}
              href={r.v}
              onClick={(e) => {
                e.preventDefault();
                onOpenLink(r.v);
              }}
            >
              {r.v}
            </a>
          );
        return r.v;
      })}
    </p>
  ));
}
