// 편집 무대: 렌더 화면 위에 면 외곽선·조절점을 그리고, 마우스·터치로 점과 면을 옮긴다.
// 편집기(PC)와 리모컨(폰)이 같이 쓴다.

import { centroid, distToSegment, pointInPolygon, surfaceOutline, translate } from '../core/geometry';
import { BOX_HANDLES, boxMap, boxOf, circleBox, coincident, dragBox, handlePos, meshLine, pointsInRect, type Box, type BoxHandle } from '../core/group';
import { isConvexQuad, type Vec2 } from '../core/homography';
import { editablePoints, withEditablePoints, type Project, type Surface } from '../core/project';
import type { Store } from '../core/store';
import { Renderer, type RendererOptions } from '../render/renderer';

export interface Selection {
  surfaceId: string | null;
  /** 선택한 조절점 번호 (mask=true 면 마스크 점 번호) */
  point: number | null;
  /** 마스크 편집 중 */
  mask: boolean;
  /** 여러 점 선택 (2개 이상이면 함께 움직인다) */
  multi: number[];
}

export interface StageOptions {
  store: Store;
  /** 실제 렌더링 화면을 깔지 (false 면 외곽선만 — 폰에서 가볍게) */
  withRenderer: boolean;
  rendererOptions?: RendererOptions;
  /** 조절점 판정 반경 (CSS px) */
  handleRadius: number;
  /**
   * 터치패드 방식: 점을 고른 뒤 빈 곳을 끌면 그 점이 손가락 움직임만큼 따라온다.
   * 손가락이 점을 가리지 않는다 (폰 리모컨용).
   */
  trackpad: boolean;
  onSelectionChange?: (sel: Selection) => void;
}

interface Drag {
  /** point: 점(겹친 점·여러 점 포함) 이동, surface: 면 이동, box: 크기 조절 상자, band: 사각형으로 점 고르기 */
  kind: 'point' | 'surface' | 'box' | 'band';
  surfaceId: string;
  index: number;
  /** point: 함께 움직일 점 번호들 */
  indices?: number[];
  /** box: 잡은 손잡이·시작 상자·대상 점(null = 면 전체) */
  handle?: BoxHandle;
  startBox?: Box;
  targets?: number[] | null;
  /** band: 끌고 있는 사각형 (정규화 좌표) */
  bandEnd?: Vec2;
  startPointer: Vec2;
  startHandles: Vec2[];
  /** 면 조절점 (마스크 모드에서도 면 전체 이동에 쓴다) */
  startPoints: Vec2[];
  startMask: Vec2[] | null;
  moved: boolean;
  /** 아직 이동이 시작되지 않은 터치 (탭인지 드래그인지 모름) */
  pendingTap?: { x: number; y: number };
}

const ACCENT = '#ffb000';
const MASK = '#ff4fd8';
const FILLS = ['#4f8cff', '#35c27a', '#ff7a45', '#b26bff', '#00c2d1', '#ffd23f', '#ff5c8a', '#8bd450'];

export class Stage {
  readonly root: HTMLDivElement;
  readonly view: HTMLDivElement;
  readonly overlay: HTMLCanvasElement;
  private readonly bg: HTMLDivElement;
  readonly renderer: Renderer | null = null;
  readonly sel: Selection = { surfaceId: null, point: null, mask: false, multi: [] };
  showHandles = true;
  /** 크기 조절 상자 표시 (상하좌우 변·모서리·가운데 손잡이) */
  boxMode = false;
  /** 여러 점 선택 모드 (태블릿: 톡 = 고르기/빼기, 빈 곳 끌기 = 사각형으로 고르기). PC 는 Shift 로도 된다 */
  pickMode = false;
  /** 손가락·마우스 이동 배율 (정밀 모드 0.25) */
  precision = 1;
  zoom = 1;
  center: Vec2 = [0.5, 0.5];
  /** true 면 출력 비율을 무시하고 컨테이너를 꽉 채운다 (전체화면 투사) */
  fill = false;
  private ctx: CanvasRenderingContext2D;
  private drag: Drag | null = null;
  /** 터치패드 방식에서 아직 움직이지 않은 탭 위치 */
  private pendingTapAt: { x: number; y: number; n: Vec2 } | null = null;
  private drawQueued = false;
  private lastNudge = 0;
  /** 출력 영역(view) 크기와, 무대 안에서의 위치 (조절점 층은 무대 전체를 덮는다) */
  private vw = 1;
  private vh = 1;
  private ox = 0;
  private oy = 0;
  private cw = 1;
  private ch = 1;

