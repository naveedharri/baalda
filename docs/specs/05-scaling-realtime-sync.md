# Scaling the realtime sync layer toward 100k concurrent editors

> Status: **research + plan** (not yet implemented). Branch `research/scaling-100k-concurrent`.
> Goal set by product: *"100k concurrent users making changes, seamlessly, without
> compromising state, ideally on modest resources."*

This document frames what that target really means, analyses where the current
server actually falls over (with measured numbers), surveys the proven ways the
Yjs/CRDT ecosystem scales, and proposes a phased plan grounded in **our** stack
(Node + Hocuspocus + Postgres, local-first, self-hostable).

---

## 1. Framing: the unit of scale is the *document*, not the user

"100k concurrent editors" is three very different problems, and conflating them
is what makes the target sound impossible:

| Axis | What bounds it | Feasible on modest resources? |
|------|----------------|-------------------------------|
| **Total users / notes** (accounts, stored docs) | Postgres rows + blob storage | Yes — trivially millions. Not a realtime problem. |
| **Total concurrent *connections*** (sockets open, mostly viewing, some editing) | sockets/CPU per process × processes; message *throughput* | Yes, with the right WS layer + sharding (see §4). |
| **Concurrent *editors on one document*** | O(n²) presence + merge fan-out on a single doc owner | **No** — hard ceiling of ~dozens–low-hundreds. Every collab tool caps this. |

**Key truth:** realtime collaboration scales by *sharding on the document*. 100k
users spread across thousands of notes (a handful of editors each) is a solved,
horizontal problem. 100k users editing **one** note is not a thing any system
does — you cap/throttle it, you don't scale it.

Our own measurement makes this concrete (single dev Node process, on a laptop
also running the load generator + Postgres + the desktop app):

| Scenario | Editors/doc | Server CPU | `/health` latency |
|----------|-------------|-----------|-------------------|
| 1,000 users on **12** notes | ~83 | 100%+ (pegged), listener wedged | timed out |
| 1,000 users on **403** notes | ~2.4 | **~13% of one core** | **~1.5 ms** |

Same 1,000 users, same box — the only change was spreading them across more
documents. The choke was never "1,000 users." It was per-document concentration.

---

## 2. Where we are today

- **One Node process** (`app/apps/server/src/index.ts`) runs *both* the Hono HTTP
  API (:3010) and the Hocuspocus WebSocket server (:3011, also `/sync` single-port).
  Node is single-threaded → **one CPU core** does all sync work. On an N-core box
  we currently use 1/N of the machine.
- **Transport:** Hocuspocus defaults to the `ws` library. Fine for hundreds of
  sockets; heavy per-connection vs alternatives (§4).
- **Persistence:** `src/yjs/persistence.ts` appends every update to `doc_updates`
  and compacts into `doc_snapshots` past a threshold. `onChange`
  (`src/sync/hocuspocus.ts`) does `appendUpdate` + `scheduleIndex` on **every**
  document change → write amplification and re-index scheduling scale with edit rate.
- **Awareness:** presence (cursors/selections) is rebroadcast to every peer on a
  doc — the O(n²) term. Our simulator further amplified it by moving every cursor.
- **Horizontal scale-out:** `@hocuspocus/extension-redis` is already a dependency
  and `REDIS_URL` is wired (unset ⇒ in-memory). So the multi-instance hook exists
  but isn't used, and — critically — the naive Redis mode has a caveat (§4.2).
- **Config gap:** the server inherits the OS default `ulimit -n` (256 on macOS).
  ~1,000 incoming sockets exhausted FDs and wedged the HTTP listener in testing.

### Bottlenecks, ranked
1. **Single process / single core** — biggest untapped headroom (we use 1 of N cores).
2. **Awareness fan-out O(n²) per doc** — the real ceiling under concentration.
3. **`ws` transport overhead** — caps socket density per process.
4. **Synchronous persistence + re-index per change** — write amplification at high edit rates.
5. **Naive "all instances process all messages" Redis fan-out** — scaling out without
   doc-routing multiplies CPU instead of reducing it (§4.2).
6. **FD / kernel limits** — config, trivial, but currently unset.

---

## 3. What the ecosystem does (researched)

The Yjs world has converged on a few battle-tested patterns. All are self-hostable.

### 3.1 Hocuspocus + Redis extension (our incremental path)
Multiple Hocuspocus instances behind a load balancer, syncing document + awareness
updates over **Redis pub/sub**. Redis only *relays* between instances; the
**Database extension still persists** (for us: Postgres). Caveat straight from the
docs: *"All messages will be handled on all instances… if you are trying to reduce
CPU load by spawning multiple servers, you should **not** connect them via Redis."*
→ Pub/sub alone spreads *connections*, not *CPU*. To reduce CPU you must **route
each document to one instance** (sticky/consistent-hash by `docId`) so a doc's
fan-out happens on exactly one node.

