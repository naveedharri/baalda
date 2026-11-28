import { describe, expect, it } from "vitest";
import { easeFrame, faceRotation, frameOf, rotate, toSphere, yawToward } from "./globe";

const pt = () => ({ x: 0, y: 0, z: 0 });

describe("globe", () => {
  const frame = frameOf([-100, 100, 0], [-50, 50, 0], 3);

  it("puts the layout centre on the front pole", () => {
    const p = toSphere(0, 0, frame, pt());
    expect(p.z).toBeCloseTo(1);
    expect(Math.hypot(p.x, p.y)).toBeCloseTo(0);
  });

  it("keeps every point on the unit sphere and the edge short of the back pole", () => {
    for (const [x, y] of [[100, 0], [-100, 50], [30, -80]]) {
      const p = toSphere(x, y, frame, pt());
      expect(Math.hypot(p.x, p.y, p.z)).toBeCloseTo(1);
      expect(p.z).toBeGreaterThan(-1);
    }
  });

  const cloud = (ax: number, ay: number, bite = false) => {
    const xs: number[] = [];
    const ys: number[] = [];
    for (let i = 0; i < 3000; i++) {
      const a = i * 2.399963;
      // A bite takes a third off one side, like a layout with a ragged edge.
      const d = Math.sqrt((i + 0.5) / 3000) * (bite && Math.cos(a) < -0.5 ? 0.65 : 1);
      xs.push(Math.cos(a) * d * ax);
      ys.push(Math.sin(a) * d * ay);
    }
    return { xs, ys, f: frameOf(xs, ys, xs.length) };
  };

  it.each([
    ["round", 100, 100, false],
    ["wide", 150, 100, false],
    ["ragged", 100, 100, true],
  ])("covers the whole sphere from a %s layout", (_, ax, ay, bite) => {
    const { xs, ys, f } = cloud(ax as number, ay as number, bite as boolean);
    const bands = [0, 0, 0, 0];
    const cap = { far: 1 };
    xs.forEach((x, i) => {
      const { z } = toSphere(x, ys[i], f, pt());
      bands[Math.min(3, Math.floor(((1 - z) / 2) * 4))]++;
      cap.far = Math.min(cap.far, z);
    });
    for (const n of bands) expect(n / xs.length).toBeGreaterThan(0.2);
    expect(cap.far).toBeLessThan(-0.99);
  });

  it("keeps neighbours together", () => {
    const { f } = cloud(150, 100);
    const a = toSphere(60, 20, f, pt());
    const b = { ...toSphere(62, 21, f, pt()) };
    const c = toSphere(-60, -20, f, pt());
    expect(Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)).toBeLessThan(0.1);
    expect(Math.hypot(a.x - c.x, a.y - c.y, a.z - c.z)).toBeGreaterThan(0.5);
  });

  it("eases toward a new frame and lands on it", () => {
    const from = cloud(100, 100).f;
    const to = cloud(150, 100).f;
    let f = from;
    for (let i = 0; i < 400 && f !== to; i++) f = easeFrame(f, to);
    expect(f).toBe(to);
  });

  it("turns any point to face the viewer", () => {
    const p = toSphere(70, -40, frame, pt());
    const r = rotate(p, faceRotation(p), pt());
    expect(r.z).toBeCloseTo(1, 4);
  });

  it("turns the short way round", () => {
    expect(yawToward(3, -3)).toBeCloseTo(3 + (Math.PI * 2 - 6));
    expect(yawToward(0, 1)).toBeCloseTo(1);
  });
});
