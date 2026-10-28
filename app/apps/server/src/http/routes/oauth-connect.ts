import { Hono } from "hono";
import { pool } from "../../db/pool.js";
import { auth, googleEnabled } from "../../auth/auth.js";
import { config } from "../../config.js";
import { orgRole } from "../../permissions/lookup.js";
import { getSession } from "../session.js";
import { setVaultBinding } from "../../mcp/oauth.js";
import { BRAND_NAME } from "../../brand.js";
import { emailEnabled } from "../../email/mailer.js";
import { esc, page } from "../pages.js";

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
 * and any self-hoster with no separate web frontend. Page chrome + branding come
 * from ../pages.ts (shared with the account pages).
 */

const AUTHORIZE_PATH = "/api/auth/mcp/authorize";

async function clientName(clientId: string | undefined): Promise<string> {
  if (!clientId) return "An application";
  const { rows } = await pool.query<{ name: string }>(
    'SELECT name FROM "oauthApplication" WHERE "clientId" = $1',
    [clientId],
  );
  return rows[0]?.name?.trim() || "An application";
}

/** A soft pastel tile (fill + deeper letter of the same hue) that stays the same for a vault. */
function monogramStyle(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  return `background:hsl(${hue} 80% 93%);color:hsl(${hue} 45% 34%)`;
}

/** The vault picker: a wide grid so a person in many vaults sees them at a glance. */
export function consentPage(opts: {
  app: string;
  email: string;
  consentCode: string;
  clientId: string;
  vaults: { id: string; name: string; role: string }[];
  preselect: string;
}): string {
  const { app, email, consentCode, clientId, vaults, preselect } = opts;
  const options = vaults
    .map((w) => {
      const initial = (w.name.trim().match(/\p{L}|\p{N}/u)?.[0] ?? "?").toUpperCase();
      return `
      <label class="ws" data-name="${esc(w.name.toLowerCase())}">
        <input type="radio" name="organization_id" value="${esc(w.id)}" ${
          w.id === preselect ? "checked" : ""
        } required />
        <span class="ws-mono" style="${monogramStyle(w.id)}">${esc(initial)}</span>
        <span class="ws-meta"><span class="ws-name" title="${esc(w.name)}">${esc(
          w.name,
        )}</span><span class="ws-role">${esc(w.role)}</span></span>
        <span class="ws-check" aria-hidden="true"></span>
      </label>`;
    })
    .join("");

  // A filter only earns its place once the grid no longer fits at a glance.
  const search =
    vaults.length > 8
      ? `<input type="search" class="ws-search" id="ws-search" placeholder="Search vaults" autocomplete="off" />`
      : "";

  const body = `
    <h1><b>${esc(app)}</b> wants access</h1>
    <p class="sub">Signed in as <b>${esc(email)}</b></p>
    <form method="POST" action="/oauth/consent">
      <input type="hidden" name="consent_code" value="${esc(consentCode)}" />
      <input type="hidden" name="client_id" value="${esc(clientId)}" />
      <div class="ws-head">
        <label>Choose a vault to connect<span class="count">${vaults.length}</span></label>
        ${search}
      </div>
      <div class="ws-grid" id="ws-grid">
        ${options}
        <p class="ws-empty" id="ws-empty" hidden>No vaults match.</p>
      </div>
      <div class="consent-foot">
        <div class="scopes"><ul>
          <li>Read and search notes you can access</li>
          <li>Create, edit and organize notes on your behalf</li>
          <li>Only within your existing sharing permissions</li>
        </ul></div>
        <div class="row">
          <button type="submit" name="decision" value="deny" class="ghost">Deny</button>
          <button type="submit" name="decision" value="allow" class="primary">Allow access</button>
        </div>
      </div>
    </form>
    <p class="foot">You can revoke this anytime in ${esc(BRAND_NAME)} vault settings.</p>
    <script>
      const checked = document.querySelector('.ws input:checked');
      if (checked) checked.closest('.ws').scrollIntoView({ block: 'nearest' });
      const q = document.getElementById('ws-search');
      if (q) q.addEventListener('input', () => {
        const term = q.value.trim().toLowerCase();
        let shown = 0;
        document.querySelectorAll('#ws-grid .ws').forEach((el) => {
          const hit = !term || el.dataset.name.includes(term);
          el.hidden = !hit;
          if (hit) shown++;
        });
        document.getElementById('ws-empty').hidden = shown > 0;
      });
    </script>`;
  return page({ title: "Authorize", body, wide: true });
}

export const oauthConnectRoutes = new Hono();

// ── Force the vault picker on every authorize (issue #211) ──────────────────
// The mcp plugin issues a code straight away unless prompt=consent, and a
// client whose user is already signed in in the browser never passes through
// /oauth/login (where we used to add it). Its token then had no vault binding
// and every call 401'd once the user belonged to two vaults. Mounted ahead of
// Better Auth's /api/auth/* handler, so this runs first.
oauthConnectRoutes.get(AUTHORIZE_PATH, async (c, next) => {
  const url = new URL(c.req.url);
  if (url.searchParams.get("prompt") === "consent") return next();
  url.searchParams.set("prompt", "consent");
  return c.redirect(`${config.betterAuthUrl}${AUTHORIZE_PATH}?${url.searchParams.toString()}`, 302);
});

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

  // Only when this server can actually send the email (issue #99); a link to a
  // reset flow that never delivers is worse than none.
  const forgot = emailEnabled()
    ? `<p class="linkline"><a href="/forgot-password">Forgot password?</a></p>`
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
      ${forgot}
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

  return c.html(
    consentPage({
      app,
      email: session.email,
      consentCode,
      clientId,
      vaults,
      preselect: session.activeOrganizationId ?? vaults[0].id,
    }),
  );
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