  private opts: StageOptions;

  constructor(container: HTMLElement, opts: StageOptions) {
    this.opts = opts;
    this.root = document.createElement('div');
    this.root.className = 'stage';
    this.view = document.createElement('div');
    this.view.className = 'stage-view';
    this.root.append(this.view);
    // 출력 영역의 검은 바탕. 확대할 때 렌더 화면과 함께 커져서, 확대해도 '출력 안'과 '밖(빗금)'이 맞게 보인다
    this.bg = document.createElement('div');
    this.bg.className = 'stage-bg';
    this.view.append(this.bg);
    if (opts.withRenderer) {
      const gl = document.createElement('canvas');
      gl.className = 'stage-gl';
      this.view.append(gl);
      this.renderer = new Renderer(gl, opts.rendererOptions);
      this.renderer.setProject(opts.store.project);
      this.renderer.start();
    }
    this.overlay = document.createElement('canvas');
    this.overlay.className = 'stage-overlay';
    // 조절점 층은 출력 영역 밖(여백)까지 덮는다 — 화면 밖으로 나간 면·점도 보이고 잡을 수 있게
    this.root.append(this.overlay);
    container.append(this.root);
    this.ctx = this.overlay.getContext('2d')!;

    opts.store.subscribe((p) => {
      this.renderer?.setProject(p);
      const s = this.surface;
      if (this.sel.surfaceId && !s) this.select(null);
      else if (s) {
        const n = this.handlesOf(s).length;
        // 격자 크기를 줄이는 등으로 점이 줄면 범위를 벗어난 선택은 정리한다
        if (this.sel.multi.some((i) => i >= n)) this.sel.multi = this.sel.multi.filter((i) => i < n);
        if (this.sel.point !== null && this.sel.point >= n) this.select(s.id, null);
      }
      this.requestDraw();
    });
    new ResizeObserver(() => this.layout()).observe(this.root);
    // 화면 비율 때문에 생기는 위아래(좌우) 여백에서도 끌 수 있게 무대 전체에서 받는다
    this.root.addEventListener('pointerdown', (e) => this.onDown(e));
    this.root.addEventListener('pointermove', (e) => this.onMove(e));
    this.root.addEventListener('pointerup', (e) => this.onUp(e));
    this.root.addEventListener('pointercancel', (e) => this.onUp(e));
    this.root.addEventListener('dblclick', (e) => this.onDoubleClick(e));
    this.layout();
  }

  get project(): Project {
    return this.opts.store.project;
  }

  get surface(): Surface | null {
    return this.project.surfaces.find((s) => s.id === this.sel.surfaceId) ?? null;
  }

  // ---------- 선택 ----------

  select(surfaceId: string | null, point: number | null = null, mask = this.sel.mask): void {
    const changed = surfaceId !== this.sel.surfaceId;
    this.sel.surfaceId = surfaceId;
    this.sel.point = point;
    this.sel.mask = surfaceId !== null && !changed ? mask : false;
    this.sel.multi = [];
    // 확대 중에 다른 점을 고르면 그 점이 보이도록 화면을 옮긴다
    const p = point !== null && this.zoom > 1 ? this.surface && this.handlesOf(this.surface)[point] : undefined;
    if (p) this.setZoom(this.zoom, [p[0], p[1]]);
    this.opts.onSelectionChange?.(this.sel);
    this.requestDraw();
  }

  setMaskMode(on: boolean): void {
    this.sel.mask = on && this.sel.surfaceId !== null;
    this.sel.point = null;
    this.sel.multi = [];
    this.opts.onSelectionChange?.(this.sel);
    this.requestDraw();
  }

  /** 현재 모드에서 움직일 수 있는 점 목록 */
  handlesOf(s: Surface): Vec2[] {
    return this.sel.mask ? (s.mask.polygon ?? []) : editablePoints(s);
  }

  private handlesPatch(s: Surface, pts: Vec2[]): Partial<Surface> {
    return this.sel.mask ? { mask: { ...s.mask, polygon: pts } } : withEditablePoints(s, pts);
  }

  /** 다음/이전 조절점 선택 */
  cyclePoint(dir: 1 | -1): void {
    const s = this.surface;
    if (!s) {
      const first = this.project.surfaces.find((x) => x.visible);
      if (first) this.select(first.id, 0);
      return;
    }
    const n = this.handlesOf(s).length;
    if (!n) return;
    const cur = this.sel.point ?? (dir > 0 ? -1 : 0);
    this.select(s.id, (cur + dir + n) % n);
  }

