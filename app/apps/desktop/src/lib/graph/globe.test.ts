import { describe, expect, it } from "vitest";
import { faceRotation, frameOf, rotate, toSphere, yawToward } from "./globe";

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
