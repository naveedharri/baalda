# Deploying the Baalda server

The server (`app/apps/server`) is a self-hostable Node + Postgres service: a Hono
HTTP API and the Hocuspocus sync WebSocket, both served on a single public port.
This guide covers running it with plain Docker and deploying it to Railway.
Everything here is optional. The desktop app works fully offline with no server
at all, and you can always use the managed backend from [baalda.com](https://baalda.com)
instead of self-hosting: set the server URL in Settings to `https://api.baalda.com`.

## Ports

The server binds one HTTP port (`PORT`, default `3010`) that serves the
REST/auth API, the per-note sync WebSocket at `/sync` and the vault channel at
`/vault-sync`. That is the only port a deployment needs to expose, and the only
one the desktop app (0.1.42+) ever dials — it derives both WebSocket URLs from
the server URL by appending the path, whatever the port. `HOCUSPOCUS_PORT`
(default `3011`) still listens for anything else that dials the dedicated
Hocuspocus port directly, but nothing in this repo needs it reachable.

> Desktop builds before 0.1.42 bumped an explicit `:3010` in the server URL to
> `:3011` for per-note sync. On a single-port deploy that port is unreachable,
> so folder structure synced while note content never uploaded (issue #79).
> Update the app; no server change is needed.

## Option A: plain Docker

The image is built from the repo root because the server is one workspace of
a pnpm monorepo and needs the workspace root's `package.json` /
`pnpm-lock.yaml` / `pnpm-workspace.yaml` to resolve its dependencies.

### Build

```bash
docker build -f app/apps/server/Dockerfile -t baalda-server .
```

### Run

```bash
docker run -p 3010:3010 \
  -e DATABASE_URL=postgres://context:context@your-postgres-host:5432/context \
  -e JWT_SECRET="$(openssl rand -base64 32)" \
  -e BETTER_AUTH_URL=https://your-domain.example \
  baalda-server
```

Run migrations once before (or on) first boot:

```bash
docker run --rm \
  -e DATABASE_URL=postgres://context:context@your-postgres-host:5432/context \
  -e JWT_SECRET="$(openssl rand -base64 32)" \
  baalda-server node dist/db/migrate.js
```

Migrations are idempotent (tracked in a `_migrations` table), so re-running
them on every deploy is safe and a normal part of a redeploy flow.

### docker-compose

A minimal stack with Postgres and a one-shot migrate step before the server
starts:

```yaml
services:
  postgres:
    image: postgres:16
    environment:
      POSTGRES_USER: context
      POSTGRES_PASSWORD: context
      POSTGRES_DB: context
    volumes:
      - baalda-postgres:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U context"]
      interval: 5s
      timeout: 5s
      retries: 10

  migrate:
    build:
      context: .
      dockerfile: app/apps/server/Dockerfile
    command: ["node", "dist/db/migrate.js"]
    environment:
      DATABASE_URL: postgres://context:context@postgres:5432/context
      JWT_SECRET: change-me-32-bytes-minimum
    depends_on:
      postgres:
        condition: service_healthy

  server:
    build:
      context: .
      dockerfile: app/apps/server/Dockerfile
    ports:
      - "3010:3010"
    environment:
      DATABASE_URL: postgres://context:context@postgres:5432/context
      JWT_SECRET: change-me-32-bytes-minimum
      BETTER_AUTH_URL: http://localhost:3010
    depends_on:
      migrate:
        condition: service_completed_successfully

volumes:
  baalda-postgres:
```

Generate a real `JWT_SECRET` for anything beyond local testing:
`openssl rand -base64 32`.

## Option B: Railway

The server's Railway settings are checked in as Infrastructure as Code at
`app/.railway/railway.ts` — Dockerfile build, pre-deploy migration, `/health`
check, restart policy and a 1 GiB memory cap — so Railway needs almost no manual
configuration:

1. Create a new Railway project, add a **Postgres** database service, and add a
   service that deploys this repo from GitHub.
2. On the server service, set the environment variables:
   - `DATABASE_URL`: reference the Postgres service's connection string
     (Railway lets you wire this as a variable reference instead of copying
     a literal value).
   - `JWT_SECRET`: generate one with `openssl rand -base64 32`.
   - `BETTER_AUTH_URL`: the server's public HTTPS URL (Railway gives you a
     `*.up.railway.app` domain, or attach your own).
3. Apply the checked-in settings from a clone. Needs the Railway CLI 5.42 or
   newer and a `pnpm install` in `app/` (which brings the `railway` SDK):

   ```bash
   cd app
   railway link            # choose the project, its environment and the server service
   railway config plan     # preview — only that service's build/deploy settings change
   railway config apply
   ```

   The file is scoped to the server service (`export const partial`), keeps every
   variable the service already has (`preserve()`) and never touches Postgres,
   volumes or domains. It pins the GitHub source to `naveedharri/baalda` (a
   project whose name contains "staging" deploys the `staging` branch, anything
   else `main`); a fork changes that one string. The settings then live on the
   service, so this is only re-run when the file changes.
4. Deploy (`apply` triggers one). `preDeployCommand` runs `node dist/db/migrate.js`
   before every deploy and the health check is `/health`, so Railway won't cut
   over traffic until migrations have run and the server is answering.
5. Expose only the one HTTP port (Railway does this automatically from
   `PORT`); nothing else needs to be public.

> **`railway.json` is legacy.** The repo-root `railway.json` is Railway's older
> "Config as Code" form of the same settings. Only services created before
> mid-2026 still read it, and Railway stops reading it everywhere on 2026-12-01;
> a newer service that has nothing but `railway.json` builds with Railpack, runs
> no migrations, and answers every sign-in with HTTP 500 (`relation "user" does
> not exist`). Keep the two files in step until `railway.json` is removed.

Then point the desktop app at it — see
[Point the desktop app at your server](#point-the-desktop-app-at-your-server)
for the first-run step, Settings → Connection, and the invite link.

### Option B (one-click)

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/baalda-server?utm_medium=integration&utm_source=button&utm_campaign=baalda)

Template [**`baalda-server`**](https://railway.com/deploy/baalda-server) — two
services, no manual configuration:

| Service | What the deploy does |
| --- | --- |
| `Postgres` | Railway's Postgres, volume at `/var/lib/postgresql/data` |
| `baalda` | Builds `app/apps/server/Dockerfile` from this repo, gets an HTTPS domain |

Its three variables are Railway template expressions, so **every deployment gets
its own values** rather than inheriting the publisher's:

```
DATABASE_URL=${{Postgres.DATABASE_URL}}
JWT_SECRET=${{secret(32)}}
BETTER_AUTH_URL=https://${{RAILWAY_PUBLIC_DOMAIN}}
```

Paste that into the template's **Raw Editor** exactly as written — unquoted, and
with no spaces around `=`. Railway's ENV parser keeps what it is given: padding
around `=` can land a **leading space inside the value** (a `BETTER_AUTH_URL` of
` https://…` breaks every invitation link), and `JWT_SECRET="…"` can bake literal
quote characters into the signing secret. Reopen the Raw Editor after saving and
check it shows three lines — pasting twice silently leaves duplicates.

`${{secret(32)}}` is what makes the template safe to publish at all — a literal
secret baked into a public template would let anyone mint a sync token for any
note on every instance deployed from it. Nothing else is set: billing stays off
(so there are **no** vault or member limits), Google sign-in stays hidden until
you add OAuth credentials, and Redis is only needed to run several instances.

Once it's up, open the desktop app: its first-run step asks whether your notes
live on the managed service or **your own server**, and the generated
`*.up.railway.app` URL goes there. You can also send your team
`https://<that URL>/open/connect` and let them click it.

### Maintaining the template

The service config lives in Railway's template editor, **not** in this repo — the
only parts version-controlled here are `app/.railway/railway.ts` (builder,
pre-deploy migration, healthcheck) and the Dockerfile. Changing the required env vars means
editing the template in the dashboard too, or one-click deploys will boot
misconfigured.

There is no API or CLI path to publishing: `railway deploy` *consumes* a template
by code, the `railway mcp` server exposes only `deploy_template`/`search_templates`,
and `backboard.railway.com/graphql/v2` rejects non-browser clients (403). It is a
dashboard-only operation.

⚠️ **Publishing changes the URL.** An unpublished template is reachable at a random
code (`/deploy/CZ25Mu`); publishing moves it to the vanity slug (`/deploy/baalda-server`)
and the old code stops resolving — it silently serves Railway's generic landing page
rather than 404ing, so a stale button looks fine in Markdown and is dead on click.
After any republish, re-check the link:

```bash
curl -sL https://railway.com/deploy/baalda-server | grep -o '<title>[^<]*</title>'
# expect: <title>Deploy &amp; Host Baalda Server | Railway</title>
```

> ⚠️ **Never use "generate template from this project" on the project that runs
> the managed instance.** That flow copies a real project's service configuration,
> and publishing it would push a public marketplace template built from production
> — env values, domain and all. Always compose the template fresh, as above.

## A staging instance

Nothing in the server distinguishes staging from production — a staging instance
is just **a second deployment of this same server with its own database**, set up
exactly as above. Give it its own `DATABASE_URL`, its own `JWT_SECRET` (sharing
one would let a token minted on either instance authenticate on the other) and a
`BETTER_AUTH_URL` matching its own public URL.

The desktop side picks it up at **build** time rather than at runtime. The
frontend's `DEFAULT_SERVER_URL` (`app/apps/desktop/src/lib/api.ts`) honours a
`VITE_SERVER_URL` inlined by Vite, and `.github/workflows/staging-release.yml`
sets that from a repo Actions variable named `STAGING_SERVER_URL`, so the
**Baalda Staging** app it publishes defaults to your staging instance with nothing
for the tester to configure. See `docs/RELEASE.md` → *Staging*.

Two consequences worth stating plainly:

- **A published staging build reveals its server URL.** Vite inlines the value
  into the JS bundle and the installer is a public prerelease asset, so anyone who
  downloads it can read the URL out. A staging instance is internet-facing and
  needs the same auth posture as a production one — it is not protected by being
  hard to find.
- **Vaults do not move between instances.** A vault's `.context/config.json`
  binds that folder to one server's vault id and doc-id map, so a folder used
  against staging must not also be opened against production. Use separate
  folders, not separate accounts.

Migrations are idempotent and tracked in `_migrations`, so a staging instance is
also the natural place to run a new migration first: deploy the branch there,
confirm `/health` and a real sync round-trip, then promote.

## Environment variables

| Variable | Required | Default | Notes |
|---|---|---|---|
| `DATABASE_URL` | yes | `postgres://context:context@localhost:5439/context` | Postgres connection string. |
| `PG_POOL_MAX` | no | `20` | Postgres connections this instance pools. Keep the total across all instances under the server's `max_connections`; a pool below `BACKFILL_CONCURRENCY` lets one vault reconnect starve the HTTP routes. |
| `JWT_SECRET` | yes | dev-only insecure default | Better Auth crypto **and** sync JWT signing. Generate with `openssl rand -base64 32`. Rotating it invalidates all sessions and sync tokens. |
| `BETTER_AUTH_URL` | yes | `http://localhost:3010` | Public base URL used for auth links (email verification, invitations). Must match the URL clients actually use. |
| `PORT` | no | `3010` | HTTP API port. Serves the sync WebSocket at `/sync` too. This is the only port a deployment needs to expose. |
| `HOCUSPOCUS_PORT` | no | `3011` | Legacy dedicated Hocuspocus port, used in local dev and by older clients. Not required in production. |
| `SYNC_TOKEN_TTL_SECONDS` | no | `600` | Per-doc sync JWT lifetime. |
| `COMPACTION_THRESHOLD` | no | `50` | Number of pending CRDT updates before the server compacts into a snapshot. |
| `CORS_ORIGINS` | no | unset | Comma-separated list of allowed origins, if you serve a web client from a different origin. |
| `OPENAI_API_KEY` | no | unset | Optional upgrade path for semantic search embeddings; the server works fully offline without it. |
| `REDIS_URL` | no | unset | **Multi-instance only.** Unset ⇒ single-instance (in-memory fanout), which is the default and covers hundreds of concurrent users. Set ⇒ the vault replication channel and the Hocuspocus editing path both fan out via Redis so N instances stay consistent (spec 05 §5). |
| `BACKFILL_CONCURRENCY` | no | `6` | Max docs streamed concurrently to a freshly-connected vault subscriber. |
| `VAULT_SYNC_PATH` | no | `/vault-sync` | WebSocket path for the background vault replication channel (served on `PORT`). |
| `POLAR_ACCESS_TOKEN` | no | unset | **Billing (optional).** Unset ⇒ billing fully disabled: no upgrade UI in clients, no free-tier limits — every self-hosted vault is unlimited. Set (with the vars below) ⇒ per-vault Pro subscriptions via [Polar](https://polar.sh). |
| `POLAR_WEBHOOK_SECRET` | with billing | unset | Signing secret of a Polar webhook endpoint pointed at `https://<your-domain>/api/billing/webhook` (raw format, `subscription.*` events). |
| `POLAR_PRODUCT_MONTHLY_ID` | with billing | unset | Polar product id for the monthly plan. |
| `POLAR_PRODUCT_YEARLY_ID` | with billing | unset | Polar product id for the yearly plan. |
| `POLAR_SERVER` | no | `sandbox` | `sandbox` or `production` Polar environment. |
| `FREE_MAX_VAULTS` | no | `3` | Free-tier cap on unsubscribed vaults per user (only enforced when billing is enabled). |
| `FREE_MAX_MEMBERS` | no | `3` | Free-tier cap on members + pending invitations per unsubscribed vault (only enforced when billing is enabled). Gates new invitations and join-code redemptions only; lowering it never removes existing members. |

> Billing note: the Polar organization must have **allow multiple subscriptions per customer** enabled
> (Organization settings, or `PATCH /v1/organizations/:id` with `subscription_settings.allow_multiple_subscriptions: true`),
> otherwise a customer's second vault upgrade is rejected at checkout.

See `app/apps/server/.env.example` for the same list with inline comments.

## Point the desktop app at your server

An account belongs to **one server**. A teammate who signs up on the managed
instance by mistake gets an account and a vault there, and nobody notices until
you cannot see them in Members — so the app asks which server before it takes a
password.

**On first run**, the sign-in dialog opens on *"Where do your notes live?"* with
two options: the managed service, or **Your own server**. Choosing your own asks
for the URL and checks `GET <url>/health` before it goes any further, so a typo
is one inline sentence instead of a `Load failed` three screens later. The
sign-in form that follows names the server it is about to post to, with a
**Change** link back.

**Later**, or on a device already signed in somewhere else: **Account settings →
Connection**. Same health check, same rules. Changing the server is a de-facto
sign-out — sessions are stored per server in the OS keychain — so the app lands
on that server's session, or signed out if it has none.

**Send one link instead of dictating a URL.** Your server serves

```
https://<your-server>/open/connect
```

which is clickable in chat (a bare `baalda://` scheme is not) and bounces into
the app, where it asks the person to confirm before connecting. Nothing is
applied without that click: the link decides where a password gets posted, so it
is treated as untrusted input. Behind a reverse proxy with a path prefix, send
`https://<your-server>/<prefix>/open/connect` and have the proxy set
`X-Forwarded-Prefix` — that header is the only way the server can learn the
prefix, since a prefix left on the forwarded path does not match the route.

The page derives the address from the incoming request, honouring
`X-Forwarded-Proto` and `X-Forwarded-Host`, and falls back to `BETTER_AUTH_URL`
— so set that correctly (see the table above) if your proxy does not forward a
usable `Host`.

> **URLs accepted:** a bare host gets `https://` (never http, which would send
> credentials in the clear); an explicit `http://` is honoured for a LAN or
> localhost server; a path prefix is kept. **Packaged builds can only reach
> plain `http://` on `localhost` / `127.0.0.1`** — the webview's
> `connect-src` allows all `https:` but only loopback for `http:`, so a LAN
> server at `http://192.168.x.x:3010` needs TLS or an SSH tunnel.

## Scaling & high availability (spec 05)

The default single-instance deploy scales to hundreds of concurrent users:
the cost of one edit is proportional to the number of people live in *that
vault* (a team), not your total user count, and the vault channel is a
stateless relay so server memory is bounded by docs being *edited*, not docs
that exist.

To go beyond one instance — for thousands of concurrent users, redundancy, or
zero-downtime **rolling deploys** — run several instances behind a load
balancer and set **`REDIS_URL`** on all of them:

- The **vault replication channel** fans out via Redis pub/sub, so a client can
  connect to any instance and still receive every authorized doc's updates.
- The **Hocuspocus editing path** uses the Redis extension, so the *same* doc
  edited live on two instances stays consistent.

No sticky sessions are required for the vault channel (it's a stateless relay);
the editing path is made instance-agnostic by the Redis extension. Clients
reconnect with jittered backoff, so a rolling deploy doesn't stampede.

A managed Redis (Railway Redis, Upstash, ElastiCache, …) works; point every
instance at the same `REDIS_URL`. For local multi-instance testing, the server
compose file ships an optional Redis under the `ha` profile:

```bash
cd app/apps/server
docker compose --profile ha up -d redis   # host port 6389
REDIS_URL=redis://localhost:6389 pnpm run dev
```

Self-hosters who run a single instance need none of this — leave `REDIS_URL`
unset and the server behaves exactly as before (Postgres only).