  /** 다음/이전 면 선택 */
  cycleSurface(dir: 1 | -1): void {
    const list = this.project.surfaces;
    if (!list.length) return;
    const i = list.findIndex((s) => s.id === this.sel.surfaceId);
    const next = list[(i + dir + list.length) % list.length]!;
    this.select(next.id, null);
  }

  // ---------- 여러 점 ----------

  private notify(): void {
    this.opts.onSelectionChange?.(this.sel);
    this.requestDraw();
  }

  /** 점 하나를 여러 점 선택에 넣거나 뺀다 */
  toggleMulti(i: number): void {
    const s = this.surface;
    if (!s) return;
    // 지금 고른 점 하나가 있으면 그것부터 넣는다 (한 점 고른 뒤 Shift+클릭으로 늘리기)
    const set = new Set(this.sel.multi.length ? this.sel.multi : this.sel.point !== null ? [this.sel.point] : []);
    const group = coincident(this.handlesOf(s), i);
    if (set.has(i)) group.forEach((k) => set.delete(k));
    else group.forEach((k) => set.add(k));
    this.sel.multi = [...set].sort((a, b) => a - b);
    this.sel.point = this.sel.multi.includes(i) ? i : (this.sel.multi[0] ?? null);
    this.notify();
  }

  addMulti(indices: number[]): void {
    const set = new Set([...this.sel.multi, ...indices]);
    this.sel.multi = [...set].sort((a, b) => a - b);
    if (this.sel.point === null || !set.has(this.sel.point)) this.sel.point = this.sel.multi[0] ?? null;
    this.notify();
  }

  clearMulti(): void {
    this.sel.multi = [];
    this.notify();
  }

  selectAllPoints(): void {
    const s = this.surface;
    if (s) this.addMulti(this.handlesOf(s).map((_, i) => i));
  }

  /** 메시에서 고른 점이 있는 가로줄·세로줄을 모두 고른다 */
  selectMeshLine(axis: 'row' | 'col'): boolean {
    const s = this.surface;
    if (!s?.mesh || this.sel.mask || this.sel.point === null) return false;
    this.addMulti(meshLine(s.mesh, this.sel.point, axis));
    return true;
  }

  /** 크기 조절 상자의 대상: 여러 점을 골랐으면 그 점들, 아니면 면 전체(null) */
  private boxTargets(): number[] | null {
    return this.sel.multi.length >= 2 ? this.sel.multi : null;
  }

  /** 대상 점들의 상자 (출력 px) */
  currentBox(): Box | null {
    const s = this.surface;
    if (!s) return null;
    const pts = this.handlesOf(s);
    const t = this.boxTargets();
    const sub = t ? t.map((i) => pts[i]!).filter(Boolean) : pts;
    if (sub.length < 2) return null;
    const { width, height } = this.project.output;
    return boxOf(sub, width, height);
  }

  /** 대상 점(+면 전체일 때는 마스크)에 상자 변환을 적용한 패치 */
  private boxPatch(s: Surface, from: Box, to: Box, targets: number[] | null, startHandles: Vec2[], startMask: Vec2[] | null): Partial<Surface> {
    const { width, height } = this.project.output;
    const f = boxMap(from, to, width, height);
    const set = targets ? new Set(targets) : null;
    const next = startHandles.map((p, i) => (!set || set.has(i) ? f(p) : p));
    const patch = this.handlesPatch(s, next);
    if (!set && !this.sel.mask && startMask) patch.mask = { ...s.mask, polygon: startMask.map(f) };
    return patch;
  }

  /** 대상 점들을 가로·세로 픽셀 길이가 같은 원(정사각 상자)으로 맞춘다 — 타원 → 원 */
  makeCircle(): boolean {
    const s = this.surface;
    const b = this.currentBox();
    if (!s || !b || s.locked) return false;
    this.opts.store.dispatch(
      { type: 'surface', id: s.id, patch: this.boxPatch(s, b, circleBox(b), this.boxTargets(), this.handlesOf(s), s.mask.polygon) },
      { history: true },
    );
    return true;
  }

  // ---------- 이동 ----------

