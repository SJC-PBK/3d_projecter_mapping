// 메시 워프: 제어점 격자(cols × rows)를 Catmull-Rom 쌍삼차 보간으로 부드럽게 잇는다.
// Catmull-Rom 은 제어점을 정확히 지나므로, 격자점을 끌면 그 위치가 그대로 화면에 찍힌다.

import { applyHomography, type Mat3, type Vec2 } from './homography';

export interface Mesh {
  /** 가로 제어점 개수 (2 이상) */
  cols: number;
  /** 세로 제어점 개수 (2 이상) */
  rows: number;
  /** 행 우선 순서. 길이 = cols × rows. 0~1 정규화 출력 좌표 */
  points: Vec2[];
}

export const MESH_MIN = 2;
export const MESH_MAX = 12;

/** 1차원 Catmull-Rom (p1 과 p2 사이, t ∈ [0,1]) */
function catmullRom(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const t2 = t * t;
  const t3 = t2 * t;
  return 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
}

/** 격자 밖 인덱스는 끝 두 점으로 직선 외삽해 가장자리가 휘지 않게 한다 (cols·rows ≥ 2 전제) */
function at(mesh: Mesh, c: number, r: number, axis: 0 | 1): number {
  const { cols, rows, points } = mesh;
  const g = (cc: number, rr: number) => points[rr * cols + cc]![axis];
  const gc = (cc: number, rr: number) =>
    cc < 0 ? 2 * g(0, rr) - g(1, rr) : cc > cols - 1 ? 2 * g(cols - 1, rr) - g(cols - 2, rr) : g(cc, rr);
  if (r < 0) return 2 * gc(c, 0) - gc(c, 1);
  if (r > rows - 1) return 2 * gc(c, rows - 1) - gc(c, rows - 2);
  return gc(c, r);
}

/** 격자 매개변수 (s,t) ∈ [0,1]² 에서의 출력 좌표 */
export function evaluateMesh(mesh: Mesh, s: number, t: number): Vec2 {
  const fx = Math.min(Math.max(s, 0), 1) * (mesh.cols - 1);
  const fy = Math.min(Math.max(t, 0), 1) * (mesh.rows - 1);
  const i = Math.min(Math.floor(fx), mesh.cols - 2);
  const j = Math.min(Math.floor(fy), mesh.rows - 2);
  const u = fx - i;
  const v = fy - j;
  const out: Vec2 = [0, 0];
  for (const axis of [0, 1] as const) {
    const col: number[] = [];
    for (let r = j - 1; r <= j + 2; r++) {
      col.push(catmullRom(at(mesh, i - 1, r, axis), at(mesh, i, r, axis), at(mesh, i + 1, r, axis), at(mesh, i + 2, r, axis), u));
    }
    out[axis] = catmullRom(col[0]!, col[1]!, col[2]!, col[3]!, v);
  }
  return out;
}

/** 현재 호모그래피로 격자점 초깃값을 채운다 (쿼드 → 메시 전환) */
export function meshFromHomography(h: Mat3, cols: number, rows: number): Mesh {
  const points: Vec2[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) points.push(applyHomography(h, [c / (cols - 1), r / (rows - 1)]));
  }
  return { cols, rows, points };
}

/** 격자 크기 변경: 현재 곡면을 새 격자로 다시 샘플링한다 */
export function resampleMesh(mesh: Mesh, cols: number, rows: number): Mesh {
  const points: Vec2[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) points.push(evaluateMesh(mesh, c / (cols - 1), r / (rows - 1)));
  }
  return { cols, rows, points };
}

/**
 * 메시 네 귀퉁이 (좌상·우상·우하·좌하).
 * 구 모양 메시처럼 위·아래 귀퉁이가 한 점(극)으로 모인 경우에는
 * 가운데와 좌우·위아래 테두리 점으로 감싸는 평행사변형을 돌려준다 (사각형으로 되돌릴 때 쓰임).
 */
