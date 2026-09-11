# Self-host the Baalda server on Coolify

Same stack as [`deploy/compose`](../compose) (Postgres + migrate-before-start +
single-port server), packaged so Coolify's Docker Compose build pack resolves
the build context correctly. If you're running Compose directly on a VPS
yourself, use [`deploy/compose`](../compose) instead — this directory exists
because Coolify runs `docker compose` with the **repo root** as the project
directory, which breaks `deploy/compose/docker-compose.yml`'s `context: ../..`
(see [issue #97](https://github.com/naveedharri/baalda/issues/97)).

## Coolify setup

1. **New Resource → Docker Compose**, point it at this repository.
2. **Base Directory:** `/` (repo root).
3. **Docker Compose Location:** `/deploy/coolify/docker-compose.yml`.
4. Deploy — no env vars to fill in first. `POSTGRES_PASSWORD` and
   `JWT_SECRET` come from Coolify's magic env vars; `BETTER_AUTH_URL` starts
   unset and the app falls back to a placeholder (`http://localhost:3010`)
   rather than refusing to start, so the stack comes up on its own. Coolify
   runs `postgres → migrate → server` in order (via `depends_on` +
   `condition: service_completed_successfully`), so the server never answers
   requests against an unmigrated schema.
5. Once it's up: open the `server` service → **Domains**, copy the generated
   `https://<something>.sslip.io` (or set your own domain there first). Then
   **Environment Variables → Production**, set `BETTER_AUTH_URL` to that URL
   (`https://…`, no trailing slash, no port — TLS is on 443), and redeploy.
   This isn't a global Coolify setting — it's this one service's own env var,
   same as `PORT` — so nothing else on the instance is affected. Until you do
   this, auth/invitation emails and the desktop app's connect link point at
   the placeholder instead of your real domain.

## Domain

The `server` service declares `SERVICE_FQDN_SERVER` — Coolify's [magic env var
convention](https://coolify.io/docs/knowledge-base/environment-variables) —
which tells Coolify to generate a domain (a free `*.sslip.io` one, unless you
already set your own) and assign it to *this* service's exposed port (`3010`)
automatically on first deploy. `postgres` and `migrate` have no exposed port,
so they're never offered a domain.

If a domain doesn't get assigned automatically (older Coolify versions), do it
by hand: open the `server` service → **Domains** → **Add domain**, set
**Service:** `server` (not `migrate` or `postgres`), **Port:** `3010`,
**Protocol:** `http` (Coolify's Traefik terminates TLS in front — the
container itself only ever speaks plain HTTP).

## A gotcha we hit testing this: `${VAR:?message}`

If you're customizing this file, don't borrow bash's `${VAR:?error message}`
pattern from `../compose/docker-compose.yml` for a required var — Coolify's
compose parser gives `:?` a different meaning than bash does. `${VAR:?}`
(nothing after the `?`) marks the var required **and blocks deployment**
until it's filled in; `${VAR:?some text}` instead treats `some text` as a
**prefilled default value**, not an error message. Writing `${JWT_SECRET:?set
JWT_SECRET in .env}` (our first attempt) meant an unset `JWT_SECRET` silently
became the literal string `set JWT_SECRET in .env` instead of failing — every
downstream value built from it came out as garbage and the deploy failed with
an opaque error nowhere near the actual cause. That's why `BETTER_AUTH_URL`
below is plain `${BETTER_AUTH_URL}` with no `:?` at all, rather than
`${BETTER_AUTH_URL:?}` — the latter is the "correct" required-var form, but it
would block the very first deploy that's needed to learn the domain in the
first place. Use `${VAR:?}` only for a var with no safe fallback the app can
run with; use a Coolify magic var (`SERVICE_PASSWORD_<ID>`, etc.) for one
Coolify can generate itself.

Then in the desktop app: **account menu → Server settings →** your
`BETTER_AUTH_URL` → **Save**. Create an account and you're synced.

## What comes up

| Service | What it does |
| --- | --- |
| `postgres` | Postgres 16 on a named volume. Never exposed outside the Compose network. |
| `migrate` | Runs `dist/db/migrate.js` to completion, *then* exits. |
| `server` | Hono HTTP + Hocuspocus WS on **one** container port (`3010`), `expose`d (not published) — Coolify's proxy reaches it on the internal network. |

## Differences from `deploy/compose`

- `build.context: .` instead of `../..`, because Coolify's project directory
  is the repo root, not this directory.
- No `ports:` / `BIND_ADDR` — nothing is published to the host. Coolify's
  Traefik terminates TLS and talks to the container directly, so there's no
  loopback bind to configure.

Everything else — the Postgres volume, the migrate-then-serve ordering, the
optional env vars (Google sign-in, Redis, billing) — is identical. Full env
var reference: [`docs/DEPLOY.md`](../../docs/DEPLOY.md).
