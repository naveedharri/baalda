// Zero-dependency WebGL2 renderer for the global graph. Draws every node as a
// GPU-shaded sphere via instanced rendering, so the whole vault stays at 60fps
// regardless of size (the 2D-canvas path repaints each node on the CPU and only
// scales to a few hundred). Local-first: raw WebGL2, no libraries.
//
// Four passes, back to front, all instanced or full-screen — never per-node CPU
// work:
//   1. backdrop  — a dithered radial gradient, so the void has depth instead of
//                  being one flat dark fill
//   2. edges     — feathered quads, NOT gl.LINES (see below)
//   3. glow      — additive halos, the light each node sheds
//   4. cores     — the lit spheres themselves
//
// WHY quads for edges: gl.LINES is capped at one device pixel on essentially
// every desktop GL implementation, so links rendered as a hard, aliased hairline
// — and once the alpha was dropped far enough to stop thousands of them washing
// the view out, they became a faint dotted mess. A quad can be 2–3px wide with a
// soft alpha falloff across its width, which reads as a *thread* at any zoom and
// stays quiet in bulk because the feathering, not the opacity, does the work.

/** A node to draw, in world (simulation) coordinates. */
export interface RenderNode {
  x: number;
  y: number;
  /** Radius in world units. */
  r: number;
  /** Fill color, 0..1 per channel. */
  color: [number, number, number];
}

// Halo extent, in multiples of the node's own radius. The glow pass expands the
// instanced quad by this much; the core pass draws at 1.0.
const HALO = 3.2;

// ---------------------------------------------------------------------------
// Backdrop: a radial gradient matching `.graph-canvas-wrap` in graph.css, drawn
// in the shader rather than left to CSS because the node/glow passes need an
// opaque surface to blend against (an alpha-clearing canvas can't do additive
// glow over the page behind it).
// ---------------------------------------------------------------------------
const BG_VERT = `#version 300 es
precision highp float;
layout(location=0) in vec2 aCorner;
void main() { gl_Position = vec4(aCorner, 0.0, 1.0); }`;

const BG_FRAG = `#version 300 es
precision highp float;
uniform vec2 uViewport;
out vec4 fragColor;

// Same three stops as the CSS backdrop, so the 2D fallback and the GPU path
// sit on an identical void.
const vec3 C_CORE = vec3(0.059, 0.067, 0.106); // #0f111b
const vec3 C_MID  = vec3(0.031, 0.035, 0.063); // #080910
const vec3 C_RIM  = vec3(0.012, 0.016, 0.035); // #030409

void main() {
  vec2 uv = gl_FragCoord.xy / uViewport;
  // CSS puts the centre at 44% from the TOP; gl_FragCoord counts from the
  // bottom, hence 0.56.
  vec2 p = (uv - vec2(0.5, 0.56)) / 0.65;
  float d = length(p);
  vec3 c = mix(C_CORE, C_MID, smoothstep(0.0, 0.52, d));
  c = mix(c, C_RIM, smoothstep(0.52, 1.0, d));
  // Ordered-ish dither at ±1/255. Without it a gradient this dark and this
  // gradual bands into visible rings on an 8-bit display — the single biggest
  // giveaway that a background is "cheap".
  float n = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
  fragColor = vec4(c + (n - 0.5) / 255.0, 1.0);
}`;

