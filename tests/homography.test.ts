import { describe, expect, it } from 'vitest';
import {
  affineFromTriangle,
  applyHomography,
  invert3,
  isConvexQuad,
  solveHomography,
  UNIT_SQUARE,
  unitSquareToQuad,
  type Vec2,
} from '../src/core/homography';

const dist = (a: Vec2, b: Vec2) => Math.hypot(a[0] - b[0], a[1] - b[1]);

// 알려진 4점 대응 (원근이 강하게 걸린 사다리꼴 포함)
const CASES: Vec2[][] = [
  [[0.31, 0.42], [0.55, 0.38], [0.57, 0.8], [0.3, 0.83]],
  [[0.1, 0.1], [0.9, 0.2], [0.7, 0.9], [0.2, 0.7]],
  [[0.4, 0.1], [0.6, 0.1], [0.95, 0.9], [0.05, 0.9]],
  [[0, 0], [1, 0], [1, 1], [0, 1]],
];

describe('호모그래피', () => {
  it.each(CASES)('네 꼭짓점을 정확히 대응시킨다 #%#', (...dst) => {
    const h = unitSquareToQuad(dst)!;
    UNIT_SQUARE.forEach((p, i) => expect(dist(applyHomography(h, p), dst[i]!)).toBeLessThan(1e-9));
  });

  it.each(CASES)('역변환 왕복 오차가 1e-6 이내다 #%#', (...dst) => {
    const h = unitSquareToQuad(dst)!;
    const inv = invert3(h)!;
    for (let k = 0; k <= 10; k++) {
      for (let j = 0; j <= 10; j++) {
        const p: Vec2 = [k / 10, j / 10];
        expect(dist(applyHomography(inv, applyHomography(h, p)), p)).toBeLessThan(1e-6);
      }
    }
  });

  it('임의 사각형 → 사각형 대응도 푼다', () => {
    const src: Vec2[] = [[0.2, 0.1], [0.8, 0.15], [0.75, 0.9], [0.1, 0.8]];
    const dst: Vec2[] = [[0.3, 0.3], [0.6, 0.2], [0.7, 0.7], [0.25, 0.6]];
    const h = solveHomography(src, dst)!;
    src.forEach((p, i) => expect(dist(applyHomography(h, p), dst[i]!)).toBeLessThan(1e-9));
  });

  it('직선의 상은 직선이다 (대각선 꺾임이 없다)', () => {
    const h = unitSquareToQuad(CASES[2]!)!;
    // 단위 정사각형의 대각선 위 점들은 변환 후에도 한 직선 위에 있어야 한다
    const a = applyHomography(h, [0, 0]);
    const b = applyHomography(h, [1, 1]);
    for (let k = 1; k < 10; k++) {
      const p = applyHomography(h, [k / 10, k / 10]);
      const cross = (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
      expect(Math.abs(cross)).toBeLessThan(1e-12);
    }
  });

  it('면 중심의 w 가 양수다 (GPU 클리핑 방지)', () => {
    for (const dst of CASES) {
      const h = unitSquareToQuad(dst)!;
      expect(h[6] * 0.5 + h[7] * 0.5 + h[8]).toBeGreaterThan(0);
    }
  });

  it('퇴화한 사각형은 null', () => {
    expect(unitSquareToQuad([[0, 0], [0.5, 0], [1, 0], [0.2, 0]])).toBeNull();
  });

  it('삼각형 아핀 변환', () => {
    const tri: Vec2[] = [[0.5, 0.1], [0.8, 0.5], [0.2, 0.5]];
    const a = affineFromTriangle(tri);
    expect(dist(applyHomography(a, [0, 0]), tri[0]!)).toBeLessThan(1e-12);
    expect(dist(applyHomography(a, [1, 0]), tri[1]!)).toBeLessThan(1e-12);
    expect(dist(applyHomography(a, [0, 1]), tri[2]!)).toBeLessThan(1e-12);
  });

  it('볼록 판정', () => {
    expect(isConvexQuad(CASES[0]!)).toBe(true);
    expect(isConvexQuad([[0, 0], [1, 1], [1, 0], [0, 1]])).toBe(false); // 꼬인 사각형
  });
});
