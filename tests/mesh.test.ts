import { describe, expect, it } from 'vitest';
import { unitSquareToQuad, applyHomography, type Vec2 } from '../src/core/homography';
import { evaluateMesh, meshFromHomography, resampleMesh, subdivideMesh, type Mesh } from '../src/core/mesh';

const dist = (a: Vec2, b: Vec2) => Math.hypot(a[0] - b[0], a[1] - b[1]);

function wavyMesh(cols: number, rows: number): Mesh {
  const points: Vec2[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      points.push([0.1 + (0.8 * c) / (cols - 1) + 0.03 * Math.sin(r * 1.7 + c), 0.1 + (0.8 * r) / (rows - 1) + 0.02 * Math.cos(c * 2.3)]);
    }
  }
  return { cols, rows, points };
}

describe('메시 보간', () => {
  it.each([[2, 2], [4, 4], [5, 3], [7, 6]])('격자점(%i×%i)을 정확히 지난다', (cols, rows) => {
    const mesh = wavyMesh(cols, rows);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const p = evaluateMesh(mesh, c / (cols - 1), r / (rows - 1));
        expect(dist(p, mesh.points[r * cols + c]!)).toBeLessThan(1e-12);
      }
    }
  });

  it('격자 사이는 연속이다 (칸 경계 양쪽 값이 같다)', () => {
    const mesh = wavyMesh(4, 4);
    const e = 1e-9;
    const left = evaluateMesh(mesh, 1 / 3 - e, 0.4);
    const right = evaluateMesh(mesh, 1 / 3 + e, 0.4);
    expect(dist(left, right)).toBeLessThan(1e-6);
  });

  it('호모그래피로 채운 격자점은 쿼드 위에 있다', () => {
    const quad: Vec2[] = [[0.31, 0.42], [0.55, 0.38], [0.57, 0.8], [0.3, 0.83]];
    const h = unitSquareToQuad(quad)!;
    const mesh = meshFromHomography(h, 4, 4);
    expect(dist(mesh.points[0]!, quad[0]!)).toBeLessThan(1e-9);
    expect(dist(mesh.points[3]!, quad[1]!)).toBeLessThan(1e-9);
    expect(dist(mesh.points[15]!, quad[2]!)).toBeLessThan(1e-9);
    expect(dist(mesh.points[12]!, quad[3]!)).toBeLessThan(1e-9);
    expect(dist(mesh.points[5]!, applyHomography(h, [1 / 3, 1 / 3]))).toBeLessThan(1e-9);
  });

  it('격자 크기를 바꿔도 네 귀퉁이는 유지된다', () => {
    const mesh = wavyMesh(4, 4);
    const m2 = resampleMesh(mesh, 6, 3);
    expect(m2.points).toHaveLength(18);
    expect(dist(m2.points[0]!, mesh.points[0]!)).toBeLessThan(1e-12);
    expect(dist(m2.points[17]!, mesh.points[15]!)).toBeLessThan(1e-12);
  });

  it('세분 격자 크기', () => {
    const g = subdivideMesh(wavyMesh(4, 4), 32);
    expect(g.positions.length).toBe(33 * 33 * 2);
    expect(g.indices.length).toBe(32 * 32 * 6);
    expect(Math.max(...g.indices)).toBe(33 * 33 - 1);
  });
});

import { distToSegment, pointInPolygon } from '../src/core/geometry';

describe('기하 판정', () => {
  it('다각형 안/밖', () => {
    const tri: Vec2[] = [[0.5, 0.1], [0.9, 0.9], [0.1, 0.9]];
    expect(pointInPolygon([0.5, 0.5], tri)).toBe(true);
    expect(pointInPolygon([0.1, 0.1], tri)).toBe(false);
  });
  it('선분까지 거리', () => {
    expect(distToSegment([0.5, 1], [0, 0], [1, 0])).toEqual({ d: 1, t: 0.5 });
  });
});
