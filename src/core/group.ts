// 여러 점을 한꺼번에 다루는 계산: 크기 조절 상자, 원으로 맞추기, 겹친 점, 사각형 선택, 메시 줄·열.
// 상자는 출력 픽셀 기준으로 계산한다 (16:9 화면에서도 "원"이 픽셀상 원이 되도록).

import type { Vec2 } from './homography';
import type { Mesh } from './mesh';

/** 출력 픽셀 기준 상자 */
export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export type BoxHandle = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw' | 'move';

export const BOX_HANDLES: BoxHandle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w', 'move'];

const MIN_PX = 4;

export function boxOf(points: readonly Vec2[], W: number, H: number): Box {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [x, y] of points) {
    x0 = Math.min(x0, x * W);
    y0 = Math.min(y0, y * H);
    x1 = Math.max(x1, x * W);
    y1 = Math.max(y1, y * H);
  }
  return { x0, y0, x1, y1 };
}

/** 상자 손잡이 위치 (출력 px) */
export function handlePos(b: Box, h: BoxHandle): Vec2 {
  const cx = (b.x0 + b.x1) / 2;
  const cy = (b.y0 + b.y1) / 2;
  if (h === 'move') return [cx, cy]; // 'move' 에도 e 가 들어 있으니 먼저 처리
  const x = h.includes('w') ? b.x0 : h.includes('e') ? b.x1 : cx;
  const y = h.startsWith('n') ? b.y0 : h.startsWith('s') ? b.y1 : cy;
  return [x, y];
}

/**
 * 손잡이를 (dx, dy) 출력 px 만큼 끈 뒤의 새 상자.
 * 변(n·s·e·w): 그쪽만 늘고 줄며 맞은편 변은 고정. 모서리: 맞은편 모서리 고정, 가로세로 비율 유지.
 * move: 통째로 이동. 너무 작아지거나 뒤집히지 않게 최소 4px.
 */
export function dragBox(b: Box, h: BoxHandle, dx: number, dy: number): Box {
  if (h === 'move') return { x0: b.x0 + dx, y0: b.y0 + dy, x1: b.x1 + dx, y1: b.y1 + dy };
  const w = Math.max(b.x1 - b.x0, 1e-9);
  const hh = Math.max(b.y1 - b.y0, 1e-9);
  const n = { ...b };
  if (h.length === 1) {
    if (h === 'n') n.y0 = Math.min(b.y0 + dy, b.y1 - MIN_PX);
    if (h === 's') n.y1 = Math.max(b.y1 + dy, b.y0 + MIN_PX);
    if (h === 'w') n.x0 = Math.min(b.x0 + dx, b.x1 - MIN_PX);
    if (h === 'e') n.x1 = Math.max(b.x1 + dx, b.x0 + MIN_PX);
    return n;
  }
  // 모서리: 끈 방향으로 늘어난 비율의 평균으로 가로·세로를 같이 키운다
  const sx = (w + (h.includes('e') ? dx : -dx)) / w;
  const sy = (hh + (h.startsWith('s') ? dy : -dy)) / hh;
  const s = Math.max((sx + sy) / 2, MIN_PX / Math.min(w, hh));
  const nw = w * s;
  const nh = hh * s;
  if (h.includes('e')) n.x1 = b.x0 + nw;
  else n.x0 = b.x1 - nw;
  if (h.startsWith('s')) n.y1 = b.y0 + nh;
  else n.y0 = b.y1 - nh;
  return n;
}

/** 상자 a 를 상자 b 로 옮기는 변환 (정규화 좌표 점에 적용) */
export function boxMap(a: Box, b: Box, W: number, H: number): (p: Vec2) => Vec2 {
  const sx = (b.x1 - b.x0) / Math.max(a.x1 - a.x0, 1e-9);
  const sy = (b.y1 - b.y0) / Math.max(a.y1 - a.y0, 1e-9);
  // 점이 한 줄로 늘어선 경우(폭 0)에는 그 방향은 이동만
  const fx = a.x1 - a.x0 < 1e-9 ? (x: number) => x + (b.x0 - a.x0) : (x: number) => b.x0 + (x - a.x0) * sx;
  const fy = a.y1 - a.y0 < 1e-9 ? (y: number) => y + (b.y0 - a.y0) : (y: number) => b.y0 + (y - a.y0) * sy;
  return ([x, y]) => [fx(x * W) / W, fy(y * H) / H];
}

/** 가운데를 그대로 두고 가로·세로 픽셀 길이를 평균으로 맞춘 상자 (타원 → 원) */
export function circleBox(b: Box): Box {
  const cx = (b.x0 + b.x1) / 2;
  const cy = (b.y0 + b.y1) / 2;
  const r = (b.x1 - b.x0 + (b.y1 - b.y0)) / 4;
  return { x0: cx - r, y0: cy - r, x1: cx + r, y1: cy + r };
}

/** i 번 점과 같은 자리에 겹친 점들 (구의 극처럼). i 자신 포함 */
export function coincident(points: readonly Vec2[], i: number, eps = 1e-9): number[] {
  const p = points[i];
  if (!p) return [];
  const out: number[] = [];
  points.forEach((q, k) => {
    if (Math.abs(q[0] - p[0]) < eps && Math.abs(q[1] - p[1]) < eps) out.push(k);
  });
  return out;
}

/** 정규화 좌표 사각형(두 꼭짓점) 안의 점 번호 */
export function pointsInRect(points: readonly Vec2[], a: Vec2, b: Vec2): number[] {
  const x0 = Math.min(a[0], b[0]);
  const x1 = Math.max(a[0], b[0]);
  const y0 = Math.min(a[1], b[1]);
  const y1 = Math.max(a[1], b[1]);
  const out: number[] = [];
  points.forEach(([x, y], k) => {
    if (x >= x0 && x <= x1 && y >= y0 && y <= y1) out.push(k);
  });
  return out;
}

/** 메시에서 i 번 점이 있는 가로줄(row) 또는 세로줄(col)의 점 번호 */
export function meshLine(mesh: Mesh, i: number, axis: 'row' | 'col'): number[] {
  const r = Math.floor(i / mesh.cols);
  const c = i % mesh.cols;
  const out: number[] = [];
  if (axis === 'row') for (let k = 0; k < mesh.cols; k++) out.push(r * mesh.cols + k);
  else for (let k = 0; k < mesh.rows; k++) out.push(k * mesh.cols + c);
  return out;
}
