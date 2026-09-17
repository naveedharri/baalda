// The editor's one HTML sanitizer: it turns an untrusted HTML fragment into
// real DOM that renders but cannot run.
//
// A note is untrusted input — it arrives over the CRDT from a teammate, from an
// AI through MCP, or from a file someone dropped into the vault — and this is
// the only `innerHTML` in the editor (see `ofm/sanitise.test.ts`). It lived
// inside `livePreview.ts` while raw HTML blocks were its only caller; the docx
// viewer renders mammoth's output through the same rules rather than an iframe,
// so it moved out here unchanged. `isDangerousUrl` stays in `urlSafety.ts`,
// shared with the mermaid sanitizer.

import { isDangerousUrl } from "./urlSafety";

/** Turns an image `src` into a webview-loadable URL (see CreateEditorOptions). */
export type ResolveAsset = (src: string) => string;

/** Tags that could execute code or leak styles — dropped entirely. */
export const BLOCKED_HTML_TAGS = new Set([
  "SCRIPT",
  "STYLE",
  "LINK",
  "IFRAME",
  "OBJECT",
  "EMBED",
  "META",
  "BASE",
]);

/**
 * Render an embedded HTML fragment into `target` as real DOM so it flows inline
 * with the surrounding Markdown — a heading, an image, a paragraph, all in the
 * one note. It's a *render, never a run*: `<script>`/`<style>`/frames are
 * dropped, every `on*` handler and `javascript:` URL is stripped, and anchors
 * are rewired to open externally (a raw `<a href>` would otherwise navigate the
 * whole app away). `DOMParser` splits head/body even for a full-document paste,
 * so `<!DOCTYPE html>…<body>…` renders just its body content.
 */
export function renderEmbeddedHtml(
  target: HTMLElement,
  html: string,
  resolveAsset: ResolveAsset,
) {
  const parsed = new DOMParser().parseFromString(html, "text/html");
  parsed.querySelectorAll("*").forEach((el) => {
    // Uppercase so a foreign-content (SVG/MathML) <script> — whose tagName is
    // lowercase — is caught by the same blocklist as an HTML one.
    if (BLOCKED_HTML_TAGS.has(el.tagName.toUpperCase())) {
      el.remove();
      return;
    }
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      const isUrlAttr = name === "href" || name === "src" || name === "xlink:href";
      if (name.startsWith("on")) {
        // Inline event handlers.
        el.removeAttribute(attr.name);
      } else if (name === "style") {
        // Inline styles enable full-screen fixed overlays / UI spoofing.
        el.removeAttribute(attr.name);
      } else if (isUrlAttr && isDangerousUrl(attr.value)) {
        el.removeAttribute(attr.name);
      }
    }
    // Point <img> at a loadable URL so vault-local images actually display.
    if (el.tagName === "IMG") {
      const src = el.getAttribute("src");
      if (src) el.setAttribute("src", resolveAsset(src));
    }
    // Rewire links so a click opens externally instead of hijacking the window.
    if (el.tagName === "A") {
      const href = el.getAttribute("href") ?? "";
      el.removeAttribute("href");
      if (/^(https?:|mailto:)/i.test(href)) {
        el.setAttribute("data-href", href);
        el.classList.add("cm-md-link");
      }
    }
  });
  target.innerHTML = parsed.body.innerHTML;
}