// ---------------------------------------------------------------------------
// Nodes. One program, two passes, switched by uHalo/uPass.
// ---------------------------------------------------------------------------
const VERT = `#version 300 es
precision highp float;
layout(location=0) in vec2 aCorner;   // unit-quad corner in [-1,1]
layout(location=1) in vec2 aPos;      // per-instance world position
layout(location=2) in float aRadius;  // per-instance world radius
layout(location=3) in vec3 aColor;    // per-instance fill

uniform vec2 uViewport;  // drawing-buffer size in device px
uniform vec2 uPan;       // world origin -> screen px (top-left origin)
uniform float uScale;    // world units -> screen px
uniform float uMinPx;    // floor on a node's on-screen radius (device px)
uniform float uHalo;     // quad half-extent in radii (1.0 core, HALO glow)
uniform float uTime;     // seconds, for the per-node breathing

out vec2 vLocal;   // position within the quad, in radii (|vLocal| <= 1 is the disc)
// The same corner in [-1,1] whatever uHalo is, so the glow's falloff can be
// written without the fragment stage needing uHalo at all. Sharing a uniform
// across stages is a portability trap: the default float precision differs
// between vertex and fragment shaders, and a driver that enforces the spec
// (Apple's does) refuses to link with "Precisions of uniform 'uHalo' differ".
out vec2 vQuad;
out vec3 vColor;
out float vPulse;  // 0..1 breathing phase, unique per node
out float vPx;     // the node's on-screen radius in device px

void main() {
  // SOFT floor on the on-screen radius, in quadrature rather than a max().
  //
  // A hard max() was flattening the entire graph: at whole-vault zoom almost
  // every node fell under the floor, so a 1200-link hub and a 1-link leaf came
  // out exactly the same size and the field read as undifferentiated pixel
  // spray. Adding the floor in quadrature lifts the small nodes to something
  // visible while leaving the big ones proportional, so the size hierarchy
  // survives all the way out.
  float px = sqrt(aRadius * uScale * aRadius * uScale + uMinPx * uMinPx);
  float r = px / uScale;

  vec2 world = aPos + aCorner * r * uHalo;
  vec2 screen = world * uScale + uPan;          // px, origin top-left
  vec2 clip = vec2(
    screen.x / (uViewport.x * 0.5) - 1.0,
    1.0 - screen.y / (uViewport.y * 0.5)
  );
  gl_Position = vec4(clip, 0.0, 1.0);
  vLocal = aCorner * uHalo;
  vQuad = aCorner;
  vColor = aColor;
  vPx = px;
  // Golden-angle phase off the instance index: neighbours never breathe in
  // step, so the field shimmers instead of blinking as one.
  float phase = float(gl_InstanceID) * 2.399963;
  vPulse = 0.5 + 0.5 * sin(uTime * 0.55 + phase);
}`;

// Matte-sphere shading, computed per fragment. The disc used to be a flat fill,
// which is what made the graph look like a field of stickers — every node the
// same brightness edge to edge, so nothing read as an object with volume.
//
// Reconstructing a hemisphere normal from the quad corner is all it takes: with
// z = sqrt(1 - x² - y²) the shading is real Lambert on a real sphere, evaluated
// on the GPU at zero cost per node. Same light direction as the 2D canvas path's
// baked sprites (upper-left, tilted toward the viewer) so the two renderers agree
// about where the light is.
const FRAG = `#version 300 es
precision highp float;
in vec2 vLocal;
in vec2 vQuad;
in vec3 vColor;
in float vPulse;
in float vPx;
out vec4 fragColor;

const vec3 LIGHT = normalize(vec3(-0.5, -0.62, 0.6));

void main() {
  float d2 = dot(vLocal, vLocal);
  if (d2 > 1.0) discard;

  // Hemisphere normal at this pixel.
  float z = sqrt(max(0.0, 1.0 - d2));
  vec3 n = vec3(vLocal, z);

  // Deliberately NO surface pattern. Banding and mottling were tried — they made
  // the nodes read as little planets, and that is a different product: the eye
  // starts inspecting individual nodes instead of reading the shape of the
  // graph. The volume comes from lighting alone.

  // Lambert, lifted by an ambient floor so the unlit limb stays coloured rather
  // than going black — a fully dark terminator reads as a hole, not a shadow.
  float diff = max(0.0, dot(n, LIGHT));
  float shade = 0.42 + 0.72 * diff;

  // Narrow soft highlight where the light hits square on: the cue that says
  // "sphere" rather than "gradient". It breathes very slightly with the node's
  // own phase, which is what keeps a settled graph from looking like a print.
  float spec = pow(diff, 20.0) * (0.42 + 0.22 * vPulse);

  // Rim light on the far limb, which is what separates one node from another
  // when they overlap in a dense cluster.
  float rim = pow(1.0 - z, 3.0) * 0.30;

  // Hover-dimming is applied by the caller as a multiplier on the fill colour,
  // and a white specular would ignore it — dimmed nodes would keep a full-bright
  // glint and stay just as eye-catching as the ones being highlighted, which
  // defeats the dimming. Tying both additive terms to the fill's own brightness
  // keeps a dark node's highlight dark. Not physically correct (real specular is
  // light-coloured, not surface-coloured) but it is the behaviour we want, and it
  // costs nothing versus threading a per-instance dim attribute through a buffer
  // that can hold 50k nodes.
  float intensity = max(vColor.r, max(vColor.g, vColor.b));
  vec3 lit = vColor * shade + vec3(spec + rim) * intensity;

  // Feather the outermost pixels. The width of the feather is one device pixel
  // expressed in local units, so a 2px dot at overview zoom is antialiased just
  // as carefully as a 200px hub — a fixed 0.94 threshold turned small nodes into
  // hard-edged, visibly stair-stepped squares of colour.
  float d = sqrt(d2);
  float aa = clamp(1.0 / max(vPx, 1.0), 0.02, 0.5);
  float alpha = 1.0 - smoothstep(1.0 - aa, 1.0, d);
  fragColor = vec4(lit, alpha);
}`;

