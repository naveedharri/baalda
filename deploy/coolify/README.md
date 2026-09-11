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
4. Set the environment variables on the `server` and `migrate` services (or as
   shared project variables — see [`.env.example`](.env.example)):
   - `POSTGRES_PASSWORD`
   - `JWT_SECRET` — `openssl rand -base64 32`
   - `BETTER_AUTH_URL` — the public HTTPS URL Coolify's proxy fronts, e.g.
     `https://baalda.example.com` (no trailing slash, no port — TLS is on 443)
5. On the `server` service, set the domain to the same host as
   `BETTER_AUTH_URL` and expose container port `3010`. Coolify's Traefik
   handles TLS and WebSocket upgrade for you — the sync WebSocket rides the
   same port at `/sync`, so there's nothing extra to route.
6. Deploy. Coolify runs `postgres → migrate → server` in order (via
   `depends_on` + `condition: service_completed_successfully`), so the server
   never answers requests against an unmigrated schema.

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
