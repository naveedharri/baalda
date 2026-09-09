import { Hono } from "hono";
import { pool } from "../../db/pool.js";
import { BRAND_NAME } from "../../brand.js";
import { emailEnabled } from "../../email/mailer.js";
import { esc, page } from "../pages.js";
import { publicBaseUrl } from "./open-link.js";
import { invitationState, loadInvitation } from "../../registry/invitations.js";

/**
 * Account pages served by this (headless) server (issue #99) — the human side
 * of the email flows, on the same branded chrome as the MCP OAuth screens so
 * they work on api.baalda.com and on any self-host with no web frontend:
 *
 *   GET /forgot-password         ask for the reset email (linked from /oauth/login)
 *   GET /reset-password?token=…  choose a new password (the emailed link), then
 *                                bounces into `baalda://signin`
 *   GET /email-verified          where the verification link lands; bounces into
 *                                `baalda://verified` so the app refreshes itself
 *   GET /invite/:id              where an invitation email lands: bounces into
 *                                the desktop app's `baalda://invite/…` deep link
 *
 * All four are public. The reset page's token is single-use and expires in an
 * hour (Better Auth's `reset-password:<token>` verification row); the invite
 * page shows only what the email that carried the id already said.
 */
export const accountPageRoutes = new Hono();

/** Better Auth ids (and anything else we'd put in a URL): one conservative shape. */
const ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

/**
 * Deep links back into the desktop app (`lib/accountLink.ts` on the desktop
 * side). Neither carries data: `verified` makes the app re-read its session so
 * the verified state appears without a reload; `signin` makes it re-check the
 * (now revoked) session and open the sign-in card.
 */
const VERIFIED_DEEP_LINK = "baalda://verified";
const SIGNIN_DEEP_LINK = "baalda://signin";

function notAvailable() {
  return page({
    title: "Not available",
    body: `<h1>Not available</h1><p class="sub">This ${esc(
      BRAND_NAME,
    )} server doesn't send email, so passwords can't be reset here. Ask whoever runs it to configure outbound email (see the deploy guide) or to set a new password for you.</p>`,
  });
}

// ── Forgot password ──────────────────────────────────────────────────────────
accountPageRoutes.get("/forgot-password", (c) => {
  if (!emailEnabled()) return c.html(notAvailable(), 404);
  const body = `
    <h1>Reset your password</h1>
    <p class="sub">Enter your email and we'll send a link to choose a new password.</p>
    <div id="err" class="err" style="display:none"></div>
    <form id="f" autocomplete="on">
      <label for="email">Email</label>
      <input id="email" type="email" required autocomplete="username" autofocus />
      <button type="submit" class="primary">Email me a reset link</button>
    </form>
    <div id="done" style="display:none">
      <div class="ok">Reset link sent to <b id="who"></b>. Check your inbox (and spam) — the link is valid for one hour.</div>
    </div>
    <p class="foot"><a class="plain" href="/oauth/login">Back to sign in</a></p>
    <script>
      const errEl = document.getElementById('err');
      function showErr(m){ errEl.textContent = m; errEl.style.display='block'; }
      document.getElementById('f').addEventListener('submit', async (e) => {
        e.preventDefault();
        errEl.style.display='none';
        const form = e.target; const btn = form.querySelector('button');
        const email = document.getElementById('email').value.trim();
        btn.disabled = true; btn.textContent = 'Sending…';
        try {
          const res = await fetch('/api/password-reset/request', {
            method:'POST', headers:{'Content-Type':'application/json'},
            body: JSON.stringify({ email })
          });
          if (!res.ok) {
            const j = await res.json().catch(()=>({}));
            if (j.error === 'no_account') throw new Error('There is no account for ' + email + ' on this server. Check the address — or the server, if your team runs its own.');
            throw new Error(j.message || 'Could not send the email');
          }
          document.getElementById('who').textContent = email;
          form.style.display = 'none';
          document.getElementById('done').style.display = 'block';
        } catch (err) {
          showErr(err.message || 'Could not send the email'); btn.disabled=false; btn.textContent='Email me a reset link';
        }
      });
    </script>`;
  return c.html(page({ title: "Reset password", body }));
});

