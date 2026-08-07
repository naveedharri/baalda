// Seed two throwaway teammates into the vault's organization, so the live check
// has someone to broadcast AS and someone to listen AS. Idempotent.
//
// Sign-up goes through the real Better Auth endpoint (so the password hash and
// account row are genuine); only the org membership is inserted directly,
// because joining otherwise needs an invitation flow this doesn't need to test.

import { execFileSync } from "node:child_process";
import { BASE, VAULT_ID } from "./common.mjs";

const PEOPLE = [
  { email: "ada@example.com", name: "Ada Lovelace", password: "TestPassword123!" },
  { email: "grace@example.com", name: "Grace Hopper", password: "TestPassword123!" },
];

const psql = (sql) =>
  execFileSync("docker", ["exec", "context-pg", "psql", "-U", "context", "-d", "context", "-t", "-A", "-c", sql])
    .toString()
    .trim();

const orgId = psql(`select organization_id from vaults where id = '${VAULT_ID}';`);
if (!orgId) {
  console.error(`No vault ${VAULT_ID}. List them with: select id, name from vaults;`);
  process.exit(1);
}
console.log(`vault ${VAULT_ID} → org ${orgId}`);

for (const person of PEOPLE) {
  let userId = psql(`select id from "user" where email = '${person.email}';`);
  if (userId) {
    console.log(`${person.email} already exists (${userId})`);
  } else {
    const res = await fetch(`${BASE}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: BASE },
      body: JSON.stringify(person),
    });
    const body = await res.json();
    if (!body.user?.id) throw new Error(`sign-up failed: ${JSON.stringify(body)}`);
    userId = body.user.id;
    console.log(`created ${person.email} (${userId})`);
  }
  psql(
    `insert into member (id, "organizationId", "userId", role, "createdAt")
     select 'vc-' || substr(md5('${orgId}${userId}'), 1, 28), '${orgId}', '${userId}', 'member', now()
     where not exists (
       select 1 from member where "organizationId" = '${orgId}' and "userId" = '${userId}'
     );`,
  );
  console.log(`  ↳ member of ${orgId}`);
}

console.log("\nseeded. now run:");
console.log(`  VAULT_ID=${VAULT_ID} node scripts/voice-check/listen.mjs`);
console.log(`  VAULT_ID=${VAULT_ID} node scripts/voice-check/broadcast.mjs "Hello from Ada"`);
