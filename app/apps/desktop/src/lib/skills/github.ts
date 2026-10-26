// The admin's GitHub token for marketplace import (private repos, and a higher
// request limit than GitHub's 60 an hour without one). It lives only in the OS
// keychain under this key, per server and vault, and never reaches Baalda.

/** Keychain key for one vault's GitHub token on one server. */
export function githubTokenKey(serverUrl: string, orgId: string): string {
  return `baalda.skills.github:${serverUrl.trim().replace(/\/+$/, "")}|${orgId}`;
}
