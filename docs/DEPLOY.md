# Deploying the Baalda server

The server (`app/apps/server`) is a self-hostable Node + Postgres service: a Hono
HTTP API and the Hocuspocus sync WebSocket, both served on a single public port.
This guide covers running it with plain Docker and deploying it to Railway.
Everything here is optional. The desktop app works fully offline with no server
at all, and you can always point it at [baalda.com](https://baalda.com) instead
of self-hosting.

## Ports

The server binds one HTTP port (`PORT`, default `3010`) that serves both the
REST/auth API and the sync WebSocket at `/sync`. That is the only port a
deployment needs to expose. `HOCUSPOCUS_PORT` (default `3011`) still exists for
local development and for older clients that dial the dedicated Hocuspocus
port directly, but it does not need to be reachable from outside the container
in production.

## Option A: plain Docker

The image is built from the repo root because the server is one workspace of
an npm-workspaces monorepo and needs the root `package.json` / lockfile to
resolve its dependencies.

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

The repo ships a checked-in `railway.json` at the repo root, so Railway needs
almost no manual configuration:

1. Create a new Railway project and deploy from this GitHub repo. Railway
   reads `railway.json` and builds `app/apps/server/Dockerfile` with the repo
   root as build context.
2. Add a **Postgres** database service to the project (Railway's own Postgres
   plugin works fine).
3. On the server service, set the environment variables:
   - `DATABASE_URL`: reference the Postgres service's connection string
     (Railway lets you wire this as a variable reference instead of copying
     a literal value).
   - `JWT_SECRET`: generate one with `openssl rand -base64 32`.
   - `BETTER_AUTH_URL`: the server's public HTTPS URL (Railway gives you a
     `*.up.railway.app` domain, or attach your own).
4. Deploy. `railway.json`'s `deploy.preDeployCommand` runs
   `npm run migrate:deploy` before every deploy, and `deploy.healthcheckPath`
   is `/health`, so Railway won't cut over traffic until migrations have run
   and the server is answering.
5. Expose only the one HTTP port (Railway does this automatically from
   `PORT`); nothing else needs to be public.

Point the desktop app at the deployed server via the server URL field in
Settings.

Once this is stable, the maintainer can publish a **Railway template** from
the dashboard (Project → Settings → generate template) to enable a true
one-click "Deploy on Railway" button in the README. Until then, deploying
from the GitHub repo as above works the same way, just with a few manual
clicks instead of one.

## Environment variables

| Variable | Required | Default | Notes |
|---|---|---|---|
| `DATABASE_URL` | yes | `postgres://context:context@localhost:5439/context` | Postgres connection string. |
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

See `app/apps/server/.env.example` for the same list with inline comments.

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
REDIS_URL=redis://localhost:6389 npm run dev
```

Self-hosters who run a single instance need none of this — leave `REDIS_URL`
unset and the server behaves exactly as before (Postgres only).
