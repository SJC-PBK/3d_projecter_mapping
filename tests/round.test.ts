import { describe, expect, it } from 'vitest';
import { unitSquareToQuad, type Vec2 } from '../src/core/homography';
import { evaluateMesh, meshCorners, sphereMesh } from '../src/core/mesh';
import { circleMask, makeQuad, makeTriangle, surfaceToQuad, surfaceToSphere } from '../src/core/project';

const dist = (a: Vec2, b: Vec2) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const SQUARE: Vec2[] = [[0.3, 0.2], [0.5, 0.2], [0.5, 0.4], [0.3, 0.4]]; // 중심 (0.4, 0.3), 반지름 0.1

describe('원형 마스크', () => {
  it('정사각형 면에는 내접원 (중심에서 모두 반지름 거리)', () => {
    const s = { ...makeQuad('a', 'a'), points: SQUARE };
    const m = circleMask(s);
    expect(m).toHaveLength(32);
    for (const p of m) expect(dist(p, [0.4, 0.3])).toBeCloseTo(0.1, 12);
  });

  it('기울어진 사각형에서도 원이 네 변에 닿는다 (변 중점 통과)', () => {
    const quad: Vec2[] = [[0.31, 0.42], [0.55, 0.38], [0.57, 0.8], [0.3, 0.83]];
    const s = { ...makeQuad('a', 'a'), points: quad };
    const m = circleMask(s);
    // 각도 0 → (1, 0.5) 오른쪽 변 중점(매개변수 기준), 각도 90° → (0.5, 1) 아래 변
    expect(m[0]![0]).toBeGreaterThan(0.54);
    expect(m[8]![1]).toBeGreaterThan(0.79);
  });

  it('정삼각형에는 내접원', () => {
    const r = 0.1;
    const c: Vec2 = [0.5, 0.5];
    const pts: Vec2[] = [0, 1, 2].map((k) => {
      const a = -Math.PI / 2 + (k * 2 * Math.PI) / 3;
      return [c[0] + 2 * r * Math.cos(a), c[1] + 2 * r * Math.sin(a)] as Vec2; // 외접원 반지름 2r → 내접원 r
    });
    const s = { ...makeTriangle('t', 't'), points: [pts[0]!, pts[1]!, pts[2]!] };
    for (const p of circleMask(s)) expect(dist(p, c)).toBeCloseTo(r, 12);
  });
});

describe('구 모양 메시', () => {
  const h = unitSquareToQuad(SQUARE)!;
  const mesh = sphereMesh(h, 9);

  it('테두리 격자점이 모두 공의 윤곽(원) 위에 있다', () => {
    for (let r = 0; r < 9; r++) {
      expect(dist(mesh.points[r * 9]!, [0.4, 0.3])).toBeCloseTo(0.1, 12); // 왼쪽 테두리
      expect(dist(mesh.points[r * 9 + 8]!, [0.4, 0.3])).toBeCloseTo(0.1, 12); // 오른쪽
    }
  });

  it('가운데 격자점이 공의 중심, 위·아래 줄은 극 한 점', () => {
    expect(dist(evaluateMesh(mesh, 0.5, 0.5), [0.4, 0.3])).toBeLessThan(1e-12);
    for (let c = 0; c < 9; c++) {
      expect(dist(mesh.points[c]!, [0.4, 0.2])).toBeLessThan(1e-12);
      expect(dist(mesh.points[72 + c]!, [0.4, 0.4])).toBeLessThan(1e-12);
    }
  });

  it('귀퉁이는 공을 감싸는 정사각형으로 복원된다 (사각형으로 되돌리기)', () => {
    meshCorners(mesh).forEach((p, i) => expect(dist(p, SQUARE[i]!)).toBeLessThan(1e-12));
    const s = surfaceToSphere({ ...makeQuad('a', 'a'), points: SQUARE });
    expect(s.kind).toBe('mesh');
    surfaceToQuad(s).points.forEach((p, i) => expect(dist(p, SQUARE[i]!)).toBeLessThan(1e-12));
  });

  it('보간된 곡면도 원 안에 머문다', () => {
    for (let k = 0; k <= 20; k++) {
      for (let j = 0; j <= 20; j++) expect(dist(evaluateMesh(mesh, k / 20, j / 20), [0.4, 0.3])).toBeLessThan(0.1 + 2e-3);
    }
  });
});
