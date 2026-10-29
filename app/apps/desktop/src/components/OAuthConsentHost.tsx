import { useEffect, useState } from "react";
import type { OAuthConsentRequest } from "../lib/api";
import { authManager } from "../lib/auth/authManager";
import { consentKeyHeader, linkMatchesServer } from "../lib/oauthConsentLink";
import { toast } from "../lib/toast";
import { useStore } from "../store";
import { ConfirmDialog } from "./ConfirmDialog";

/**
 * Finishes a claude.ai / ChatGPT connection to a keyed vault (W3, security
 * rule 2), raised by a `baalda://oauth-consent` link from the server's consent
 * page. Reads the request from the signed-in server, asks the person, and only
 * on their click presents the vault key. The browser page then continues on
 * its own.
 */
export function OAuthConsentHost() {
  const link = useStore((s) => s.oauthConsentLink);
  const serverUrl = useStore((s) => s.serverUrl);
  const signedIn = useStore((s) => s.authStatus === "signed-in");
  const [request, setRequest] = useState<OAuthConsentRequest | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setRequest(null);
    setError(null);
    if (!link) return;
    if (!signedIn) {
      setError("Sign in to Baalda, then start the connection again.");
      return;
    }
    if (!linkMatchesServer(link, serverUrl)) {
      setError("This connection request is for another Baalda server than the one this app is using.");
      return;
    }
    let live = true;
    authManager.api
      .getOAuthConsent(link.id)
      .then((r) => live && setRequest(r))
      .catch(() => live && setError("This connection request expired or belongs to another account. Start it again."));
    return () => {
      live = false;
    };
  }, [link, serverUrl, signedIn]);

  if (!link) return null;
  const close = () => useStore.getState().clearOAuthConsent();

  if (error) {
    return (
      <ConfirmDialog title="Can't finish connecting" confirmLabel="OK" tone="accent" onConfirm={close} onCancel={close}>
        <p>{error}</p>
      </ConfirmDialog>
    );
  }
  if (!request) return null;

  const allow = async () => {
    const header = await consentKeyHeader(request.vaultIds, authManager.api);
    if (!header) {
      toast(`This computer doesn't have the key for ${request.vaultName || "this vault"} yet.`, "error");
      return;
    }
    await authManager.api.completeOAuthConsent(request.id, header);
    toast(`${request.app} is connected to ${request.vaultName || "your vault"}.`, "success");
    close();
  };

  return (
    <ConfirmDialog
      title={`Connect ${request.app}?`}
      confirmLabel="Allow access"
      tone="accent"
      onConfirm={allow}
      onCancel={close}
    >
      <p>
        {request.app} wants to read and edit notes in <b>{request.vaultName || "your vault"}</b>, within your
        existing permissions. It keeps working when this computer is off.
      </p>
    </ConfirmDialog>
  );
}