// The glow pass: the light a node sheds into the void around it. Additive, so
// overlapping halos in a cluster sum into a genuine bright core the way a
// star field does — that accumulation is the whole reason dense regions read as
// dense rather than as a uniform speckle.
const GLOW_FRAG = `#version 300 es
precision highp float;
in vec2 vLocal;
in vec2 vQuad;
in vec3 vColor;
in float vPulse;
out vec4 fragColor;

uniform float uGlow;  // global glow scale (drops as the graph grows)

void main() {
  float d = length(vLocal);
  if (d > 1.0) {
    // Outside the sphere: a soft, steep falloff to nothing at the quad's edge.
    // Measured in quad space (vQuad), which is 0..1 across the halo whatever
    // its extent — so this needs no uniform, and the program links on drivers
    // that enforce cross-stage precision matching.
    float t = clamp(1.0 - length(vQuad), 0.0, 1.0);
    float g = pow(t, 2.4);
    float amp = uGlow * (0.55 + 0.45 * vPulse);
    fragColor = vec4(vColor * g * amp, g * amp * 0.9);
    return;
  }
  // Under the sphere the glow is flat and full: the core pass paints over it,
  // and a hole here would show as a dark ring around every small node.
  float amp = uGlow * (0.55 + 0.45 * vPulse) * 0.34;
  fragColor = vec4(vColor * amp, amp);
}`;

// ---------------------------------------------------------------------------
// Edges: instanced quads, one per link, expanded in SCREEN space so the width
// is a constant number of device pixels at any zoom.
// ---------------------------------------------------------------------------
const LINE_VERT = `#version 300 es
precision highp float;
layout(location=0) in vec2 aCorner;  // x: 0..1 along the segment, y: -1..1 across
layout(location=1) in vec4 aSeg;     // per-instance x0,y0,x1,y1 in world units
uniform vec2 uViewport;
uniform vec2 uPan;
uniform float uScale;
uniform float uWidthPx;              // full width of the quad, device px
out float vAcross;
void main() {
  vec2 p0 = aSeg.xy * uScale + uPan;
  vec2 p1 = aSeg.zw * uScale + uPan;
  vec2 dir = p1 - p0;
  float len = max(1e-4, length(dir));
  dir /= len;
  vec2 nrm = vec2(-dir.y, dir.x);
  vec2 p = mix(p0, p1, aCorner.x) + nrm * (aCorner.y * uWidthPx * 0.5);
  vec2 clip = vec2(
    p.x / (uViewport.x * 0.5) - 1.0,
    1.0 - p.y / (uViewport.y * 0.5)
  );
  gl_Position = vec4(clip, 0.0, 1.0);
  vAcross = aCorner.y;
}`;

const LINE_FRAG = `#version 300 es
precision highp float;
in float vAcross;
uniform vec4 uLineColor;
out vec4 fragColor;
void main() {
  // Soft across the width: solid down the spine, faded to nothing at the rim.
  // This is what replaces MSAA on a 1px line — and it is why the resting alpha
  // can be raised without thousands of overlapping links turning into a wash.
  float a = pow(1.0 - abs(vAcross), 1.5);
  fragColor = vec4(uLineColor.rgb, uLineColor.a * a);
}`;

const FLOATS_PER_NODE = 6; // x, y, r, cr, cg, cb

/**
 * The exact (vertex, fragment) pairs this renderer links, exported so a unit
 * test can check them for portability traps that only some drivers enforce —
 * chiefly a uniform declared in BOTH stages, which links fine on a software
 * rasteriser and is rejected outright by Apple's driver ("Precisions of uniform
 * 'x' differ between VERTEX and FRAGMENT shaders"), taking the whole GPU
 * renderer offline and dropping the graph to its capped 2D fallback.
 */
export const PROGRAM_SOURCES = [
  { name: "background", vert: BG_VERT, frag: BG_FRAG },
  { name: "node", vert: VERT, frag: FRAG },
  { name: "glow", vert: VERT, frag: GLOW_FRAG },
  { name: "line", vert: LINE_VERT, frag: LINE_FRAG },
];

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type);
  if (!sh) throw new Error("createShader failed");
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error("shader compile failed: " + log);
  }
  return sh;
}