  /**
   * 출력 픽셀 단위 미세이동. 점을 골랐으면 그 점, 아니면 면 전체(마스크 포함).
   * 0.6초 안에 이어지는 이동은 실행취소 한 번으로 묶는다.
   */
  nudge(dxPx: number, dyPx: number): boolean {
    const s = this.surface;
    if (!s || s.locked) return false;
    const { width, height } = this.project.output;
    const dx = dxPx / width;
    const dy = dyPx / height;
    const now = performance.now();
    if (now - this.lastNudge > 600) this.opts.store.checkpoint();
    this.lastNudge = now;
    const pts = this.handlesOf(s);
    const idx = this.sel.multi.length >= 2 ? this.sel.multi : this.sel.point !== null && pts[this.sel.point] ? coincident(pts, this.sel.point) : null;
    if (idx) {
      const set = new Set(idx);
      const next = pts.map((p, i) => (set.has(i) ? ([p[0] + dx, p[1] + dy] as Vec2) : p));
      this.opts.store.dispatch({ type: 'surface', id: s.id, patch: this.handlesPatch(s, next) });
    } else {
      this.opts.store.dispatch({ type: 'surface', id: s.id, patch: moveSurface(s, dx, dy) });
    }
    return true;
  }

  // ---------- 좌표 변환 ----------

  /** 정규화 좌표 → 무대 CSS px (무대 왼쪽 위 기준, 출력 영역은 (ox, oy) 에서 시작) */
  toScreen(p: Vec2): Vec2 {
    return [this.ox + ((p[0] - this.center[0]) * this.zoom + 0.5) * this.vw, this.oy + ((p[1] - this.center[1]) * this.zoom + 0.5) * this.vh];
  }

  toNorm(x: number, y: number): Vec2 {
    return [((x - this.ox) / this.vw - 0.5) / this.zoom + this.center[0], ((y - this.oy) / this.vh - 0.5) / this.zoom + this.center[1]];
  }

  private pointer(e: PointerEvent | MouseEvent): { x: number; y: number; n: Vec2 } {
    const r = this.overlay.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    return { x, y, n: this.toNorm(x, y) };
  }

  setZoom(zoom: number, center?: Vec2): void {
    this.zoom = Math.min(8, Math.max(1, zoom));
    if (center) this.center = center;
    if (this.zoom === 1) this.center = [0.5, 0.5];
    this.applyViewTransform();
    this.requestDraw();
  }

  // ---------- 배치 ----------

  layout(): void {
    const cw = this.root.clientWidth;
    const ch = this.root.clientHeight;
    const { width, height } = this.project.output;
    let vw = cw;
    let vh = ch;
    if (!this.fill) {
      const a = width / height;
      if (cw / ch > a) vw = ch * a;
      else vh = cw / a;
    }
    this.vw = Math.max(1, Math.floor(vw));
    this.vh = Math.max(1, Math.floor(vh));
    this.ox = Math.floor((cw - this.vw) / 2);
    this.oy = Math.floor((ch - this.vh) / 2);
    this.cw = Math.max(1, cw);
    this.ch = Math.max(1, ch);
    Object.assign(this.view.style, {
      width: `${this.vw}px`,
      height: `${this.vh}px`,
      left: `${this.ox}px`,
      top: `${this.oy}px`,
    });
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.overlay.width = this.cw * dpr;
    this.overlay.height = this.ch * dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.applyViewTransform();
    this.draw();
  }

  private applyViewTransform(): void {
    const tx = (0.5 - this.center[0] * this.zoom) * this.vw;
    const ty = (0.5 - this.center[1] * this.zoom) * this.vh;
    const t = this.zoom === 1 ? '' : `translate(${tx}px, ${ty}px) scale(${this.zoom})`;
    this.bg.style.transform = t;
    if (this.renderer) this.renderer.canvas.style.transform = t;
  }

  // ---------- 그리기 ----------

  requestDraw(): void {
    if (this.drawQueued) return;
    this.drawQueued = true;
    requestAnimationFrame(() => {
      this.drawQueued = false;
      this.draw();
    });
  }

