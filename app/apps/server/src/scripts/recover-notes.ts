// ============================================================================
//  REVIEWED NOTE RECOVERY (issue #200) — a thin client for
//  GET/POST /api/vaults/:vaultId/recovery on a RUNNING server.
//
//  It talks to the server over HTTP on purpose: restores must go through the
//  live doc writer, so open editors merge them like any other edit. Writing the
//  CRDT store from a second process would bypass them.
//
//    BAALDA_URL=https://api.example.com BAALDA_TOKEN=<owner/admin session token> \
//      pnpm run recover:notes -- list  <vaultId> > review.csv
//    # edit the `apply` column: yes = restore that version, anything else = skip
//    BAALDA_URL=… BAALDA_TOKEN=… pnpm run recover:notes -- apply <vaultId> review.csv
//
//  `list` prefills `apply=yes` only where the proposed version holds everything
//  the note holds now. Every restore records a "Before revert" version first,
//  so it can be undone from the note's Version History.
// ============================================================================

import { readFileSync } from "node:fs";

function usage(msg?: string): never {
  if (msg) console.error(`error: ${msg}\n`);
  console.error("usage: pnpm run recover:notes -- list <vaultId>\n       pnpm run recover:notes -- apply <vaultId> <review.csv>");
  process.exit(2);
}

/** Minimal RFC 4180 reader — quoted cells may hold commas, quotes and newlines. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c !== ""));
}

async function main(): Promise<void> {
  const [cmd, vaultId, file] = process.argv.slice(2).filter((a) => a !== "--");
  const base = process.env.BAALDA_URL?.replace(/\/+$/, "");
  const token = process.env.BAALDA_TOKEN;
  if (!base || !token) usage("set BAALDA_URL and BAALDA_TOKEN");
  if (!vaultId) usage("vaultId required");
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const url = `${base}/api/vaults/${encodeURIComponent(vaultId)}/recovery`;

  if (cmd === "list") {
    const res = await fetch(`${url}?format=csv`, { headers });
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
    process.stdout.write(await res.text());
    return;
  }
  if (cmd === "apply") {
    if (!file) usage("review.csv required");
    const [head, ...rows] = parseCsv(readFileSync(file, "utf8"));
    const col = (name: string) => {
      const i = head.indexOf(name);
      if (i < 0) usage(`review file has no "${name}" column`);
      return i;
    };
    const [a, d, v] = [col("apply"), col("docId"), col("versionId")];
    const items = rows
      .filter((r) => r[a]?.trim().toLowerCase() === "yes")
      .map((r) => ({ docId: r[d], versionId: Number(r[v]) }));
    if (items.length === 0) {
      console.error("nothing marked apply=yes");
      return;
    }
    let ok = 0;
    for (let i = 0; i < items.length; i += 500) {
      const res = await fetch(`${url}/apply`, {
        method: "POST",
        headers,
        body: JSON.stringify({ items: items.slice(i, i + 500) }),
      });
      if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
      const { results } = (await res.json()) as { results: { docId: string; ok: boolean; error?: string }[] };
      for (const r of results) {
        if (r.ok) ok++;
        else console.error(`skipped ${r.docId}: ${r.error}`);
      }
    }
    console.error(`restored ${ok} of ${items.length} note(s)`);
    return;
  }
  usage(cmd ? `unknown command ${cmd}` : undefined);
}

if (process.argv[1]?.includes("recover-notes")) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
