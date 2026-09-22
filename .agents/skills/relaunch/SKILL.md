---
name: relaunch
description: Kill the running Baalda desktop (Tauri) dev instance AND the backend server, then launch fresh instances of both. Use when the user says "relaunch", "restart the app", "kill and relaunch", or wants a clean restart after code/config changes.
---

# Relaunch Skill Guide

Kills the current desktop (Tauri) dev process tree **and** the backend server, then
starts fresh instances of both. Postgres (Docker) is **left running** — restarting
the server process does not touch the DB, so no re-seed is needed.

Project: the `app/` directory in this Baalda checkout. Resolve paths from the
repository root; do not assume a particular clone location.
- Desktop launch: `pnpm run dev:desktop` (= `pnpm --filter desktop tauri dev`; Vite on :1420) from the app root.
- Server launch: `pnpm run dev` from `app/apps/server/` (tsx watch; HTTP :3010, Hocuspocus WS :3011, GET /health).

## Steps

### 1. Kill the running instances
Inspect the desktop dev chain (`dev:desktop` → `tauri dev` → `vite` →
`target/debug/desktop`) and backend (`tsx watch src/index.ts`). Use process
arguments, parent relationships, and working directories to identify only this
Baalda checkout's processes. Stop identified PIDs with SIGTERM, wait for shutdown,
and use SIGKILL only for confirmed survivors. Avoid broad `pkill` patterns that
could stop another project's Vite or tsx processes. Skip shutdown if none run.

### 2. Make sure Postgres is up
The server needs Postgres (Docker, host port 5439). It usually stays up across
restarts — only start it if it's missing.

```bash
docker ps --filter "publish=5439" --format "{{.Names}} {{.Status}}" || true
# If nothing is listed, from app/apps/server/ run: pnpm run db:up
```

Do **not** run `pnpm run migrate` unless migrations changed, and never run
`pnpm test` in `apps/server` (it wipes the dev DB / users/orgs/vaults).

### 3. Launch the backend server
Launch from the server directory with Codex `exec_command`, using a short
`yield_time_ms` and retaining the returned session ID for startup logs. For a
detached process, use `subprocess.Popen(..., start_new_session=True)` with stdin
from DEVNULL and stdout/stderr redirected to a fresh log file in a temporary
directory; retain its PID and log path.

```bash
# From the repository root:
cd app/apps/server && pnpm run dev
```

### 4. Launch the desktop
Launch from the app root using the same background process approach as the server.

```bash
# From the repository root:
cd app && pnpm run dev:desktop
```

### 5. Confirm both came up
- **Server** (wait ~3–5s): `curl -s http://localhost:3010/health` returns OK, and
  the task output shows the HTTP :3010 / Hocuspocus WS listeners started.
- **Desktop** (wait ~15–20s; cargo may recompile): tail the background task output.
  Success looks like:

```
VITE v7.x ready ...
Running `target/debug/desktop`
```

If `tauri.conf.json` or Rust changed, expect a `Compiling desktop` / `Rebuilding
application...` step before `Running target/debug/desktop`.

## Notes
- If a process is owned by a Codex exec session, stop that session cleanly as well
  so its output stream closes. Poll session output with `write_stdin`.
- Restarting the **server process** is safe — it does not re-seed or wipe anything.
  Only `pnpm test` in `apps/server` wipes the DB.
- A `tauri.conf.json` edit auto-triggers a rebuild in a *running* `tauri dev`, so a
  full relaunch is only needed when the watcher isn't running or you want a clean slate.
