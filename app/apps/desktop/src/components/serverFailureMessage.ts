import { ServerCheckError } from "../lib/api";
import { plainHttpHint } from "../lib/auth/serverChoice";

/**
 * What to show a person whose server address didn't check out.
 *
 * Shared by the auth dialog's server step and Settings → Connection so the same
 * failure never gets two different explanations. `ApiClient.health` already
 * writes the actionable sentence; this only adds the one thing it can't know —
 * that a plain-http LAN address was blocked by the webview's CSP rather than
 * being offline (see `plainHttpHint`).
 */
export function serverFailureMessage(error: unknown, url: string): string {
  const base = error instanceof Error ? error.message : String(error);
  if (error instanceof ServerCheckError && error.kind === "unreachable") {
    const hint = plainHttpHint(url);
    if (hint) return `${base} ${hint}`;
  }
  return base;
}
