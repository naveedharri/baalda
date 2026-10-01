/**
 * The app version this build reports to the server on the requests that hand
 * out the ability to push note content (issue #251).
 *
 * The server refuses the routes that hand out the ability to push note content
 * — the per-doc sync token, the vault-channel token and the batch push — with
 * `426 client_outdated` when this is below its `MIN_CLIENT_VERSION` (and, once
 * an operator enables `UNVERSIONED_CLIENTS=refuse`, when it is absent). Builds
 * that predate the header include the ones too old to push safely, so being
 * able to tell builds apart is the whole point of sending it.
 *
 * Sent as a QUERY PARAMETER ({@link CLIENT_VERSION_PARAM}), not a header. The
 * webview is cross-origin to the API, so a new request header needs the
 * server's CORS preflight to list it — and a server that predates this change
 * (an un-upgraded self-host, or production in the minutes before it deploys)
 * would refuse the preflight and with it EVERY request. An unknown query
 * parameter is simply ignored by an older server. The server also accepts the
 * `x-baalda-version` header for non-browser clients.
 *
 * Read from `tauri.conf.json` at BUILD time rather than through Tauri's async
 * `getVersion()`: the very first request of a launch (a sync-token mint) must
 * already carry it, and it must work under vitest with no Tauri runtime. The
 * Staging build's `-staging.N` suffix is applied by its workflow, not written
 * here; the server compares only `major.minor.patch`, so the base is enough.
 */
import { version } from "../../src-tauri/tauri.conf.json";

/** Mirrors the server's `src/http/client-version.ts CLIENT_VERSION_PARAM`. */
export const CLIENT_VERSION_PARAM = "clientVersion";

export const CLIENT_VERSION: string = version;

/** The server's refusal code for a build below its minimum version. */
export const CLIENT_OUTDATED_CODE = "client_outdated";
