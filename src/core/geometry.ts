// 편집 화면의 선택 판정 등에 쓰는 순수 기하 함수.

import type { Vec2 } from './homography';
import { meshOutline } from './mesh';
import type { Surface } from './project';

export function pointInPolygon(p: Vec2, poly: readonly Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!;
    const b = poly[j]!;
    if (a[1] > p[1] !== b[1] > p[1] && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

/** 점 p 와 선분 ab 사이 거리, 그리고 선분 위 가장 가까운 점의 비율 t */
export function distToSegment(p: Vec2, a: Vec2, b: Vec2): { d: number; t: number } {
  const abx = b[0] - a[0];
  const aby = b[1] - a[1];
  const len2 = abx * abx + aby * aby;
  const t = len2 > 0 ? Math.min(1, Math.max(0, ((p[0] - a[0]) * abx + (p[1] - a[1]) * aby) / len2)) : 0;
  return { d: Math.hypot(p[0] - (a[0] + abx * t), p[1] - (a[1] + aby * t)), t };
}

/** 면의 바깥 테두리 */
export function surfaceOutline(s: Surface): Vec2[] {
  return s.kind === 'mesh' && s.mesh ? meshOutline(s.mesh, 6) : s.points;
}

export function centroid(pts: readonly Vec2[]): Vec2 {
  let x = 0;
  let y = 0;
  for (const p of pts) {
    x += p[0];
    y += p[1];
  }
  return [x / pts.length, y / pts.length];
}

/** 모든 점을 (dx, dy) 만큼 옮긴 새 배열 */
export function translate(pts: readonly Vec2[], dx: number, dy: number): Vec2[] {
  return pts.map((p) => [p[0] + dx, p[1] + dy] as Vec2);
}
