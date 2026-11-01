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
  "FRAME",
  "FRAMESET",
  "PORTAL",
  "FENCEDFRAME",
]);

const MATHML_NS = "http://www.w3.org/1998/Math/MathML";

/** Attributes that make a click or submit navigate the app window. */
const NAVIGATING_ATTRS = new Set(["action", "formaction", "formtarget", "target", "ping"]);

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
    const tag = el.tagName.toUpperCase();
    if (BLOCKED_HTML_TAGS.has(tag)) {
      el.remove();
      return;
    }
    // A form submit would navigate the whole app window (the main CSP has no
    // form-action): keep its contents as inert markup, drop the form itself.
    if (tag === "FORM") {
      const box = parsed.createElement("div");
      while (el.firstChild) box.appendChild(el.firstChild);
      el.replaceWith(box);
    }
    // Only an HTML/SVG anchor or an image-map area may carry a link, and those
    // are rewired below; `href` anywhere else (MathML) is dropped.
    const isLink = tag === "A" || tag === "AREA";
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      const isUrlAttr = name === "href" || name === "src" || name === "xlink:href";
      if (NAVIGATING_ATTRS.has(name) || (!isLink && name === "href" && el.namespaceURI === MATHML_NS)) {
        el.removeAttribute(attr.name);
      } else if (name.startsWith("on")) {
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
    // Case-insensitive: an SVG <a> has a lowercase tagName and used to keep
    // its live https href (a look-alike page could replace the app).
    if (isLink) {
      const href = el.getAttribute("href") ?? el.getAttribute("xlink:href") ?? "";
      el.removeAttribute("href");
      el.removeAttribute("xlink:href");
      if (/^(https?:|mailto:)/i.test(href)) {
        el.setAttribute("data-href", href);
        el.classList.add("cm-md-link");
      }
    }
  });
  target.innerHTML = parsed.body.innerHTML;
}
