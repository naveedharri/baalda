import { describe, expect, it } from "vitest";
import { PROGRAM_SOURCES } from "./webglRenderer";

// These are source-level checks, not GL ones: there is no WebGL2 context under
// vitest. They exist because the failure they guard against is invisible on a
// software rasteriser (which links happily) and fatal on real hardware — the
// user sees "WebGL unavailable" and the capped 2D fallback, with the real cause
// buried in a driver message.

const declarations = (src: string, keyword: "uniform" | "in" | "out") => {
  const names = new Set<string>();
  const re = new RegExp(
    `^\\s*(?:precision\\s+\\w+\\s+\\w+;)?\\s*(?:layout\\([^)]*\\)\\s*)?${keyword}\\s+(?:lowp|mediump|highp\\s+)?\\s*\\w+\\s+(\\w+)\\s*;`,
    "gm",
  );
  for (const m of src.matchAll(re)) names.add(m[1]);
  return names;
};

describe("shader portability", () => {
  for (const { name, vert, frag } of PROGRAM_SOURCES) {
    it(`${name}: declares no uniform in both stages`, () => {
      const shared = [...declarations(vert, "uniform")].filter((u) =>
        declarations(frag, "uniform").has(u),
      );
      // If a stage genuinely needs the same value, pass it through as a varying
      // instead — see vQuad in the node/glow programs.
      expect(shared, `shared between stages: ${shared.join(", ")}`).toEqual([]);
    });

    it(`${name}: every fragment input is produced by the vertex stage`, () => {
      const outs = declarations(vert, "out");
      const missing = [...declarations(frag, "in")].filter((v) => !outs.has(v));
      expect(missing, `no vertex output for: ${missing.join(", ")}`).toEqual([]);
    });

    it(`${name}: both stages pin an explicit float precision`, () => {
      // Relying on the defaults is what makes cross-stage mismatches possible in
      // the first place — vertex defaults to highp, fragment does not.
      expect(vert).toMatch(/precision\s+highp\s+float;/);
      expect(frag).toMatch(/precision\s+highp\s+float;/);
    });
  }
});