  draw(): void {
    const c = this.ctx;
    c.clearRect(0, 0, this.cw, this.ch);
    if (!this.showHandles) return;
    this.drawOutputBounds();
    const surfaces = this.project.surfaces;
    const big = this.opts.handleRadius >= 20;
    surfaces.forEach((s, i) => {
      const outline = surfaceOutline(s).map((p) => this.toScreen(p));
      const selected = s.id === this.sel.surfaceId;
      path(c, outline);
      if (!this.opts.withRenderer) {
        c.fillStyle = hexA(FILLS[i % FILLS.length]!, s.visible ? 0.35 : 0.08);
        c.fill();
      } else if (selected) {
        c.fillStyle = 'rgba(255,176,0,0.08)';
        c.fill();
      }
      const broken = s.kind === 'quad' && !isConvexQuad(s.points);
      c.setLineDash(s.visible ? [] : [4, 4]);
      c.lineWidth = selected ? 2 : 1;
      c.strokeStyle = broken ? '#ff3b3b' : selected ? ACCENT : 'rgba(255,255,255,0.6)';
      c.stroke();
      c.setLineDash([]);

      if (selected && s.kind === 'mesh' && s.mesh && !this.sel.mask) this.drawMeshNet(s);
      if (s.mask.polygon && s.mask.polygon.length >= 3 && (selected || this.sel.mask)) {
        path(c, s.mask.polygon.map((p) => this.toScreen(p)));
        c.setLineDash([6, 4]);
        c.strokeStyle = MASK;
        c.lineWidth = 1.5;
        c.stroke();
        c.setLineDash([]);
      }

      const [lx, ly] = this.toScreen(centroid(s.points));
      c.font = `${big ? 14 : 12}px system-ui, sans-serif`;
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      const label = `${s.locked ? '🔒 ' : ''}${s.name}${broken ? ' (꼬임)' : ''}${s.visible ? '' : ' (숨김)'}`;
      c.lineWidth = 3;
      c.strokeStyle = 'rgba(0,0,0,0.8)';
      c.strokeText(label, lx, ly);
      c.fillStyle = selected ? ACCENT : '#fff';
      c.fillText(label, lx, ly);
    });

    const s = this.surface;
    if (!s) return;
    const pts = this.handlesOf(s);
    const r = big ? 9 : 6;
    const multi = new Set(this.sel.multi);
    pts.forEach((p, i) => {
      const [x, y] = this.toScreen(p);
      const on = i === this.sel.point || multi.has(i);
      c.beginPath();
      if (this.sel.mask) c.rect(x - r, y - r, r * 2, r * 2);
      else c.arc(x, y, r, 0, Math.PI * 2);
      c.fillStyle = on ? (this.sel.mask ? MASK : ACCENT) : 'rgba(0,0,0,0.6)';
      c.fill();
      c.lineWidth = 2;
      c.strokeStyle = s.locked ? '#888' : this.sel.mask ? MASK : on ? '#fff' : ACCENT;
      c.stroke();
    });
    // 사각형으로 고르는 중
    const d = this.drag;
    if (d?.kind === 'band' && d.bandEnd) {
      const [ax, ay] = this.toScreen(d.startPointer);
      const [bx, by] = this.toScreen(d.bandEnd);
      c.setLineDash([5, 4]);
      c.strokeStyle = '#fff';
      c.lineWidth = 1;
      c.strokeRect(Math.min(ax, bx), Math.min(ay, by), Math.abs(bx - ax), Math.abs(by - ay));
      c.fillStyle = 'rgba(255,176,0,0.12)';
      c.fillRect(Math.min(ax, bx), Math.min(ay, by), Math.abs(bx - ax), Math.abs(by - ay));
      c.setLineDash([]);
    }
    if (this.boxMode && !s.locked) this.drawBox(big);
    // 선택한 점: 화면을 가로지르는 십자선 (손가락에 가려도 위치가 보이게)
    const sp = this.sel.point !== null && this.sel.multi.length < 2 ? pts[this.sel.point] : undefined;
    if (sp) {
      const [x, y] = this.toScreen(sp);
      c.strokeStyle = 'rgba(255,176,0,0.55)';
      c.lineWidth = 1;
      c.beginPath();
      c.moveTo(0, y);
      c.lineTo(this.cw, y);
      c.moveTo(x, 0);
      c.lineTo(x, this.ch);
      c.stroke();
    }
  }