// ── Reset password (the emailed link) ────────────────────────────────────────
accountPageRoutes.get("/reset-password", (c) => {
  const token = c.req.query("token") ?? "";
  if (!ID_RE.test(token)) {
    return c.html(
      page({
        title: "Invalid link",
        body: `<h1>This link isn't valid</h1><p class="sub">Request a new reset link from the ${esc(
          BRAND_NAME,
        )} app (Sign in → Forgot password?).</p>`,
      }),
      400,
    );
  }
  const body = `
    <h1>Choose a new password</h1>
    <p class="sub">At least 8 characters. Every other device signed in to this account will be signed out.</p>
    <div id="err" class="err" style="display:none"></div>
    <form id="f" autocomplete="on">
      <label for="pw">New password</label>
      <input id="pw" type="password" required minlength="8" autocomplete="new-password" autofocus />
      <label for="pw2">Repeat it</label>
      <input id="pw2" type="password" required minlength="8" autocomplete="new-password" />
      <button type="submit" class="primary">Set new password</button>
    </form>
    <div id="done" style="display:none">
      <div class="ok">Your password is updated. Opening ${esc(BRAND_NAME)} so you can sign in with it…</div>
      <a class="btn primary" href="${esc(SIGNIN_DEEP_LINK)}" style="display:block;text-decoration:none">Open ${esc(
        BRAND_NAME,
      )}</a>
    </div>
    <script>
      const TOKEN = ${JSON.stringify(token)};
      const SIGNIN = ${JSON.stringify(SIGNIN_DEEP_LINK)};
      const errEl = document.getElementById('err');
      function showErr(m){ errEl.textContent = m; errEl.style.display='block'; }
      document.getElementById('f').addEventListener('submit', async (e) => {
        e.preventDefault();
        errEl.style.display='none';
        const pw = document.getElementById('pw').value, pw2 = document.getElementById('pw2').value;
        if (pw !== pw2) { showErr("Those passwords don't match."); return; }
        const form = e.target; const btn = form.querySelector('button');
        btn.disabled = true; btn.textContent = 'Saving…';
        try {
          const res = await fetch('/api/auth/reset-password', {
            method:'POST', headers:{'Content-Type':'application/json'},
            body: JSON.stringify({ newPassword: pw, token: TOKEN })
          });
          if (!res.ok) {
            const j = await res.json().catch(()=>({}));
            const code = j.code || '';
            if (code === 'INVALID_TOKEN' || /invalid token/i.test(j.message || '')) {
              throw new Error('This link has expired or was already used. Request a new one from the app.');
            }
            throw new Error(j.message || 'Could not set the password');
          }
          form.style.display = 'none';
          document.getElementById('done').style.display = 'block';
          // Hand off to the app, which re-checks its session (revoked by the
          // reset) and opens the sign-in card. The button stays as the fallback.
          setTimeout(() => { location.href = SIGNIN; }, 600);
        } catch (err) {
          showErr(err.message || 'Could not set the password'); btn.disabled=false; btn.textContent='Set new password';
        }
      });
    </script>`;
  return c.html(page({ title: "Choose a new password", body }));
});

// ── Email verified (verification link callback) ──────────────────────────────
accountPageRoutes.get("/email-verified", (c) => {
  const error = c.req.query("error");
  if (error) {
    return c.html(
      page({
        title: "Link expired",
        body: `<h1>This link has expired</h1><p class="sub">Sign in to ${esc(
          BRAND_NAME,
        )} and we'll send you a fresh confirmation email.</p>`,
      }),
      400,
    );
  }
  // Same hand-off as the invite page: bounce into the app, which refreshes its
  // session so the verified state shows without a reload; button as fallback.
  return c.html(
    page({
      title: "Email confirmed",
      body: `<h1>Email confirmed</h1><p class="sub">Thanks — your address is verified. Taking you back to ${esc(
        BRAND_NAME,
      )}…</p>
      <a class="btn primary" href="${esc(VERIFIED_DEEP_LINK)}" style="display:block;text-decoration:none">Open ${esc(
        BRAND_NAME,
      )}</a>
      <script>location.href = ${JSON.stringify(VERIFIED_DEEP_LINK)};</script>`,
    }),
  );
});

// ── Invitation landing page ──────────────────────────────────────────────────
accountPageRoutes.get("/invite/:id", async (c) => {
  const id = c.req.param("id");
  if (!ID_RE.test(id)) return c.text("Malformed link", 400);

  const inv = await loadInvitation(pool, id);
  if (!inv) {
    return c.html(
      page({
        title: "Invitation not found",
        body: `<h1>Invitation not found</h1><p class="sub">This link doesn't match any invitation. Ask the person who invited you to send a new one.</p>`,
      }),
      404,
    );
  }
  const state = invitationState(inv);
  if (state !== "pending") {
    const why =
      state === "expired"
        ? "This invitation has expired."
        : state === "accepted"
          ? "This invitation was already accepted."
          : "This invitation was withdrawn.";
    return c.html(
      page({
        title: "Invitation unavailable",
        body: `<h1>${esc(why)}</h1><p class="sub">Ask the person who invited you to <b>${esc(
          inv.organizationName,
        )}</b> to send a new invitation${state === "accepted" ? ", or just sign in — you may already be a member" : ""}.</p>`,
      }),
      410,
    );
  }

  const server = publicBaseUrl(c);
  const deepLink = `baalda://invite/${encodeURIComponent(id)}?server=${encodeURIComponent(server)}`;
  const who = inv.inviterName?.trim() || "A teammate";
  const body = `
    <h1>Join ${esc(inv.organizationName)}</h1>
    <p class="sub"><b>${esc(who)}</b> invited <b>${esc(inv.email)}</b> to this vault${
      inv.role === "admin" ? " as an admin" : ""
    }.</p>
    <a class="btn primary" href="${esc(deepLink)}" style="display:block;text-decoration:none">Open in ${esc(
      BRAND_NAME,
    )}</a>
    <p class="sub" style="margin-top:18px">Sign in with <b>${esc(
      inv.email,
    )}</b> — or create an account with that address — and you'll land in the vault.</p>
    <p class="foot">Don't have ${esc(BRAND_NAME)} yet? <a href="https://baalda.com" rel="noopener">Get it</a>, then open this link again.</p>
    <script>location.href = ${JSON.stringify(deepLink)};</script>`;
  return c.html(page({ title: `Join ${inv.organizationName}`, body }));
});
