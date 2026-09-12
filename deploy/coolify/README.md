# Self-host the Baalda server on Coolify

Same stack as [`deploy/compose`](../compose) (Postgres + migrate-before-start +
single-port server), packaged so Coolify's Docker Compose build pack resolves
the build context correctly. If you're running Compose directly on a VPS
yourself, use [`deploy/compose`](../compose) instead — this directory exists
because Coolify runs `docker compose` with the **repo root** as the project
directory, which breaks `deploy/compose/docker-compose.yml`'s `context: ../..`
(see [issue #97](https://github.com/naveedharri/baalda/issues/97)).

> **Tested end-to-end** on a live Coolify instance: build → `postgres` →
> `migrate` → `server` all healthy, a custom domain with a real Let's
> Encrypt certificate, and the desktop app signing in and syncing notes
> through it. The gotchas below are all things that broke during that test
> and are now fixed in this file — read them if you're customizing it.

## Coolify setup

1. **New Resource → Docker Compose** (a public repo works with **Public Git
   Repository**, no credentials needed), point it at this repository.
2. **Base Directory:** `/` (repo root).
3. **Docker Compose Location:** `/deploy/coolify/docker-compose.yml`.
4. Deploy — no env vars to fill in first. `POSTGRES_PASSWORD` and
   `JWT_SECRET` come from Coolify's magic env vars; `BETTER_AUTH_URL`
   resolves to a placeholder (`http://localhost:3010`) via the compose
   file's own `${BETTER_AUTH_URL:-http://localhost:3010}` default, so the
   stack comes up on its own. Coolify runs `postgres → migrate → server` in
   order (via `depends_on` + `condition: service_completed_successfully`),
   so the server never answers requests against an unmigrated schema.
5. Once it's up: open the `server` service → **Domains**. A domain is
   already there (Coolify auto-generated a free `*.sslip.io` one via
   `SERVICE_FQDN_SERVER`) — use it, or **Add Domain** with your own (Service
   `server`, Port `3010`, Protocol `https`; point the domain's DNS `A`
   record at your Coolify server first, or the certificate can't be issued).
6. **Environment Variables → Production** on the `server` service, set
   `BETTER_AUTH_URL` to that domain (`https://…`, no trailing slash, no
   port — TLS is on 443), and redeploy. This isn't a global Coolify
   setting — it's this one service's own env var, same as `PORT` — so
   nothing else on the instance is affected. Until you do this,
   auth/invitation emails and the desktop app's connect link point at the
   placeholder instead of your real domain.

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

## Gotchas we hit testing this

Three separate issues surfaced while getting this file working, in the order
we hit them. All three are already fixed here — this is context for anyone
customizing the file, or hitting a similar error.

**1. `${VAR:?message}` means something different in Coolify than in bash.**
Coolify's compose parser gives `:?` its own meaning: `${VAR:?}` (nothing after
the `?`) marks the var required **and blocks deployment** until it's filled
in; `${VAR:?some text}` instead treats `some text` as a **prefilled default
value**, not an error message shown on a missing var. Writing
`${JWT_SECRET:?set JWT_SECRET in .env}` (our first attempt, copied from
`../compose/docker-compose.yml`, where it's correct — that's a plain
`docker compose` CLI, which *does* implement bash's `:?` semantics) meant an
unset `JWT_SECRET` silently became the literal string `set JWT_SECRET in
.env` instead of failing. Every downstream value built from it came out as
garbage and the deploy failed with an error nowhere near the real cause. Fix:
use a Coolify magic var (`SERVICE_PASSWORD_64_<ID>`, etc.) for anything
Coolify can generate itself, and plain `${VAR:-default}` (standard bash `:-`
behavior — Coolify's docs confirm this one isn't special-cased) for anything
else that needs a safe placeholder.

**2. An unset `${VAR}` becomes an empty string in the container, not an
absent key — the app's own fallback doesn't catch that.**
`app/apps/server/src/config.ts`'s `required(name, fallback)` applies
`fallback` via `??`, which only triggers on `undefined`/`null` — not on `""`.
Coolify interpolates a genuinely-unset `${BETTER_AUTH_URL}` to an empty
string in the container's environment rather than omitting the key, so the
app saw `v = ""`, skipped the fallback, and threw `Missing required env var:
BETTER_AUTH_URL` — crashing **both** `migrate` and `server` on startup,
before either reached any Postgres-related code (this is what an opaque
`migrate` `exit 1` with no other log actually was). Fix: supply the default
in the compose interpolation itself — `${BETTER_AUTH_URL:-http://localhost:3010}`
— so the container never sees an empty value in the first place; don't rely
on an app-level fallback for a var Coolify might pass through empty.

**3. A Coolify platform bug could corrupt a domain into `https://` with no
host, and abort every deploy after that with `The string 'https://' is no
valid url.`** This is
[coollabsio/coolify#11664](https://github.com/coollabsio/coolify/issues/11664),
fixed in **Coolify v4.3.19**. If you hit that exact error and your compose
file has no `:?`/`:-` issues, update Coolify — the fix skips/heals a
corrupted domain row at deploy time and prevents new corruption on save. Not
something this file can work around.

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