  /** 출력 해상도 영역의 경계: 점선 테두리 + 네 귀퉁이 꺾쇠 + 해상도 표시 (편집 화면에만, 출력에는 안 나옴) */
  private drawOutputBounds(): void {
    const c = this.ctx;
    const [ax, ay] = this.toScreen([0, 0]);
    const [bx, by] = this.toScreen([1, 1]);
    // 확대하면 경계가 무대 밖으로 나갈 수 있어, 글자는 보이는 범위 안쪽에 둔다
    const x0 = Math.max(ax, 1);
    const y0 = Math.max(ay, 1);
    const x1 = Math.min(bx, this.cw - 1);
    const y1 = Math.min(by, this.ch - 1);
    c.save();
    c.setLineDash([8, 6]);
    c.lineWidth = 1.5;
    c.strokeStyle = 'rgba(127, 211, 255, 0.75)';
    c.strokeRect(ax + 1, ay + 1, bx - ax - 2, by - ay - 2);
    c.setLineDash([]);
    // 귀퉁이 꺾쇠 (실제 귀퉁이가 화면 안에 있을 때만)
    const L = 22;
    c.lineWidth = 3;
    c.strokeStyle = '#7fd3ff';
    const corner = (x: number, y: number, dx: number, dy: number) => {
      c.beginPath();
      c.moveTo(x + dx * L, y);
      c.lineTo(x, y);
      c.lineTo(x, y + dy * L);
      c.stroke();
    };
    if (ax >= 0 && ay >= 0) corner(ax + 1.5, ay + 1.5, 1, 1);
    if (bx <= this.cw && ay >= 0) corner(bx - 1.5, ay + 1.5, -1, 1);
    if (bx <= this.cw && by <= this.ch) corner(bx - 1.5, by - 1.5, -1, -1);
    if (ax >= 0 && by <= this.ch) corner(ax + 1.5, by - 1.5, 1, -1);
    // 해상도 표시
    const { width, height } = this.project.output;
    const label = `출력 ${width}×${height}`;
    c.font = '600 12px system-ui, sans-serif';
    const tw = c.measureText(label).width;
    if (x1 - x0 > tw + 20 && y1 - y0 > 30) {
      c.fillStyle = 'rgba(0, 0, 0, 0.65)';
      c.fillRect(x0 + 6, y0 + 6, tw + 12, 20);
      c.fillStyle = '#7fd3ff';
      c.textAlign = 'left';
      c.textBaseline = 'middle';
      c.fillText(label, x0 + 12, y0 + 16);
    }
    c.restore();
  }

  /** 출력 px → 무대 CSS px */
  private pxToScreen([x, y]: Vec2): Vec2 {
    const { width, height } = this.project.output;
    return this.toScreen([x / width, y / height]);
  }

  private drawBox(big: boolean): void {
    const b = this.currentBox();
    if (!b) return;
    const c = this.ctx;
    const [x0, y0] = this.pxToScreen([b.x0, b.y0]);
    const [x1, y1] = this.pxToScreen([b.x1, b.y1]);
    c.setLineDash([6, 4]);
    c.strokeStyle = '#7fd3ff';
    c.lineWidth = 1.5;
    c.strokeRect(x0, y0, x1 - x0, y1 - y0);
    c.setLineDash([]);
    const r = big ? 11 : 7;
    for (const h of BOX_HANDLES) {
      const [x, y] = this.pxToScreen(handlePos(b, h));
      c.beginPath();
      if (h === 'move') c.arc(x, y, r, 0, Math.PI * 2);
      else c.rect(x - r, y - r, r * 2, r * 2);
      c.fillStyle = h === 'move' ? 'rgba(127,211,255,0.35)' : '#fff';
      c.fill();
      c.strokeStyle = '#1a6fa0';
      c.lineWidth = 2;
      c.stroke();
      if (h === 'move') {
        c.beginPath();
        c.moveTo(x - r + 3, y);
        c.lineTo(x + r - 3, y);
        c.moveTo(x, y - r + 3);
        c.lineTo(x, y + r - 3);
        c.stroke();
      }
    }
  }

  private hitBox(x: number, y: number): BoxHandle | null {
    const b = this.currentBox();
    if (!b) return null;
    let best: BoxHandle | null = null;
    let bestD = this.opts.handleRadius + 2;
    for (const h of BOX_HANDLES) {
      const [sx, sy] = this.pxToScreen(handlePos(b, h));
      const d = Math.hypot(sx - x, sy - y);
      if (d <= bestD) {
        bestD = d;
        best = h;
      }
    }
    return best;
  }

