// SPDX-License-Identifier: Apache-2.0
//
// Client-held vault keys (W3). OFF unless BAALDA_VAULT_KEYS is explicitly on:
// with the flag unset or off, nothing in src/crypto is consulted and the server
// behaves exactly as before. Read per call so tests can stub the env.
const ON = new Set(["1", "true", "on", "yes"]);
const OFF = new Set(["", "0", "false", "off", "no"]);

export function vaultKeysEnabled(): boolean {
  const raw = (process.env.BAALDA_VAULT_KEYS ?? "").trim().toLowerCase();
  if (ON.has(raw)) return true;
  if (OFF.has(raw)) return false;
  throw new Error(`BAALDA_VAULT_KEYS must be on or off, got "${process.env.BAALDA_VAULT_KEYS}"`);
}