function link(
  gl: WebGL2RenderingContext,
  vertSrc: string,
  fragSrc: string,
  label: string,
): WebGLProgram {
  const prog = gl.createProgram();
  if (!prog) throw new Error(`createProgram (${label}) failed`);
  gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, vertSrc));
  gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, fragSrc));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    throw new Error(`${label} program link failed: ` + gl.getProgramInfoLog(prog));
  }
  return prog;
}

/** Uniform locations shared by the node core + glow programs. */
interface NodeUniforms {
  viewport: WebGLUniformLocation | null;
  pan: WebGLUniformLocation | null;
  scale: WebGLUniformLocation | null;
  minPx: WebGLUniformLocation | null;
  halo: WebGLUniformLocation | null;
  time: WebGLUniformLocation | null;
  glow: WebGLUniformLocation | null;
}

export class WebGLGraphRenderer {
  private gl: WebGL2RenderingContext;
  private program: WebGLProgram;
  private glowProgram: WebGLProgram;
  private nodeU: NodeUniforms;
  private glowU: NodeUniforms;
  private vao: WebGLVertexArrayObject;
  private instBuf: WebGLBuffer;
  private instData = new Float32Array(0);
  private count = 0;

  private bgProgram: WebGLProgram;
  private bgVao: WebGLVertexArrayObject;
  private uBgViewport: WebGLUniformLocation | null;

  private lineProgram: WebGLProgram;
  private lineVao: WebGLVertexArrayObject;
  private lineBuf: WebGLBuffer;
  private lineCount = 0;
  private hlVao: WebGLVertexArrayObject;
  private hlBuf: WebGLBuffer;
  private hlCount = 0;
  private uLineViewport: WebGLUniformLocation | null;
  private uLinePan: WebGLUniformLocation | null;
  private uLineScale: WebGLUniformLocation | null;
  private uLineColor: WebGLUniformLocation | null;
  private uLineWidth: WebGLUniformLocation | null;