### 3.2 `y-redis` / `@y/redis` (the Yjs team's scalable backend)
Purpose-built for horizontal scale. **Stateless** WebSocket servers: each "room"
is a **Redis stream**; the server assembles updates from Redis + persistent storage
(**S3 or Postgres**) only for the *initial sync*, then keeps **no Y.Doc in memory**.
A separate **worker** flushes Redis → durable store and trims the stream. *"Start as
many instances as you want… no coordination needed."* Best fit for our self-host
model (Postgres persistence, add Redis) and eliminates the per-instance memory growth
that plagues stateful servers.

### 3.3 Y-Sweet (Jamsocket, Rust)
Open-source Yjs server in **Rust**; **one process per document** (session-backend
model), S3 persistence, horizontal scale by spinning doc-processes. Rust removes the
single-core JS ceiling for the hot path. Self-hostable (Docker/Linux) or managed.
Strong per-doc isolation; different runtime than our Node stack (integration cost).

### 3.4 Cloudflare Durable Objects / PartyKit / `y-durableobjects`
Per-document **actor** auto-sharded globally at the edge; each doc = one stateful
object. The cleanest expression of "document = unit of scale," effectively unlimited
total docs. Ties persistence/runtime to Cloudflare → best considered for a **managed
edition**, not the self-hostable Postgres core.

### 3.5 Transport & process efficiency (orthogonal, applies to all)
- **uWebSockets.js** instead of `ws`: reported ~1M sockets on a laptop at 0–2% CPU
  / ~500 MB idle; ~10 KB/conn bookkeeping. The single biggest per-box connection-density win.
- **One process per core** (cluster / multiple instances) to use the whole machine.
- **`least_conn` load balancing** (not round-robin) because WS connections are long-lived.
- **Awareness throttling/coalescing**: cap cursor broadcasts (~10/s), drop
  intermediate positions, keep awareness off the persistence path.

---

## 4. Recommended architecture for Baalda

Two deployment targets, one codebase:

- **Self-host (OSS core):** Node + Hocuspocus + Postgres, optionally + Redis. Must
  stay simple to run on one box, and scale to a few nodes when needed.
- **Managed (baalda.com):** free to run many nodes; can adopt a doc-actor backend.

**North-star topology:** stateless/doc-sharded sync workers, Redis as the live
relay/stream, Postgres (+ blob store) as durable truth, a WS-aware load balancer
routing by `docId`, and awareness treated as cheap, throttled, non-persistent.

```
            ┌── LB (least_conn, sticky/hash by docId) ──┐
 clients ──▶│  sync worker 1 │ … │ sync worker N        │  (1 per core, uWS transport)
            └───────┬──────────────────┬────────────────┘
                    │ Redis streams / pub-sub (per-doc rooms)
                    ▼
             Postgres (doc_updates + snapshots)  +  blob store (attachments)
                    ▲
             persistence worker(s): flush Redis → Postgres, compact, trim
```

---

## 5. Phased plan

### Phase 0 — Instrument & set a real baseline (prereq, ~days)
- Add per-doc + per-process metrics: connections, awareness msgs/s, updates/s,
  persistence write latency, event-loop lag. (No numbers → no scaling.)
- Load-test harness: extend `scripts/demo/simulate-activity.ts` (already scales to
  1,000 with synthetic identities) into a repeatable benchmark with knobs for
  users, docs, edits/s, and cursor rate; record CPU/latency/lag.
- **Exit:** dashboards + a reproducible "N users × M docs × E edits/s" number.

### Phase 1 — Use the whole box + stop the cheap bleeding (low risk, high ROI)
1. **Multi-core:** run one sync worker per core (Node cluster or N processes) with
   **consistent-hash-by-`docId`** routing so each doc lives on one worker (avoids
   cross-worker fan-out). HTTP API can stay separate/shared.
2. **uWebSockets.js transport** for the WS layer (Hocuspocus supports a uWS
   adapter) → order-of-magnitude more sockets/process at near-zero idle CPU.
3. **Awareness throttle/coalesce** on client (`src/lib/sync`) and a server-side
   rate cap; keep awareness out of Postgres entirely.
4. **Batch persistence:** debounce/coalesce `appendUpdate` writes and decouple
   `scheduleIndex` from the hot path (queue it). Keep compaction.
5. **Ops:** raise `ulimit -n` (systemd/container), `least_conn` LB, backpressure,
   dead-connection ping/timeout.
- **Target:** a single 8-core box comfortably serving tens of thousands of
  connections with realistic per-doc editor counts; graceful degradation, no wedging.

