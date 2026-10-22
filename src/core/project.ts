// 프로젝트 파일(JSON) 타입 정의, 기본값, 저장/불러오기, 마이그레이션.
// 모든 좌표는 출력 해상도와 무관한 0~1 정규화 값이다. 픽셀 변환은 렌더러에서만 한다.

import { applyHomography, unitSquareToQuad, type Vec2 } from './homography';
import { evaluateMesh, meshCorners, meshFromHomography, resampleMesh, sphereMesh, type Mesh } from './mesh';

export type { Vec2 } from './homography';
export type { Mesh } from './mesh';

export const PROJECT_VERSION = 1;

export type ShaderPreset = 'scanlines' | 'noise' | 'flash' | 'grid';
export const SHADER_PRESETS: { id: ShaderPreset; label: string }[] = [
  { id: 'scanlines', label: '스캔라인' },
  { id: 'noise', label: '노이즈' },
  { id: 'flash', label: '단색 깜빡임' },
  { id: 'grid', label: '격자 (두께 조절)' },
];

/** 격자 효과 기본 두께 (출력 px) */
export const GRID_LINE_DEFAULT = 2;
export const GRID_BORDER_DEFAULT = 6;
export const GRID_WIDTH_MAX = 60;
/** 격자 효과 기본 칸 수 (가로 × 세로) */
export const GRID_CELLS_X_DEFAULT = 8;
export const GRID_CELLS_Y_DEFAULT = 4;
export const GRID_CELLS_MAX = 40;

export interface ShaderParams {
  /** 움직임 속도 배율 */
  speed: number;
  /** 효과 색 (#rrggbb). 격자는 선 색 */
  color: string;
  /** 격자: 선 두께 (출력 px). 없으면 GRID_LINE_DEFAULT */
  lineWidth?: number;
  /** 격자: 테두리 두께 (출력 px). 없으면 GRID_BORDER_DEFAULT */
  borderWidth?: number;
  /** 격자: 가로·세로 칸 수 (1~40). 없으면 GRID_CELLS_X/Y_DEFAULT */
  cellsX?: number;
  cellsY?: number;
}

export type Source =
  | { id: string; name: string; type: 'image'; uri: string }
  | { id: string; name: string; type: 'video'; uri: string; loop: boolean }
  | { id: string; name: string; type: 'shader'; preset: ShaderPreset; params: ShaderParams }
  | { id: string; name: string; type: 'color'; value: string };

export type SourceType = Source['type'];
export type SurfaceKind = 'quad' | 'triangle' | 'mesh';

export interface Mask {
  /** 출력 좌표 다각형. null 이면 마스크 없음 */
  polygon: Vec2[] | null;
  /** 가장자리 페더 (출력 해상도 기준 px) */
  feather: number;
}

export interface Surface {
  id: string;
  name: string;
  kind: SurfaceKind;
  /** quad: 4점(좌상·우상·우하·좌하), triangle: 3점, mesh: 메시 네 귀퉁이(참고용) */
  points: Vec2[];
  mesh: Mesh | null;
  sourceId: string | null;
  /** 소스에서 잘라 쓸 영역. quad·mesh 4점, triangle 3점 */
  uv: Vec2[];
  mask: Mask;
  opacity: number;
  visible: boolean;
  locked: boolean;
}

/** 처음 세팅용 전체 화면 격자 (프로젝터가 비추는 범위 확인). 없으면 끔 */
export type OutputPattern = 'black' | 'blue' | 'green';
export const OUTPUT_PATTERNS: { id: OutputPattern; label: string; color: string }[] = [
  { id: 'black', label: '블랙', color: '#000000' },
  { id: 'blue', label: '블루', color: '#1f4fff' },
  { id: 'green', label: '그린', color: '#00a651' },
];

export interface Project {
  version: number;
  output: { width: number; height: number; pattern?: OutputPattern };
  sources: Source[];
  surfaces: Surface[];
}

export const QUAD_UV: Vec2[] = [
  [0, 0],
  [1, 0],
  [1, 1],
  [0, 1],
];
export const TRIANGLE_UV: Vec2[] = [
  [0.5, 0],
  [1, 1],
  [0, 1],
];

