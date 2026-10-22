// 호모그래피(3×3 투시 변환) 계산. DOM·WebGL 에 의존하지 않는 순수 함수만 둔다.
// 행렬은 행 우선(row-major) 길이 9 배열로 다룬다: [h0 h1 h2; h3 h4 h5; h6 h7 h8]

export type Vec2 = [number, number];
export type Mat3 = [number, number, number, number, number, number, number, number, number];

/** 단위 정사각형의 네 꼭짓점 (좌상 → 우상 → 우하 → 좌하, y 는 아래 방향) */
export const UNIT_SQUARE: readonly Vec2[] = [
  [0, 0],
  [1, 0],
  [1, 1],
  [0, 1],
];

export const IDENTITY: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

/**
 * 연립방정식 A·x = b 를 부분 피벗 가우스 소거로 푼다.
 * 특이 행렬이면 null.
 */
function solveLinear(a: number[][], b: number[]): number[] | null {
  const n = b.length;
  const m = a.map((row, i) => [...row, b[i]!]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(m[r]![col]!) > Math.abs(m[pivot]![col]!)) pivot = r;
    }
    if (Math.abs(m[pivot]![col]!) < 1e-12) return null;
    [m[col], m[pivot]] = [m[pivot]!, m[col]!];
    const pr = m[col]!;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const row = m[r]!;
      const f = row[col]! / pr[col]!;
      if (f === 0) continue;
      for (let c = col; c <= n; c++) row[c]! -= f * pr[c]!;
    }
  }
  return m.map((row, i) => row[n]! / row[i]!);
}

/**
 * 네 점 src[i] → dst[i] 대응을 만족하는 호모그래피 H 를 구한다 (h8 = 1 로 고정한 8미지수 선형식).
 * 세 점이 한 직선 위에 있는 등 퇴화한 경우 null.
 */
export function solveHomography(src: readonly Vec2[], dst: readonly Vec2[]): Mat3 | null {
  if (src.length !== 4 || dst.length !== 4) throw new Error('호모그래피는 점 4개가 필요합니다');
  const a: number[][] = [];
  const b: number[] = [];
  for (let i = 0; i < 4; i++) {
    const [u, v] = src[i]!;
    const [x, y] = dst[i]!;
    a.push([u, v, 1, 0, 0, 0, -u * x, -v * x]);
    b.push(x);
    a.push([0, 0, 0, u, v, 1, -u * y, -v * y]);
    b.push(y);
  }
  const h = solveLinear(a, b);
  if (!h) return null;
  return [h[0]!, h[1]!, h[2]!, h[3]!, h[4]!, h[5]!, h[6]!, h[7]!, 1];
}

/** 단위 정사각형 → 사각형 dst 호모그래피. 렌더러가 정점 셰이더에 넘긴다. */
export function unitSquareToQuad(dst: readonly Vec2[]): Mat3 | null {
  const h = solveHomography(UNIT_SQUARE, dst);
  if (!h) return null;
  // 면 중심의 동차좌표 w 가 양수가 되도록 부호를 맞춘다 (음수면 GPU 가 클리핑해 버린다).
  const w = h[6] * 0.5 + h[7] * 0.5 + h[8];
  return w < 0 ? (h.map((x) => -x) as Mat3) : h;
}

/** 점 p 에 H 를 적용한 결과 (동차 나눗셈 포함) */
export function applyHomography(h: Mat3, p: Vec2): Vec2 {
  const [u, v] = p;
  const w = h[6] * u + h[7] * v + h[8];
  return [(h[0] * u + h[1] * v + h[2]) / w, (h[3] * u + h[4] * v + h[5]) / w];
}

/** 3×3 역행렬. 특이 행렬이면 null. */
export function invert3(m: Mat3): Mat3 | null {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-15) return null;
  const k = 1 / det;
  return [
    A * k,
    -(b * i - c * h) * k,
    (b * f - c * e) * k,
    B * k,
    (a * i - c * g) * k,
    -(a * f - c * d) * k,
    C * k,
    -(a * h - b * g) * k,
    (a * e - b * d) * k,
  ];
}

/** 단위 삼각형 (0,0),(1,0),(0,1) → 삼각형 dst 아핀 변환 */
export function affineFromTriangle(dst: readonly Vec2[]): Mat3 {
  const [p0, p1, p2] = dst as [Vec2, Vec2, Vec2];
  return [p1[0] - p0[0], p2[0] - p0[0], p0[0], p1[1] - p0[1], p2[1] - p0[1], p0[1], 0, 0, 1];
}

/** 사각형이 볼록하고 꼬이지 않았는지 (모든 외적의 부호가 같은지) */
export function isConvexQuad(p: readonly Vec2[]): boolean {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = p[i]!;
    const b = p[(i + 1) % 4]!;
    const c = p[(i + 2) % 4]!;
    const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    if (Math.abs(cross) < 1e-12) return false;
    const s = Math.sign(cross);
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}
