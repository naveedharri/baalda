// Zero-dependency WebGL2 renderer for the global graph. Draws every node as a
// GPU-shaded disc via instanced rendering, so the whole vault stays at 60fps
// regardless of size (the 2D-canvas path repaints each node on the CPU and only
// scales to a few hundred). Local-first: raw WebGL2, no libraries.
//
// This first cut renders nodes only and auto-fits the node cloud to the
// viewport. Edges, pan/zoom, hover, and sphere shading are layered on next.

/** A node to draw, in world (simulation) coordinates. */
export interface RenderNode {
  x: number;
  y: number;
  /** Radius in world units. */
  r: number;
  /** Fill color, 0..1 per channel. */
  color: [number, number, number];
}

const VERT = `#version 300 es
layout(location=0) in vec2 aCorner;   // unit-quad corner in [-1,1]
layout(location=1) in vec2 aPos;      // per-instance world position
layout(location=2) in float aRadius;  // per-instance world radius
layout(location=3) in vec3 aColor;    // per-instance fill

uniform vec2 uViewport;  // drawing-buffer size in device px
uniform vec2 uPan;       // world origin -> screen px (top-left origin)
uniform float uScale;    // world units -> screen px
uniform float uMinPx;    // floor on a node's on-screen radius (device px)

out vec2 vCorner;
out vec3 vColor;

void main() {
  // Keep every node at least uMinPx wide on screen so tiny-degree nodes don't
  // vanish when the whole vault is fit into the viewport.
  float r = max(aRadius, uMinPx / uScale);
  vec2 world = aPos + aCorner * r;
  vec2 screen = world * uScale + uPan;          // px, origin top-left
  vec2 clip = vec2(
    screen.x / (uViewport.x * 0.5) - 1.0,
    1.0 - screen.y / (uViewport.y * 0.5)
  );
  gl_Position = vec4(clip, 0.0, 1.0);
  vCorner = aCorner;
  vColor = aColor;
}`;

const FRAG = `#version 300 es
precision mediump float;
in vec2 vCorner;
in vec3 vColor;
out vec4 fragColor;

void main() {
  // Solid disc: inside the rim it's opaque, outside is dropped. A small fixed
  // feather softens the edge without collapsing sub-pixel discs to zero alpha.
  float d = length(vCorner);
  if (d > 1.0) discard;
  float alpha = 1.0 - smoothstep(0.9, 1.0, d);
  fragColor = vec4(vColor, alpha);
}`;

// Edges: one shared program drawing gl.LINES. Each vertex is a world position;
// the same uScale/uPan/uViewport as the nodes, so edges line up with them.
const LINE_VERT = `#version 300 es
layout(location=0) in vec2 aPos;
uniform vec2 uViewport;
uniform vec2 uPan;
uniform float uScale;
void main() {
  vec2 screen = aPos * uScale + uPan;
  vec2 clip = vec2(
    screen.x / (uViewport.x * 0.5) - 1.0,
    1.0 - screen.y / (uViewport.y * 0.5)
  );
  gl_Position = vec4(clip, 0.0, 1.0);
}`;

const LINE_FRAG = `#version 300 es
precision mediump float;
uniform vec4 uLineColor;
out vec4 fragColor;
void main() { fragColor = uLineColor; }`;

const FLOATS_PER_NODE = 6; // x, y, r, cr, cg, cb

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

export class WebGLGraphRenderer {
  private gl: WebGL2RenderingContext;
  private program: WebGLProgram;
  private vao: WebGLVertexArrayObject;
  private instBuf: WebGLBuffer;
  private instData = new Float32Array(0);
  private count = 0;
  private uViewport: WebGLUniformLocation | null;
  private uPan: WebGLUniformLocation | null;
  private uScale: WebGLUniformLocation | null;
  private uMinPx: WebGLUniformLocation | null;
  private lineProgram: WebGLProgram;
  private lineVao: WebGLVertexArrayObject;
  private lineBuf: WebGLBuffer;
  private lineVertCount = 0;
  private lineData = new Float32Array(0);
  private hlVao: WebGLVertexArrayObject;
  private hlBuf: WebGLBuffer;
  private hlVertCount = 0;
  private uLineViewport: WebGLUniformLocation | null;
  private uLinePan: WebGLUniformLocation | null;
  private uLineScale: WebGLUniformLocation | null;
  private uLineColor: WebGLUniformLocation | null;

  constructor(private canvas: HTMLCanvasElement) {
    const gl = canvas.getContext("webgl2", { antialias: true, alpha: true, premultipliedAlpha: false });
    if (!gl) throw new Error("WebGL2 is not available");
    this.gl = gl;

    const prog = gl.createProgram();
    if (!prog) throw new Error("createProgram failed");
    const vs = compile(gl, gl.VERTEX_SHADER, VERT);
    const fs = compile(gl, gl.FRAGMENT_SHADER, FRAG);
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error("program link failed: " + gl.getProgramInfoLog(prog));
    }
    this.program = prog;
    this.uViewport = gl.getUniformLocation(prog, "uViewport");
    this.uPan = gl.getUniformLocation(prog, "uPan");
    this.uScale = gl.getUniformLocation(prog, "uScale");
    this.uMinPx = gl.getUniformLocation(prog, "uMinPx");

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