const clone = <T>(v: T): T => structuredClone(v);

/** 기존 id 와 겹치지 않는 새 id */
export function newId(prefix: string, existing: Iterable<string>): string {
  const used = new Set(existing);
  for (let n = 1; ; n++) {
    const id = `${prefix}${n}`;
    if (!used.has(id)) return id;
  }
}

/** 화면 가운데 근처에 새 사각형 면 */
export function makeQuad(id: string, name: string, offset = 0): Surface {
  const x0 = 0.3 + offset;
  const y0 = 0.25 + offset;
  return {
    id,
    name,
    kind: 'quad',
    points: [
      [x0, y0],
      [x0 + 0.4, y0],
      [x0 + 0.4, y0 + 0.5],
      [x0, y0 + 0.5],
    ],
    mesh: null,
    sourceId: null,
    uv: clone(QUAD_UV),
    mask: { polygon: null, feather: 0 },
    opacity: 1,
    visible: true,
    locked: false,
  };
}

/** 새 삼각형 면 (지붕 박공 등) */
export function makeTriangle(id: string, name: string, offset = 0): Surface {
  const x0 = 0.35 + offset;
  const y0 = 0.2 + offset;
  return {
    ...makeQuad(id, name, offset),
    kind: 'triangle',
    points: [
      [x0 + 0.15, y0],
      [x0 + 0.3, y0 + 0.3],
      [x0, y0 + 0.3],
    ],
    uv: clone(TRIANGLE_UV),
  };
}

/** 쿼드 → 메시. 현재 호모그래피로 격자점 초깃값을 채운다 */
export function surfaceToMesh(s: Surface, cols = 4, rows = 4): Surface {
  if (s.kind === 'mesh' && s.mesh) return { ...s, mesh: resampleMesh(s.mesh, cols, rows) };
  const quad = s.kind === 'quad' ? s.points : triangleToQuadPoints(s.points);
  const h = unitSquareToQuad(quad);
  const mesh: Mesh = h
    ? meshFromHomography(h, cols, rows)
    : { cols: 2, rows: 2, points: [quad[0]!, quad[1]!, quad[3]!, quad[2]!].map((p) => [p[0], p[1]] as Vec2) };
  return { ...s, kind: 'mesh', mesh, points: meshCorners(mesh), uv: s.kind === 'triangle' ? clone(QUAD_UV) : s.uv };
}

/**
 * 공(구) 모양 메시로 바꾼다. 지금 면의 네 모서리를 "공에 꼭 맞는 정사각형"으로 보고
 * 그 안에 공의 앞면 격자를 만든다. 테두리가 공의 윤곽이 되므로 마스크가 필요 없다.
 */
export function surfaceToSphere(s: Surface, n = 9): Surface {
  const quad = s.kind === 'quad' ? s.points : s.kind === 'mesh' && s.mesh ? meshCorners(s.mesh) : triangleToQuadPoints(s.points);
  const h = unitSquareToQuad(quad);
  if (!h) return s;
  const mesh = sphereMesh(h, n);
  return { ...s, kind: 'mesh', mesh, points: meshCorners(mesh), uv: s.kind === 'triangle' ? clone(QUAD_UV) : s.uv };
}

/**
 * 면 안에 꼭 맞는 원(타원) 마스크 다각형 (n 점, 셰이더 한도 32).
 * 사각형은 원근을 따라 기울어진 원, 삼각형은 내접 타원(슈타이너), 메시는 휜 모양을 따른다.
 */
