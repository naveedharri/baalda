import type { AccessSummary, BulkAccessResource } from "./api";
import { ApiError } from "./api";

type Mode = AccessSummary["mode"];

export interface AccessSummaryTransport {
  /** One request for many rows. */
  many(orgId: string, groups: BulkAccessResource[][], userIds: string[]): Promise<Mode[]>;
  /** One row — the fallback for a server without the batch route. */
  one(orgId: string, resources: BulkAccessResource[], userIds: string[]): Promise<Mode>;
}

interface Pending {
  orgId: string;
  userIds: string[];
  resource: BulkAccessResource;
  cancelled: () => boolean;
  resolve: (mode: Mode) => void;
  reject: (error: unknown) => void;
}

/** Rows per request; the server accepts up to 500 groups. */
export const SUMMARY_BATCH_MAX = 200;
/** Long enough to gather every row that mounts in one render. */
export const SUMMARY_BATCH_DELAY_MS = 30;

/**
 * Coalesces the Access panel's per-row "what can these people do here?" reads
 * into one request per render. Before this every visible row sent its own
 * request, four at a time, and each one resolved its whole subtree on the
 * server — a person view of a large vault was dozens of full-vault resolves,
 * and every person toggled started the lot again while the old ones still ran.
 *
 * Rows whose badge unmounted before the flush are dropped, so a stale person
 * selection never reaches the server.
 */
export function createAccessSummaryBatcher(
  transport: AccessSummaryTransport,
  schedule: (run: () => void) => void = (run) => { setTimeout(run, SUMMARY_BATCH_DELAY_MS); },
) {
  let queue: Pending[] = [];
  let scheduled = false;
  /** Set once the server answered 404 for the batch route. */
  let batchUnsupported = false;

  const sendOneByOne = async (items: Pending[]) => {
    let next = 0;
    const worker = async () => {
      while (next < items.length) {
        const item = items[next++];
        if (item.cancelled()) continue;
        try {
          item.resolve(await transport.one(item.orgId, [item.resource], item.userIds));
        } catch (error) {
          item.reject(error);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, items.length) }, worker));
  };

  const send = async (items: Pending[]) => {
    if (batchUnsupported) return sendOneByOne(items);
    try {
      const modes = await transport.many(items[0].orgId, items.map((item) => [item.resource]), items[0].userIds);
      items.forEach((item, i) => item.resolve(modes[i]));
    } catch (error) {
      if (error instanceof ApiError && (error.status === 404 || error.status === 405)) {
        batchUnsupported = true;
        return sendOneByOne(items);
      }
      items.forEach((item) => item.reject(error));
    }
  };

  const flush = () => {
    scheduled = false;
    const live = queue.filter((item) => !item.cancelled());
    queue = [];
    const byScope = new Map<string, Pending[]>();
    for (const item of live) {
      const scope = JSON.stringify([item.orgId, item.userIds]);
      const list = byScope.get(scope);
      if (list) list.push(item);
      else byScope.set(scope, [item]);
    }
    for (const items of byScope.values()) {
      for (let i = 0; i < items.length; i += SUMMARY_BATCH_MAX) {
        void send(items.slice(i, i + SUMMARY_BATCH_MAX));
      }
    }
  };

  return {
    /** Queue one row. `cancelled` is read at flush time. */
    read(orgId: string, resource: BulkAccessResource, userIds: string[], cancelled: () => boolean): Promise<Mode> {
      return new Promise<Mode>((resolve, reject) => {
        queue.push({ orgId, userIds, resource, cancelled, resolve, reject });
        if (!scheduled) {
          scheduled = true;
          schedule(flush);
        }
      });
    },
  };
}
