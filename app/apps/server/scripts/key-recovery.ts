// SPDX-License-Identifier: Apache-2.0
//
// The launch safety net's offline half (src/crypto/key-recovery.ts). Run on
// the owner's own computer, never on a server. From app/apps/server:
//
//   npx tsx scripts/key-recovery.ts keygen <private-key-file>
//     Writes a new recovery private key to <file> (mode 600; keep it OFFLINE,
//     never in the repo) and prints the public key for KEY_RECOVERY_PUBLIC_KEY
//     plus a fresh KEY_RECOVERY_ADMIN_TOKEN.
//
//   KEY_RECOVERY_ADMIN_TOKEN=… npx tsx scripts/key-recovery.ts show <server-url> <vaultId>
//     Lists the vault's members, whether each has an account key, and the copies.
//
//   KEY_RECOVERY_ADMIN_TOKEN=… npx tsx scripts/key-recovery.ts rescue <server-url> <vaultId> <userId|email> <private-key-file>
//     Opens the vault's recovery copy with the offline key, checks it against
//     the vault (the server refuses a wrong key), and re-issues it to that
//     member's CURRENT account key. Their app picks it up within seconds.
//
// The member must have an account key (they signed in to Baalda 0.1.98+ at
// least once since losing access). Nothing here prints a key.

import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import {
  generateRecoveryKeypair,
  openRecoveryCopy,
  recoveryKeyFingerprint,
  recoveryPublicFromPrivate,
} from "../src/crypto/recovery-seal.js";
import { sealVkTo } from "../../desktop/src/lib/vaultKeys/crypto.js";

const ADMIN_HEADER = "x-baalda-recovery-admin";

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

function readPrivateKey(file: string): Buffer {
  const key = Buffer.from(readFileSync(file, "utf8").trim(), "base64");
  if (key.length !== 32) fail(`${file} is not a recovery private key`);
  return key;
}

type Listing = {
  keyed: boolean;
  generation: number | null;
  copies: Array<{ generation: number; recoveryKeyFp: string; sealedVk: string }>;
  members: Array<{ userId: string; email: string; name: string | null; role: string; publicKey: string | null }>;
};

async function listing(server: string, vaultId: string): Promise<Listing> {
  const token = process.env.KEY_RECOVERY_ADMIN_TOKEN ?? fail("Set KEY_RECOVERY_ADMIN_TOKEN");
  const res = await fetch(`${server.replace(/\/$/, "")}/api/admin/key-recovery/${encodeURIComponent(vaultId)}`, {
    headers: { [ADMIN_HEADER]: token },
  });
  if (res.status === 404) fail("Not found: wrong vault id, wrong admin token, or recovery is off on that server");
  if (!res.ok) fail(`Server answered ${res.status}`);
  return (await res.json()) as Listing;
}

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  if (cmd === "keygen") {
    const file = args[0] ?? fail("usage: keygen <private-key-file>");
    const { publicKey, privateKey } = generateRecoveryKeypair();
    writeFileSync(file, privateKey.toString("base64") + "\n", { flag: "wx", mode: 0o600 });
    chmodSync(file, 0o600);
    privateKey.fill(0);
    console.log(`Private key written to ${file}. Keep it offline; it can open every vault while recovery is on.`);
    console.log(`KEY_RECOVERY_PUBLIC_KEY=${publicKey.toString("base64")}`);
    console.log(`KEY_RECOVERY_ADMIN_TOKEN=${randomBytes(32).toString("base64url")}`);
    console.log(`Fingerprint: ${recoveryKeyFingerprint(publicKey)}`);
    return;
  }
  if (cmd === "show") {
    const [server, vaultId] = args;
    if (!server || !vaultId) fail("usage: show <server-url> <vaultId>");
    const l = await listing(server, vaultId);
    console.log(`keyed: ${l.keyed}  generation: ${l.generation ?? "-"}`);
    for (const c of l.copies) console.log(`copy: generation ${c.generation}, recovery key ${c.recoveryKeyFp}`);
    for (const m of l.members) {
      console.log(`${m.role.padEnd(6)} ${m.email}  ${m.userId}  account key: ${m.publicKey ? "yes" : "NO"}`);
    }
    return;
  }
  if (cmd === "rescue") {
    const [server, vaultId, who, keyFile] = args;
    if (!server || !vaultId || !who || !keyFile) fail("usage: rescue <server-url> <vaultId> <userId|email> <private-key-file>");
    const l = await listing(server, vaultId);
    if (!l.keyed || l.generation == null) fail("This vault is not encrypted; nothing to recover.");
    const member = l.members.find((m) => m.userId === who || m.email.toLowerCase() === who.toLowerCase());
    if (!member) fail("No such member in this vault.");
    if (!member.publicKey) fail("That member has no account key yet: they must sign in to Baalda 0.1.98+ once first.");
    const priv = readPrivateKey(keyFile);
    const fp = recoveryKeyFingerprint(recoveryPublicFromPrivate(priv));
    const copy = l.copies.find((c) => c.generation === l.generation && c.recoveryKeyFp === fp);
    if (!copy) fail(`No recovery copy for generation ${l.generation} under recovery key ${fp}.`);
    let vk: Buffer;
    try {
      vk = openRecoveryCopy(Buffer.from(copy.sealedVk, "base64"), priv, vaultId, l.generation);
    } catch {
      fail("The copy does not open with this private key.");
    } finally {
      priv.fill(0);
    }
    const sealed = Buffer.from(sealVkTo(new Uint8Array(Buffer.from(member.publicKey, "base64")), new Uint8Array(vk)));
    const res = await fetch(`${server.replace(/\/$/, "")}/api/admin/key-recovery/${encodeURIComponent(vaultId)}/grant`, {
      method: "POST",
      headers: {
        [ADMIN_HEADER]: process.env.KEY_RECOVERY_ADMIN_TOKEN!,
        "x-baalda-vk": vk.toString("base64"),
        "content-type": "application/json",
      },
      body: JSON.stringify({ userId: member.userId, generation: l.generation, sealedVk: sealed.toString("base64") }),
    });
    vk.fill(0);
    if (res.status !== 201) fail(`Grant refused: ${res.status} ${JSON.stringify(await res.json().catch(() => ({})))}`);
    console.log(`Done: ${member.email} gets this vault's key the next time their app checks (seconds).`);
    return;
  }
  fail("usage: keygen | show | rescue (see the header of this file)");
}

void main();
