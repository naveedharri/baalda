// Join celebration: a warm chime + a lightweight confetti burst. Both are
// self-contained (WebAudio synth, hand-rolled canvas) so there's no asset to
// ship and no dependency — matching the graph view's no-deps canvas approach.

let ctx: AudioContext | null = null;

function audioContext(): AudioContext | null {
  try {
    ctx ??= new AudioContext();
    if (ctx.state === "suspended") void ctx.resume();
    return ctx;
  } catch {
    return null; // no audio device / autoplay blocked — celebration stays visual
  }
}

/** A short, bright ascending arpeggio (C6–E6–G6–C7) — celebratory but polite. */
export function playJoinChime(): void {
  const ac = audioContext();
  if (!ac) return;
  const t0 = ac.currentTime;
  for (const [freq, at] of [
    [1046.5, 0], // C6
    [1318.5, 0.09], // E6
    [1568.0, 0.18], // G6
    [2093.0, 0.27], // C7
  ] as const) {
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    osc.type = "triangle";
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0, t0 + at);
    gain.gain.linearRampToValueAtTime(0.16, t0 + at + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + at + 0.5);
    osc.connect(gain).connect(ac.destination);
    osc.start(t0 + at);
    osc.stop(t0 + at + 0.55);
  }
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  rot: number;
  vr: number;
  size: number;
  color: string;
}

const CONFETTI_COLORS = [
  "#f97316",
  "#facc15",
  "#4ade80",
  "#38bdf8",
  "#a78bfa",
  "#fb7185",
];

/**
 * Fire a brief confetti burst onto `canvas` (sized to its client box). Returns a
 * cancel function that stops the animation early. Auto-stops once every particle
 * has fallen past the bottom, so it never spins forever.
 */
export function runConfetti(
  canvas: HTMLCanvasElement,
  opts: { count?: number; random?: () => number } = {},
): () => void {
  const rand = opts.random ?? Math.random;
  const g = canvas.getContext("2d");
  if (!g) return () => {};

  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  canvas.width = Math.max(1, Math.floor(w * dpr));
  canvas.height = Math.max(1, Math.floor(h * dpr));
  g.scale(dpr, dpr);

  const count = opts.count ?? 120;
  const particles: Particle[] = Array.from({ length: count }, () => ({
    // Rain in from just above the top edge, spread across the width.
    x: rand() * w,
    y: -20 - rand() * h * 0.4,
    vx: (rand() - 0.5) * 3,
    vy: 2 + rand() * 4,
    rot: rand() * Math.PI * 2,
    vr: (rand() - 0.5) * 0.3,
    size: 5 + rand() * 6,
    color: CONFETTI_COLORS[Math.floor(rand() * CONFETTI_COLORS.length)],
  }));

  let raf = 0;
  let stopped = false;
  const gravity = 0.08;

  const frame = () => {
    if (stopped) return;
    g.clearRect(0, 0, w, h);
    let alive = 0;
    for (const p of particles) {
      p.vy += gravity;
      p.x += p.vx;
      p.y += p.vy;
      p.rot += p.vr;
      if (p.y < h + 20) alive++;
      g.save();
      g.translate(p.x, p.y);
      g.rotate(p.rot);
      g.fillStyle = p.color;
      g.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.6);
      g.restore();
    }
    if (alive === 0) {
      g.clearRect(0, 0, w, h);
      return;
    }
    raf = requestAnimationFrame(frame);
  };
  raf = requestAnimationFrame(frame);

  return () => {
    stopped = true;
    cancelAnimationFrame(raf);
    g.clearRect(0, 0, w, h);
  };
}