export function meshCorners(mesh: Mesh): Vec2[] {
  const { cols, rows, points } = mesh;
  const c = [points[0]!, points[cols - 1]!, points[cols * rows - 1]!, points[(rows - 1) * cols]!];
  const same = (a: Vec2, b: Vec2) => Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-9;
  if (same(c[0]!, c[1]!) && same(c[2]!, c[3]!)) {
    const o = evaluateMesh(mesh, 0.5, 0.5);
    const r = evaluateMesh(mesh, 1, 0.5);
    const d = evaluateMesh(mesh, 0.5, 1);
    const a: Vec2 = [r[0] - o[0], r[1] - o[1]];
    const b: Vec2 = [d[0] - o[0], d[1] - o[1]];
    return [
      [o[0] - a[0] - b[0], o[1] - a[1] - b[1]],
      [o[0] + a[0] - b[0], o[1] + a[1] - b[1]],
      [o[0] + a[0] + b[0], o[1] + a[1] + b[1]],
      [o[0] - a[0] + b[0], o[1] - a[1] + b[1]],
    ];
  }
  return c.map((p) => [p[0], p[1]] as Vec2);
}

/**
 * 구 모양 메시: 사각형 h 안에 꼭 맞는 공의 앞면을 경선·위선 격자로 덮는다 (정사영).
 * 격자 매개변수 s 는 경도 -90°~90°, t 는 위도 -90°~90° 이므로
 * 메시 테두리가 곧 공의 윤곽(원)이 되고, 위·아래 줄은 극에서 한 점으로 모인다.
 * n 은 홀수로 해야 적도·중앙 경선이 격자점 위에 온다.
 */
export function sphereMesh(h: Mat3, n = 9): Mesh {
  const points: Vec2[] = [];
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const lon = (c / (n - 1) - 0.5) * Math.PI;
      const lat = (r / (n - 1) - 0.5) * Math.PI;
      const x = Math.cos(lat) * Math.sin(lon);
      const y = Math.sin(lat);
      points.push(applyHomography(h, [(x + 1) / 2, (y + 1) / 2]));
    }
  }
  return { cols: n, rows: n, points };
}

/** 메시 바깥 테두리를 따라 찍은 점 (편집기 외곽선·선택 판정용) */
export function meshOutline(mesh: Mesh, perEdge = 8): Vec2[] {
  const out: Vec2[] = [];
  const n = perEdge * Math.max(mesh.cols - 1, mesh.rows - 1);
  for (let k = 0; k < n; k++) out.push(evaluateMesh(mesh, k / n, 0));
  for (let k = 0; k < n; k++) out.push(evaluateMesh(mesh, 1, k / n));
  for (let k = 0; k < n; k++) out.push(evaluateMesh(mesh, 1 - k / n, 1));
  for (let k = 0; k < n; k++) out.push(evaluateMesh(mesh, 0, 1 - k / n));
  return out;
}

export interface MeshGeometry {
  /** 정점 출력 좌표 (x,y) */
  positions: Float32Array;
  /** 정점 격자 매개변수 (s,t) — 텍스처 좌표 계산용 */
  params: Float32Array;
  indices: Uint16Array;
}

/** 렌더링용 세분 격자 (기본 32×32 칸) */
export function subdivideMesh(mesh: Mesh, res = 32): MeshGeometry {
  const n = res + 1;
  const positions = new Float32Array(n * n * 2);
  const params = new Float32Array(n * n * 2);
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const s = c / res;
      const t = r / res;
      const p = evaluateMesh(mesh, s, t);
      const k = (r * n + c) * 2;
      positions[k] = p[0];
      positions[k + 1] = p[1];
      params[k] = s;
      params[k + 1] = t;
    }
  }
  const indices = new Uint16Array(res * res * 6);
  let k = 0;
  for (let r = 0; r < res; r++) {
    for (let c = 0; c < res; c++) {
      const a = r * n + c;
      indices.set([a, a + 1, a + n + 1, a, a + n + 1, a + n], k);
      k += 6;
    }
  }
  return { positions, params, indices };
}
