import { Hono } from "hono";
import { pool } from "../../db/pool.js";
import { auth, googleEnabled } from "../../auth/auth.js";
import { config } from "../../config.js";
import { orgRole } from "../../permissions/lookup.js";
import { getSession } from "../session.js";
import { setVaultBinding } from "../../mcp/oauth.js";
import { BRAND_NAME } from "../../brand.js";
import { GLYPH_FAVICON_DATA_URI, WORDMARK_DATA_URI } from "../../brand-assets.js";

/**
 * The human-facing pages of the MCP OAuth flow (the Better Auth `mcp` plugin
 * drives the machinery; these are the screens it redirects a browser through):
 *
 *   GET  /oauth/login    ← plugin's `loginPage`. Sign in to an existing account.
 *   GET  /oauth/consent  ← plugin's `consentPage`. Pick the vault + Allow.
 *   POST /oauth/consent  → records the vault binding, completes consent,
 *                          bounces back to the client's redirect_uri.
 *
 * Served by this (headless) server itself so the flow works on api.baalda.com
 * and any self-hoster with no separate web frontend. Branded with the official
 * Baalda logos (embedded, see brand-assets.ts).
 */

const AUTHORIZE_PATH = "/api/auth/mcp/authorize";

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Shared chrome: dark, premium, matches the Baalda brand (black + chrome). */
function page(opts: { title: string; body: string; head?: string }): string {
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
  .ghost {
    background: rgba(255,255,255,0.05); color: #ededea; border: 1px solid rgba(255,255,255,0.14);
    display:flex; align-items:center; justify-content:center; gap:9px; margin-top: 4px; text-decoration:none;
  }
  .ghost:hover { background: rgba(255,255,255,0.09); }
  .divider { display:flex; align-items:center; gap:12px; color:#6a6a74; font-size:12px; margin: 18px 0; }
  .divider::before, .divider::after { content:""; height:1px; flex:1; background: rgba(255,255,255,0.1); }
  .err { background: rgba(220,80,80,0.12); border:1px solid rgba(220,80,80,0.35); color:#f4b6b6;
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

async function clientName(clientId: string | undefined): Promise<string> {
  if (!clientId) return "An application";
  const { rows } = await pool.query<{ name: string }>(
    'SELECT name FROM "oauthApplication" WHERE "clientId" = $1',
    [clientId],
  );
  return rows[0]?.name?.trim() || "An application";
}

export const oauthConnectRoutes = new Hono();

// ── Sign-in page (Better Auth mcp plugin's loginPage) ───────────────────────
oauthConnectRoutes.get("/oauth/login", async (c) => {
  const url = new URL(c.req.url);
  const app = await clientName(url.searchParams.get("client_id") ?? undefined);
  // Re-enter authorize after sign-in with prompt=consent forced on. The Better
  // Auth `mcp` plugin only shows a consent screen (our vault picker) when
  // the request carries prompt=consent — clients like Claude don't send it, so
  // we add it ourselves here (the one point in the flow we control).
  const authorizeParams = new URLSearchParams(url.search);
  authorizeParams.set("prompt", "consent");
  const authorizeUrl = `${config.betterAuthUrl}${AUTHORIZE_PATH}?${authorizeParams.toString()}`;

  const google = googleEnabled
    ? `<div class="divider">or</div>
       <button type="button" id="google" class="btn ghost">
         <svg width="17" height="17" viewBox="0 0 24 24" aria-hidden="true"><path fill="#EA4335" d="M12 10.2v3.9h5.5c-.24 1.4-1.6 4.1-5.5 4.1-3.3 0-6-2.7-6-6.1s2.7-6.1 6-6.1c1.9 0 3.1.8 3.8 1.5l2.6-2.5C17.1 2.9 14.8 2 12 2 6.9 2 2.8 6.1 2.8 11.2S6.9 20.4 12 20.4c6 0 7.9-4.2 7.9-7.5 0-.5-.1-.9-.2-1.3H12z"/></svg>
         Continue with Google
       </button>`
    : "";

  const body = `
    <h1>Sign in to ${esc(BRAND_NAME)}</h1>
    <p class="sub">to connect <b>${esc(app)}</b></p>
    <div id="err" class="err" style="display:none"></div>
    <form id="f" autocomplete="on">
      <label for="email">Email</label>
      <input id="email" type="email" required autocomplete="username" autofocus />
      <label for="password">Password</label>
      <input id="password" type="password" required autocomplete="current-password" />
      <button type="submit" class="primary">Sign in</button>
    </form>
    ${google}
    <p class="foot">Authorizing access for <b>${esc(app)}</b> to your ${esc(BRAND_NAME)} account.</p>
    <script>
      const AUTHORIZE_URL = ${JSON.stringify(authorizeUrl)};
      const errEl = document.getElementById('err');
      function showErr(m){ errEl.textContent = m; errEl.style.display='block'; }
      document.getElementById('f').addEventListener('submit', async (e) => {
        e.preventDefault();
        errEl.style.display='none';
        const btn = e.target.querySelector('button'); btn.disabled = true; btn.textContent='Signing in…';
        try {
          // redirect:'manual' — on success the mcp plugin's after-hook tries to
          // auto-resume authorize and answers with a 3xx; we deliberately ignore
          // that (opaqueredirect) and drive the browser to authorize ourselves,
          // with prompt=consent, so the vault picker always shows.
          const res = await fetch('/api/auth/sign-in/email', {
            method:'POST', credentials:'include', redirect:'manual',
            headers:{'Content-Type':'application/json'},
            body: JSON.stringify({
              email: document.getElementById('email').value,
              password: document.getElementById('password').value
            })
          });
          const ok = (res.status >= 200 && res.status < 300) || res.type === 'opaqueredirect' || res.status === 0;
          if (!ok) { const j = await res.json().catch(()=>({})); throw new Error(j.message || 'Invalid email or password'); }
          window.location.assign(AUTHORIZE_URL);
        } catch (err) {
          showErr(err.message || 'Sign in failed'); btn.disabled=false; btn.textContent='Sign in';
        }
      });
      const g = document.getElementById('google');
      if (g) g.addEventListener('click', async () => {
        g.disabled = true;
        try {
          const res = await fetch('/api/auth/sign-in/social', {
            method:'POST', credentials:'include',
            headers:{'Content-Type':'application/json'},
            body: JSON.stringify({ provider:'google', callbackURL: AUTHORIZE_URL })
          });
          const j = await res.json();
          if (j.url) window.location.assign(j.url); else throw new Error('Could not start Google sign-in');
        } catch (err) { showErr(err.message || 'Google sign-in failed'); g.disabled=false; }
      });
    </script>`;
  return c.html(page({ title: "Sign in", body }));
});

// ── Consent page with vault picker (mcp plugin's consentPage) ───────────────
oauthConnectRoutes.get("/oauth/consent", async (c) => {
  const consentCode = c.req.query("consent_code") ?? "";
  const clientId = c.req.query("client_id") ?? "";
  const session = await getSession(c);
  if (!session) {
    return c.html(
      page({
        title: "Session expired",
        body: `<h1>Session expired</h1><p class="sub">Please restart the connection from ${esc(
          BRAND_NAME,
        )} in your app.</p>`,
      }),
      400,
    );
  }
  if (!consentCode || !clientId) {
    return c.html(
      page({ title: "Invalid request", body: `<h1>Invalid request</h1><p class="sub">Missing authorization details.</p>` }),
      400,
    );
  }

  const app = await clientName(clientId);
  const { rows: vaults } = await pool.query<{ id: string; name: string; role: string }>(
    `SELECT o.id, o.name, m.role
       FROM member m JOIN organization o ON o.id = m."organizationId"
      WHERE m."userId" = $1
      ORDER BY o."createdAt" ASC`,
    [session.userId],
  );

  if (vaults.length === 0) {
    return c.html(
      page({
        title: "No vault",
        body: `<h1>No vault found</h1><p class="sub">Your account isn't a member of any ${esc(
          BRAND_NAME,
        )} vault yet. Create or join one in the app, then try again.</p>`,
      }),
      400,
    );
  }

  const preselect = session.activeOrganizationId ?? vaults[0].id;
  const options = vaults
    .map(
      (w) => `
      <label class="ws">
        <input type="radio" name="organization_id" value="${esc(w.id)}" ${
          w.id === preselect ? "checked" : ""
        } required />
        <span class="ws-meta"><span class="ws-name">${esc(w.name)}</span><span class="ws-role">${esc(
          w.role,
        )}</span></span>
      </label>`,
    )
    .join("");

  const body = `
    <h1><b>${esc(app)}</b> wants access</h1>
    <p class="sub">Signed in as <b>${esc(session.email)}</b></p>
    <form method="POST" action="/oauth/consent">
      <input type="hidden" name="consent_code" value="${esc(consentCode)}" />
      <input type="hidden" name="client_id" value="${esc(clientId)}" />
      <label>Choose a vault to connect</label>
      ${options}
      <div class="scopes"><ul>
        <li>Read and search notes you can access</li>
        <li>Create, edit and organize notes on your behalf</li>
        <li>Only within your existing sharing permissions</li>
      </ul></div>
      <div class="row">
        <button type="submit" name="decision" value="deny" class="ghost">Deny</button>
        <button type="submit" name="decision" value="allow" class="primary">Allow access</button>
      </div>
    </form>
    <p class="foot">You can revoke this anytime in ${esc(BRAND_NAME)} vault settings.</p>`;
  return c.html(page({ title: "Authorize", body }));
});

oauthConnectRoutes.post("/oauth/consent", async (c) => {
  const form = await c.req.parseBody();
  const consentCode = typeof form.consent_code === "string" ? form.consent_code : "";
  const clientId = typeof form.client_id === "string" ? form.client_id : "";
  const organizationId =
    typeof form.organization_id === "string" ? form.organization_id : "";
  const accept = form.decision === "allow";

  const session = await getSession(c);
  if (!session) {
    return c.html(
      page({ title: "Session expired", body: `<h1>Session expired</h1><p class="sub">Please restart the connection.</p>` }),
      400,
    );
  }
  if (!consentCode) {
    return c.html(page({ title: "Invalid request", body: `<h1>Invalid request</h1>` }), 400);
  }

  // On Allow: bind the chosen vault BEFORE completing consent, and only if
  // the user is really a member of it (the picker is user-supplied input).
  if (accept) {
    if (!organizationId || !(await orgRole(organizationId, session.userId))) {
      return c.html(
        page({
          title: "Authorize",
          body: `<h1>Pick a vault</h1><p class="sub">Select a vault you belong to, then try again.</p>`,
        }),
        400,
      );
    }
    await setVaultBinding(clientId, session.userId, organizationId);
  }

  try {
    const result = (await auth.api.oAuthConsent({
      body: { accept, consent_code: consentCode },
      headers: c.req.raw.headers,
    })) as { redirectURI?: string };
    if (result?.redirectURI) return c.redirect(result.redirectURI);
    throw new Error("no redirect");
  } catch {
    return c.html(
      page({
        title: "Authorization failed",
        body: `<h1>Authorization failed</h1><p class="sub">Something went wrong completing the connection. Please restart it from your app.</p>`,
      }),
      400,
    );
  }
});
