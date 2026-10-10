import { describe, expect, it, vi } from "vitest";
import {
  EMBED_RETRY_DELAYS_MS,
  EMBED_SCAN_DEBOUNCE_MS,
  EMBED_SLOW_RETRY_MS,
  EmbedArrivalFetcher,
  attachmentRelFromSrc,
  embedAttachmentRefs,
} from "../embedArrival";

describe("attachmentRelFromSrc", () => {
  it("reads all three spellings of the vault's attachments store as one path", () => {
    expect(attachmentRelFromSrc("/attachments/2a8962a8b6cb08ae.png")).toBe("attachments/2a8962a8b6cb08ae.png");
    expect(attachmentRelFromSrc("attachments/2a8962a8b6cb08ae.png")).toBe("attachments/2a8962a8b6cb08ae.png");
    expect(attachmentRelFromSrc("./attachments/2a8962a8b6cb08ae.png")).toBe("attachments/2a8962a8b6cb08ae.png");
  });

  it("refuses URLs, traversal and paths outside attachments/", () => {
    expect(attachmentRelFromSrc("https://x.test/attachments/a.png")).toBeNull();
    expect(attachmentRelFromSrc("/attachments/../secret.png")).toBeNull();
    expect(attachmentRelFromSrc("notes/a.png")).toBeNull();
    expect(attachmentRelFromSrc("/attachments/.hidden.png")).toBeNull();
  });
});

describe("embedAttachmentRefs", () => {
  it("collects image, link and html embeds once each", () => {
    const md = [
      "![Screenshot 2026-10-09 at 11.56.32 AM](/attachments/2a8962a8b6cb08ae.png)",
      "[report](attachments/r.pdf) and again ![x](./attachments/2a8962a8b6cb08ae.png)",
      '<img src="/attachments/h.jpg">',
      "![remote](https://example.com/attachments/no.png)",
    ].join("\n");
    expect(embedAttachmentRefs(md).sort()).toEqual([
      "attachments/2a8962a8b6cb08ae.png",
      "attachments/h.jpg",
      "attachments/r.pdf",
    ]);
  });
});

function harness(
  opts: { present?: Set<string>; failTimes?: number; wanted?: Set<string> } = {},
) {
  const present = opts.present ?? new Set<string>();
  let fails = opts.failTimes ?? 0;
  const timers: { fn: () => void; ms: number }[] = [];
  const requests: string[][] = [];
  const fetcher = new EmbedArrivalFetcher({
    exists: async (p) => present.has(p),
    download: async (paths) => {
      requests.push([...paths]);
      if (fails > 0) {
        fails--;
        throw new Error("no downloadable copy yet");
      }
      for (const p of paths) present.add(p);
    },
    ...(opts.wanted ? { isWanted: (p: string) => opts.wanted!.has(p) } : {}),
    setTimeout: (fn, ms) => {
      const t = { fn, ms };
      timers.push(t);
      return t;
    },
    clearTimeout: (h) => {
      const i = timers.indexOf(h as never);
      if (i >= 0) timers.splice(i, 1);
    },
  });
  const flush = async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  };
  const fire = async () => {
    const t = timers.shift();
    if (!t) throw new Error("no timer armed");
    t.fn();
    await flush();
    return t.ms;
  };
  return { fetcher, timers, requests, present, fire, flush };
}