  constructor(private canvas: HTMLCanvasElement) {
    const gl = canvas.getContext("webgl2", {
      antialias: true,
      alpha: true,
      premultipliedAlpha: false,
    });
    if (!gl) throw new Error("WebGL2 is not available");
    this.gl = gl;

    // ---- Backdrop ----
    this.bgProgram = link(gl, BG_VERT, BG_FRAG, "background");
    this.uBgViewport = gl.getUniformLocation(this.bgProgram, "uViewport");
    const bgVao = gl.createVertexArray();
    if (!bgVao) throw new Error("createVertexArray (bg) failed");
    this.bgVao = bgVao;
    gl.bindVertexArray(bgVao);
    const bgQuad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, bgQuad);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
      gl.STATIC_DRAW,
    );
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);

    // ---- Nodes (core + glow share one VAO and one instance buffer) ----
    this.program = link(gl, VERT, FRAG, "node");
    this.glowProgram = link(gl, VERT, GLOW_FRAG, "glow");
    const uniformsOf = (p: WebGLProgram): NodeUniforms => ({
      viewport: gl.getUniformLocation(p, "uViewport"),
      pan: gl.getUniformLocation(p, "uPan"),
      scale: gl.getUniformLocation(p, "uScale"),
      minPx: gl.getUniformLocation(p, "uMinPx"),
      halo: gl.getUniformLocation(p, "uHalo"),
      time: gl.getUniformLocation(p, "uTime"),
      glow: gl.getUniformLocation(p, "uGlow"),
    });
    this.nodeU = uniformsOf(this.program);
    this.glowU = uniformsOf(this.glowProgram);

    const vao = gl.createVertexArray();
    if (!vao) throw new Error("createVertexArray failed");
    this.vao = vao;
    gl.bindVertexArray(vao);

    // Static unit quad (triangle strip): 4 corners in [-1,1].
    const quad = new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]);
    const quadBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
    gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    // Per-instance buffer: [x, y, r, cr, cg, cb].
    const instBuf = gl.createBuffer();
    if (!instBuf) throw new Error("createBuffer failed");
    this.instBuf = instBuf;
    const stride = FLOATS_PER_NODE * 4;
    gl.bindBuffer(gl.ARRAY_BUFFER, instBuf);
    gl.enableVertexAttribArray(1); // aPos
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, stride, 0);
    gl.vertexAttribDivisor(1, 1);
    gl.enableVertexAttribArray(2); // aRadius
    gl.vertexAttribPointer(2, 1, gl.FLOAT, false, stride, 8);
    gl.vertexAttribDivisor(2, 1);
    gl.enableVertexAttribArray(3); // aColor
    gl.vertexAttribPointer(3, 3, gl.FLOAT, false, stride, 12);
    gl.vertexAttribDivisor(3, 1);

    gl.bindVertexArray(null);

    // ---- Edge quads ----
    this.lineProgram = link(gl, LINE_VERT, LINE_FRAG, "line");
    this.uLineViewport = gl.getUniformLocation(this.lineProgram, "uViewport");
    this.uLinePan = gl.getUniformLocation(this.lineProgram, "uPan");
    this.uLineScale = gl.getUniformLocation(this.lineProgram, "uScale");
    this.uLineColor = gl.getUniformLocation(this.lineProgram, "uLineColor");
    this.uLineWidth = gl.getUniformLocation(this.lineProgram, "uWidthPx");

    // Quad corners for a segment: x runs 0→1 along it, y ±1 across it.
    const segQuad = new Float32Array([0, -1, 0, 1, 1, -1, 1, 1]);
    const segQuadBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, segQuadBuf);
    gl.bufferData(gl.ARRAY_BUFFER, segQuad, gl.STATIC_DRAW);

    const makeSegVao = (): [WebGLVertexArrayObject, WebGLBuffer] => {
      const v = gl.createVertexArray();
      const b = gl.createBuffer();
      if (!v || !b) throw new Error("createVertexArray/Buffer (seg) failed");
      gl.bindVertexArray(v);
      gl.bindBuffer(gl.ARRAY_BUFFER, segQuadBuf);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, b);
      gl.enableVertexAttribArray(1); // aSeg — one x0,y0,x1,y1 per instance
      gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 16, 0);
      gl.vertexAttribDivisor(1, 1);
      gl.bindVertexArray(null);
      return [v, b];
    };
    [this.lineVao, this.lineBuf] = makeSegVao();
    [this.hlVao, this.hlBuf] = makeSegVao();

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  }

  /** Match the drawing buffer to the CSS size × dpr. */
  resize(cssW: number, cssH: number, dpr: number): void {
    const w = Math.max(1, Math.round(cssW * dpr));
    const h = Math.max(1, Math.round(cssH * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.gl.viewport(0, 0, w, h);
  }

  /** Upload the node set (rebuilds the instance buffer). */
  setNodes(nodes: RenderNode[]): void {
    this.count = nodes.length;
    if (this.instData.length < nodes.length * FLOATS_PER_NODE) {
      this.instData = new Float32Array(nodes.length * FLOATS_PER_NODE);
    }
    const d = this.instData;
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      const o = i * FLOATS_PER_NODE;
      d[o] = n.x;
      d[o + 1] = n.y;
      d[o + 2] = n.r;
      d[o + 3] = n.color[0];
      d[o + 4] = n.color[1];
      d[o + 5] = n.color[2];
    }
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instBuf);
    gl.bufferData(gl.ARRAY_BUFFER, d.subarray(0, nodes.length * FLOATS_PER_NODE), gl.DYNAMIC_DRAW);
  }

  /** Upload edge segments as flat world coords [x0,y0,x1,y1,…] — four floats
   *  per link, consumed as one quad instance each. */
  setEdges(positions: Float32Array): void {
    this.lineCount = Math.floor(positions.length / 4);
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.lineBuf);
    gl.bufferData(gl.ARRAY_BUFFER, positions, gl.DYNAMIC_DRAW);
  }

  /** Upload the hover-highlight edges (bright lines from the hovered node),
   *  same flat [x0,y0,x1,y1,…] layout as `setEdges`. */
  setHighlightEdges(positions: Float32Array): void {
    this.hlCount = Math.floor(positions.length / 4);
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.hlBuf);
    gl.bufferData(gl.ARRAY_BUFFER, positions, gl.DYNAMIC_DRAW);
  }

  /**
   * Draw one frame with the given world→screen transform.
   * `minPx` floors a node's on-screen radius (device px), `time` drives the
   * per-node breathing, and `glow` scales the halos (turned down as the node
   * count rises so a dense vault doesn't bloom into a single white cloud).
   */
  draw(
    scale: number,
    panX: number,
    panY: number,
    minPx: number,
    time: number,
    glow: number,
    dpr: number,
  ): void {
    const gl = this.gl;
    const vw = this.canvas.width;
    const vh = this.canvas.height;

    // ---- 1. Backdrop ----
    gl.disable(gl.BLEND);
    gl.useProgram(this.bgProgram);
    gl.bindVertexArray(this.bgVao);
    gl.uniform2f(this.uBgViewport, vw, vh);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);
    gl.enable(gl.BLEND);

    const drawSegments = (
      vao: WebGLVertexArrayObject,
      instances: number,
      widthPx: number,
      r: number,
      g: number,
      b: number,
      a: number,
    ) => {
      if (instances === 0) return;
      gl.useProgram(this.lineProgram);
      gl.bindVertexArray(vao);
      gl.uniform2f(this.uLineViewport, vw, vh);
      gl.uniform1f(this.uLineScale, scale);
      gl.uniform2f(this.uLinePan, panX, panY);
      gl.uniform4f(this.uLineColor, r, g, b, a);
      gl.uniform1f(this.uLineWidth, widthPx);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, instances);
      gl.bindVertexArray(null);
    };

    // ---- 2. Edges ----
    // Resting links: a cool blue-steel thread. Feathered quads let this sit at a
    // real alpha — hairlines at this opacity used to accumulate into a flat
    // lavender wash over dense regions, so they had to be dialled down until
    // they nearly disappeared. The softness carries the density now.
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    drawSegments(this.lineVao, this.lineCount, 1.6 * dpr, 0.44, 0.56, 0.9, 0.3);

    // Hover rays go UNDER the nodes, not over them. Drawn last, they crossed the
    // hovered node itself — dozens of bright lines converging on top of the very
    // thing being pointed at, which blew out its centre and hid it. Beneath the
    // node layer they emerge from behind it instead, which is also what the
    // geometry actually is: a link starts at the node, not on it.
    drawSegments(this.hlVao, this.hlCount, 2.6 * dpr, 1.0, 0.86, 0.38, 0.95);

    if (this.count === 0) return;

    const bindNodes = (u: NodeUniforms, halo: number) => {
      gl.bindVertexArray(this.vao);
      gl.uniform2f(u.viewport, vw, vh);
      gl.uniform1f(u.scale, scale);
      gl.uniform2f(u.pan, panX, panY);
      gl.uniform1f(u.minPx, minPx);
      gl.uniform1f(u.halo, halo);
      gl.uniform1f(u.time, time);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.count);
      gl.bindVertexArray(null);
    };

    // ---- 3. Glow (additive) ----
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
    gl.useProgram(this.glowProgram);
    gl.uniform1f(this.glowU.glow, glow);
    bindNodes(this.glowU, HALO);

    // ---- 4. Cores ----
    // Last, so every edge — resting or highlighted — is occluded by the discs
    // it connects, and every halo is capped by its own sphere.
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(this.program);
    bindNodes(this.nodeU, 1.0);
  }

  /** The most recent GL error code (0 = none). Diagnostic only. */
  glError(): number {
    return this.gl.getError();
  }

  dispose(): void {
    const gl = this.gl;
    gl.deleteBuffer(this.instBuf);
    gl.deleteVertexArray(this.vao);
    gl.deleteProgram(this.program);
    gl.deleteProgram(this.glowProgram);
    gl.deleteVertexArray(this.bgVao);
    gl.deleteProgram(this.bgProgram);
    gl.deleteBuffer(this.lineBuf);
    gl.deleteVertexArray(this.lineVao);
    gl.deleteProgram(this.lineProgram);
    gl.deleteBuffer(this.hlBuf);
    gl.deleteVertexArray(this.hlVao);
  }
}

/** Fit a set of world-space points into a viewport (device px), returning the
 *  world→screen scale and pan that centers them with a margin. */
export function fitToViewport(
  nodes: RenderNode[],
  viewW: number,
  viewH: number,
  marginPx = 40,
): { scale: number; panX: number; panY: number } {
  if (nodes.length === 0) return { scale: 1, panX: viewW / 2, panY: viewH / 2 };
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of nodes) {
    if (n.x - n.r < minX) minX = n.x - n.r;
    if (n.y - n.r < minY) minY = n.y - n.r;
    if (n.x + n.r > maxX) maxX = n.x + n.r;
    if (n.y + n.r > maxY) maxY = n.y + n.r;
  }
  const w = Math.max(1, maxX - minX);
  const h = Math.max(1, maxY - minY);
  const scale = Math.min((viewW - marginPx * 2) / w, (viewH - marginPx * 2) / h);
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  return { scale, panX: viewW / 2 - cx * scale, panY: viewH / 2 - cy * scale };
}
