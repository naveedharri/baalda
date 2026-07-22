---
name: relaunch
description: Kill the running Baalda desktop (Tauri) dev instance AND the backend server, then launch fresh instances of both. Use when the user says "relaunch", "restart the app", "kill and relaunch", or wants a clean restart after code/config changes.
---

# Relaunch Skill Guide

Kills the current desktop (Tauri) dev process tree **and** the backend server, then
starts fresh instances of both. Postgres (Docker) is **left running** — restarting
the server process does not touch the DB, so no re-seed is needed.

Project: `/Users/macbook/Documents/OpenSource/Baalda/app`
- Desktop launch: `pnpm run dev:desktop` (= `pnpm --filter desktop tauri dev`; Vite on :1420) from the app root.
- Server launch: `pnpm run dev` from `app/apps/server/` (tsx watch; HTTP :3010, Hocuspocus WS :3011, GET /health).

## Steps

### 1. Kill the running instances
Kill both the desktop dev chain (`dev:desktop` → `tauri dev` → `vite` →
`target/debug/desktop`) and the backend server (`tsx src/index.ts`).

```bash
# Desktop
pkill -f "target/debug/desktop"        # the Tauri app binary
pkill -f "node_modules/.*/tauri"       # tauri dev (pnpm resolves bins via .pnpm/)
pkill -f "node_modules/.*vite.*bin"    # desktop's Vite dev server
pkill -f "dev:desktop"                 # the pnpm wrapper(s)
pkill -f "tauri dev"                   # pnpm tauri dev
# Backend server
pkill -f "tsx.*src/index.ts"           # the Node/tsx server
pkill -f "apps/server"                 # server pnpm wrapper
sleep 1
# Confirm nothing survived:
pgrep -fl "tauri dev|node_modules/.*vite.*bin|target/debug/desktop|tsx.*src/index.ts" || echo "all stopped"
```

If `pgrep` still lists survivors, `kill -9` them by PID.

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
Run in the **background** from the server dir. Use the Bash tool with
`run_in_background: true`.

```bash
cd /Users/macbook/Documents/OpenSource/Baalda/app/apps/server && pnpm run dev
```

### 4. Launch the desktop
Run in the **background** from the app root. Use the Bash tool with
`run_in_background: true`.

```bash
cd /Users/macbook/Documents/OpenSource/Baalda/app && pnpm run dev:desktop
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
- If a process was launched from a Claude background shell in this session, kill that
  background task too (via its task id) so its output stream closes cleanly.
- Restarting the **server process** is safe — it does not re-seed or wipe anything.
  Only `pnpm test` in `apps/server` wipes the DB.
- A `tauri.conf.json` edit auto-triggers a rebuild in a *running* `tauri dev`, so a
  full relaunch is only needed when the watcher isn't running or you want a clean slate.
