// One WebGL2 context shared by every live 3D mascot. It draws into a fixed offscreen canvas, one viewport per
// mascot, and each mascot's own 2D canvas copies its picture across, so any number of live faces cost one
// context. Programs compile the first time a character is drawn and are kept.
import { fragmentFor, VERTEX } from "./shaders";
import type { Look } from "./catalog";
import { nField } from "./navmark";

const SIZE = 256;

interface Program {
  prog: WebGLProgram;
  loc: Record<string, WebGLUniformLocation | null>;
}

const UNIFORMS = ["uRes", "uPhase", "uEnergy", "uGlow", "uSat", "uSettle", "uMode", "uTint", "uAA", "uSdf"];

export class SharedGl {
  readonly canvas: HTMLCanvasElement;
  private gl: WebGL2RenderingContext | null = null;
  private programs = new Map<string, Program | null>();
  private buffer: WebGLBuffer | null = null;
  private field: WebGLTexture | null = null;
  contexts = 0;

  constructor() {
    this.canvas = document.createElement("canvas");
    this.canvas.width = SIZE;
    this.canvas.height = SIZE;
    this.canvas.addEventListener("webglcontextlost", (e) => {
      e.preventDefault();
      this.gl = null;
      this.field = null;
      this.programs.clear();
    });
  }

  private context(): WebGL2RenderingContext | null {
    if (this.gl && !this.gl.isContextLost()) return this.gl;
    const gl = this.canvas.getContext("webgl2", { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false, powerPreference: "low-power" });
    if (!gl) return null;
    this.gl = gl;
    this.contexts++;
    this.buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.disable(gl.BLEND);
    return gl;
  }

  private program(gl: WebGL2RenderingContext, id: string): Program | null {
    if (this.programs.has(id)) return this.programs.get(id) ?? null;
    let made: Program | null = null;
    try {
      const compile = (type: number, src: string) => {
        const s = gl.createShader(type)!;
        gl.shaderSource(s, src);
        gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? "shader failed");
        return s;
      };
      const prog = gl.createProgram()!;
      gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERTEX));
      gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, fragmentFor(id)));
      gl.bindAttribLocation(prog, 0, "aPos");
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) ?? "link failed");
      const loc: Record<string, WebGLUniformLocation | null> = {};
      for (const u of UNIFORMS) loc[u] = gl.getUniformLocation(prog, u);
      made = { prog, loc };
    } catch (err) {
      console.warn(`Helper Desk: the ${id} mascot shader did not compile`, err);
    }
    this.programs.set(id, made);
    return made;
  }

  /** The NavAIgate N's distance field as a texture: signed distance, its gradient and the ribbon coordinate, filtered linearly. */
  private fieldTexture(gl: WebGL2RenderingContext): WebGLTexture | null {
    if (this.field) return this.field;
    const f = nField();
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, f.size, f.size, 0, gl.RGBA, gl.FLOAT, f.data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.field = tex;
    return tex;
  }

  /** True when a context exists or can be made. */
  available(): boolean {
    return this.context() !== null;
  }

  /** Draws one mascot into the shared canvas at `px` pixels square. Returns false when WebGL is unavailable. */
  draw(id: string, look: Look, tint: readonly [number, number, number], px: number, aa = 2): boolean {
    const gl = this.context();
    if (!gl) return false;
    const p = this.program(gl, id);
    if (!p) return false;
    const size = Math.min(SIZE, Math.max(8, Math.round(px)));
    gl.viewport(0, 0, size, size);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(0, 0, size, size);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(p.prog);
    gl.uniform2f(p.loc.uRes, size, size);
    gl.uniform1f(p.loc.uPhase, look.phase);
    gl.uniform1f(p.loc.uEnergy, look.energy);
    gl.uniform1f(p.loc.uGlow, look.glow);
    gl.uniform1f(p.loc.uSat, look.sat);
    gl.uniform1f(p.loc.uSettle, look.settle);
    gl.uniform1f(p.loc.uMode, look.mode);
    if (p.loc.uSdf) {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.fieldTexture(gl));
      gl.uniform1i(p.loc.uSdf, 0);
    }
    gl.uniform3f(p.loc.uTint, tint[0], tint[1], tint[2]);
    gl.uniform1i(p.loc.uAA, aa);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    return true;
  }

  /** Copies the last drawn picture, `px` pixels square, onto a 2D canvas. */
  blit(target: CanvasRenderingContext2D, px: number) {
    const size = Math.min(SIZE, Math.max(8, Math.round(px)));
    target.clearRect(0, 0, size, size);
    target.drawImage(this.canvas, 0, SIZE - size, size, size, 0, 0, size, size);
  }

  /** Compile errors show up as a missing program; this lists the ids that failed. */
  failed(): string[] {
    return [...this.programs].filter(([, v]) => v === null).map(([k]) => k);
  }
}

let shared: SharedGl | null = null;

export function sharedGl(): SharedGl {
  shared ??= new SharedGl();
  return shared;
}

export const SHARED_SIZE = SIZE;
