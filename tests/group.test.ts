import { describe, expect, it } from 'vitest';
import { boxMap, boxOf, circleBox, coincident, dragBox, handlePos, meshLine, pointsInRect } from '../src/core/group';
import { unitSquareToQuad, type Vec2 } from '../src/core/homography';
import { sphereMesh } from '../src/core/mesh';

const W = 1920;
const H = 1080;
const px = (p: Vec2): Vec2 => [p[0] * W, p[1] * H];

describe('크기 조절 상자', () => {
  const pts: Vec2[] = [[0.25, 0.25], [0.5, 0.25], [0.5, 0.75], [0.25, 0.75]]; // 480×540px, x 480~960, y 270~810
  const b = boxOf(pts, W, H);

  it('상자는 출력 픽셀 기준', () => {
    expect(b).toEqual({ x0: 480, y0: 270, x1: 960, y1: 810 });
    expect(handlePos(b, 'n')).toEqual([720, 270]);
    expect(handlePos(b, 'se')).toEqual([960, 810]);
    expect(handlePos(b, 'move')).toEqual([720, 540]); // 가운데
    expect(handlePos(b, 'e')).toEqual([960, 540]);
  });

  it('위 변을 끌면 위쪽만 늘고 아래 변은 고정', () => {
    const nb = dragBox(b, 'n', 999, -100);
    expect(nb).toEqual({ x0: 480, y0: 170, x1: 960, y1: 810 });
    const f = boxMap(b, nb, W, H);
    expect(px(f(pts[2]!))).toEqual([960, 810]); // 아래 점은 그대로
    expect(px(f(pts[0]!))[1]).toBeCloseTo(170, 9);
  });

  it('모서리는 맞은편 모서리를 고정하고 비율을 유지', () => {
    const nb = dragBox(b, 'se', 48, 54); // 가로 10%, 세로 10%
    expect(nb.x0).toBe(480);
    expect(nb.y0).toBe(270);
    expect((nb.x1 - nb.x0) / (nb.y1 - nb.y0)).toBeCloseTo(480 / 540, 9);
    expect(nb.x1 - nb.x0).toBeCloseTo(528, 9);
  });

  it('반대로 끌어도 뒤집히지 않는다 (최소 4px)', () => {
    const nb = dragBox(b, 'e', -5000, 0);
    expect(nb.x1 - nb.x0).toBe(4);
  });

  it('상자 변환은 안쪽 점의 상대 위치를 유지한다', () => {
    const inner: Vec2 = [0.375, 0.5]; // 상자 정가운데
    const nb = dragBox(b, 'w', -240, 0);
    const q = px(boxMap(b, nb, W, H)(inner));
    expect(q[0]).toBeCloseTo((nb.x0 + nb.x1) / 2, 9);
    expect(q[1]).toBeCloseTo(540, 9);
  });
});

describe('원으로 맞추기', () => {
  it('정규화 좌표로 정사각형이어도 16:9 화면에서는 타원 → 픽셀상 원으로', () => {
    const h = unitSquareToQuad([[0.3, 0.2], [0.5, 0.2], [0.5, 0.4], [0.3, 0.4]])!; // 384×216px 타원
    const mesh = sphereMesh(h, 9);
    const b = boxOf(mesh.points, W, H);
    const cb = circleBox(b);
    expect(cb.x1 - cb.x0).toBeCloseTo(cb.y1 - cb.y0, 9);
    expect(cb.x1 - cb.x0).toBeCloseTo(300, 9); // (384 + 216) / 2
    const f = boxMap(b, cb, W, H);
    const c = [(cb.x0 + cb.x1) / 2, (cb.y0 + cb.y1) / 2];
    // 바뀐 테두리 점이 모두 같은 반지름(픽셀)
    for (let r = 0; r < 9; r++) {
      const q = px(f(mesh.points[r * 9]!));
      expect(Math.hypot(q[0] - c[0]!, q[1] - c[1]!)).toBeCloseTo(150, 6);
    }
  });
});

describe('점 고르기', () => {
  it('구의 극처럼 겹친 점을 찾는다', () => {
    const mesh = sphereMesh(unitSquareToQuad([[0.3, 0.2], [0.5, 0.2], [0.5, 0.4], [0.3, 0.4]])!, 9);
    expect(coincident(mesh.points, 3)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(coincident(mesh.points, 40)).toEqual([40]); // 가운데 점은 혼자
  });

  it('사각형 안의 점', () => {
    const pts: Vec2[] = [[0.1, 0.1], [0.5, 0.5], [0.9, 0.9]];
    expect(pointsInRect(pts, [0.6, 0.6], [0.2, 0.2])).toEqual([1]);
  });

  it('메시 줄·열', () => {
    const mesh = { cols: 4, rows: 3, points: [] };
    expect(meshLine(mesh, 6, 'row')).toEqual([4, 5, 6, 7]);
    expect(meshLine(mesh, 6, 'col')).toEqual([2, 6, 10]);
  });
});
