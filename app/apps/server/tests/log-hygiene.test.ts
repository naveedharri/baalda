import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Issue #267: no server log line may carry a user's file path, note title or
 * email address. Paths name clients, people and documents, and stdout is
 * shipped to log tooling whose retention and access are far broader than the
 * data's. Log ids and counts instead.
 *
 * A static check over `src/`: every `console.*(...)` call (its first few lines,
 * which is where the template literal lives) is searched for an interpolation
 * of a path-, title- or email-shaped expression. Operator-run CLI scripts
 * (`src/scripts/`) print to the operator's own terminal and are exempt, as is
 * the dev-only `log` email transport, whose whole job is to print the message.
 */

const SRC = fileURLToPath(new URL("../src", import.meta.url));
const EXEMPT = [/^scripts\//, /\.test\.ts$/];
/** The mailer's `log` transport prints the message by design (dev only). */
const EXEMPT_SNIPPETS = ["(log transport — not delivered)"];

const FORBIDDEN = /\$\{[^}]*\b(rel_?[pP]ath|relPath|\w*\.path|path|title|email|\w+\.to)\b[^}]*\}/;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

describe("server logging never prints paths, titles or emails (#267)", () => {
  it("has no console call interpolating one", () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      const rel = relative(SRC, file);
      if (EXEMPT.some((re) => re.test(rel))) continue;
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        if (!/console\.(log|info|warn|error|debug)\(/.test(line)) return;
        const span = lines.slice(i, i + 4).join("\n");
        const call = span.slice(0, span.indexOf(");") === -1 ? span.length : span.indexOf(");"));
        if (EXEMPT_SNIPPETS.some((s) => call.includes(s))) return;
        if (FORBIDDEN.test(call)) offenders.push(`${rel}:${i + 1}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});
