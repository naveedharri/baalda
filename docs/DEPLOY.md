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
   - `PORT`: explicitly set `8080`, and use **8080** as the public domain's
     target port under Settings → Networking.
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
5. Expose only the one HTTP port. Check the public domain's target port is
   **8080**, matching `PORT`, then open `https://<your-domain>/health`.
   A successful deployment healthcheck alone does not verify public routing.

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

The template must explicitly set `PORT=8080` and its public domain's target port
to **8080**, and pin `RAILWAY_DOCKERFILE_PATH`. The three instance-specific
variables are Railway template expressions, so
**every deployment gets its own values** rather than inheriting the publisher's:

```
DATABASE_URL=${{Postgres.DATABASE_URL}}
JWT_SECRET=${{secret(32)}}
BETTER_AUTH_URL=https://${{RAILWAY_PUBLIC_DOMAIN}}
PORT=8080
RAILWAY_DOCKERFILE_PATH=app/apps/server/Dockerfile
```

Paste that into the template's **Raw Editor** exactly as written — unquoted, and
with no spaces around `=`. Railway's ENV parser keeps what it is given: padding
around `=` can land a **leading space inside the value** (a `BETTER_AUTH_URL` of
` https://…` breaks every invitation link), and `JWT_SECRET="…"` can bake literal
quote characters into the signing secret. Reopen the Raw Editor after saving and
check it shows five lines — pasting twice silently leaves duplicates.

`${{secret(32)}}` is what makes the template safe to publish at all — a literal
secret baked into a public template would let anyone mint a sync token for any
note on every instance deployed from it. Billing stays off
(so there are **no** vault or member limits), Google sign-in stays hidden until
you add OAuth credentials, and Redis is only needed to run several instances.

Once it's up, open the desktop app: its first-run step asks whether your notes
live on the managed service or **your own server**, and the generated
`*.up.railway.app` URL goes there. You can also send your team
`https://<that URL>/open/connect` and let them click it.

