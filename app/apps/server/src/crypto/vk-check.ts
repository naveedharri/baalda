// SPDX-License-Identifier: Apache-2.0
//
// `vaults.vk_check`: a fixed constant sealed under the vault key, AAD bound to
// the vault id. Verifying a presented key = opening the check. GCM's tag
// comparison is constant-time, and every failure (wrong key, another vault's
// check, tampering, malformed bytes) collapses to the same `false`.
import { aadFor, open, seal } from "./envelope.js";

// Interop contract with the desktop (byte-for-byte): plaintext is this ASCII
// constant, AAD = aadFor("vaults", "vk_check", vaultId, vaultId), envelope as
// in envelope.ts (GCM additional data = 15-byte header || AAD).
const CHECK_PLAINTEXT = Buffer.from("baalda-vk-check-v1", "ascii");

function checkAad(vaultId: string): Buffer {
  return aadFor("vaults", "vk_check", vaultId, vaultId);
}

export function makeVkCheck(vk: Buffer, vaultId: string, generation = 1, nonceForTest?: Buffer): Buffer {
  return seal(vk, checkAad(vaultId), CHECK_PLAINTEXT, generation, nonceForTest);
}

export function verifyVk(vk: Buffer, vaultId: string, check: Buffer): boolean {
  try {
    // The constant is public and already authenticated by the tag.
    return open(vk, checkAad(vaultId), check).equals(CHECK_PLAINTEXT);
  } catch {
    return false;
  }
}
