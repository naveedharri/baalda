---
name: window-simulator
description: Run Baalda's real desktop UI in a local browser with synthetic vault data to preview Windows or macOS layouts, investigate visual bugs, and capture screenshots from a Mac. Use for browser UI simulation; native window behavior still requires the target OS.
---

# Window simulator

Use the tracked harness in `app/apps/desktop/dev/window-simulator/`. It imports
the real React app, styles, and editor after installing Tauri IPC and server
mocks. Both platform modes use the same synthetic vault and members so missing
fixture data cannot masquerade as a platform difference.

## Start on a Mac

Resolve paths from this Baalda checkout. Read `AGENTS.md` and `CLAUDE.md` before
changing product code. Install dependencies with `pnpm install` in `app/` if needed.

From `app/apps/desktop/`:

```bash
pnpm run simulate:windows
# Or, for the macOS layout:
pnpm run simulate:macos
```

The simulator uses port **1425**, separate from Tauri development on 1420.
Once the server is running, reuse it for both URLs:

- Windows: `http://localhost:1425/dev/window-simulator/?platform=windows`
- macOS: `http://localhost:1425/dev/window-simulator/?platform=macos`
- Add `&theme=dark` or `&sidebarHidden=true` for those states.

Keep the Vite process/session handle for logs and cleanup. If the port is busy,
check whether this checkout's simulator is already serving there; do not stop
an unrelated process or launch a second server needlessly. A browser reload
resets the fixture's in-memory changes.

## Preview and investigate

Use available browser tooling to open the real simulator URL. For a large
review screenshot use a 1600×1000 viewport; also inspect 720×600 when changing
window chrome or panel layout. Compare Windows and macOS with the same theme,
viewport, sidebar state, and selected note. A macOS browser simulation cannot
draw the operating system's actual traffic lights. The platform parameter selects
the app's platform branch; it does not change the browser engine into WebView2 or
WKWebView.

Navigate the surfaces affected by the change. For titlebar work, include the
sidebar shown/hidden, the Activity/Versions panel, graph, welcome screen, and
settings overlays. On Windows, opening the Activity/Versions panel hides the
window caption controls; its own close button stays at the top edge. Closing the
panel restores the caption controls. For avatars, inspect a vault icon and several character
avatars in the same document: shared SVG resource IDs can fail in the full app
even when an isolated gallery renders correctly.

If a panel is unexpectedly empty or an action is missing, inspect the mock
response and the consuming API type before blaming the platform. The harness
must return complete, correctly shaped data for the surface being reviewed.
For example, `/api/auth-methods` controls the bug-report button, member roles
control manager actions, and a public link requires a real-shaped `url` field.
Add missing synthetic responses in the harness rather than changing production
authorization or visibility rules to make a preview appear populated.
Keep the fake API session and UI store in agreement: profile saves re-read the
session, and seeding only the visible signed-in state produces a false sign-out
when the client has no demo token.

The harness is development-only. Keep sample identities, links, and credentials
obviously synthetic. Preserve mocked IPC/network boundaries; do not connect the
simulator to a real vault, account, database, or model provider. Preview actions
must not send email, publish notes, change access on a real server, or make
payments. Do not save real credentials in fixtures or screenshots.

## Verify and hand off

Follow the current task's testing arrangement. If the user wants visual review
before a single final testing pass, finish the preview edits and wait for that
review before starting the pass. Relevant product tests, type checking, and a
Windows-target frontend build remain separate from the browser simulation:

```bash
# From app/apps/desktop; select tests appropriate to the actual change.
pnpm exec vitest run <test-files>
pnpm exec tsc --noEmit
TAURI_ENV_PLATFORM=windows pnpm run build
```

Save screenshots in an ignored `artifacts.local/` directory or an OS temporary
directory, never alongside tracked fixtures. Show the user the screenshot and
the live URL, and leave the simulator running when it is the requested preview.
Keep the user's latest reviewed layout in the deliverable tab.

Report browser checks as simulation checks. Native Windows drag, resize, Snap,
DPI scaling, WebView2-specific behavior, caption commands, and packaged CSP need
appropriate native validation; macOS `cargo check` does not compile Windows-only
Rust branches. This workflow needs neither a backend nor destructive server tests.