export function circleMask(s: Surface, n = 32): Vec2[] {
  const out: Vec2[] = [];
  const h = s.kind === 'quad' ? unitSquareToQuad(s.points) : null;
  const [A, B, C] = s.points as [Vec2, Vec2, Vec2];
  const tri = s.kind === 'triangle';
  const G: Vec2 = [(A[0] + B[0] + C[0]) / 3, (A[1] + B[1] + C[1]) / 3];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const u = 0.5 + 0.5 * Math.cos(a);
    const v = 0.5 + 0.5 * Math.sin(a);
    if (s.kind === 'mesh' && s.mesh) out.push(evaluateMesh(s.mesh, u, v));
    else if (tri) {
      // 슈타이너 내접 타원: G + ½[cos a·(A−G) + sin a·(C−B)/√3]
      const k = 1 / Math.sqrt(3);
      out.push([
        G[0] + 0.5 * (Math.cos(a) * (A[0] - G[0]) + Math.sin(a) * (C[0] - B[0]) * k),
        G[1] + 0.5 * (Math.cos(a) * (A[1] - G[1]) + Math.sin(a) * (C[1] - B[1]) * k),
      ]);
    } else out.push(h ? applyHomography(h, [u, v]) : s.points[0]!);
  }
  return out;
}

/** 메시·삼각형 → 쿼드. 메시는 네 귀퉁이만 남긴다 */
export function surfaceToQuad(s: Surface): Surface {
  if (s.kind === 'quad') return s;
  const points = s.kind === 'mesh' && s.mesh ? meshCorners(s.mesh) : triangleToQuadPoints(s.points);
  return { ...s, kind: 'quad', mesh: null, points, uv: s.kind === 'triangle' ? clone(QUAD_UV) : s.uv };
}

/** 삼각형을 감싸는 사각형 (밑변 두 점 + 꼭대기를 둘로 나눔) */
function triangleToQuadPoints(p: Vec2[]): Vec2[] {
  if (p.length === 4) return clone(p);
  const [top, br, bl] = p as [Vec2, Vec2, Vec2];
  const w = (br[0] - bl[0]) * 0.25;
  return [
    [top[0] - w, top[1]],
    [top[0] + w, top[1]],
    [br[0], br[1]],
    [bl[0], bl[1]],
  ];
}

/** 면의 편집 가능한 점 목록 (mesh 는 격자점 전체) */
export function editablePoints(s: Surface): Vec2[] {
  return s.kind === 'mesh' && s.mesh ? s.mesh.points : s.points;
}

/** 편집 가능한 점 목록을 바꾼 새 면 (mesh 면 points 의 귀퉁이도 맞춘다) */
export function withEditablePoints(s: Surface, pts: Vec2[]): Partial<Surface> {
  if (s.kind === 'mesh' && s.mesh) {
    const mesh = { ...s.mesh, points: pts };
    return { mesh, points: meshCorners(mesh) };
  }
  return { points: pts };
}

/** 쿼드 면 위의 매개변수 점 → 출력 좌표 (마스크 기본 다각형 계산 등) */
export function quadPoint(s: Surface, uv: Vec2): Vec2 {
  const h = unitSquareToQuad(s.points);
  return h ? applyHomography(h, uv) : s.points[0]!;
}

/**
 * 새 면의 기본 소스: 검은 바탕에 흰 격자선·흰 테두리·귀퉁이 색 상자. 선·테두리 두께를 바꿀 수 있는 격자 효과.
 * (id 는 처음 만든 '흰 격자' 때 그대로 — 예전 프로젝트에서는 같은 id 의 그림 파일(assets/grid-white.png) 소스였다)
 */
export const WHITE_GRID: Source = {
  id: 'grid-white',
  name: '기본 격자',
  type: 'shader',
  preset: 'grid',
  params: {
    speed: 0,
    color: '#ffffff',
    lineWidth: GRID_LINE_DEFAULT,
    borderWidth: GRID_BORDER_DEFAULT,
    cellsX: GRID_CELLS_X_DEFAULT,
    cellsY: GRID_CELLS_Y_DEFAULT,
  },
};

/** 예전 그림 파일 방식의 기본 격자인지 (두께 조절 격자로 바꿀 수 있다) */
export function isOldGridImage(s: Source): boolean {
  return s.id === WHITE_GRID.id && s.type === 'image' && s.uri === 'assets/grid-white.png';
}

