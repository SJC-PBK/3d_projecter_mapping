// 워프·마스크·효과 GLSL. 면 하나를 그릴 때 쓰는 프로그램 하나로 모든 면 종류를 처리한다.

export const MAX_MASK_POINTS = 32;

/**
 * 정점 셰이더.
 * aXY 를 uH(3×3)로 변환해 동차좌표 (x·w, y·w, w) 를 얻고 그대로 gl_Position.w 에 w 를 넣는다.
 * → GPU 의 원근 보정 보간이 vST 를 정확한 호모그래피 매개변수로 보간해 주므로
 *   두 삼각형 사이 대각선에서 꺾임이 생기지 않는다.
 * 좌표계: 0~1 정규화, y 아래 방향 → 클립 공간 [-1,1], y 위 방향.
 */
export const WARP_VS = /* glsl */ `#version 300 es
in vec2 aXY;
in vec2 aST;
uniform mat3 uH;
out vec2 vST;
void main() {
  vec3 p = uH * vec3(aXY, 1.0);
  vST = aST;
  gl_Position = vec4(2.0 * p.x - p.z, p.z - 2.0 * p.y, 0.0, p.z);
}
`;

/** 프래그먼트 셰이더. uMode: 0 텍스처, 1 단색, 2 스캔라인, 3 노이즈, 4 단색 깜빡임, 5 빈 소스 표시, 6 전체 화면 세팅 격자, 7 면 격자(두께 조절) */
export const WARP_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vST;
out vec4 outColor;

uniform int uMode;
uniform int uUVMode;          // 0: 사각형 쌍선형, 1: 삼각형 무게중심
uniform vec2 uUV[4];
uniform sampler2D uTex;
uniform vec3 uColor;
uniform float uTime;
uniform float uSpeed;
uniform float uOpacity;
uniform vec2 uOutRes;         // 출력 해상도 (세팅 격자 칸을 출력 px 로 그리려고)
uniform float uLine;          // 면 격자 선 두께 (캔버스 px)
uniform float uBorder;        // 면 격자 테두리 두께 (캔버스 px)
uniform vec2 uCells;          // 면 격자 가로·세로 칸 수

uniform int uMaskCount;       // 0 이면 마스크 없음
uniform vec2 uMask[${MAX_MASK_POINTS}];       // 캔버스 픽셀 좌표 (gl_FragCoord 기준)
uniform float uFeather;       // 캔버스 픽셀

float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float maskAlpha() {
  if (uMaskCount < 3) return 1.0;
  vec2 p = gl_FragCoord.xy;
  bool inside = false;
  float d = 1e9;
  for (int i = 0; i < ${MAX_MASK_POINTS}; i++) {
    if (i >= uMaskCount) break;
    int j = i == 0 ? uMaskCount - 1 : i - 1;
    vec2 a = uMask[i];
    vec2 b = uMask[j];
    if (((a.y > p.y) != (b.y > p.y)) && (p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x)) inside = !inside;
    vec2 ab = b - a;
    float t = clamp(dot(p - a, ab) / max(dot(ab, ab), 1e-6), 0.0, 1.0);
    d = min(d, length(p - (a + ab * t)));
  }
  if (!inside) return 0.0;
  // 페더 0 이면 1px 안티에일리어싱만
  return uFeather > 0.0 ? smoothstep(0.0, uFeather, d) : clamp(d + 0.5, 0.0, 1.0);
}

