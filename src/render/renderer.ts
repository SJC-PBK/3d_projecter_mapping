// WebGL2 렌더 루프. 프로젝트 상태를 받아 면마다 워프해서 그린다.
// 정규화 좌표 → 픽셀 변환은 여기(렌더러)에서만 한다.

import { affineFromTriangle, IDENTITY, unitSquareToQuad, type Mat3 } from '../core/homography';
import { subdivideMesh, type Mesh } from '../core/mesh';
import { EDGE_LINE_DEFAULT, GRID_BORDER_DEFAULT, GRID_CELLS_X_DEFAULT, GRID_CELLS_Y_DEFAULT, GRID_LINE_DEFAULT, OUTPUT_PATTERNS, type Project, type Source, type Surface } from '../core/project';
import { MAX_MASK_POINTS, WARP_FS, WARP_VS } from './shaders/warp';
import { SourceManager } from './sources/manager';

const MESH_RES = 32;

interface Geometry {
  vao: WebGLVertexArrayObject;
  buffers: WebGLBuffer[];
  count: number;
}

interface MeshCache extends Geometry {
  mesh: Mesh;
}

type Uniforms = Record<
  'uH' | 'uMode' | 'uUVMode' | 'uUV' | 'uTex' | 'uColor' | 'uTime' | 'uSpeed' | 'uOpacity' | 'uMaskCount' | 'uMask' | 'uFeather' | 'uOutRes' | 'uLine' | 'uBorder' | 'uCells',
  WebGLUniformLocation | null
>;

export interface RendererOptions {
  /** 1초마다 측정한 fps */
  onFps?: (fps: number) => void;
  /** 자동재생이 막힌 영상이 있을 때 (터치 필요) */
  onNeedsGesture?: () => void;
  onSourceError?: (sourceId: string, message: string) => void;
  /** 화면 비율 최대 배율 (기본 2) */
  maxPixelRatio?: number;
}

export class Renderer {
  readonly gl: WebGL2RenderingContext;
  private program!: WebGLProgram;
  private u!: Uniforms;
  private quad!: Geometry;
  private tri!: Geometry;
  private meshes = new Map<string, MeshCache>();
  private sources!: SourceManager;
  private usedKey = '';
  private project: Project | null = null;
  private raf = 0;
  private frames = 0;
  private fpsStart = 0;
  private startTime = performance.now();
  private lost = false;

  readonly canvas: HTMLCanvasElement;
  private opts: RendererOptions;

