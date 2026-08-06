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
answer requests against an old schema. Same guarantee `railway.json` gets from
its `preDeployCommand`.

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
docker compose pull && docker compose up -d --build   # upgrade
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