describe("EmbedArrivalFetcher", () => {
  it("requests a teammate's new embed once per hash, however many edits name it", async () => {
    const h = harness();
    let text = "hello";
    h.fetcher.noteRemoteChange(() => text);
    text = "hello\n![shot](/attachments/2a8962a8b6cb08ae.png)";
    h.fetcher.noteRemoteChange(() => text);
    expect(await h.fire()).toBe(EMBED_SCAN_DEBOUNCE_MS);
    expect(h.requests).toEqual([["attachments/2a8962a8b6cb08ae.png"]]);

    // More remote typing in the same note, the ref still there: no new request.
    text += "\nmore typing";
    h.fetcher.noteRemoteChange(() => text);
    await h.fire();
    expect(h.requests).toHaveLength(1);
  });

  it("never asks for a file already on this disk", async () => {
    const h = harness({ present: new Set(["attachments/a.png"]) });
    h.fetcher.noteRemoteChange(() => "![a](/attachments/a.png)");
    await h.fire();
    expect(h.requests).toEqual([]);
  });

  it("retries on backoff while the uploader is still sending, then stops", async () => {
    const h = harness({ failTimes: 2 });
    h.fetcher.noteRemoteChange(() => "![a](/attachments/a.png)");
    await h.fire();
    expect(h.requests).toHaveLength(1);
    expect(await h.fire()).toBe(EMBED_RETRY_DELAYS_MS[0]);
    expect(await h.fire()).toBe(EMBED_RETRY_DELAYS_MS[1]);
    expect(h.requests).toHaveLength(3);
    expect(h.present.has("attachments/a.png")).toBe(true);
    expect(h.timers).toHaveLength(0);
  });

  it("gives up after the last retry and arms nothing after stop()", async () => {
    const h = harness({ failTimes: 999 });
    h.fetcher.noteRemoteChange(() => "![a](/attachments/a.png)");
    await h.fire();
    for (let i = 0; i < EMBED_RETRY_DELAYS_MS.length; i++) await h.fire();
    expect(h.requests).toHaveLength(EMBED_RETRY_DELAYS_MS.length + 1);
    expect(h.timers).toHaveLength(0);

    const s = harness({ failTimes: 999 });
    s.fetcher.noteRemoteChange(() => "![a](/attachments/a.png)");
    s.fetcher.stop();
    expect(s.timers).toHaveLength(0);
    const spy = vi.fn();
    s.fetcher.noteRemoteChange(spy);
    expect(spy).not.toHaveBeenCalled();
  });

  it("keeps asking every 30 s while an open image still waits, and stops once none does", async () => {
    const wanted = new Set(["attachments/a.png"]);
    const h = harness({ failTimes: 999, wanted });
    h.fetcher.noteRemoteChange(() => "![a](/attachments/a.png)");
    await h.fire();
    for (let i = 0; i < EMBED_RETRY_DELAYS_MS.length; i++) await h.fire();
    // Past the fixed schedule: the slow cadence, not silence.
    expect(h.timers.map((t) => t.ms)).toEqual([EMBED_SLOW_RETRY_MS]);
    expect(await h.fire()).toBe(EMBED_SLOW_RETRY_MS);
    expect(h.timers.map((t) => t.ms)).toEqual([EMBED_SLOW_RETRY_MS]);
    // The image loaded elsewhere or the note closed: the next miss ends it.
    wanted.clear();
    await h.fire();
    expect(h.timers).toHaveLength(0);
  });

  it("lands on the slow cadence once the uploader finally finishes", async () => {
    const h = harness({ failTimes: EMBED_RETRY_DELAYS_MS.length + 3, wanted: new Set(["attachments/a.png"]) });
    h.fetcher.noteRemoteChange(() => "![a](/attachments/a.png)");
    await h.fire();
    while (h.timers.length) await h.fire();
    expect(h.present.has("attachments/a.png")).toBe(true);
  });

  it("asks again at once on a nudge, with the schedule reset", async () => {
    const h = harness({ failTimes: 3 });
    h.fetcher.noteRemoteChange(() => "![a](/attachments/a.png)");
    await h.fire();
    await h.fire();
    await h.fire();
    expect(h.requests).toHaveLength(3);
    expect(h.timers.map((t) => t.ms)).toEqual([EMBED_RETRY_DELAYS_MS[2]]);
    h.fetcher.nudge();
    await h.flush();
    expect(h.requests).toHaveLength(4);
    expect(h.present.has("attachments/a.png")).toBe(true);
    expect(h.timers).toHaveLength(0);
  });

  it("a nudge with nothing pending asks for nothing", async () => {
    const h = harness();
    h.fetcher.nudge();
    await h.flush();
    expect(h.requests).toEqual([]);
  });

  it("starts afresh when an image asks for a path whose schedule already ran out", async () => {
    const h = harness({ failTimes: EMBED_RETRY_DELAYS_MS.length + 1 });
    h.fetcher.noteRemoteChange(() => "![a](/attachments/a.png)");
    await h.fire();
    while (h.timers.length) await h.fire();
    expect(h.present.has("attachments/a.png")).toBe(false);
    const before = h.requests.length;
    await h.fetcher.request(["attachments/a.png"]);
    await h.flush();
    expect(h.requests.length).toBe(before + 1);
    expect(h.present.has("attachments/a.png")).toBe(true);
  });
});