    // ---- Edge line program ----
    const lp = gl.createProgram();
    if (!lp) throw new Error("createProgram (line) failed");
    gl.attachShader(lp, compile(gl, gl.VERTEX_SHADER, LINE_VERT));
    gl.attachShader(lp, compile(gl, gl.FRAGMENT_SHADER, LINE_FRAG));
    gl.linkProgram(lp);
    if (!gl.getProgramParameter(lp, gl.LINK_STATUS)) {
      throw new Error("line program link failed: " + gl.getProgramInfoLog(lp));
    }
    this.lineProgram = lp;
    this.uLineViewport = gl.getUniformLocation(lp, "uViewport");
    this.uLinePan = gl.getUniformLocation(lp, "uPan");
    this.uLineScale = gl.getUniformLocation(lp, "uScale");
    this.uLineColor = gl.getUniformLocation(lp, "uLineColor");

    const lineVao = gl.createVertexArray();
    if (!lineVao) throw new Error("createVertexArray (line) failed");
    this.lineVao = lineVao;
    gl.bindVertexArray(lineVao);
    const lineBuf = gl.createBuffer();
    if (!lineBuf) throw new Error("createBuffer (line) failed");
    this.lineBuf = lineBuf;
    gl.bindBuffer(gl.ARRAY_BUFFER, lineBuf);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);

    // Highlight-edge VAO/buffer (hover): same line program, its own buffer.
    const hlVao = gl.createVertexArray();
    if (!hlVao) throw new Error("createVertexArray (hl) failed");
    this.hlVao = hlVao;
    gl.bindVertexArray(hlVao);
    const hlBuf = gl.createBuffer();
    if (!hlBuf) throw new Error("createBuffer (hl) failed");
    this.hlBuf = hlBuf;
    gl.bindBuffer(gl.ARRAY_BUFFER, hlBuf);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);

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

  /** Upload edge line vertices as flat world coords [x0,y0,x1,y1,…] — two
   *  vertices per edge (a gl.LINES list). */
  setEdges(positions: Float32Array): void {
    this.lineVertCount = positions.length / 2;
    if (this.lineData.length < positions.length) this.lineData = positions;
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.lineBuf);
    gl.bufferData(gl.ARRAY_BUFFER, positions, gl.DYNAMIC_DRAW);
  }

  /** Upload the hover-highlight edges (bright lines from the hovered node),
   *  same flat [x0,y0,x1,y1,…] layout as `setEdges`. */
  setHighlightEdges(positions: Float32Array): void {
    this.hlVertCount = positions.length / 2;
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.hlBuf);
    gl.bufferData(gl.ARRAY_BUFFER, positions, gl.DYNAMIC_DRAW);
  }

  /** Draw edges then nodes with the given world→screen transform. `minPx` is
   *  the floor on each node's on-screen radius, in device px. */
  draw(scale: number, panX: number, panY: number, minPx: number): void {
    const gl = this.gl;
    gl.clearColor(0.04, 0.04, 0.07, 1); // near-black, matching the graph backdrop
    gl.clear(gl.COLOR_BUFFER_BIT);

    // Edges first, under the nodes (faint, additive-ish via low alpha).
    if (this.lineVertCount > 0) {
      gl.useProgram(this.lineProgram);
      gl.bindVertexArray(this.lineVao);
      gl.uniform2f(this.uLineViewport, this.canvas.width, this.canvas.height);
      gl.uniform1f(this.uLineScale, scale);
      gl.uniform2f(this.uLinePan, panX, panY);
      gl.uniform4f(this.uLineColor, 0.62, 0.68, 0.9, 0.35);
      gl.drawArrays(gl.LINES, 0, this.lineVertCount);
      gl.bindVertexArray(null);
    }

    // Nodes on top.
    if (this.count > 0) {
      gl.useProgram(this.program);
      gl.bindVertexArray(this.vao);
      gl.uniform2f(this.uViewport, this.canvas.width, this.canvas.height);
      gl.uniform1f(this.uScale, scale);
      gl.uniform2f(this.uPan, panX, panY);
      gl.uniform1f(this.uMinPx, minPx);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.count);
      gl.bindVertexArray(null);
    }

    // Hover highlight edges — bright, drawn last so they sit on top of the
    // dimmed cloud and read as rays from the hovered node to its neighbors.
    if (this.hlVertCount > 0) {
      gl.useProgram(this.lineProgram);
      gl.bindVertexArray(this.hlVao);
      gl.uniform2f(this.uLineViewport, this.canvas.width, this.canvas.height);
      gl.uniform1f(this.uLineScale, scale);
      gl.uniform2f(this.uLinePan, panX, panY);
      gl.uniform4f(this.uLineColor, 1.0, 0.92, 0.5, 0.95);
      gl.drawArrays(gl.LINES, 0, this.hlVertCount);
      gl.bindVertexArray(null);
    }
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
