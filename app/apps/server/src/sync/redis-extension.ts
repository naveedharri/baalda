// HA for the open-note (Hocuspocus) path (spec 05 §5). When REDIS_URL is set,
// the Hocuspocus Redis extension mirrors document updates + awareness across
// instances via Redis pub/sub, so the SAME doc can be edited live on different
// instances and stays consistent — which is what makes horizontal scale and
// rolling deploys safe. The vault replication channel already scales via its own
// RedisPubSub; this covers the stateful editing path.
//
// Unset REDIS_URL ⇒ no extension ⇒ single-instance behaviour, unchanged. This is
// the self-host default and today's managed deploy.

import { Redis as RedisExtension } from "@hocuspocus/extension-redis";
import { Redis as IORedis } from "ioredis";
import type { Extension } from "@hocuspocus/server";

export function redisExtensions(redisUrl: string | undefined): Extension[] {
  if (!redisUrl) return [];
  return [
    new RedisExtension({
      // ioredis parses the URL natively — auth, db index, and rediss:// TLS.
      // A fresh client per role (pub/sub); `maxRetriesPerRequest: null` is the
      // recommended setting for the long-lived subscriber connection.
      createClient: () => new IORedis(redisUrl, { maxRetriesPerRequest: null }),
      // identifier omitted → the extension generates a unique per-instance id.
    }),
  ];
}