/** 매핑용 8초 반복 영상 3종 (검은 바탕 = 빛 없음, 첫·끝 장면이 같아 반복 이음매 없음) */
export const SAMPLE_CLIPS: Source[] = [
  { id: 'clip-light-sweep', name: '빛 훑기 (영상)', type: 'video', uri: 'assets/clips/light-sweep.mp4', loop: true },
  { id: 'clip-neon-edge', name: '테두리 네온 (영상)', type: 'video', uri: 'assets/clips/neon-edge.mp4', loop: true },
  { id: 'clip-brick-build', name: '벽돌 쌓기 (영상)', type: 'video', uri: 'assets/clips/brick-build.mp4', loop: true },
];

/** 처음 실행했을 때의 프로젝트: 기본 격자를 쿼드 하나에 */
export function createDefaultProject(): Project {
  const surface = makeQuad('front', '정면 벽');
  surface.sourceId = WHITE_GRID.id;
  return {
    version: PROJECT_VERSION,
    output: { width: 1920, height: 1080 },
    sources: [
      { ...WHITE_GRID },
      { id: 'grid', name: '격자 패턴', type: 'image', uri: 'assets/grid.png' },
      { id: 'checker', name: '체크무늬 패턴', type: 'image', uri: 'assets/checker.png' },
      { id: 'circles', name: '원 패턴', type: 'image', uri: 'assets/circles.png' },
      { id: 'sample', name: '샘플 영상', type: 'video', uri: 'assets/sample.mp4', loop: true },
      // 매핑용 8초 반복 영상 (clips/ 의 HyperFrames 프로젝트로 만듦)
      ...SAMPLE_CLIPS.map((c) => ({ ...c })),
      { id: 'white', name: '흰색', type: 'color', value: '#ffffff' },
    ],
    surfaces: [surface],
  };
}

export function serializeProject(p: Project): string {
  return JSON.stringify(p, null, 2);
}

// ---------- 불러오기 (검증 + 마이그레이션) ----------

export class ProjectError extends Error {}

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const str = (v: unknown, d: string) => (typeof v === 'string' ? v : d);
const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d);

function vec(v: unknown, where: string): Vec2 {
  if (!Array.isArray(v) || v.length !== 2 || !v.every((x) => typeof x === 'number' && Number.isFinite(x))) {
    throw new ProjectError(`${where}: 좌표는 [x, y] 숫자 쌍이어야 합니다`);
  }
  return [v[0], v[1]];
}

function vecs(v: unknown, n: number | null, where: string): Vec2[] {
  if (!Array.isArray(v)) throw new ProjectError(`${where}: 좌표 목록이 없습니다`);
  if (n !== null && v.length !== n) throw new ProjectError(`${where}: 점이 ${n}개여야 합니다 (지금 ${v.length}개)`);
  return v.map((p, i) => vec(p, `${where}[${i}]`));
}

/**
 * 버전별 마이그레이션. 구조가 바뀌면 여기에 `if (version === N) { ...; version = N + 1 }` 단계를 추가한다.
 * 지금은 version 1 뿐이다.
 */
function migrate(raw: Json): Json {
  const version = num(raw.version, 1);
  if (version > PROJECT_VERSION) {
    throw new ProjectError(`이 앱보다 새 버전(${version})의 프로젝트 파일입니다. 앱을 업데이트하세요`);
  }
  return { ...raw, version: PROJECT_VERSION };
}

function parseSource(v: unknown, i: number): Source {
  const where = `sources[${i}]`;
  if (!isObj(v)) throw new ProjectError(`${where}: 객체가 아닙니다`);
  const id = str(v.id, '');
  if (!id) throw new ProjectError(`${where}: id 가 없습니다`);
  const name = str(v.name, id);
  switch (v.type) {
    case 'image':
      return { id, name, type: 'image', uri: str(v.uri, '') };
    case 'video':
      return { id, name, type: 'video', uri: str(v.uri, ''), loop: bool(v.loop, true) };
    case 'shader': {
      const preset = SHADER_PRESETS.some((p) => p.id === v.preset) ? (v.preset as ShaderPreset) : 'scanlines';
      const params = isObj(v.params) ? v.params : {};
      const width = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? { value: Math.min(GRID_WIDTH_MAX, Math.max(0, v)) } : null);
      const lw = width(params.lineWidth);
      const bw = width(params.borderWidth);
      const cells = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? { value: Math.min(GRID_CELLS_MAX, Math.max(1, Math.round(v))) } : null);
      const cx = cells(params.cellsX);
      const cy = cells(params.cellsY);
      return {
        id,
        name,
        type: 'shader',
        preset,
        params: {
          speed: num(params.speed, 1),
          color: str(params.color, '#ffffff'),
          ...(lw ? { lineWidth: lw.value } : {}),
          ...(bw ? { borderWidth: bw.value } : {}),
          ...(cx ? { cellsX: cx.value } : {}),
          ...(cy ? { cellsY: cy.value } : {}),
        },
      };
    }
    case 'color':
      return { id, name, type: 'color', value: str(v.value, '#ffffff') };
    default:
      throw new ProjectError(`${where}: 알 수 없는 소스 종류 "${String(v.type)}"`);
  }
}

