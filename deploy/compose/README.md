# Self-host the Baalda server with Docker Compose

One command, one machine you control, no vendor account. If you'd rather not
manage a server at all, use the [Railway one-click deploy](../../docs/DEPLOY.md#option-b-railway-one-click)
or the managed option at [baalda.com](https://baalda.com) — the desktop app is
identical either way, you just point Server settings somewhere else.

```bash
cd deploy/compose
cp .env.example .env          # fill in POSTGRES_PASSWORD, JWT_SECRET, BETTER_AUTH_URL
docker compose up -d
```

Attachments use PostgreSQL by default. No MinIO credentials are required.

The server comes as a published image, `ghcr.io/naveedharri/baalda-server`
(amd64 and arm64), so tools that deploy a pasted compose file without building
(Portainer stacks, Hostinger's Docker Manager, CasaOS, Synology Container
Manager) work as is: paste `docker-compose.yml` and set the three values from
`.env.example`. Set `BAALDA_VERSION` (e.g. `0.1.112`) to pin a release;
unset follows the latest one. To build from this checkout or a fork instead:

```bash
docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build
```

Then in the desktop app: **account menu → Server settings →** your
`BETTER_AUTH_URL` → **Save**. Create an account and you're synced.

## What comes up

| Service | What it does |
| --- | --- |
| `postgres` | Postgres 16 on a named volume. Never published to the host. |
| `migrate` | Runs `dist/db/migrate.js` to completion, *then* exits. |
| `server` | Hono HTTP + Hocuspocus WS on **one** port (`3010`). |

The ordering is the point: `server` waits on `migrate` finishing successfully,
which waits on Postgres being healthy. A deploy can therefore never briefly
answer requests against an old schema. Same guarantee a Railway service gets from
the `preDeployCommand` in `app/.railway/railway.ts`.

**One port, not two.** The CRDT WebSocket is served on the HTTP port at `/sync`,
so there is nothing else to open or route. The dedicated `HOCUSPOCUS_PORT` exists
for local dev only.

## TLS — read this before exposing it

`server` binds to **127.0.0.1 by default**, on purpose. The API carries session
tokens and note content, so it must not be served over plain HTTP across a
network. Put a TLS terminator in front of it and let that reach port 3010:

```nginx
# nginx — the two Upgrade lines are mandatory, sync is a WebSocket
location / {
    proxy_pass http://127.0.0.1:3010;
    proxy_http_version 1.1;
    proxy_set_header Upgrade    $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host       $host;
    proxy_read_timeout 3600s;   # don't cut idle sync sockets
}
```

Caddy needs no WebSocket config — `reverse_proxy 127.0.0.1:3010` is enough, and
it gets you a certificate automatically.

Only set `BIND_ADDR=0.0.0.0` when something else already terminates TLS (a cloud
load balancer, a Tailscale/WireGuard network, another host's proxy).

## Operating it

```bash
docker compose logs -f server        # follow
docker compose ps                    # health
docker compose pull && docker compose up -d   # upgrade (a pinned BAALDA_VERSION: raise it first)
```

**Back up the volume.** `baalda_pgdata` holds every note's CRDT history — the
server's copy of your team's writing. Note that each desktop client also keeps
its own `.md` files on disk, so a total server loss is recoverable from any
client's vault; the volume is what makes *new* devices and *late* teammates able
to catch up.

```bash
docker compose exec -T postgres pg_dump -U baalda baalda | gzip > baalda-$(date +%F).sql.gz
```

⚠️ `docker compose down -v` deletes that volume. `down` without `-v` does not.

## Optional pieces

- **Google sign-in** — set `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` with the
  redirect URI `https://<your-server>/api/auth/callback/google`. Unset, the
  desktop app hides the Google button and email + password still works.
- **Billing stays off.** Leave the Polar block alone. Billing off means *no*
  limits — unlimited vaults, unlimited members.
- **Multiple instances** — only then set `REDIS_URL`, so every instance shares
  the vault replication feed. A single server uses in-memory pub/sub and needs no
  Redis.

Full env var reference: [`docs/DEPLOY.md`](../../docs/DEPLOY.md).

## Optional MinIO storage

MinIO is defined in `docker-compose.minio.yml`, which Compose does not load
by default. Unlike a disabled profile in the base file, this keeps MinIO's
required-variable checks out of the PostgreSQL-only startup path.

1. Set `MINIO_ROOT_USER` and `MINIO_ROOT_PASSWORD` in `.env`. Use a strong,
   unique password (for example, generate one with `openssl rand -hex 24`).
2. Start MinIO and create the bucket:

   ```bash
   docker compose -f docker-compose.yml -f docker-compose.minio.yml up -d minio
   docker compose -f docker-compose.yml -f docker-compose.minio.yml exec minio sh -c 'mc alias set local http://localhost:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" && mc mb --ignore-existing local/baalda'
   ```

   Credentials are expanded inside the container; `.env` does not need to be
   sourced into your shell. Missing or empty credentials fail configuration
   validation when this additional file is included.

3. To store new attachments in MinIO, add the following to `x-server-env` in
   `docker-compose.yml`:

   ```yaml
   BLOB_STORAGE: s3
   S3_ENDPOINT: ${S3_ENDPOINT:?set a client-reachable MinIO endpoint in .env}
   S3_BUCKET: baalda
   S3_ACCESS_KEY_ID: ${MINIO_ROOT_USER:?set MINIO_ROOT_USER in .env}
   S3_SECRET_ACCESS_KEY: ${MINIO_ROOT_PASSWORD:?set MINIO_ROOT_PASSWORD in .env}
   S3_FORCE_PATH_STYLE: "true"
   ```

   Publish the MinIO API port using the commented `ports` example in
   `docker-compose.minio.yml`, and set `S3_ENDPOINT` in `.env` to an address
   both the server container and clients can reach. For a team deployment,
   use an HTTPS hostname with TLS terminated in front of MinIO.

   `http://minio:9000` only resolves inside the Compose network. Setting
   `S3_PROXY_DOWNLOADS: "1"` can proxy downloads through the server, but uploads
   still use presigned URLs and require a client-reachable endpoint. See the
   [S3 deployment guide](../../docs/DEPLOY.md#bucket-cors) for browser CORS.

4. Apply the server configuration:

   ```bash
   docker compose -f docker-compose.yml -f docker-compose.minio.yml up -d
   ```

Include both `-f` arguments for subsequent MinIO-enabled operations, including
`ps`, `logs`, upgrades and `down`. The old `--profile minio` command is replaced
by explicit file inclusion. Starting MinIO alone does not change the server's
storage backend or migrate existing attachments. Back up both PostgreSQL and
the `baalda_minio` volume when using MinIO; `down -v` deletes those volumes.

## Compose configuration regression check

From the repository root, run:

```bash
python3 scripts/test-compose-config.py
```

This checks the default stack without MinIO credentials, and the optional
configuration with missing, empty, and valid credentials. It uses an isolated
environment and does not start containers or read your `.env`.
