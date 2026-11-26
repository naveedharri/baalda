/**
 * Development only (loaded from App.tsx behind `import.meta.env.DEV`): shows
 * the update card or the What's New card over the running app, so a design
 * change can be looked at without shipping an update.
 *
 *   curl 'http://localhost:1420/__baalda/preview?screen=update'
 *   curl 'http://localhost:1420/__baalda/preview?screen=update-failed'
 *   curl 'http://localhost:1420/__baalda/preview?screen=whats-new&video=https://youtu.be/<id>'
 *   curl 'http://localhost:1420/__baalda/preview?screen=none'
 *
 * (vite.config.ts relays those as an HMR event), or
 * `__baaldaPreview("whats-new")` from the devtools console. Escape closes.
 * Option-Shift-U and Option-Shift-W open them from the keyboard.
 *
 * A test build made with `VITE_DESIGN_PREVIEW=1` (no Vite server to relay
 * from) opens on the update card; Escape moves on to What's New.
 */
import { useCallback, useEffect, useState } from "react";
import type { UpdateState } from "../lib/updater";
import { releaseNoteItems, releaseNoteVideo } from "../lib/releaseNotes";
import { UpdateGateView } from "./UpdateGateView";
import { WhatsNewDialog } from "./WhatsNewDialog";

type Request = { screen: string | null; video?: string | null };

const listeners = new Set<(r: Request) => void>();
const emit = (r: Request) => listeners.forEach((l) => l(r));
(window as unknown as { __baaldaPreview?: (screen: string, video?: string) => void }).__baaldaPreview = (
  screen,
  video,
) => emit({ screen, video });
import.meta.hot?.on("baalda:preview", (r: Request) => emit(r));

const VERSION = "0.1.115";
const SAMPLE_VIDEO = "https://www.youtube.com/watch?v=yTo3sDwB1-o";
const SAMPLE_NOTES = [
  "- **Access groups.** Give a whole team the same access in one place.",
  "- **Join codes add people to groups.** New joiners land with the right access.",
  "- **Faster first sync.** Big vaults arrive with their notes filled in.",
].join("\n");

/** A pretend update: check, a 96.8 MB download, install, restart, again. */
function phaseAt(ms: number): UpdateState {
  const t = ms % 14_000;
  const total = 96_800_000;
  if (t < 700) return { phase: "checking" };
  if (t < 1_100) return { phase: "available", version: VERSION };
  if (t < 9_100) {
    const x = (t - 1_100) / 8_000;
    const eased = x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2;
    return { phase: "downloading", version: VERSION, downloaded: Math.round(total * eased), total };
  }
  if (t < 11_400) return { phase: "installing", version: VERSION };
  return { phase: "ready", version: VERSION };
}

function PretendUpdate({ failed }: { failed: boolean }) {
  const [ms, setMs] = useState(0);
  useEffect(() => {
    if (failed) return;
    const start = performance.now();
    const id = window.setInterval(() => setMs(performance.now() - start), 80);
    return () => window.clearInterval(id);
  }, [failed]);
  const update: UpdateState = failed
    ? { phase: "failed", version: VERSION, message: "the download was interrupted" }
    : phaseAt(ms);
  return (
    <UpdateGateView
      update={update}
      version={VERSION}
      launching={!failed}
      required={failed ? VERSION : null}
      working={!failed}
      onRetry={async () => {}}
      onDownloadManually={() => {}}
      onReload={() => {}}
    />
  );
}

const AUTOPLAY = Boolean(import.meta.env.VITE_DESIGN_PREVIEW);

export default function DevPreview() {
  const [req, setReq] = useState<Request | null>(AUTOPLAY ? { screen: "update" } : null);
  useEffect(() => {
    const on = (r: Request) => setReq(r.screen && r.screen !== "none" ? r : null);
    listeners.add(on);
    return () => void listeners.delete(on);
  }, []);
  const close = useCallback(
    () => setReq((r) => (AUTOPLAY && r?.screen === "update" ? { screen: "whats-new" } : null)),
    [],
  );
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || !e.shiftKey) return;
      if (e.code === "KeyU") setReq({ screen: "update" });
      else if (e.code === "KeyW") setReq({ screen: "whats-new" });
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  useEffect(() => {
    if (!req || req.screen === "whats-new") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [req, close]);

  if (!req) return null;
  if (req.screen === "update" || req.screen === "update-failed") {
    return <PretendUpdate key={req.screen} failed={req.screen === "update-failed"} />;
  }
  if (req.screen === "whats-new") {
    const video = req.video === "none" ? null : releaseNoteVideo(`video: ${req.video || SAMPLE_VIDEO} "Access groups in two minutes"`);
    return <WhatsNewDialog key={String(req.video)} version={VERSION} notes={releaseNoteItems(SAMPLE_NOTES, 5)} video={video} onClose={close} />;
  }
  return null;
}
