// Diagnostic listener. Joins the vault channel as "Grace" and reports two
// things, in this order of usefulness:
//
//   1. WHO ELSE IS ON THE CHANNEL. If the desktop app isn't listed, it isn't
//      connected — it's signed out, or sync is off for this vault — and no
//      broadcast will ever reach it. This is the first thing to check when
//      "voice doesn't work", and it is almost always the answer.
//   2. Every voice frame it receives, so a broadcast can be confirmed as
//      leaving the server even when nothing is audible on the desktop. That
//      splits a server-side bug from a client-side one in one run.
//
//   VAULT_ID=<uuid> node scripts/voice-check/listen.mjs

import { decodeVoiceFrame, loadWs, signIn, vaultToken, wsUrl } from "./common.mjs";

const SECONDS = Number(process.env.LISTEN_SECONDS ?? 30);

const WebSocket = await loadWs();
const token = await vaultToken(await signIn("grace@example.com", "TestPassword123!"));

const ws = new WebSocket(wsUrl());
ws.binaryType = "arraybuffer";

const peers = new Set();
let frames = 0;

ws.on("open", () => ws.send(JSON.stringify({ t: "hello", token, manifest: {}, caps: ["voice"] })));

ws.on("message", (data, isBinary) => {
  if (!isBinary) {
    const msg = JSON.parse(data.toString());
    if (msg.t === "ready") {
      console.log(`listening for ${SECONDS}s…\n`);
      // Announcing triggers a presence-query round, so every other connection
      // in this vault re-announces itself — that's how we enumerate them.
      ws.send(
        JSON.stringify({ t: "presence", docId: null, name: "Grace", color: "#30a46c", status: "online" }),
      );
    } else if (msg.t === "presence" && !peers.has(msg.userId)) {
      peers.add(msg.userId);
      console.log(`peer on channel: ${msg.name || "(unnamed)"} — ${msg.userId}`);
    } else if (msg.t === "err") {
      console.error("refused:", msg.message);
      process.exit(1);
    }
    return;
  }
  const v = decodeVoiceFrame(new Uint8Array(data));
  if (!v) return;
  frames++;
  if (v.header.n === 0) console.log(`\n▶ ${v.header.m ?? v.header.u} started talking`);
  if (v.header.f === 1) console.log(`■ stopped after ${frames} frames`);
});

function report() {
  console.log(`\n— ${peers.size} peer(s) seen, ${frames} voice frame(s) received`);
  if (peers.size <= 1) {
    console.log("Only this listener was on the channel. If the desktop app was open,");
    console.log("it is NOT connected: sign in and turn sync on for this vault.");
  }
  process.exit(0);
}

process.on("SIGINT", report);
setTimeout(report, SECONDS * 1000);