### Phase 2 — Horizontal, document-sharded (medium)
Pick ONE (decision below), keeping Postgres as durable truth:
- **2a. Hocuspocus + Redis with doc-sharded routing** — smallest delta from today;
  reuse the existing extension + our persistence. Requires the LB/router to pin a
  doc to an instance so Redis is a *relay*, not a CPU multiplier.
- **2b. Adopt `y-redis` model** — stateless workers + Redis streams + Postgres
  persistence worker. More rework, but removes in-memory doc state and is the
  Yjs-native "scale indefinitely" answer. Our binary-only store (we already ship
  opaque Yjs updates, never markdown) maps cleanly onto its storage provider.
- **Target:** add nodes → linear connection capacity; a hot doc's cost stays on one node.

### Phase 3 — Managed-edition massive scale (later, optional)
For baalda.com only: evaluate a **doc-actor** backend (Y-Sweet's per-doc process,
or Durable Objects/PartyKit) for global edge distribution and effectively unlimited
document count. Self-host core stays on the Phase-2 Node/Postgres path.

### Cross-cutting — the per-doc ceiling is a product decision
Because §1's third axis can't be scaled away: add a **per-document concurrent-editor
cap** with overflow → live **view-only** (still gets updates, can't broadcast
cursors/edits until a slot frees). This is what Google Docs/Figma/Notion do. It
turns the one unsolvable case into a defined, graceful behavior.

---

## 6. Honest answer to "100k concurrent edits on the same resources"

- **100k open connections, mostly viewing + a realistic slice editing, across many
  docs:** achievable — Phase 1 (uWS + all cores) on one strong box gets deep into
  the tens-of-thousands; Phase 2 crosses 100k by adding a few nodes.
- **100k clients *all actively editing every second*, across many docs:** that is
  ~100k+ CRDT updates/s + fan-out — a *throughput* wall, not a socket wall. It is
  shardable (Phase 2/3) but is **not** a single-modest-box number; it is a
  small-fleet number. No single-node collab server does this, in any language.
- **100k editing one doc:** not feasible anywhere; handled by the §5 editor cap.

So: "seamless 100k across the workspace" — **yes, with doc-sharding + an efficient
transport**; the honest caveat is that truly-simultaneous global edit throughput
needs a few nodes, not one laptop, and per-doc concurrency is always capped.

---

## 7. Decisions needed
- **D1:** Phase-2 direction — `2a` (Hocuspocus+Redis+doc routing, least change) vs
  `2b` (`y-redis` stateless workers, more future-proof)?
- **D2:** Is uWebSockets.js acceptable as the transport (native dep) for the OSS core?
- **D3:** Per-doc editor cap value + the view-only-overflow UX.
- **D4:** Blob/large-doc storage — stay Postgres, or add S3-compatible for managed?

## 8. Risks
- uWS is a native module — build/packaging across platforms.
- Doc-sharded routing needs sticky/consistent-hash at the LB; rebalancing on
  node changes must not split a doc across two owners (would fork live state).
- `y-redis` adoption is a meaningful rewrite of the persistence/transport seam.
- Benchmarks must run **off** the load-generator's machine to be meaningful (our
  laptop test had the generator, server, DB, and app all competing).

## 9. Sources
- Hocuspocus scalability + Redis extension (incl. the "all instances process all
  messages" caveat): https://tiptap.dev/docs/hocuspocus/guides/scalability ·
  https://tiptap.dev/docs/hocuspocus/server/extensions/redis ·
  https://github.com/ueberdosis/hocuspocus/blob/main/docs/server/extensions/redis.md
- `y-redis` (stateless, Redis streams, S3/Postgres persistence):
  https://github.com/yjs/y-redis · https://docs.yjs.dev/ecosystem/database-provider/y-redis
- Y-Sweet (Rust, per-doc, S3): https://github.com/jamsocket/y-sweet ·
  https://docs.jamsocket.com/y-sweet/concepts/how-ysweet-works
- Durable Objects / PartyKit / y-durableobjects:
  https://blog.cloudflare.com/cloudflare-acquires-partykit/ ·
  https://github.com/napolab/y-durableobjects
- WebSocket density at scale (uWebSockets.js, ~1M sockets; least_conn; Redis to ~100k):
  https://unetworkingab.medium.com/millions-of-active-websockets-with-node-js-7dc575746a01 ·
  https://dev.to/chengyixu/building-a-production-ready-websocket-server-with-nodejs-scaling-to-100k-connections-25mk ·
  https://websocket.org/guides/websockets-at-scale/
- Yjs scaling guidance (subdocuments, distributed, no central source of truth):
  https://docs.yjs.dev/ · https://velt.dev/blog/yjs-websocket-server-real-time-collaboration
