// SPDX-License-Identifier: Apache-2.0
//
// Manage in-app messages (docs/MESSAGES.md) on a running server. From
// app/apps/server, with BAALDA_SERVER_URL and BAALDA_ADMIN_TOKEN set:
//
//   pnpm messages list
//   pnpm messages create <file.json>        a new message from its spec
//   pnpm messages update <id> <file.json>   replace a message's spec
//   pnpm messages archive <id>              stop showing it (one way)
//   pnpm messages stats <id>                shown / snoozed / dismissed / done
//
// Prints the server's JSON answer. Never prints the token.

import { readFileSync } from "node:fs";

const ADMIN_HEADER = "x-baalda-admin-token";

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

const USAGE = `Usage: pnpm messages <command>
  list
  create <file.json>
  update <id> <file.json>
  archive <id>
  stats <id>
Needs BAALDA_SERVER_URL and BAALDA_ADMIN_TOKEN in the environment.`;

function readSpec(file: string | undefined): unknown {
  if (!file) fail(USAGE);
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    fail(`Could not read ${file} as JSON: ${(err as Error).message}`);
  }
}

async function call(method: string, path: string, body?: unknown): Promise<void> {
  const server = process.env.BAALDA_SERVER_URL?.trim().replace(/\/+$/, "");
  const token = process.env.BAALDA_ADMIN_TOKEN?.trim();
  if (!server) fail("BAALDA_SERVER_URL is not set.");
  if (!token) fail("BAALDA_ADMIN_TOKEN is not set.");

  let res: Response;
  try {
    res = await fetch(`${server}/api/admin/messages${path}`, {
      method,
      headers: {
        [ADMIN_HEADER]: token,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch (err) {
    fail(`Could not reach ${server}: ${(err as Error).message}`);
  }
  const text = await res.text();
  let out: unknown = text;
  try {
    out = JSON.parse(text);
  } catch {
    /* not JSON: print as is */
  }
  if (res.status === 404 && path === "") {
    console.error("404: messages are off on this server, or the admin token is wrong.");
  }
  console.log(typeof out === "string" ? out : JSON.stringify(out, null, 2));
  if (!res.ok) process.exit(1);
}

async function main(): Promise<void> {
  const [cmd, a, b] = process.argv.slice(2);
  const id = (v: string | undefined) => (v ? `/${encodeURIComponent(v)}` : fail(USAGE));
  switch (cmd) {
    case "list":
      return call("GET", "");
    case "create":
      return call("POST", "", readSpec(a));
    case "update":
      return call("PUT", id(a), readSpec(b));
    case "archive":
      return call("DELETE", id(a));
    case "stats":
      return call("GET", `${id(a)}/stats`);
    default:
      fail(USAGE);
  }
}

void main();
