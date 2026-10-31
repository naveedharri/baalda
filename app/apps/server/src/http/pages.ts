import { BRAND_NAME } from "../brand.js";
import { GLYPH_FAVICON_DATA_URI, WORDMARK_INK_DATA_URI } from "../brand-assets.js";
import { FONT_FACE_CSS } from "./fonts.js";

/**
 * Shared chrome for every human-facing page this headless server renders: the
 * MCP OAuth login/consent screens (routes/oauth-connect.ts) and the account
 * pages — password reset, email verified, invitation landing
 * (routes/account-pages.ts). One light card in the baalda.com style, the official wordmark embedded as a
 * data URI so nothing depends on a static-file host. Branded with the Baalda
 * logos (see brand-assets.ts / docs/BRANDING.md).
 */

export function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Light, matching baalda.com: warm off-white page, white card, ink type, pill buttons. */
export function page(opts: { title: string; body: string; head?: string; wide?: boolean }): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>${esc(opts.title)} · ${esc(BRAND_NAME)}</title>
<link rel="icon" href="${GLYPH_FAVICON_DATA_URI}" />
<style>
${FONT_FACE_CSS}
  :root {
    color-scheme: light;
    --ink: #030302; --muted: #737373; --faint: #a3a3a3;
    --line: rgba(3,3,2,0.10); --line-strong: rgba(3,3,2,0.22);
    --violet: #7c5cff; --green: #3f8850;
    --display: "Radio Canada Big", "Inter", -apple-system, BlinkMacSystemFont, sans-serif;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px;
    font: 15px/1.5 "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
    color: var(--ink); background: #fcf9f7;
    background-image: radial-gradient(70% 55% at 50% 0%, rgba(124,92,255,0.16), transparent 70%);
    background-repeat: no-repeat;
    -webkit-font-smoothing: antialiased;
  }
  .card {
    width: 100%; max-width: 420px; background: #fff;
    border: 1px solid rgba(3,3,2,0.07); border-radius: 24px; padding: 36px 32px;
    box-shadow: 0 30px 60px -20px rgba(48,32,140,0.16), 0 2px 6px rgba(3,3,2,0.04);
  }
  .wordmark { display:block; height: 22px; margin: 2px auto 26px; object-fit: contain; }
  h1 { font-family: var(--display); font-size: 26px; line-height: 1.15; font-weight: 600; margin: 0 0 8px;
       text-align: center; letter-spacing: -0.025em; }
  .sub { color: var(--muted); text-align: center; margin: 0 0 26px; font-size: 14px; }
  .sub b { color: var(--ink); font-weight: 500; }
  label { display:block; font-size: 13px; font-weight: 500; color: #404040; margin: 0 0 6px; }
  input[type=email], input[type=password], input[type=search] {
    width: 100%; padding: 11px 14px; margin-bottom: 15px; font: inherit; font-size: 14px; color: var(--ink);
    background: #fff; border: 1px solid var(--line); border-radius: 12px;
    transition: border-color .15s, box-shadow .15s;
  }
  input::placeholder { color: var(--faint); }
  input:focus { outline: none; border-color: rgba(124,92,255,0.6); box-shadow: 0 0 0 4px rgba(124,92,255,0.14); }
  button, .btn {
    width: 100%; height: 46px; padding: 0 20px; font-size: 14.5px; font-weight: 500; border-radius: 999px;
    border: 0; cursor: pointer; font-family: inherit; text-align: center;
    transition: background .15s, box-shadow .2s, transform .15s;
  }
  .btn { display: inline-flex; align-items: center; justify-content: center; }
  .primary { background: var(--ink); color: #fff; box-shadow: 0 8px 16px -6px rgba(3,3,2,0.35); }
  .primary:hover { background: #262624; box-shadow: 0 12px 22px -8px rgba(3,3,2,0.4); }
  .primary:disabled { opacity: .5; cursor: default; }
  .ghost {
    background: #fff; color: var(--ink); box-shadow: inset 0 0 0 1px rgba(3,3,2,0.15);
    display:flex; align-items:center; justify-content:center; gap:9px; margin-top: 4px; text-decoration:none;
  }
  .ghost:hover { box-shadow: inset 0 0 0 1px rgba(3,3,2,0.35); }
  .divider { display:flex; align-items:center; gap:12px; color: var(--faint); font-size:12px; margin: 18px 0; }
  .divider::before, .divider::after { content:""; height:1px; flex:1; background: var(--line); }
  .err { background: #fdf0f0; border:1px solid #f4cccc; color:#a32020;
         padding:10px 12px; border-radius:12px; font-size:13px; margin-bottom:16px; }
  .ok { background: #eef7f0; border:1px solid #cbe5d2; color:#2c6a3c;
        padding:10px 12px; border-radius:12px; font-size:13px; margin-bottom:16px; }
  .card.wide { max-width: 960px; min-width: 0; padding: 40px 40px 32px; }
  .ws-head { display:flex; align-items:center; justify-content:space-between; gap:16px; margin: 0 0 14px; }
  .ws-head label { margin:0; font-size:12px; color: var(--muted); font-weight:500; text-transform: uppercase;
        letter-spacing: 0.08em; }
  .ws-head .count { color: var(--faint); margin-left:6px; }
  .ws-search { flex: 0 1 260px; width: auto; min-width: 0; margin: 0 !important; padding: 9px 14px !important;
        font-size: 13.5px !important; border-radius: 999px !important; }
  .ws-grid {
    display:grid; grid-template-columns: repeat(auto-fill, minmax(min(250px, 100%), 1fr)); gap:12px;
    max-height: min(48vh, 460px); overflow-y:auto; padding: 4px; margin: 0 -4px;
    scrollbar-width: thin; scrollbar-color: rgba(3,3,2,0.18) transparent;
  }
  .ws { position:relative; border:1px solid var(--line); border-radius:16px; padding:14px;
        cursor:pointer; display:flex; align-items:center; gap:12px; min-width:0; margin:0;
        background: #fff; transition:border-color .15s, box-shadow .2s, transform .15s; }
  .ws[hidden] { display:none; }
  .ws:hover { border-color: var(--line-strong); box-shadow: 0 10px 20px -12px rgba(3,3,2,0.18); }
  .ws input { position:absolute; opacity:0; pointer-events:none; }
  .ws:has(input:checked) { border-color: var(--violet); background: #faf8ff;
        box-shadow: 0 0 0 3px rgba(124,92,255,0.14), 0 12px 24px -14px rgba(76,47,199,0.35); }
  .ws:has(input:focus-visible) { box-shadow: 0 0 0 4px rgba(124,92,255,0.3); }
  .ws-mono { flex:none; width:38px; height:38px; border-radius:11px; display:grid; place-items:center;
        font-family: var(--display); font-weight:600; font-size:16px;
        box-shadow: inset 0 0 0 1px rgba(3,3,2,0.06); }
  .ws-name { font-weight:500; font-size:14px; line-height:1.3; color: var(--ink); overflow:hidden;
        overflow-wrap:anywhere; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; }
  .ws-role { color: var(--muted); font-size:12.5px; text-transform:capitalize; }
  .ws-meta { display:flex; flex-direction:column; gap:1px; min-width:0; flex:1; }
  .ws-check { flex:none; width:20px; height:20px; border-radius:50%; border:1.5px solid rgba(3,3,2,0.2);
        display:grid; place-items:center; transition: background .15s, border-color .15s; }
  .ws:has(input:checked) .ws-check { background: var(--violet); border-color: var(--violet); }
  .ws:has(input:checked) .ws-check::after { content:""; width:7px; height:7px; border-radius:50%; background:#fff; }
  .ws-empty { grid-column: 1 / -1; color: var(--muted); font-size:13px; text-align:center; padding: 24px 0; }
  .consent-foot { display:flex; align-items:center; gap:28px; margin-top:24px; padding-top:22px;
        border-top:1px solid var(--line); }
  .consent-foot .scopes { flex:1; margin:0; }
  .consent-foot .row { margin:0; flex:none; width: 320px; }
  @media (max-width: 720px) {
    .card.wide { padding: 28px 18px; }
    .consent-foot { flex-direction:column; align-items:stretch; gap:16px; }
    .consent-foot .row { width:auto; }
  }
  .scopes { background: #faf8f6; border:1px solid rgba(3,3,2,0.06); border-radius:16px;
            padding:14px 16px; margin: 6px 0 22px; }
  .scopes li { color: #404040; font-size:13.5px; margin: 5px 0; list-style:none; position:relative; padding-left:24px; }
  .scopes li::before { content:"✓"; position:absolute; left:0; color: var(--green); font-weight:700; }
  .scopes ul { margin:0; padding:0; }
  .row { display:flex; gap:10px; margin-top: 4px; }
  .row button { flex:1; margin-top: 0; }
  .foot { text-align:center; color: var(--faint); font-size:12px; margin-top:22px; }
  .foot a { color: var(--muted); }
  .linkline { text-align:right; margin: -8px 0 14px; font-size: 12.5px; }
  .linkline a, a.plain { color: var(--muted); text-decoration: none; }
  .linkline a:hover, a.plain:hover { color: var(--ink); text-decoration: underline; }
  code { background: rgba(3,3,2,0.05); border-radius: 6px; padding: 0.1em 0.4em; font-size: 13px; }
</style>
${opts.head ?? ""}
</head>
<body>
  <div class="card${opts.wide ? " wide" : ""}">
    <img class="wordmark" src="${WORDMARK_INK_DATA_URI}" alt="${esc(BRAND_NAME)}" />
    ${opts.body}
  </div>
</body>
</html>`;
}
