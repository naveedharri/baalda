// ============================================================================
//  ADMIN ESCAPE HATCH — set a user's password from the server's shell.
//
//  For a self-hosted server with no outbound email configured (so no "Forgot
//  password?"), or for the one account whose mailbox is also locked out. Writes
//  a fresh argon2id hash to the user's credential account — creating that
//  account row when the user only ever signed in with Google — and revokes
//  every live session for the account, so whoever held the old password (or a
//  stolen session) is out.
//
//  Run from app/apps/server with the server's env (DATABASE_URL):
//
//    pnpm run set-password -- someone@example.com                 # generates one
//    pnpm run set-password -- someone@example.com --password 'N3w-pass-w0rd'
//
//  Lives under src/ so tsc emits it into the production image as
//  dist/scripts/set-password.js (`node dist/scripts/set-password.js <email>`
//  inside the container — tsx is a dev dependency and isn't shipped).
//  Prints the password when it generated one. Nothing is emailed.
// ============================================================================

import { randomBytes, randomUUID } from "node:crypto";
import { Algorithm, hash as argonHash } from "@node-rs/argon2";
import { pool, closePool } from "../db/pool.js";

function usage(msg?: string): never {
  if (msg) console.error(`error: ${msg}\n`);
  console.error("usage: pnpm run set-password -- <email> [--password <new password>]");
  process.exit(2);
}

function parseArgs(argv: string[]): { email: string; password: string | null } {
  let email: string | null = null;
  let password: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--password" || a === "-p") {
      password = argv[++i] ?? usage("--password needs a value");
    } else if (a.startsWith("--")) {
      usage(`unknown flag ${a}`);
    } else if (email === null) {
      email = a;
    } else {
      usage(`unexpected argument ${a}`);
    }
  }
  if (!email || !email.includes("@")) usage("an email address is required");
  if (password !== null && password.length < 8) usage("the password must be at least 8 characters");
  return { email, password };
}

/** URL-safe, 20 chars ≈ 120 bits — fine for a one-time password someone will change. */
function generatePassword(): string {
  return randomBytes(15).toString("base64url");
}

async function main(): Promise<void> {
  const { email, password: given } = parseArgs(process.argv.slice(2));
  const password = given ?? generatePassword();

  const user = await pool.query<{ id: string; email: string }>(
    `SELECT id, email FROM "user" WHERE lower(email) = lower($1)`,
    [email],
  );
  if (!user.rows[0]) {
    console.error(`No account with the email ${email}.`);
    process.exit(1);
  }
  const { id: userId, email: storedEmail } = user.rows[0];

  // Same algorithm and options as auth.ts (argon2id, library defaults).
  const hashed = await argonHash(password, { algorithm: Algorithm.Argon2id });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const updated = await client.query(
      `UPDATE account SET password = $2, "updatedAt" = now()
        WHERE "userId" = $1 AND "providerId" = 'credential'`,
      [userId, hashed],
    );
    let created = false;
    if (updated.rowCount === 0) {
      // A Google-only account has no credential row yet — same shape Better
      // Auth's own reset-password creates (accountId = userId).
      await client.query(
        `INSERT INTO account (id, "accountId", "providerId", "userId", password, "createdAt", "updatedAt")
         VALUES ($1, $2, 'credential', $2, $3, now(), now())`,
        [randomUUID(), userId, hashed],
      );
      created = true;
    }
    const sessions = await client.query(`DELETE FROM session WHERE "userId" = $1`, [userId]);
    await client.query("COMMIT");

    console.log(`Password ${created ? "set" : "replaced"} for ${storedEmail}.`);
    console.log(`Revoked ${sessions.rowCount ?? 0} live session(s).`);
    if (given === null) {
      console.log(`\nNew password (shown once, share it out of band):\n\n  ${password}\n`);
    }
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

main()
  .then(() => closePool())
  .catch(async (err) => {
    console.error(err);
    await closePool().catch(() => {});
    process.exit(1);
  });