**Password recovery:** outbound email is optional and is not configured by the
template. To enable **Forgot password?**, add `EMAIL_FROM` and either
`SMTP_URL` or `RESEND_API_KEY`; see [Outbound email](#outbound-email-password-reset-invitations).
That section also covers administrator password recovery without email.

### Existing Railway deployment returns 502

The earlier template fixed the domain target at **3010** but omitted `PORT`
and the Dockerfile builder. A Railpack deployment could therefore listen on
**8080** while its domain still forwarded to **3010**. This can show as Online
with a passing healthcheck while the desktop reports it cannot reach the server.

Set `PORT=8080` in the **baalda** service's Variables and change the existing
domain's target port to **8080** under Settings → Networking, then redeploy.
Keep the existing domain so `BETTER_AUTH_URL` and clients' saved URLs stay valid.
Confirm `https://<your-domain>/health` responds successfully. An existing setup
using **3010** for both values is also valid; the two values must agree.

The server and Docker image retain their `3010` default for local and Compose
deployments. Railway's explicit service variable overrides that default.

### Maintaining the template

The service config lives in Railway's template editor, **not** in this repo — the
only parts version-controlled here are `app/.railway/railway.ts` (builder,
pre-deploy migration, healthcheck) and the Dockerfile. Changing the required env vars means
editing the template in the dashboard too, or one-click deploys will boot
misconfigured.

For the `baalda` template service, set
`RAILWAY_DOCKERFILE_PATH=app/apps/server/Dockerfile` and keep the build context
at the repository root. Railway uses this variable to detect the Dockerfile
([Railway Dockerfile documentation](https://docs.railway.com/builds/dockerfiles)).
Set the pre-deploy command to `node dist/db/migrate.js`, the healthcheck
to `/health`, `PORT=8080`, and the public domain target to **8080**. The checked-in
IaC is not automatically applied when someone clicks the template button.
After saving, inspect the published template again and verify those settings;
repository changes alone do not repair the marketplace template or existing
deployments.

Use the dashboard to edit the template's service configuration and apply its
staged changes. Current Railway CLI versions also support
`railway templates publish` / `update` for marketplace metadata; those commands do not expose the
service configuration. See [Railway template CLI documentation](https://docs.railway.com/cli/templates).

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

## Option C: Coolify

Coolify (and similar PaaS Docker Compose tools) run `docker compose` with the
**repo root** as the project directory, not the directory the compose file
lives in. That breaks [`deploy/compose/docker-compose.yml`](../deploy/compose)'s
`build.context: ../..`, which assumes you run `cd deploy/compose && docker
compose up` — Coolify instead resolves that path two directories *above* the
repo root and the build fails with `lstat /app: no such file or directory`.

[`deploy/coolify/docker-compose.yml`](../deploy/coolify) is the same stack
(Postgres → migrate → server) with `build.context: .`, built for that project
directory, and with no ports published — Coolify's own Traefik proxy
terminates TLS and reaches the container on the internal network instead.
Tested end-to-end on a live Coolify instance: build, all three services
healthy, a custom domain with a real Let's Encrypt certificate, and the
desktop app signing in and syncing through it.

1. **New Resource → Docker Compose** (**Public Git Repository** works for a
   public repo, no credentials needed), point it at this repository (or your fork).
2. **Base Directory:** `/` (repo root) — this is what makes `context: .` in
   the compose file resolve correctly.
3. **Docker Compose Location:** `/deploy/coolify/docker-compose.yml`.
4. Deploy — no env vars to fill in first. `POSTGRES_PASSWORD` and
   `JWT_SECRET` come from Coolify's magic env vars
   (`SERVICE_PASSWORD_64_POSTGRES`, `SERVICE_REALBASE64_64_JWT`);
   `BETTER_AUTH_URL` resolves to a placeholder (`http://localhost:3010`) via
   the compose file's own `:-` default, so the stack comes up on its own.
   `migrate` must complete successfully before `server` starts, so a deploy
   never briefly answers requests against an old schema. `server` also
   declares Coolify's `SERVICE_FQDN_SERVER` magic env var, so a domain
   (targeting its exposed port `3010`) is generated and assigned to it
   automatically; if that doesn't happen, assign one by hand (Service →
   `server`, Port → `3010`, Protocol → `https`, with the domain's DNS `A`
   record already pointed at your Coolify server).
5. Once it's up, set `BETTER_AUTH_URL` to the real domain from step 4
   (`https://…`, no trailing slash, no port) in the `server` service's own
   Environment Variables — not a global Coolify setting — and redeploy. Until
   then, auth/invitation links point at the placeholder instead. The sync
   WebSocket rides the same port at `/sync`, so nothing else needs routing.

   Three Coolify-specific gotchas this file already works around — see
   [`deploy/coolify/README.md`](../deploy/coolify/README.md#gotchas-we-hit-testing-this)
   for the full detail if you're customizing it: `${VAR:?text}` means
   "prefilled default", not "error message", unlike bash; an unset `${VAR}`
   reaches the container as an **empty string**, which this server's own env
   fallback does not catch (the default has to live in the compose file's
   `${VAR:-default}`, not in app code); and a since-fixed Coolify bug
   ([#11664](https://github.com/coollabsio/coolify/issues/11664), fixed in
   **v4.3.19**) could corrupt a saved domain into a bare `https://`, aborting
   every deploy with `The string 'https://' is no valid url.` — if you hit
   that exact error, update Coolify.

Full walkthrough and the differences from `deploy/compose`:
[`deploy/coolify/README.md`](../deploy/coolify/README.md).

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
| `PG_POOL_MAX` | no | `30` | Postgres connections this instance pools. Keep the total across all instances under the server's `max_connections`; a pool below `BACKFILL_CONCURRENCY` lets one vault reconnect starve the HTTP routes. |
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
| `BATCH_MAX_NOTES` | no | `200` | Items one `POST /api/vaults/:id/notes/batch` may carry. Past it the request is refused with `batch_too_large`; the desktop chunks to this number. |
| `BATCH_MAX_FOLDERS` | no | `500` | Same, for `folders/batch`. Higher than notes because a folder row is cheaper — no per-item permission walk on a resolved parent. |
| `BATCH_MAX_FILES` | no | `200` | Same, for `files/batch`. |
| `BATCH_MAX_DOCS` | no | `100` | Items one `POST /api/vaults/:id/docs/batch` (CRDT content push) may carry. |
| `BATCH_MAX_DECODED_BYTES` | no | `4194304` | Total **decoded** update bytes one `docs/batch` may carry (4 MiB). The route also takes a 16 MB body limit; this is the heap bound behind it. |
| `BOOTSTRAP_MAX_PAGE_BYTES` | no | `4194304` | Byte budget for one bootstrap page (4 MiB). A single doc larger than a page ships alone rather than being refused. |
| `BOOTSTRAP_MAX_PAGE_DOCS` | no | `256` | Doc budget for one bootstrap page, for a vault of many tiny notes. |
| `BOOTSTRAP_CONCURRENCY` | no | `4` | Bootstrap pages built at once across this instance. Past it a page request answers 503 + `Retry-After` (`bootstrap_busy`). Raise only alongside the container's memory: a page is merged and gzipped in heap before a byte is sent. |
| `BOOTSTRAP_TTL_HOURS` | no | `24` | How long a bootstrap session's materialised doc list stays valid. Past it a page request answers 410 `session_expired` and the client re-POSTs with a fresh `have`. |
| `POLAR_ACCESS_TOKEN` | no | unset | **Billing (optional).** Unset ⇒ billing fully disabled: no upgrade UI in clients, no free-tier limits — every self-hosted vault is unlimited. Set (with the vars below) ⇒ per-vault Pro subscriptions via [Polar](https://polar.sh). |
| `POLAR_WEBHOOK_SECRET` | with billing | unset | Signing secret of a Polar webhook endpoint pointed at `https://<your-domain>/api/billing/webhook` (raw format, `subscription.*` events). |
| `POLAR_PRODUCT_MONTHLY_ID` | with billing | unset | Polar product id for the monthly plan. |
| `POLAR_PRODUCT_YEARLY_ID` | with billing | unset | Polar product id for the yearly plan. |
| `POLAR_SERVER` | no | `sandbox` | `sandbox` or `production` Polar environment. |
| `FREE_MAX_VAULTS` | no | `2` | Free-tier cap on unsubscribed vaults for new accounts (only enforced when billing is enabled). Migration 031 records the previous three-vault allowance for accounts that already exist. |
| `FREE_MAX_MEMBERS` | no | `3` | Free-tier cap on members + pending invitations per unsubscribed vault (only enforced when billing is enabled). Gates new invitations and join-code redemptions only; lowering it never removes existing members. |
| `BLOB_STORAGE` | no | `postgres` | Where attachment BYTES live: `postgres` (zero config) or `s3`. See [Attachments storage](#attachments-storage). An unrecognised value, or `s3` with an incomplete bucket config, is a fatal startup error. |
| `MAX_BLOB_BYTES` | no | `26214400` | Hard ceiling for one attachment on the Postgres provider, in bytes (25 MB). A heap bound, not a taste one — that provider buffers the whole value, ~3.7x, in a 512 MB heap. Raise it only alongside the container's memory. |
| `MAX_INFLIGHT_UPLOAD_BYTES` | no | `2 × MAX_BLOB_BYTES` | Total upload-body bytes admitted at once. Beyond it uploads queue, then shed with 503. Never lower than `MAX_BLOB_BYTES`. |
| `MAX_BLOB_BYTES_DIRECT` | no | `524288000` | Ceiling for one attachment on S3 (500 MB). A product decision, not a heap bound: the bytes never enter this process. Per-category caps still apply. |
| `BLOB_MIME_ENFORCE` | no | `reject` | `reject` answers 415 for a Content-Type Baalda does not know; `warn` logs and stores it. Use `warn` first on an existing server to see what enforcement would refuse. |
| `BLOB_PENDING_TTL_MINUTES` | no | `60` | How long an abandoned upload holds its content's dedupe slot before the sweep removes it. Always on, every 15 minutes, serialized across instances by an advisory lock. |
| `FREE_MAX_STORAGE_MB` | no | `1024` | Free-tier attachment storage per unsubscribed vault (only enforced when billing is enabled; a vault with an active subscription is unlimited). Over it, `intent` answers 402 `storage_limit_reached`. Lowering it never deletes anything. |

| `BLOB_GC_ENABLED` | no | `false` | Delete stored attachments no note references any more. **Off by default** — see [Attachment garbage collection](#attachment-garbage-collection). The deletion *queue* (objects whose row a vault or org delete already removed) is always on and is not affected by this. |
| `BLOB_GC_ORPHAN_DAYS` | no | `30` | How long an unreferenced attachment must have existed before it is collectable. An attachment is uploaded before the note embedding it is written, and that note may arrive days later from a device that was offline. |
| `BLOB_GC_INTERVAL_MS` | no | `21600000` | Minimum gap between orphan sweeps (6 h). The GC ticks every 15 minutes for the always-on sweeps; this rate-limits the orphan pass on top of that. |
| `BLOB_GC_MAX_DELETES_PER_RUN` | no | `200` | Hard ceiling on deletions in one orphan sweep — the blast radius if the reference table is wrong. |
| `S3_BUCKET` | with `s3` | unset | Bucket name. Create it first — the server never does. |
| `S3_ACCESS_KEY_ID` | with `s3` | unset | Access key. |
| `S3_SECRET_ACCESS_KEY` | with `s3` | unset | Secret key. Set via env only, never committed. |
| `S3_REGION` | no | `us-east-1` | AWS region. Cloudflare R2 wants `auto`. |
| `S3_ENDPOINT` | no | unset | Unset ⇒ real AWS S3. R2: `https://<account-id>.r2.cloudflarestorage.com`. MinIO: your host. |
| `S3_FORCE_PATH_STYLE` | no | `false` | `true` for MinIO and anything else without bucket-per-subdomain DNS. |
| `S3_KEY_PREFIX` | no | unset | Path prefix for NEW object keys (`<prefix>/vaults/<vaultId>/<sha256>`), so two deployments can share one bucket. Leading/trailing slashes are stripped; `..` is a fatal startup error. Rows store the full key, so changing it never strands existing objects. |
| `S3_PRESIGN_UPLOAD_TTL_SECONDS` | no | `900` | Lifetime of an upload URL. Also the lifetime of the Postgres provider's signed same-origin PUT. |
| `S3_PRESIGN_DOWNLOAD_TTL_SECONDS` | no | `300` | Lifetime of a download URL. |
| `S3_PROXY_DOWNLOADS` | no | `false` | `true` streams downloads through this server instead of redirecting to the bucket. Needed when clients cannot reach the bucket (a MinIO on a private subnet); costs egress twice. |

Notes and embedded attachments sync on Free, within the configured storage limit.
Attachment bytes use the configured blob provider (Postgres or S3-compatible storage,
including R2); Markdown retains portable attachment links rather than inline binary data.
When billing is enabled, standalone file sync requires an active Pro subscription on
the vault (including the `past_due` grace period). Migration 031 preserves only
the previous three-vault allowance for accounts that already exist when it runs;
its legacy `attachment_sync` column does not grant blob transfer. Existing blobs
are not deleted, and blob deletion remains available after a downgrade so stored
data can still be cleaned up. Billing-disabled self-hosts remain unlimited.
| `S3_CHECKSUM_MODE` | no | `auto` | `auto` \| `sha256` \| `md5` \| `none`. `auto` = sha256 on real AWS, md5 against any custom endpoint (R2 implements only `Content-MD5`). |
| `S3_MULTIPART_THRESHOLD_BYTES` | no | `104857600` | Where a single PUT becomes a presigned multipart upload (100 MB, AWS's own threshold). |
| `S3_MULTIPART_PART_BYTES` | no | `16777216` | Bytes per multipart part (16 MB). Raised automatically if an object would need more than 10 000 parts. |
| `DEEP_LINK_SCHEME` | no | `baalda` | URL scheme of the desktop app the server's pages bounce into. Set `baalda-staging` on the server behind the Staging app so production and staging links open the right app on a machine that has both. |
| `EMAIL_FROM` | for email | unset | **Outbound email (optional).** Sender address, e.g. `Baalda <no-reply@example.com>`. With this and ONE transport below, password reset ("Forgot password?"), sign-up verification and invitation emails switch on. Unset ⇒ email off and none of those is offered (invitations are shared as a link instead). |
| `SMTP_URL` | one transport | unset | Any SMTP server: `smtp://user:pass@host:587` (STARTTLS) or `smtps://user:pass@host:465` (TLS). |
| `RESEND_API_KEY` | one transport | unset | [Resend](https://resend.com) API key — the HTTPS alternative to SMTP. |
| `EMAIL_TRANSPORT` | no | inferred | Force `smtp` \| `resend` \| `log` \| `memory` instead of inferring from the credential set. `log` prints emails to stdout (local dev); `memory` is the test suite's; both are refused in production. |

> Billing note: the Polar organization must have **allow multiple subscriptions per customer** enabled
> (Organization settings, or `PATCH /v1/organizations/:id` with `subscription_settings.allow_multiple_subscriptions: true`),
> otherwise a customer's second vault upgrade is rejected at checkout.

Billing needs no manual cleanup, and in particular none after a vault is deleted.
`DELETE /api/orgs/:orgId` asks the provider to cancel at the **end of the current
period** *before* it deletes anything: if the provider refuses, the vault is kept
and the route answers `502 subscription_cancel_failed`. The `subscriptions` row
then outlives the vault as a **tombstone** (migration 024 dropped the cascade
from `organization` and added `deleted_at` / `org_name` / `owner_user_id`), so a
late `subscription.*` webhook is stored and acknowledged instead of failing on a
foreign key and being retried by the provider forever. Webhooks resolve their row
by provider subscription id first, which is also what makes a transferred
subscription land on the vault that now holds it. Tombstones are what the owner
sees under "From deleted vaults", and `GET /api/billing/mine` re-reads stale
active rows from the provider, so our Postgres and the provider converge on their
own — never edit `subscriptions` by hand to fix a mismatch.

See `app/apps/server/.env.example` for the same list with inline comments.

## Attachments storage

Images, PDFs and every other file dropped into a note are **attachments**. Their
bytes have to live somewhere, and there are two answers.

**Postgres (the default, and nothing to configure).** The bytes are a column of
the `blobs` table: one database, one backup, no bucket, no credentials. This is
the right choice for most self-hosts. Its ceiling is `MAX_BLOB_BYTES` (25 MB per
file) and that number is a **heap bound**, not a policy — `node-postgres` has no
binary parameter protocol, so an N-byte attachment costs roughly 3.7N of this
process's memory at peak. Raising it without raising the container's memory is
how you get an OOM under two concurrent uploads.

**S3-compatible object storage (`BLOB_STORAGE=s3`).** AWS S3, Cloudflare R2,
MinIO, or anything else that speaks the same API. Clients upload and download
**straight to the bucket** through short-lived presigned URLs, so a 500 MB video
never passes through this server: the request it handles is a few hundred bytes
of JSON. Files over `S3_MULTIPART_THRESHOLD_BYTES` (100 MB) upload as presigned
multipart, so a failure costs one part rather than the whole transfer.

The provider is recorded on **every blob row at upload time**, never read from
the environment at download time. Switching `BLOB_STORAGE` back to `postgres`
therefore leaves everything written while S3 was on fully readable; it only
changes where the NEXT attachment goes. (Moving existing bytes between the two
is a separate migration script, and is not part of this release.)

### Turning S3 on

Create the bucket first — the server never creates one — then set:

```bash
BLOB_STORAGE=s3
S3_BUCKET=your-bucket
S3_ACCESS_KEY_ID=...
S3_SECRET_ACCESS_KEY=...
```

plus the endpoint bits for your provider:

| Provider | Settings |
|---|---|
| **AWS S3** | Leave `S3_ENDPOINT` unset; set `S3_REGION` to the bucket's real region. |
| **Cloudflare R2** | `S3_REGION=auto`, `S3_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com` |
| **MinIO** | `S3_ENDPOINT=https://your-minio-host`, `S3_FORCE_PATH_STYLE=true` |

Two deployments (staging and production, say) can share one bucket by giving
each a different `S3_KEY_PREFIX` — set `S3_KEY_PREFIX=staging` on the staging
server and leave it empty in production, and neither one's keys can land on the
other's.

The server **fails closed**: `BLOB_STORAGE=s3` with any of the three required
vars missing is a fatal startup error naming what is absent, not a silent
fallback to storing bytes in the database.

The Compose bundle ships a MinIO service behind a profile, so nothing about
`docker compose up -d` changes unless you ask for it:

```bash
docker compose --profile minio up -d minio
docker compose exec minio mc alias set local http://localhost:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD"
docker compose exec minio mc mb local/baalda
```

Then uncomment the `S3_*` block in `x-server-env` and restart the server. Read
the comments above the `minio` service before you do — the endpoint you sign
has to be one your CLIENTS can reach, which is not the same as one the server
can reach.

### Bucket CORS

Only needed if a **browser context** uploads directly — a webview fallback, or a
future web client. The desktop app's own transport is a native HTTP client and
sends no `Origin`, so a bucket with no CORS config works fine for it.

```json
[
  {
    "AllowedOrigins": ["tauri://localhost", "http://tauri.localhost", "https://your-app-origin"],
    "AllowedMethods": ["GET", "PUT", "HEAD"],
    "AllowedHeaders": ["content-type", "content-length", "content-md5"],
    "ExposeHeaders": ["etag"],
    "MaxAgeSeconds": 3000
  }
]
```

`ExposeHeaders: ["etag"]` is not optional for multipart: the client has to read
each part's `ETag` to complete the upload, and a browser hides it otherwise.

### Troubleshooting

| Symptom | Cause |
|---|---|
| `getaddrinfo ENOTFOUND your-bucket.your-host` | Path-style addressing is off. Set `S3_FORCE_PATH_STYLE=true` (MinIO and most self-hosted gateways). |
| Every upload 403s with `SignatureDoesNotMatch`, immediately | Clock skew. Presigned URLs are signed against **this server's** clock; more than ~15 minutes from the bucket's and every signature is rejected. Run NTP. |
| Every upload 403s, and the URL contains `x-amz-checksum-sha256` | You set `S3_CHECKSUM_MODE=sha256` against a non-AWS endpoint. R2 implements only `Content-MD5`. Use `auto` (the default) or `md5`. |
| Uploads fail with `InvalidRequest` / an XML checksum error on an older MinIO | Update MinIO, or check you have not overridden the client's checksum settings — the server already sets `WHEN_REQUIRED` on both sides, which is what older gateways need. |
| Downloads 404 in a browser but work in the app | The signed `S3_ENDPOINT` is an address only the server can reach (e.g. `http://minio:9000`). Use a client-reachable address, or set `S3_PROXY_DOWNLOADS=1`. |
| A blob answers **503 `storage_unavailable`** | The row says `s3` and this build has no bucket configured. Never a 404 on purpose: a 404 tells the desktop the file is gone and it re-uploads every byte. |
| Attachments upload but never appear for teammates | The upload finished but `complete` never ran, leaving the row `pending`. Pending rows are invisible by design and are swept after `BLOB_PENDING_TTL_MINUTES`. |

### Attachment garbage collection

Three sweeps run inside the server on one timer, each serialized across
instances by a Postgres advisory lock. Two are always on and need no
configuration:

- **Abandoned uploads.** A `blobs` row is created at `intent`, before any byte
  moves, and holds its content's dedupe slot. A client that quits mid-upload
  leaves it `pending`; after `BLOB_PENDING_TTL_MINUTES` the row and its object
  go.
- **The deletion queue.** Deleting a vault, deleting an organization, or calling
  `DELETE /api/blobs/:id` removes `blobs` rows — two of those through a database
  cascade that runs no application code at all. A trigger records the
  provider and key of every non-Postgres row as it goes, and the sweep removes
  the objects. Nothing is lost if the bucket is briefly unreachable: the queue
  retries with exponential backoff and keeps a `last_error` for anything it
  eventually gives up on.

The third, **orphan collection**, is off unless you set `BLOB_GC_ENABLED=true`.
It deletes an attachment that no note references any more — the only sweep that
removes something a user made. It decides from a table derived from note text,
so it is wrapped in guards: a vault with no indexed notes is skipped entirely, a
vault whose references have never been built is rebuilt and re-asked rather than
swept, nothing younger than `BLOB_GC_ORPHAN_DAYS` is eligible, and no run
deletes more than `BLOB_GC_MAX_DELETES_PER_RUN`. Every deletion is logged:

```
[blob-gc] orphan removed: blob=<id> vault=<id> path=attachments/… size=…
```

Turn it on after a full re-index has run, and read those lines before the next
sweep six hours later.

### Moving existing attachments to S3

Flipping `BLOB_STORAGE=s3` only changes where NEW attachments go. Everything
already uploaded keeps `storage_provider = 'postgres'` and keeps being served
from the database — correct (a blob is always read through the provider recorded
on its row) and also why the database stays large.

`pnpm run blobs:migrate` moves them. It is **never automatic** and is not part
of a deploy: two phases, with you in between. Run it with the server's own
environment (it needs `DATABASE_URL` and the same `BLOB_STORAGE=s3` bucket
configuration; inside the container it is `node dist/scripts/migrate-blobs.js`).

```bash
# 1. See what would move. Changes nothing.
pnpm run blobs:migrate -- --copy --dry-run

# 2. Write the objects. Re-hashes every blob's bytes and refuses to move any row
#    whose content disagrees with its recorded sha256; verifies each object with
#    a HEAD; records `storage_key` ONLY — the provider stays `postgres`, so this
#    phase does not change how a single byte is read and is undone by clearing
#    the column.
pnpm run blobs:migrate -- --copy

# 3. Confirm downloads still work (they are still coming from the database).

# 4. Flip the verified rows and release their bytes. Re-checks that each object
#    is still there at the right size first, because after this the database
#    copy is gone.
pnpm run blobs:migrate -- --cutover
```

Flags: `--dry-run`, `--vault <id>` (one note collection), `--batch <n>` (rows
per page, default 50), `--limit <n>`, `--sleep-ms <n>` (pause between rows, to
keep a live database responsive). Both phases are idempotent and re-runnable;
the process exits non-zero if any row failed or any hash mismatched, so you can
script them and stop on the first phase that did not go cleanly.

**Reclaiming the disk.** Nulling a `BYTEA` column does not shrink the database
file. Postgres marks the old row versions dead and reuses the space for future
inserts; to give it back to the filesystem you need either `VACUUM (FULL)
blobs` — which takes an `ACCESS EXCLUSIVE` lock, i.e. downtime proportional to
the table — or [`pg_repack`](https://reorg.github.io/pg_repack/), which does the
same online at the cost of an extension and roughly double the table's disk
while it runs. Neither is run for you.

### Rolling it out

Staging first, always. The check that matters is a real round trip: upload a
video larger than `MAX_BLOB_BYTES` (so it can only have gone direct to the
bucket) from a packaged app, confirm a second device downloads it, and watch the
server's RSS stay flat while it transfers.

## Outbound email (password reset, invitations)

Email is opt-in, on the same pattern as Google sign-in: leave it unconfigured
and the server never tries to send anything — the desktop hides "Forgot
password?", `POST /api/auth/request-password-reset` answers 400, and Members
offers **Copy link** on each invitation so an admin can paste it into chat.
Configure `EMAIL_FROM` plus either `SMTP_URL` or `RESEND_API_KEY` and three
things switch on together:

- **Password reset** — "Forgot password?" in the app (and on `/oauth/login`)
  emails a single-use link, valid for one hour, to `<BETTER_AUTH_URL>/reset-password`,
  a page this server renders itself; setting the password there bounces back
  into the app's sign-in card. Setting a new password signs out every other
  session. The request reports what happened — sent, no account for that
  address on this server, or the provider's error — rather than a neutral
  "check your inbox" (sign-up already reveals whether an address is taken, so
  the neutral answer protected nothing and hid wrong-server mistakes).
  An account created through Google has no password; the same flow lets it set one.
- **Sign-up verification** — a confirmation email on sign-up, recorded when the
  link is clicked; the confirmation page bounces back into the app, which shows
  the verified state under Account settings → Email without a reload (and offers
  a resend). It does not gate sign-in yet (accounts created before this shipped
  were never verified, and locking them out would be worse than the problem it
  solves).
- **Invitation emails** — inviting a teammate emails them a link to
  `<BETTER_AUTH_URL>/invite/<id>`, which opens the desktop app on that
  invitation: sign in (or sign up) with the invited address and they land in the
  vault. Members says "Invitation emailed" only once the provider accepted the
  message; if it refused, the reason is shown with the link to share instead.
  Inviting an address that is already pending re-sends. A teammate who was
  invited by email but joins with the vault's **join code** ends up in the same
  state — the invited role, invitation marked accepted.

Links are built from `BETTER_AUTH_URL`, so it must be the address people can
reach from outside. A half-configured setup (a transport without `EMAIL_FROM`,
or the other way round) is a startup error on purpose: offering reset links
that never arrive is worse than offering none.

**No email and someone is locked out?** From the server's shell, with the
server's environment (`DATABASE_URL`):

```bash
cd app/apps/server
pnpm run set-password -- someone@example.com                # prints a generated password
pnpm run set-password -- someone@example.com --password '…'  # or set a chosen one
```

It writes a fresh argon2id hash (creating the credential for a Google-only
account) and revokes the account's live sessions. In Docker, run the compiled
copy inside the container: `docker exec -it <container> node dist/scripts/set-password.js someone@example.com`.

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