function parseSurface(v: unknown, i: number): Surface {
  const where = `surfaces[${i}]`;
  if (!isObj(v)) throw new ProjectError(`${where}: 객체가 아닙니다`);
  const id = str(v.id, '');
  if (!id) throw new ProjectError(`${where}: id 가 없습니다`);
  const kind = v.kind;
  if (kind !== 'quad' && kind !== 'triangle' && kind !== 'mesh') {
    throw new ProjectError(`${where}: kind 는 quad·triangle·mesh 중 하나여야 합니다`);
  }
  let mesh: Mesh | null = null;
  if (kind === 'mesh') {
    if (!isObj(v.mesh)) throw new ProjectError(`${where}: mesh 면인데 mesh 가 없습니다`);
    const cols = num(v.mesh.cols, 0);
    const rows = num(v.mesh.rows, 0);
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 2 || rows < 2) {
      throw new ProjectError(`${where}.mesh: cols·rows 는 2 이상의 정수여야 합니다`);
    }
    mesh = { cols, rows, points: vecs(v.mesh.points, cols * rows, `${where}.mesh.points`) };
  }
  const n = kind === 'triangle' ? 3 : 4;
  const points = mesh ? meshCorners(mesh) : vecs(v.points, n, `${where}.points`);
  const uv = v.uv === undefined ? clone(kind === 'triangle' ? TRIANGLE_UV : QUAD_UV) : vecs(v.uv, n, `${where}.uv`);
  const mask = isObj(v.mask) ? v.mask : {};
  return {
    id,
    name: str(v.name, id),
    kind,
    points,
    mesh,
    sourceId: typeof v.sourceId === 'string' ? v.sourceId : null,
    uv,
    mask: {
      polygon: mask.polygon == null ? null : vecs(mask.polygon, null, `${where}.mask.polygon`),
      feather: Math.max(0, num(mask.feather, 0)),
    },
    opacity: Math.min(1, Math.max(0, num(v.opacity, 1))),
    visible: bool(v.visible, true),
    locked: bool(v.locked, false),
  };
}

/** JSON 값 → 검증된 Project. 문제가 있으면 무엇이 틀렸는지 담은 ProjectError */
export function parseProject(input: unknown): Project {
  const raw = typeof input === 'string' ? (JSON.parse(input) as unknown) : input;
  if (!isObj(raw)) throw new ProjectError('프로젝트 파일이 JSON 객체가 아닙니다');
  const m = migrate(raw);
  const out = isObj(m.output) ? m.output : {};
  const sources = Array.isArray(m.sources) ? m.sources.map(parseSource) : [];
  const surfaces = Array.isArray(m.surfaces) ? m.surfaces.map(parseSurface) : [];
  const ids = new Set<string>();
  for (const s of surfaces) {
    if (ids.has(s.id)) throw new ProjectError(`면 id "${s.id}" 가 중복됩니다`);
    ids.add(s.id);
  }
  const pattern = OUTPUT_PATTERNS.some((p) => p.id === out.pattern) ? (out.pattern as OutputPattern) : undefined;
  return {
    version: PROJECT_VERSION,
    output: { width: Math.max(1, num(out.width, 1920)), height: Math.max(1, num(out.height, 1080)), ...(pattern ? { pattern } : {}) },
    sources,
    surfaces,
  };
}