  private drawMeshNet(s: Surface): void {
    const m = s.mesh!;
    const c = this.ctx;
    c.strokeStyle = 'rgba(255,176,0,0.45)';
    c.lineWidth = 1;
    c.beginPath();
    for (let r = 0; r < m.rows; r++) {
      for (let k = 0; k < m.cols; k++) {
        const [x, y] = this.toScreen(m.points[r * m.cols + k]!);
        if (k === 0) c.moveTo(x, y);
        else c.lineTo(x, y);
      }
    }
    for (let k = 0; k < m.cols; k++) {
      for (let r = 0; r < m.rows; r++) {
        const [x, y] = this.toScreen(m.points[r * m.cols + k]!);
        if (r === 0) c.moveTo(x, y);
        else c.lineTo(x, y);
      }
    }
    c.stroke();
  }

  // ---------- 마우스·터치 ----------

  private hitHandle(pts: Vec2[], x: number, y: number): number {
    let best = -1;
    let bestD = this.opts.handleRadius;
    pts.forEach((p, i) => {
      const [sx, sy] = this.toScreen(p);
      const d = Math.hypot(sx - x, sy - y);
      if (d <= bestD) {
        bestD = d;
        best = i;
      }
    });
    return best;
  }

  /** 손가락·마우스 아래의 맨 위 면 */
  private surfaceAt(n: Vec2): Surface | null {
    const list = this.project.surfaces;
    for (let i = list.length - 1; i >= 0; i--) {
      const s = list[i]!;
      if (s.visible && pointInPolygon(n, surfaceOutline(s))) return s;
    }
    return null;
  }

  private startDrag(kind: Drag['kind'], s: Surface, index: number, n: Vec2, pendingTap?: Drag['pendingTap']): void {
    this.drag = {
      kind,
      surfaceId: s.id,
      index,
      startPointer: n,
      startHandles: this.handlesOf(s),
      startPoints: editablePoints(s),
      startMask: s.mask.polygon,
      moved: false,
      pendingTap,
    };
  }

  private onDown(e: PointerEvent): void {
    if (!this.showHandles || e.button > 0) return;
    this.root.setPointerCapture(e.pointerId);
    const { x, y, n } = this.pointer(e);
    const s = this.surface;
    const picking = this.pickMode || e.shiftKey;

    // 0) 크기 조절 상자 손잡이
    if (s && this.boxMode && !s.locked) {
      const h = this.hitBox(x, y);
      if (h) {
        this.startDrag('box', s, -1, n);
        Object.assign(this.drag!, { handle: h, startBox: this.currentBox()!, targets: this.boxTargets() });
        return;
      }
    }
    // 1) 선택한 면의 조절점
    if (s) {
      const pts = this.handlesOf(s);
      const i = this.hitHandle(pts, x, y);
      if (i >= 0) {
        if (picking) {
          this.toggleMulti(i);
          return;
        }
        if (this.sel.multi.length >= 2 && this.sel.multi.includes(i)) {
          // 고른 점들을 함께 끈다
          this.sel.point = i;
          this.startDrag('point', s, i, n);
          this.drag!.indices = this.sel.multi.slice();
          this.notify();
          return;
        }
        this.select(s.id, i, this.sel.mask);
        this.startDrag('point', s, i, n);
        this.drag!.indices = coincident(pts, i); // 구의 극처럼 겹친 점은 같이
        return;
      }
      // 여러 점 선택 중 빈 곳을 끌면 사각형으로 고르기
      if (picking) {
        this.startDrag('band', s, -1, n);
        this.drag!.bandEnd = n;
        return;
      }
    }
    // 2) 다른 면의 조절점 (마스크 편집 중이 아닐 때)
    if (!this.sel.mask && !picking) {
      const list = this.project.surfaces;
      for (let k = list.length - 1; k >= 0; k--) {
        const o = list[k]!;
        if (!o.visible || o.id === s?.id) continue;
        const i = this.hitHandle(editablePoints(o), x, y);
        if (i >= 0) {
          this.select(o.id, i);
          this.startDrag('point', o, i, n);
          return;
        }
      }
    }
    // 3) 터치패드 방식: 탭인지 드래그인지는 움직여 봐야 안다
    if (this.opts.trackpad) {
      if (s) {
        this.startDrag(this.sel.point !== null ? 'point' : 'surface', s, this.sel.point ?? -1, n, { x, y });
        if (this.sel.point !== null) {
          this.drag!.indices = this.sel.multi.length >= 2 ? this.sel.multi.slice() : coincident(this.handlesOf(s), this.sel.point);
        }
      } else this.drag = null;
      this.pendingTapAt = { x, y, n };
      return;
    }
    // 4) 면 안을 누르면 선택하고 면 전체를 옮긴다
    const hit = this.surfaceAt(n);
    if (hit) {
      if (hit.id !== s?.id || this.sel.point !== null) this.select(hit.id, null);
      this.startDrag('surface', hit, -1, n);
    } else if (!this.sel.mask) {
      this.select(null);
    }
  }

