import type { AccessBoardResponse, AccessSummary, AccessTreeResponse, ApiClient } from "./api";
import { serverFeatures } from "./serverFeatures";

/**
 * One load of the person Access tab: the vault's structure and, when the
 * server offers it, every row's mode for that person in the SAME response
 * (`access-board`). Board and List both read from it, so the first paint
 * already has final counts instead of climbing as 70 summary batches land.
 */

export type SummaryMode = AccessSummary["mode"];

/** `/health` feature for `GET /vaults/:id/access-board`. Not a required feature. */
export const ACCESS_BOARD = "access-board";

/** Rows a write may re-read through the summaries route; past it, reload the map. */
export const ACCESS_MAP_REREAD_MAX = 200;

const CHAR_MODE: Record<string, SummaryMode> = { e: "open", v: "readonly", n: "private", m: "mixed" };

/**
 * `modes` carries one char per item in folders ++ notes ++ files order.
 * Keys match the row keys (`${kind}:${id}`) the Board and List already use.
 * An unknown or missing char leaves that row unanswered (it is then read the
 * old way), never guessed.
 */
export function decodeBoardModes(resp: Pick<AccessBoardResponse, "folders" | "notes" | "files" | "modes">): Map<string, SummaryMode> {
  const out = new Map<string, SummaryMode>();
  const modes = resp.modes ?? "";
  let i = 0;
  const take = (kind: "folder" | "note" | "file", id: string) => {
    const mode = CHAR_MODE[modes.charAt(i++)];
    if (mode) out.set(`${kind}:${id}`, mode);
  };
  for (const f of resp.folders) take("folder", f.id);
  for (const n of resp.notes) take("note", n.id);
  for (const f of resp.files ?? []) take("file", f.id);
  return out;
}

export interface AccessMapResult {
  tree: AccessTreeResponse;
  /** Every row's mode from the one-request route; null = old server, read per row. */
  modes: Map<string, SummaryMode> | null;
}

type AccessMapApi = Pick<ApiClient, "getAccessBoard" | "listAccessTree" | "getHealth" | "getBaseUrl">;

/** Servers (by URL) that answered 404 to access-board: fall back once, then stay there. */
const unsupported = new Set<string>();

export function forgetAccessBoardSupport(): void {
  unsupported.clear();
}

/**
 * The fallback is decided per load: `access-board` must be in the server's
 * cached `/health` features AND not have answered 404 before. Otherwise, or on
 * that 404, today's path: `listAccessTree` alone, modes read by the batcher.
 */
export async function loadAccessMap(api: AccessMapApi, vaultId: string, userId: string): Promise<AccessMapResult> {
  if (await boardSupported(api)) {
    const resp = await api.getAccessBoard(vaultId, userId);
    if (resp) {
      const { modes: _m, totals: _t, complete: _c, ...tree } = resp;
      return { tree, modes: decodeBoardModes(resp) };
    }
    unsupported.add(api.getBaseUrl());
  }
  return { tree: await api.listAccessTree(vaultId), modes: null };
}

/** Unknown features (health unreachable or unparseable) count as absent. */
async function boardSupported(api: AccessMapApi): Promise<boolean> {
  try {
    const server = api.getBaseUrl();
    if (unsupported.has(server)) return false;
    return (await serverFeatures(server, () => api.getHealth())).has(ACCESS_BOARD);
  } catch {
    return false;
  }
}
