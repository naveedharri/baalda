/* Status moments (redesign preview): the avatar acts out its status. Props are
   drawn in the generated face's own 1744-unit box, so they land on the mouth,
   eyes and head of any teammate's character. An uploaded photo has no known
   geometry, so it gets the status emoji as a small badge instead. Small sizes
   draw the still prop only; everything is static under reduced motion (CSS). */
import { STATUS_MOMENTS, isMoment } from "../lib/prefs";
import { resolveAvatar } from "../lib/avatarIdentity";
import "./statusMoment.css";

const LN = 'stroke="#000" stroke-width="22" stroke-linecap="round" stroke-linejoin="round"';
const CLOSED_EYES = `<rect x="770" y="745" width="140" height="95" rx="40" fill="#fff"/><rect x="975" y="745" width="140" height="95" rx="40" fill="#fff"/><path ${LN} fill="none" d="M790 790q50 30 100 0M990 790q50 30 100 0"/>`;
const CIGARETTE = `<g transform="rotate(-8 955 942)"><rect x="955" y="922" width="410" height="40" rx="10" ${LN} fill="#f4f1ea"/><rect x="966" y="933" width="60" height="18" rx="4" fill="#d9a46b"/><circle class="sm-ember" cx="1368" cy="942" r="24"/></g>`;

function layers(status: string, full: boolean): { clip: string; free: string } {
  if (status === "smoke") {
    if (!full) return { clip: CIGARETTE, free: "" };
    const tip = [0, 1, 2, 3]
      .map((i) => `<circle class="sm-tip" style="animation-delay:${i * 0.6}s" cx="1368" cy="900" r="55" fill="#80808b"/>`)
      .join("");
    const ash = [0, 1]
      .map((i) => `<circle class="sm-ash" style="animation-delay:${i * 0.25}s" cx="1370" cy="930" r="13" fill="#8a8a94"/>`)
      .join("");
    const out = [0, 1, 2, 3, 4, 5]
      .map((i) => `<circle class="sm-out" style="animation-delay:${i * 0.1}s" cx="958" cy="958" r="${55 + i * 6}" fill="#8a8a95"/>`)
      .join("");
    return {
      clip: `<g class="sm-hand"><path ${LN} fill="#fff" d="M1075 1090 q-30 300 -60 660 l300 0 q-20 -360 -40 -660z"/>${CIGARETTE}<path ${LN} fill="#fff" d="M1110 925 q-10 -55 55 -55 h60 q70 0 70 70 v95 q0 65 -65 65 h-60 q-65 0 -65 -70z"/><path ${LN} fill="none" d="M1150 990 h90 M1150 1040 h90 M1150 1090 h70"/></g><g class="sm-purse"><rect x="895" y="928" width="120" height="60" rx="28" fill="#fff"/><ellipse cx="955" cy="958" rx="20" ry="17" fill="#2c2b33"/></g>`,
      free: `<g class="sm-hand"><g class="sm-gate">${tip}</g>${ash}</g>${out}`,
    };
  }
  if (status === "coffee") {
    const mug = `<path ${LN} fill="#fde99b" d="M930 1000 h240 v220 q0 60 -60 60 h-120 q-60 0 -60 -60z"/><path ${LN} fill="none" d="M1170 1060 q90 0 90 70 q0 70 -90 70"/>`;
    if (!full) return { clip: `<g transform="translate(0,300)">${mug}</g>`, free: "" };
    const steam = [0, 1, 2]
      .map((i) => `<path class="sm-steam" style="animation-delay:${i * 0.8}s" d="M${1000 + i * 55} 960 q-30 -60 0 -120 q30 -60 0 -120" stroke="#9a9aa5" stroke-width="18" fill="none" stroke-linecap="round"/>`)
      .join("");
    return {
      clip: `<g class="sm-mug">${mug}<path ${LN} fill="#fff" d="M1030 1280 q-20 120 -10 420 l200 0 q0 -300 -20 -420z"/></g><g class="sm-sip">${CLOSED_EYES}</g>`,
      free: steam,
    };
  }
  if (status === "lunch") {
    const bowl = `<path ${LN} fill="#f7d9be" d="M760 1380 q190 160 380 0 z"/><path ${LN} fill="none" d="M740 1380 h420"/>`;
    if (!full) return { clip: bowl, free: "" };
    return {
      clip: `${bowl}<g class="sm-chop"><path ${LN} d="M960 960 L1320 1300 M1000 940 L1350 1270"/><path stroke="#e8c27a" stroke-width="16" fill="none" stroke-linecap="round" d="M950 960 q-20 60 10 120 q20 50 -5 100 M985 955 q20 70 -5 130"/></g><g class="sm-chew"><rect x="900" y="935" width="100" height="40" rx="20" fill="#fff"/><path ${LN} fill="none" d="M915 958 q35 22 70 0"/></g>`,
      free: "",
    };
  }
  if (status === "meeting") {
    const set = `<path ${LN} fill="none" stroke-width="40" stroke="#2c2b33" d="M560 830 C 500 170, 1230 170, 1170 830"/><rect x="505" y="740" width="110" height="200" rx="45" fill="#4b68c3" ${LN}/><rect x="1115" y="740" width="110" height="200" rx="45" fill="#4b68c3" ${LN}/>`;
    if (!full) return { clip: set, free: "" };
    return {
      clip: `${set}<path ${LN} fill="none" d="M1170 930 q0 120 -140 60"/><circle cx="1025" cy="990" r="22" fill="#2c2b33"/><rect x="900" y="935" width="100" height="45" rx="20" fill="#fff"/><ellipse class="sm-talk" cx="950" cy="962" rx="34" ry="24" fill="#2c2b33"/>`,
      free: "",
    };
  }
  if (status === "focus") {
    const zz = full
      ? [0, 1, 2].map((i) => `<text class="sm-z" style="animation-delay:${i}s" x="1180" y="620">z</text>`).join("")
      : "";
    return { clip: CLOSED_EYES, free: zz };
  }
  return { clip: "", free: "" };
}

export function StatusMoment({
  status,
  size,
  image,
}: {
  status: string | undefined;
  /** Rendered avatar size in px: under 30 draws the still prop only. */
  size: number;
  /** An uploaded photo: geometry unknown, so show the emoji badge. */
  image?: string | null;
}) {
  if (!isMoment(status)) return null;
  const meta = STATUS_MOMENTS.find((m) => m.id === status)!;
  // A picked character is still a generated face; only a real photo is unknown.
  const photo = image ? resolveAvatar({ image }).photo : null;
  if (photo || status === "brb") {
    return (
      <span className="sm-badge" aria-hidden="true">
        {meta.emoji}
      </span>
    );
  }
  const { clip, free } = layers(status, size >= 30);
  return (
    <span className={`sm-layer sm-${status}`} aria-hidden="true" title={meta.label}>
      <svg className="sm-clip" viewBox="0 0 1744 1744" dangerouslySetInnerHTML={{ __html: clip }} />
      <svg className="sm-free" viewBox="0 0 1744 1744" dangerouslySetInnerHTML={{ __html: free }} />
    </span>
  );
}
