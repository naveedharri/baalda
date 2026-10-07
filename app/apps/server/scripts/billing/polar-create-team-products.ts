/**
 * Create (or reuse) the two Polar SANDBOX seat-based products the Team plan needs.
 *
 *   "Baalda Team (monthly)"  recurring month, seat_based usd, one volume tier: min 3, no max, $10/seat
 *   "Baalda Team (yearly)"   recurring year,  seat_based usd, one volume tier: min 3, no max, $110/seat
 *
 * Usage (from app/apps/server):
 *   pnpm exec tsx scripts/billing/polar-create-team-products.ts [--write-env]
 *   pnpm exec tsx scripts/billing/polar-create-team-products.ts --server production            # list only
 *   pnpm exec tsx scripts/billing/polar-create-team-products.ts --server production --yes [--write-env]
 *
 * Reads POLAR_ACCESS_TOKEN / POLAR_SERVER from .env (dotenv). `--server`
 * defaults to sandbox and must equal POLAR_SERVER. Production only ever
 * creates or writes .env with BOTH `--server production` AND `--yes`; without
 * `--yes` it lists and stops. A product whose name already matches is reused,
 * never duplicated, and no existing product is modified. With --write-env it
 * upserts POLAR_PRODUCT_TEAM_MONTHLY_ID / POLAR_PRODUCT_TEAM_YEARLY_ID into
 * this server's .env and touches no other line. Never prints the token.
 */
import "dotenv/config";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Polar } from "@polar-sh/sdk";
import type { Product } from "@polar-sh/sdk/models/components/product.js";
import type { ProductCreateRecurring } from "@polar-sh/sdk/models/components/productcreaterecurring.js";

const argv = process.argv.slice(2);
const val = (f: string): string | undefined => {
  const i = argv.indexOf(f);
  return i >= 0 ? argv[i + 1] : undefined;
};
const WRITE_ENV = argv.includes("--write-env");
const YES = argv.includes("--yes");
const SERVER = val("--server") ?? "sandbox";
const ENV_PATH = fileURLToPath(new URL("../../.env", import.meta.url));

if (SERVER !== "sandbox" && SERVER !== "production") {
  console.error(`Refusing: --server must be sandbox or production (got ${SERVER}).`);
  process.exit(2);
}
if (process.env.POLAR_SERVER !== SERVER) {
  console.error(`Refusing: --server ${SERVER} does not match POLAR_SERVER (${process.env.POLAR_SERVER ?? "unset"}).`);
  process.exit(2);
}
const PRODUCTION = SERVER === "production";
// Production creates/writes only with --yes; without it the run is list-only.
const MAY_WRITE = !PRODUCTION || YES;
const token = process.env.POLAR_ACCESS_TOKEN;
if (!token) {
  console.error("POLAR_ACCESS_TOKEN is not set.");
  process.exit(2);
}
const polar = new Polar({ accessToken: token, server: SERVER });

type Spec = { envKey: string; body: ProductCreateRecurring };
const SPECS: Spec[] = [
  {
    envKey: "POLAR_PRODUCT_TEAM_MONTHLY_ID",
    body: {
      name: "Baalda Team (monthly)",
      description: "Per-seat Team plan, billed monthly. Minimum 3 seats.",
      recurringInterval: "month",
      prices: [
        {
          amountType: "seat_based",
          priceCurrency: "usd",
          seatTiers: { seatTierType: "volume", tiers: [{ minSeats: 3, maxSeats: null, pricePerSeat: 1000 }] },
        },
      ],
    },
  },
  {
    envKey: "POLAR_PRODUCT_TEAM_YEARLY_ID",
    body: {
      name: "Baalda Team (yearly)",
      description: "Per-seat Team plan, billed yearly. Minimum 3 seats.",
      recurringInterval: "year",
      prices: [
        {
          amountType: "seat_based",
          priceCurrency: "usd",
          seatTiers: { seatTierType: "volume", tiers: [{ minSeats: 3, maxSeats: null, pricePerSeat: 11000 }] },
        },
      ],
    },
  },
];

