// Keychain-backed storage for client-held vault keys (W3).
//
// The account X25519 private key lives under `baalda.keys:<serverUrl>|<userId>`
// and each vault key under `vk:<serverUrl>:<vaultId>`, both in the OS keychain
// via the prefix-scoped `vault_secret_*` Rust commands. Never localStorage.
// Values are base64. A session-lifetime in-memory cache saves keychain round
// trips (and repeated macOS prompts); `clearVaultKeyCache` drops it on sign-out
// or a server switch.

import * as ipc from "../ipc";
import { fromBase64, toBase64, VK_BYTES } from "./crypto";

export type SecretIo = {
  get: (key: string) => Promise<string | null>;
  set: (key: string, value: string) => Promise<void>;
  delete: (key: string) => Promise<void>;
};

const tauriIo: SecretIo = {
  get: ipc.vaultSecretGet,
  set: ipc.vaultSecretSet,
  delete: ipc.vaultSecretDelete,
};

let io: SecretIo = tauriIo;
const cache = new Map<string, Uint8Array>();

/** Tests swap the IO; pass nothing to restore the keychain. */
export function setSecretIoForTests(next?: SecretIo): void {
  io = next ?? tauriIo;
  cache.clear();
}

export function clearVaultKeyCache(): void {
  cache.clear();
}

export const accountKeyName = (serverUrl: string, userId: string) => `baalda.keys:${serverUrl}|${userId}`;
export const vaultKeyName = (serverUrl: string, vaultId: string) => `vk:${serverUrl}:${vaultId}`;

async function getBytes(name: string): Promise<Uint8Array | null> {
  const hit = cache.get(name);
  if (hit) return hit;
  const raw = await io.get(name);
  if (raw == null) return null;
  const bytes = fromBase64(raw);
  cache.set(name, bytes);
  return bytes;
}

async function setBytes(name: string, bytes: Uint8Array): Promise<void> {
  await io.set(name, toBase64(bytes));
  cache.set(name, bytes);
}

async function remove(name: string): Promise<void> {
  cache.delete(name);
  await io.delete(name);
}

export const getAccountPrivateKey = (serverUrl: string, userId: string) =>
  getBytes(accountKeyName(serverUrl, userId));
export const setAccountPrivateKey = (serverUrl: string, userId: string, key: Uint8Array) =>
  setBytes(accountKeyName(serverUrl, userId), key);
export const deleteAccountPrivateKey = (serverUrl: string, userId: string) =>
  remove(accountKeyName(serverUrl, userId));

export async function getVaultKey(serverUrl: string, vaultId: string): Promise<Uint8Array | null> {
  const vk = await getBytes(vaultKeyName(serverUrl, vaultId));
  return vk && vk.length === VK_BYTES ? vk : null;
}
export async function setVaultKey(serverUrl: string, vaultId: string, vk: Uint8Array): Promise<void> {
  if (vk.length !== VK_BYTES) throw new Error("vault key must be 32 bytes");
  await setBytes(vaultKeyName(serverUrl, vaultId), vk);
}
export const deleteVaultKey = (serverUrl: string, vaultId: string) => remove(vaultKeyName(serverUrl, vaultId));
