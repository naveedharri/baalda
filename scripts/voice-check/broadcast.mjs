// Broadcast a real voice transmission into the vault as "Ada", so a running
// desktop app can be checked for: audible playback, the "Ada is talking" label,
// and the megaphone's receiving shake.
//
// Audio is synthesised with macOS `say` straight to 16 kHz mono PCM16 — the
// exact format the desktop transmits — and paced at the same 200ms cadence, so
// the server and the receiver see traffic indistinguishable from a live mic.
//
//   VAULT_ID=<uuid> node scripts/voice-check/broadcast.mjs "what to say"

import { execFileSync } from "node:child_process";
import { readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BASE, encodeVoiceFrame, loadWs, signIn, vaultToken, wsUrl } from "./common.mjs";

const SAMPLE_RATE = 16_000;
const CHUNK_MS = 200;
const CHUNK_BYTES = (SAMPLE_RATE * 2 * CHUNK_MS) / 1000; // 16-bit mono

const text =
  process.argv.slice(2).join(" ") ||
  "Hey! This is Ada testing the push to talk feature. If you can hear me, it works.";

/** Strip the RIFF header — find the `data` chunk, take everything after it. */
function pcmFromWav(buf) {
  let off = 12; // past "RIFF____WAVE"
  while (off < buf.length - 8) {
    const id = buf.toString("ascii", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === "data") return buf.subarray(off + 8, off + 8 + size);
    off += 8 + size + (size % 2);
  }
  throw new Error("no data chunk in wav");
}

const wav = join(tmpdir(), `voice-check-${process.pid}.wav`);
try {
  execFileSync("say", ["-v", "Samantha", "-o", wav, "--data-format=LEI16@16000", "--channels=1", text]);
} catch {
  console.error("`say` failed — this synthesiser is macOS-only.");
  process.exit(1);
}
const pcm = pcmFromWav(readFileSync(wav));
unlinkSync(wav);

const WebSocket = await loadWs();
const token = await vaultToken(await signIn("ada@example.com", "TestPassword123!"));
console.log(`signed in as Ada @ ${BASE}`);

const total = Math.ceil(pcm.length / CHUNK_BYTES);
console.log(`${(pcm.length / (SAMPLE_RATE * 2)).toFixed(1)}s of audio → ${total} chunks`);

const ws = new WebSocket(wsUrl());
ws.binaryType = "arraybuffer";
ws.on("open", () =>
  ws.send(JSON.stringify({ t: "hello", token, manifest: {}, caps: ["voice"] })),
);

ws.on("message", async (data, isBinary) => {
  if (isBinary) return;
  const msg = JSON.parse(data.toString());
  if (msg.t === "err") {
    console.error("server refused:", msg.message);
    process.exit(1);
  }
  if (msg.t !== "ready") return;

  // Announce first: the relay stamps the opening chunk with the name/colour it
  // holds for this connection, and that's what the listener displays.
  ws.send(
    JSON.stringify({ t: "presence", docId: null, name: "Ada Lovelace", color: "#e5484d", status: "online" }),
  );
  console.log("channel ready — transmitting…");

  const streamId = `vc-${Date.now().toString(36)}`;
  for (let n = 0; n < total; n++) {
    ws.send(
      encodeVoiceFrame(
        { s: streamId, n, ...(n === 0 ? { fmt: "pcm16", sr: SAMPLE_RATE } : {}) },
        pcm.subarray(n * CHUNK_BYTES, (n + 1) * CHUNK_BYTES),
      ),
    );
    process.stdout.write(".");
    await new Promise((r) => setTimeout(r, CHUNK_MS)); // pace like a live mic
  }
  ws.send(encodeVoiceFrame({ s: streamId, n: total, f: 1 }, Buffer.alloc(0)));
  console.log(`\nsent ${total} chunks + end marker`);
  setTimeout(() => ws.close(), 500);
});

ws.on("close", () => process.exit(0));
ws.on("error", (e) => {
  console.error("ws error:", e.message);
  process.exit(1);
});