void main() {
  vec2 uv = uUVMode == 1
    ? uUV[0] + vST.x * (uUV[1] - uUV[0]) + vST.y * (uUV[2] - uUV[0])
    : mix(mix(uUV[0], uUV[1], vST.x), mix(uUV[3], uUV[2], vST.x), vST.y);
  float t = uTime * uSpeed;
  vec4 c;
  if (uMode == 0) {
    c = texture(uTex, uv);
  } else if (uMode == 1) {
    c = vec4(uColor, 1.0);
  } else if (uMode == 2) {
    float band = 0.5 + 0.5 * sin((uv.y * 24.0 - t * 2.0) * 6.2831853);
    c = vec4(uColor * smoothstep(0.35, 0.9, band), 1.0);
  } else if (uMode == 3) {
    float n = hash(floor(uv * vec2(160.0, 90.0)) + floor(t * 24.0));
    c = vec4(uColor * n, 1.0);
  } else if (uMode == 4) {
    c = vec4(uColor * step(0.5, fract(t)), 1.0);
  } else if (uMode == 6) {
    // 세팅 격자: 120px 칸 흰 선, 굵은 테두리, 가운데 십자 (프로젝터가 비추는 범위·중심 확인)
    vec2 p = vST * uOutRes;
    vec2 fw = max(fwidth(p), vec2(1.0));
    vec2 cell = mod(p, 120.0);
    vec2 dl = min(cell, 120.0 - cell);
    float grid = max(step(dl.x, fw.x), step(dl.y, fw.y));
    vec2 e = min(p, uOutRes - p);
    float border = step(min(e.x, e.y), 8.0 * max(fw.x, fw.y));
    vec2 cc = abs(p - uOutRes * 0.5);
    float center = max(step(cc.x, 2.0 * fw.x), step(cc.y, 2.0 * fw.y));
    c = vec4(mix(uColor, vec3(1.0), max(max(grid, border), center)), 1.0);
  } else if (uMode == 7) {
    // 면 격자: 검은 바탕, 가로·세로 uCells 칸(모두 같은 크기), 흰 선·테두리·가운데 십자, 귀퉁이 색 상자.
    // 두께는 화면 px 기준이라 면이 비스듬하거나 작아도 같은 두께로 보인다.
    vec2 fw = max(fwidth(uv), vec2(1e-6));
    vec2 q = uv * uCells;
    vec2 dLine = abs(fract(q + 0.5) - 0.5) / uCells / fw;  // 가장 가까운 격자선까지 (px)
    vec2 dCenter = abs(uv - 0.5) / fw;
    vec2 dEdge = min(uv, 1.0 - uv) / fw;
    float h = uLine * 0.5;
    float line = 1.0 - smoothstep(h - 0.5, h + 0.5, min(dLine.x, dLine.y));
    // 가운데 십자는 칸 수가 짝수인 방향에만 (그래야 격자선과 겹친다 — 홀수면 칸 한가운데를 갈라 칸이 고르지 않아 보임)
    vec2 even = step(0.5, 1.0 - mod(uCells, 2.0));
    vec2 dC = mix(vec2(1e6), dCenter, even);
    float center = 1.0 - smoothstep(h * 1.6 - 0.5, h * 1.6 + 0.5, min(dC.x, dC.y));
    float border = 1.0 - smoothstep(uBorder - 0.5, uBorder + 0.5, min(dEdge.x, dEdge.y));
    vec3 col = uColor * max(max(line, center), border);
    // 귀퉁이 색 상자 (방향 확인): 왼쪽 위 빨강, 오른쪽 위 초록, 오른쪽 아래 파랑, 왼쪽 아래 노랑
    vec2 k = vec2(0.046875, 0.083333);
    if (uv.x < k.x && uv.y < k.y) col = vec3(1.0, 0.235, 0.235);
    else if (uv.x > 1.0 - k.x && uv.y < k.y) col = vec3(0.157, 0.745, 0.275);
    else if (uv.x > 1.0 - k.x && uv.y > 1.0 - k.y) col = vec3(0.235, 0.431, 1.0);
    else if (uv.x < k.x && uv.y > 1.0 - k.y) col = vec3(0.941, 0.745, 0.0);
    c = vec4(col, 1.0);
  } else {
    // 소스가 없거나 아직 불러오는 중: 어두운 빗금
    float s = step(0.5, fract((vST.x + vST.y) * 12.0));
    c = vec4(vec3(0.12 + 0.08 * s), 1.0);
  }
  float a = c.a * uOpacity * maskAlpha();
  outColor = vec4(c.rgb * a, a); // 미리 곱한 알파
}
`;
