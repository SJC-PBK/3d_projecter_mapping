// 화면 확인용 테스트 패턴(격자·원·체크무늬) PNG 와 샘플 영상을 public/assets/ 에 만든다.
// 실행: npm run assets            (전부. 샘플 영상은 ffmpeg 가 있을 때만)
//       npm run assets -- grid-white   (이름을 주면 그 패턴만)

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';

const OUT = join(import.meta.dirname, '..', 'public', 'assets');
const W = 1920;
const H = 1080;

type Pixel = (x: number, y: number) => [number, number, number];

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function png(pixel: Pixel): Buffer {
  const raw = Buffer.alloc((W * 3 + 1) * H);
  for (let y = 0; y < H; y++) {
    const row = y * (W * 3 + 1);
    raw[row] = 0;
    for (let x = 0; x < W; x++) raw.set(pixel(x, y), row + 1 + x * 3);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; // 비트 깊이
  ihdr[9] = 2; // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const WHITE: [number, number, number] = [255, 255, 255];
const BLACK: [number, number, number] = [0, 0, 0];
const CELL = 120; // 16 × 9 칸

// 격자: 검은 바탕에 흰 선 16×9 칸, 굵은 테두리, 가운데 십자, 귀퉁이 색 표시(방향 확인용)
const grid: Pixel = (x, y) => {
  const corner = 90;
  if (x < corner && y < corner) return [255, 60, 60]; // 좌상 빨강
  if (x >= W - corner && y < corner) return [60, 220, 60]; // 우상 초록
  if (x >= W - corner && y >= H - corner) return [70, 120, 255]; // 우하 파랑
  if (x < corner && y >= H - corner) return [255, 220, 0]; // 좌하 노랑
  const border = x < 8 || y < 8 || x >= W - 8 || y >= H - 8;
  const line = x % CELL < 3 || y % CELL < 3 || x % CELL >= CELL - 2 || y % CELL >= CELL - 2;
  const cross = Math.abs(x - W / 2) < 3 || Math.abs(y - H / 2) < 3;
  const diag = Math.abs(x * H - y * W) < 2.5 * W || Math.abs((W - x) * H - y * W) < 2.5 * W;
  if (border || cross) return WHITE;
  if (diag) return [0, 200, 255];
  return line ? [200, 200, 200] : BLACK;
};

// 기본 격자 (파일 이름은 예전 그대로 grid-white): 새 면의 기본 소스.
// 검은 바탕에 흰 격자선, 굵은 흰 테두리, 가운데 흰 십자, 귀퉁이 색 표시(방향 확인용). 투사했을 때 면의 각도가 잘 보인다.
const gridWhite: Pixel = (x, y) => {
  const corner = 90;
  if (x < corner && y < corner) return [255, 60, 60];
  if (x >= W - corner && y < corner) return [40, 190, 70];
  if (x >= W - corner && y >= H - corner) return [60, 110, 255];
  if (x < corner && y >= H - corner) return [240, 190, 0];
  if (x < 14 || y < 14 || x >= W - 14 || y >= H - 14) return WHITE;
  // 격자를 화면 가운데 기준으로 놓아 모든 칸이 같은 크기가 되게 한다. 가운데 십자선은 조금 더 굵게
  const dx = Math.abs(x - W / 2);
  const dy = Math.abs(y - H / 2);
  if (dx < 4 || dy < 4) return WHITE;
  const near = (d: number) => d % CELL < 2 || d % CELL > CELL - 2;
  return near(dx) || near(dy) ? WHITE : BLACK;
};

// 체크무늬: 16×9 칸 흑백
const checker: Pixel = (x, y) => ((Math.floor(x / CELL) + Math.floor(y / CELL)) % 2 ? WHITE : BLACK);

// 원: 동심원 + 칸마다 작은 원 (원이 타원으로 찌그러지면 비율이 틀린 것)
const circles: Pixel = (x, y) => {
  const r = Math.hypot(x - W / 2, y - H / 2);
  if (r % 90 < 4) return WHITE;
  const cx = (x % CELL) - CELL / 2;
  const cy = (y % CELL) - CELL / 2;
  const rr = Math.hypot(cx, cy);
  if (rr < 40 && rr > 36) return [255, 140, 0];
  return BLACK;
};

const only = process.argv.slice(2);
for (const [name, fn] of [['grid', grid], ['grid-white', gridWhite], ['checker', checker], ['circles', circles]] as const) {
  if (only.length && !only.includes(name)) continue;
  const file = join(OUT, `${name}.png`);
  writeFileSync(file, png(fn));
  console.log('만듦:', file);
}

// 샘플 영상: ffmpeg 내장 테스트 신호 (저작권 없음). 10초 반복, 1280×720, 소리 없음.
if (!only.length || only.includes('sample')) try {
  const file = join(OUT, 'sample.mp4');
  execFileSync('ffmpeg', [
    '-y', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30:duration=10',
    '-c:v', 'libx264', '-profile:v', 'baseline', '-pix_fmt', 'yuv420p', '-crf', '28',
    '-movflags', '+faststart', '-an', file,
  ]);
  console.log('만듦:', file);
} catch {
  console.warn('ffmpeg 가 없어 샘플 영상은 건너뜀');
}