  constructor(canvas: HTMLCanvasElement, opts: RendererOptions = {}) {
    this.canvas = canvas;
    this.opts = opts;
    const gl = canvas.getContext('webgl2', { antialias: true, alpha: false, premultipliedAlpha: true, powerPreference: 'high-performance' });
    if (!gl) throw new Error('이 브라우저는 WebGL2 를 지원하지 않습니다');
    this.gl = gl;
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.lost = true;
    });
    canvas.addEventListener('webglcontextrestored', () => {
      this.lost = false;
      this.meshes.clear();
      this.init();
    });
    this.init();
  }

  private init(): void {
    const gl = this.gl;
    this.program = link(gl, WARP_VS, WARP_FS);
    const names = ['uH', 'uMode', 'uUVMode', 'uUV', 'uTex', 'uColor', 'uTime', 'uSpeed', 'uOpacity', 'uMaskCount', 'uMask', 'uFeather', 'uOutRes', 'uLine', 'uBorder', 'uCells'] as const;
    this.u = Object.fromEntries(names.map((n) => [n, gl.getUniformLocation(this.program, n)])) as Uniforms;
    const square = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]);
    this.quad = this.geometry(square, square, new Uint16Array([0, 1, 2, 0, 2, 3]));
    const tri = new Float32Array([0, 0, 1, 0, 0, 1]);
    this.tri = this.geometry(tri, tri, new Uint16Array([0, 1, 2]));
    this.sources?.dispose();
    this.sources = new SourceManager(gl);
    this.sources.onNeedsGesture = () => this.opts.onNeedsGesture?.();
    this.sources.onError = (id, msg) => this.opts.onSourceError?.(id, msg);
    this.usedKey = '';
    if (this.project) this.syncSources(this.project);
  }

  setProject(p: Project): void {
    const prevSources = this.project?.sources;
    this.project = p;
    this.syncSources(p, p.sources !== prevSources);
    // 없어진 메시 면의 버퍼 정리
    for (const id of this.meshes.keys()) {
      if (!p.surfaces.some((s) => s.id === id && s.kind === 'mesh')) this.dropMesh(id);
    }
  }

  /** 면이 쓰는 소스만 불러온다 — 목록의 영상을 전부 열면 기기가 동시에 20개를 재생하게 된다 */
  private syncSources(p: Project, changed = true): void {
    const used = new Set(p.surfaces.map((s) => s.sourceId).filter((id): id is string => id !== null));
    const key = [...used].sort().join('\n');
    if (!changed && key === this.usedKey) return;
    this.usedKey = key;
    this.sources.sync(p.sources.filter((s) => used.has(s.id)));
  }

  /** 사용자 터치 직후 호출: 막힌 영상 재생 */
  resumeVideos(): void {
    this.sources.resumeVideos();
  }

  start(): void {
    if (this.raf) return;
    const loop = (now: number) => {
      this.raf = requestAnimationFrame(loop);
      this.render(now);
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop(): void {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  /** 캔버스 표시 크기에 맞게 그리기 버퍼 크기를 맞춘다 */
  private resize(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, this.opts.maxPixelRatio ?? 2);
    const w = Math.max(1, Math.round(this.canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(this.canvas.clientHeight * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }

  render(now = performance.now()): void {
    if (this.lost) return;
    const gl = this.gl;
    this.resize();
    this.sources.update();
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    const p = this.project;
    if (p) {
      gl.useProgram(this.program);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.uniform1f(this.u.uTime, (now - this.startTime) / 1000);
      gl.uniform1i(this.u.uTex, 0);
      gl.activeTexture(gl.TEXTURE0);
      gl.uniform2f(this.u.uOutRes, p.output.width, p.output.height);
      if (p.output.pattern) this.drawPattern(p.output.pattern);
      const byId = new Map(p.sources.map((s) => [s.id, s]));
      for (const s of p.surfaces) {
        if (s.visible && s.opacity > 0) this.drawSurface(s, s.sourceId ? byId.get(s.sourceId) : undefined, p);
      }
    }
    this.frames++;
    if (now - this.fpsStart >= 1000) {
      this.opts.onFps?.(Math.round((this.frames * 1000) / (now - this.fpsStart)));
      this.frames = 0;
      this.fpsStart = now;
    }
  }

  /** 처음 세팅용 전체 화면 격자 (면들은 이 위에 그린다) */
  private drawPattern(id: string): void {
    const gl = this.gl;
    const color = OUTPUT_PATTERNS.find((x) => x.id === id)?.color ?? '#1f4fff';
    gl.uniformMatrix3fv(this.u.uH, true, IDENTITY); // 단위 정사각형 = 화면 전체
    gl.uniform1i(this.u.uUVMode, 0);
    gl.uniform2fv(this.u.uUV, new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]));
    gl.uniform1f(this.u.uOpacity, 1);
    gl.uniform1i(this.u.uMaskCount, 0);
    gl.uniform1i(this.u.uMode, 6);
    gl.uniform3fv(this.u.uColor, hexToRgb(color));
    gl.bindVertexArray(this.quad.vao);
    gl.drawElements(gl.TRIANGLES, this.quad.count, gl.UNSIGNED_SHORT, 0);
    gl.bindVertexArray(null);
  }

  private drawSurface(s: Surface, src: Source | undefined, p: Project): void {
    const gl = this.gl;
    let h: Mat3 | null;
    let geo: Geometry;
    if (s.kind === 'quad') {
      h = unitSquareToQuad(s.points);
      geo = this.quad;
    } else if (s.kind === 'triangle') {
      h = affineFromTriangle(s.points);
      geo = this.tri;
    } else {
      if (!s.mesh) return;
      h = IDENTITY;
      geo = this.meshGeometry(s.id, s.mesh);
    }
    if (!h) return; // 퇴화한 사각형

    gl.uniformMatrix3fv(this.u.uH, true, h);
    gl.uniform1i(this.u.uUVMode, s.kind === 'triangle' ? 1 : 0);
    const uv = s.uv.length >= 3 ? s.uv : [[0, 0], [1, 0], [1, 1], [0, 1]];
    const uvFlat = new Float32Array(8);
    uv.slice(0, 4).forEach((q, i) => uvFlat.set(q, i * 2));
    gl.uniform2fv(this.u.uUV, uvFlat);
    gl.uniform1f(this.u.uOpacity, s.opacity);

    // 소스 종류 → 셰이더 모드
    let mode = 5;
    let speed = 1;
    let color = '#ffffff';
    if (src?.type === 'image' || src?.type === 'video') {
      const tex = this.sources.texture(src.id);
      if (tex) {
        gl.bindTexture(gl.TEXTURE_2D, tex);
        mode = 0;
      }
    } else if (src?.type === 'color') {
      mode = 1;
      color = src.value;
    } else if (src?.type === 'shader') {
      mode = { scanlines: 2, noise: 3, flash: 4, grid: 7, edge: 8 }[src.preset];
      speed = src.params.speed;
      color = src.params.color;
      if (src.preset === 'grid') {
        // 두께는 출력 px → 이 캔버스 px (편집기 미리보기는 출력보다 작다)
        const k = this.canvas.width / p.output.width;
        gl.uniform1f(this.u.uLine, (src.params.lineWidth ?? GRID_LINE_DEFAULT) * k);
        gl.uniform1f(this.u.uBorder, (src.params.borderWidth ?? GRID_BORDER_DEFAULT) * k);
        gl.uniform2f(this.u.uCells, src.params.cellsX ?? GRID_CELLS_X_DEFAULT, src.params.cellsY ?? GRID_CELLS_Y_DEFAULT);
      } else if (src.preset === 'edge') {
        gl.uniform1f(this.u.uLine, (src.params.lineWidth ?? EDGE_LINE_DEFAULT) * (this.canvas.width / p.output.width));
      }
    }
    gl.uniform1i(this.u.uMode, mode);
    gl.uniform1f(this.u.uSpeed, speed);
    gl.uniform3fv(this.u.uColor, hexToRgb(color));

    // 마스크: 정규화 좌표 → 캔버스 픽셀 (gl_FragCoord 는 아래가 원점)
    const poly = s.mask.polygon;
    if (poly && poly.length >= 3) {
      const W = this.canvas.width;
      const H = this.canvas.height;
      const n = Math.min(poly.length, MAX_MASK_POINTS);
      const flat = new Float32Array(MAX_MASK_POINTS * 2);
      for (let i = 0; i < n; i++) flat.set([poly[i]![0] * W, (1 - poly[i]![1]) * H], i * 2);
      gl.uniform1i(this.u.uMaskCount, n);
      gl.uniform2fv(this.u.uMask, flat);
      gl.uniform1f(this.u.uFeather, (s.mask.feather * W) / p.output.width);
    } else {
      gl.uniform1i(this.u.uMaskCount, 0);
    }

    gl.bindVertexArray(geo.vao);
    gl.drawElements(gl.TRIANGLES, geo.count, gl.UNSIGNED_SHORT, 0);
    gl.bindVertexArray(null);
  }

  private meshGeometry(id: string, mesh: Mesh): Geometry {
    const cached = this.meshes.get(id);
    if (cached && cached.mesh === mesh) return cached;
    if (cached) this.dropMesh(id);
    const g = subdivideMesh(mesh, MESH_RES);
    const geo = { ...this.geometry(g.positions, g.params, g.indices), mesh };
    this.meshes.set(id, geo);
    return geo;
  }

  private dropMesh(id: string): void {
    const m = this.meshes.get(id);
    if (!m) return;
    this.meshes.delete(id);
    this.gl.deleteVertexArray(m.vao);
    for (const b of m.buffers) this.gl.deleteBuffer(b);
  }

  private geometry(xy: Float32Array, st: Float32Array, idx: Uint16Array): Geometry {
    const gl = this.gl;
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    const buffers: WebGLBuffer[] = [];
    for (const [name, data] of [['aXY', xy], ['aST', st]] as const) {
      const loc = gl.getAttribLocation(this.program, name);
      const buf = gl.createBuffer()!;
      buffers.push(buf);
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    }
    const ib = gl.createBuffer()!;
    buffers.push(ib);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    return { vao, buffers, count: idx.length };
  }

  dispose(): void {
    this.stop();
    this.sources.dispose();
    for (const id of [...this.meshes.keys()]) this.dropMesh(id);
  }
}

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type)!;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(`셰이더 컴파일 실패: ${gl.getShaderInfoLog(sh)}`);
  return sh;
}

function link(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const p = gl.createProgram()!;
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`셰이더 연결 실패: ${gl.getProgramInfoLog(p)}`);
  return p;
}

const rgbCache = new Map<string, Float32Array>();
function hexToRgb(hex: string): Float32Array {
  let v = rgbCache.get(hex);
  if (!v) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex);
    const n = m ? parseInt(m[1]!, 16) : 0xffffff;
    v = new Float32Array([((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]);
    rgbCache.set(hex, v);
  }
  return v;
}