function errText(e: unknown): string {
  const x = e as { statusCode?: number; body?: string; message?: string };
  return `HTTP ${x.statusCode ?? "?"} ${(x.body ?? x.message ?? String(e)).slice(0, 800)}`;
}

async function listAll(): Promise<Product[]> {
  const out: Product[] = [];
  const pages = await polar.products.list({ isArchived: false, limit: 100 });
  for await (const page of pages) out.push(...page.result.items);
  return out;
}

function describe(p: Product): string {
  const prices = (p.prices as unknown as Array<Record<string, unknown>>).map((x) => {
    const tiers = x.seatTiers as { minimumSeats?: number; maximumSeats?: number | null; tiers?: unknown } | undefined;
    return JSON.stringify({
      priceId: x.id,
      amountType: x.amountType,
      currency: x.priceCurrency,
      isArchived: x.isArchived,
      minimumSeats: tiers?.minimumSeats,
      maximumSeats: tiers?.maximumSeats,
      tiers: tiers?.tiers,
    });
  });
  return `id=${p.id} name="${p.name}" interval=${String(p.recurringInterval)}\n    prices: ${prices.join("\n            ")}`;
}

function upsertEnv(values: Record<string, string>): void {
  const lines = readFileSync(ENV_PATH, "utf8").split("\n");
  for (const [key, val] of Object.entries(values)) {
    const at = lines.findIndex((l) => l.startsWith(`${key}=`));
    if (at >= 0) {
      lines[at] = `${key}=${val}`;
      continue;
    }
    let lastPolar = -1;
    lines.forEach((l, i) => {
      if (/^POLAR_[A-Z_]+=/.test(l)) lastPolar = i;
    });
    if (lastPolar >= 0) lines.splice(lastPolar + 1, 0, `${key}=${val}`);
    else {
      const end = lines.length > 0 && lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;
      lines.splice(end, 0, `${key}=${val}`);
    }
  }
  writeFileSync(ENV_PATH, lines.join("\n"));
}

async function main(): Promise<void> {
  if (PRODUCTION) {
    console.log(`=== PRODUCTION: Polar production API, ${MAY_WRITE ? "WILL create missing products" : "list only (no --yes)"} ===`);
  }
  const creating = MAY_WRITE && (PRODUCTION || WRITE_ENV);
  console.log(`server=${SERVER} mode=${creating ? `create${WRITE_ENV ? " + --write-env" : ""}` : "dry run (list only)"}`);
  const existing = await listAll();
  console.log(`\nexisting active products: ${existing.length}`);
  for (const p of existing) console.log(`  - ${p.name} (${p.id}) interval=${String(p.recurringInterval)}`);

  const ids: Record<string, string> = {};
  for (const spec of SPECS) {
    const match = existing.find((p) => p.name === spec.body.name);
    if (match) {
      console.log(`\nREUSE  ${spec.body.name}\n  ${describe(match)}`);
      ids[spec.envKey] = match.id;
      continue;
    }
    if (!creating) {
      console.log(`\nWOULD CREATE  ${spec.body.name}  ${JSON.stringify(spec.body)}`);
      continue;
    }
    try {
      const created = await polar.products.create(spec.body);
      console.log(`\nCREATED  ${spec.body.name}\n  ${describe(created)}`);
      ids[spec.envKey] = created.id;
    } catch (e) {
      console.error(`\nREFUSED  ${spec.body.name}  ${errText(e)}`);
      process.exitCode = 1;
    }
  }

  console.log("\nids:");
  for (const spec of SPECS) console.log(`  ${spec.envKey}=${ids[spec.envKey] ?? "(none)"}`);

  if (WRITE_ENV && MAY_WRITE) {
    if (Object.keys(ids).length === SPECS.length) {
      upsertEnv(ids);
      console.log(`\nwrote ${Object.keys(ids).join(", ")} to .env`);
    } else {
      console.error("\nnot writing .env: at least one product is missing");
      process.exitCode = 1;
    }
  }
}

main().catch((e) => {
  console.error(errText(e));
  process.exit(1);
});