  private onMove(e: PointerEvent): void {
    const d = this.drag;
    if (!d) return;
    const { x, y, n } = this.pointer(e);
    if (d.pendingTap) {
      if (Math.hypot(x - d.pendingTap.x, y - d.pendingTap.y) < 6) return;
      d.pendingTap = undefined;
      this.pendingTapAt = null;
      d.startPointer = n; // 움직이기 시작한 곳부터 계산 (갑자기 튀지 않게)
    }
    if (d.kind === 'band') {
      d.bandEnd = n;
      this.requestDraw();
      return;
    }
    const s = this.project.surfaces.find((o) => o.id === d.surfaceId);
    if (!s || s.locked) return;
    if (!d.moved) {
      this.opts.store.checkpoint();
      d.moved = true;
    }
    const dx = (n[0] - d.startPointer[0]) * this.precision;
    const dy = (n[1] - d.startPointer[1]) * this.precision;
    let patch: Partial<Surface>;
    if (d.kind === 'box' && d.startBox && d.handle) {
      const { width, height } = this.project.output;
      const nb = dragBox(d.startBox, d.handle, dx * width, dy * height);
      patch = this.boxPatch(s, d.startBox, nb, d.targets ?? null, d.startHandles, d.startMask);
    } else if (d.kind === 'point' && d.startHandles[d.index]) {
      const set = new Set(d.indices ?? [d.index]);
      const pts = d.startHandles.map((p, i) => (set.has(i) ? ([p[0] + dx, p[1] + dy] as Vec2) : p));
      patch = this.handlesPatch(s, pts);
    } else {
      patch = withEditablePoints(s, translate(d.startPoints, dx, dy));
      if (d.startMask) patch.mask = { ...s.mask, polygon: translate(d.startMask, dx, dy) };
    }
    this.opts.store.dispatch({ type: 'surface', id: s.id, patch });
  }

  private onUp(e: PointerEvent): void {
    if (this.root.hasPointerCapture(e.pointerId)) this.root.releasePointerCapture(e.pointerId);
    const tap = this.pendingTapAt;
    this.pendingTapAt = null;
    const d = this.drag;
    this.drag = null;
    if (d?.kind === 'band' && d.bandEnd) {
      const s = this.surface;
      if (s) this.addMulti(pointsInRect(this.handlesOf(s), d.startPointer, d.bandEnd));
      this.requestDraw();
      return;
    }
    if (tap && e.type === 'pointerup') {
      // 움직이지 않은 탭: 그 자리의 면을 고른다 (빈 곳이면 선택 해제)
      const hit = this.surfaceAt(tap.n);
      this.select(hit?.id ?? null, null);
    }
  }

  /** 마스크 편집 중 테두리를 두 번 누르면 점을 끼워 넣는다. 마스크가 없으면 면 모양으로 만든다 */
  private onDoubleClick(e: MouseEvent): void {
    const s = this.surface;
    if (!s || !this.sel.mask || s.locked) return;
    const { n } = this.pointer(e);
    const poly = s.mask.polygon;
    if (!poly || poly.length < 3) return;
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < poly.length; i++) {
      const { d } = distToSegment(n, poly[i]!, poly[(i + 1) % poly.length]!);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    if (bestD * this.zoom * this.vw > this.opts.handleRadius * 2) return; // 테두리에서 너무 멀다
    const next = poly.slice();
    next.splice(best + 1, 0, n);
    this.opts.store.dispatch({ type: 'surface', id: s.id, patch: { mask: { ...s.mask, polygon: next } } }, { history: true });
    this.select(s.id, best + 1, true);
  }
}

/** 면 전체(조절점 + 마스크)를 옮기는 패치 */
export function moveSurface(s: Surface, dx: number, dy: number): Partial<Surface> {
  const patch = withEditablePoints(s, translate(editablePoints(s), dx, dy));
  if (s.mask.polygon) patch.mask = { ...s.mask, polygon: translate(s.mask.polygon, dx, dy) };
  return patch;
}

function path(c: CanvasRenderingContext2D, pts: Vec2[]): void {
  c.beginPath();
  pts.forEach(([x, y], i) => (i ? c.lineTo(x, y) : c.moveTo(x, y)));
  c.closePath();
}

function hexA(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
