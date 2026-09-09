import { BRAND_NAME } from "../brand.js";
import { GLYPH_FAVICON_DATA_URI, WORDMARK_DATA_URI } from "../brand-assets.js";

/**
 * Shared chrome for every human-facing page this headless server renders: the
 * MCP OAuth login/consent screens (routes/oauth-connect.ts) and the account
 * pages — password reset, email verified, invitation landing
 * (routes/account-pages.ts). One dark card, the official wordmark embedded as a
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

/** Dark, premium, matches the Baalda brand (black + chrome). */
export function page(opts: { title: string; body: string; head?: string }): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>${esc(opts.title)} · ${esc(BRAND_NAME)}</title>
<link rel="icon" href="${GLYPH_FAVICON_DATA_URI}" />
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px;
    font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    color: #ededea; background: #08080b;
    background-image:
      radial-gradient(1100px 600px at 50% -10%, rgba(150,170,210,0.14), transparent 60%),
      radial-gradient(800px 500px at 50% 120%, rgba(90,110,150,0.10), transparent 60%);
  }
  .card {
    width: 100%; max-width: 400px; background: rgba(20,20,26,0.72);
    border: 1px solid rgba(255,255,255,0.08); border-radius: 18px; padding: 34px 30px;
    box-shadow: 0 24px 70px rgba(0,0,0,0.55), inset 0 1px 0 rgba(255,255,255,0.05);
    backdrop-filter: blur(14px);
  }
  .wordmark { display:block; height: 34px; margin: 2px auto 22px; object-fit: contain; }
  h1 { font-size: 18px; font-weight: 600; margin: 0 0 6px; text-align: center; letter-spacing: -0.01em; }
  .sub { color: #9a9aa6; text-align: center; margin: 0 0 24px; font-size: 13.5px; }
  .sub b { color: #d7d7dc; font-weight: 600; }
  label { display:block; font-size: 12.5px; color: #a6a6b0; margin: 0 0 6px; }
  input[type=email], input[type=password] {
    width: 100%; padding: 11px 13px; margin-bottom: 15px; font-size: 14px; color: #f2f2ef;
    background: rgba(0,0,0,0.35); border: 1px solid rgba(255,255,255,0.12); border-radius: 10px;
    transition: border-color .15s, box-shadow .15s;
  }
  input:focus { outline: none; border-color: rgba(170,190,230,0.7); box-shadow: 0 0 0 3px rgba(120,150,210,0.18); }
  button, .btn {
    width: 100%; padding: 11px 14px; font-size: 14px; font-weight: 600; border-radius: 10px;
    border: 0; cursor: pointer; font-family: inherit; text-align: center;
  }
  .primary { background: linear-gradient(180deg,#f4f5f7,#d9dde3); color: #16161b; }
  .primary:hover { background: linear-gradient(180deg,#ffffff,#e6e9ee); }
  .primary:disabled { opacity: .6; cursor: default; }
  .ghost {
    background: rgba(255,255,255,0.05); color: #ededea; border: 1px solid rgba(255,255,255,0.14);
    display:flex; align-items:center; justify-content:center; gap:9px; margin-top: 4px; text-decoration:none;
  }
  .ghost:hover { background: rgba(255,255,255,0.09); }
  .divider { display:flex; align-items:center; gap:12px; color:#6a6a74; font-size:12px; margin: 18px 0; }
  .divider::before, .divider::after { content:""; height:1px; flex:1; background: rgba(255,255,255,0.1); }
  .err { background: rgba(220,80,80,0.12); border:1px solid rgba(220,80,80,0.35); color:#f4b6b6;
         padding:10px 12px; border-radius:9px; font-size:13px; margin-bottom:16px; }
  .ok { background: rgba(90,170,110,0.12); border:1px solid rgba(90,170,110,0.35); color:#bfe3c8;
        padding:10px 12px; border-radius:9px; font-size:13px; margin-bottom:16px; }
  .ws { display:block; border:1px solid rgba(255,255,255,0.12); border-radius:11px; padding:12px 14px;
        margin-bottom:10px; cursor:pointer; display:flex; align-items:center; gap:12px; transition:border-color .12s, background .12s; }
  .ws:hover { border-color: rgba(170,190,230,0.5); background: rgba(255,255,255,0.03); }
  .ws input { accent-color:#c6d2ea; width:16px; height:16px; margin:0; }
  .ws-name { font-weight:600; font-size:14px; }
  .ws-role { color:#8a8a94; font-size:12px; text-transform:capitalize; }
  .ws-meta { display:flex; flex-direction:column; gap:1px; }
  .scopes { background: rgba(0,0,0,0.28); border:1px solid rgba(255,255,255,0.08); border-radius:11px;
            padding:13px 15px; margin: 6px 0 22px; }
  .scopes li { color:#c3c3cb; font-size:13px; margin: 4px 0; list-style:none; position:relative; padding-left:22px; }
  .scopes li::before { content:"✓"; position:absolute; left:0; color:#8fb99b; font-weight:700; }
  .scopes ul { margin:0; padding:0; }
  .row { display:flex; gap:10px; margin-top: 4px; }
  .row button { flex:1; }
  .foot { text-align:center; color:#6a6a74; font-size:11.5px; margin-top:20px; }
  .foot a { color:#9a9aa6; }
  .linkline { text-align:right; margin: -8px 0 14px; font-size: 12.5px; }
  .linkline a, a.plain { color:#9a9aa6; text-decoration: none; }
  .linkline a:hover, a.plain:hover { color:#d7d7dc; text-decoration: underline; }
  code { background: rgba(255,255,255,0.08); border-radius: 6px; padding: 0.1em 0.4em; font-size: 13px; }
</style>
${opts.head ?? ""}
</head>
<body>
  <div class="card">
    <img class="wordmark" src="${WORDMARK_DATA_URI}" alt="${esc(BRAND_NAME)}" />
    ${opts.body}
  </div>
</body>
</html>`;
}
