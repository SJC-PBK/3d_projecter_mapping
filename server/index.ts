// 정적 파일 + WebSocket 중계 서버. 시작하면 LAN 주소와 리모컨 QR 코드를 출력한다.
//   npm run dev   → Vite 개발 서버를 미들웨어로 붙여 실행
//   npm start     → dist/ (npm run build 결과)를 그대로 내보냄 — 인터넷 없이 동작
// 환경변수: PORT (기본 5200), HOST (기본 0.0.0.0), MEDIA_DIR (올린 파일 폴더, 기본 ./media),
//           STATE_FILE (지금 매핑을 저장할 파일, 기본 ./data/project.json — 다시 시작해도 매핑이 남는다)

import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { networkInterfaces } from 'node:os';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import qrcode from 'qrcode-terminal';
import { WebSocket, WebSocketServer } from 'ws';
import { applyOp, type Message, type Role } from '../src/core/ops.ts';
import type { Project } from '../src/core/project.ts';

const ROOT = resolve(import.meta.dirname, '..');
const DEV = process.argv.includes('--dev');
const PORT = Number(process.env.PORT ?? 5200);
const HOST = process.env.HOST ?? '0.0.0.0';
const DIST = join(ROOT, 'dist');
const MEDIA = resolve(process.env.MEDIA_DIR ?? join(ROOT, 'media'));
const STATE_FILE = resolve(process.env.STATE_FILE ?? join(ROOT, 'data', 'project.json'));
const MAX_UPLOAD = 300 * 1024 * 1024; // 300MB (사내망 누구나 올릴 수 있으므로 제한)

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};
const MEDIA_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.mp4', '.webm', '.mov']);

// ---------- 배포 버전 ----------
// 화면마다 빌드된 스크립트 파일 이름(코드가 바뀌면 이름의 해시가 바뀐다). 접속한 화면이 자기 것과 비교해
// 다르면 옛 화면이므로 새로고침한다 (프로젝터에 띄워 둔 출력 화면이 배포 뒤에도 옛 코드로 남지 않게).
// 개발 모드에서는 Vite 가 바로 바꿔 주므로 null.
function readBuilds(): Record<string, string | null> {
  const out: Record<string, string | null> = { editor: null, output: null, remote: null };
  if (DEV) return out;
  for (const role of Object.keys(out)) {
    try {
      const html = readFileSync(join(DIST, role, 'index.html'), 'utf8');
      out[role] = /<script[^>]+src="\/assets\/([^"]+\.js)"/.exec(html)?.[1] ?? null;
    } catch {
      out[role] = null;
    }
  }
  return out;
}
const builds = readBuilds();

// ---------- 공유 상태 ----------

const serverId = `server-${Math.random().toString(36).slice(2, 8)}`;
let seq = 0;
// 서버가 기준으로 들고 있는 매핑. 파일에도 저장해 서비스를 다시 시작해도 잃지 않는다
// (2026-10-22: 메모리에만 두었더니 재시작 직후 처음 붙은 빈 편집기가 기준이 되어 매핑이 기본값으로 바뀐 일이 있었다)
let project: Project | null = loadState();

function loadState(): Project | null {
  try {
    const p = JSON.parse(readFileSync(STATE_FILE, 'utf8')) as Project;
    return p && Array.isArray(p.surfaces) && Array.isArray(p.sources) ? p : null;
  } catch {
    return null;
  }
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
/** 잦은 변경(드래그)은 0.5초 모아서 저장. 임시 파일에 쓰고 바꿔치기 해 반쯤 쓴 파일이 남지 않게 */
function saveState(): void {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    if (!project) return;
    try {
      mkdirSync(join(STATE_FILE, '..'), { recursive: true });
      writeFileSync(`${STATE_FILE}.tmp`, JSON.stringify(project));
      renameSync(`${STATE_FILE}.tmp`, STATE_FILE);
    } catch (err) {
      console.error('매핑 저장 실패', err);
    }
  }, 500);
}
const roles = new Map<WebSocket, Role>();

function send(ws: WebSocket, msg: Message): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function fullMessage(): Message | null {
  return project ? { kind: 'op', from: serverId, seq: ++seq, op: { type: 'full', project }, sentAt: Date.now() } : null;
}

function broadcastPeers(): void {
  const peers: Record<Role, number> = { editor: 0, output: 0, remote: 0 };
  for (const r of roles.values()) peers[r]++;
  for (const ws of roles.keys()) send(ws, { kind: 'peers', from: serverId, peers });
}

function onMessage(ws: WebSocket, raw: string): void {
  let msg: Message;
  try {
    msg = JSON.parse(raw) as Message;
  } catch {
    return;
  }
  switch (msg.kind) {
    case 'hello': {
      roles.set(ws, msg.role);
      send(ws, { kind: 'server', build: builds[msg.role] ?? null });
      if (msg.project && (project === null || msg.push)) {
        // 서버가 비었거나, 끊긴 동안 고친 내용 → 이 상태를 기준으로 삼고 모두에게 알린다
        project = msg.project;
        saveState();
        const full = fullMessage()!;
        for (const other of roles.keys()) if (other !== ws) send(other, full);
      }
      // 접속한 화면에는 언제나 현재 기준 상태를 보낸다
      const full = fullMessage();
      if (full) send(ws, full);
      broadcastPeers();
      return;
    }
    case 'op':
      if (!project) return;
      project = applyOp(project, msg.op);
      saveState();
      for (const other of roles.keys()) if (other !== ws) send(other, msg);
      return;
    case 'ping':
      send(ws, { kind: 'pong', t: msg.t });
      return;
    default:
      return;
  }
}

// ---------- HTTP ----------

function safeJoin(base: string, urlPath: string): string | null {
  const p = normalize(join(base, decodeURIComponent(urlPath)));
  return p === base || p.startsWith(base + sep) ? p : null;
}

function serveFile(res: http.ServerResponse, file: string, req: http.IncomingMessage): void {
  const st = statSync(file);
  const type = MIME[extname(file).toLowerCase()] ?? 'application/octet-stream';
  // 이름에 해시가 붙은 빌드 파일(editor-AbC123.js)은 오래 캐시, 나머지(HTML·테스트 패턴·올린 파일)는
  // 매번 바뀌었는지 묻게 한다 — 같은 이름으로 그림을 바꿔도 옛 그림이 남지 않게
  const hashed = /-[A-Za-z0-9_-]{8}\.(js|css)$/.test(file);
  const lastModified = st.mtime.toUTCString();
  const cache = { 'Cache-Control': hashed ? 'public, max-age=31536000, immutable' : 'no-cache', 'Last-Modified': lastModified };
  const since = req.headers['if-modified-since'];
  if (!hashed && since && Math.floor(st.mtimeMs / 1000) <= Math.floor(Date.parse(since) / 1000)) {
    res.writeHead(304, cache);
    res.end();
    return;
  }
  const range = req.headers.range;
  // 영상 탐색·Safari 재생에 Range 응답이 필요하다
  const m = range ? /bytes=(\d*)-(\d*)/.exec(range) : null;
  if (m) {
    const start = m[1] ? Number(m[1]) : 0;
    const end = m[2] ? Math.min(Number(m[2]), st.size - 1) : st.size - 1;
    res.writeHead(206, {
      'Content-Type': type,
      'Content-Range': `bytes ${start}-${end}/${st.size}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': end - start + 1,
      ...cache,
    });
    createReadStream(file, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': st.size, 'Accept-Ranges': 'bytes', ...cache });
  createReadStream(file).pipe(res);
}

function json(res: http.ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function listMedia(): { name: string; uri: string; type: 'image' | 'video' }[] {
  if (!existsSync(MEDIA)) return [];
  return readdirSync(MEDIA)
    .filter((n) => MEDIA_EXT.has(extname(n).toLowerCase()))
    .sort()
    .map((name) => ({
      name,
      uri: `/media/${encodeURIComponent(name)}`,
      type: ['.mp4', '.webm', '.mov'].includes(extname(name).toLowerCase()) ? ('video' as const) : ('image' as const),
    }));
}

async function upload(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
  const original = url.searchParams.get('name') ?? 'file';
  const ext = extname(original).toLowerCase();
  if (!MEDIA_EXT.has(ext)) return json(res, 400, { error: '이미지(png·jpg·gif·webp·svg) 또는 영상(mp4·webm·mov)만 올릴 수 있습니다' });
  const size = Number(req.headers['content-length'] ?? 0);
  if (size > MAX_UPLOAD) return json(res, 413, { error: '300MB 이하 파일만 올릴 수 있습니다' });
  mkdirSync(MEDIA, { recursive: true });
  // 파일 이름에서 경로·특수문자 제거, 같은 이름이 있으면 번호를 붙인다
  const stem = original.slice(0, original.length - ext.length).replace(/[^\p{L}\p{N}_-]+/gu, '_').slice(0, 60) || 'file';
  let name = `${stem}${ext}`;
  for (let n = 2; existsSync(join(MEDIA, name)); n++) name = `${stem}-${n}${ext}`;
  // 크기를 미리 알리지 않은 요청도 받는 도중 300MB 를 넘으면 끊고 지운다
  let received = 0;
  const limit = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      received += chunk.length;
      cb(received > MAX_UPLOAD ? new Error('too-large') : null, chunk);
    },
  });
  try {
    await pipeline(req, limit, createWriteStream(join(MEDIA, name)));
  } catch (err) {
    rmSync(join(MEDIA, name), { force: true });
    if (err instanceof Error && err.message === 'too-large') return json(res, 413, { error: '300MB 이하 파일만 올릴 수 있습니다' });
    throw err;
  }
  json(res, 200, { name, uri: `/media/${encodeURIComponent(name)}`, type: ['.mp4', '.webm', '.mov'].includes(ext) ? 'video' : 'image' });
}

type Next = () => void;
type Handler = (req: http.IncomingMessage, res: http.ServerResponse, next: Next) => void;

/** /api/*, /media/* 와 화면 주소 정리 (vite 보다 먼저) */
const appRoutes: Handler = (req, res, next) => {
  const url = new URL(req.url ?? '/', 'http://x');
  const path = url.pathname;
  if (/^\/(output|editor|remote)$/.test(path)) {
    res.writeHead(302, { Location: `${path}/${url.search}` });
    res.end();
    return;
  }
  if (path === '/api/media' && req.method === 'GET') return json(res, 200, listMedia());
  if (path === '/api/upload' && req.method === 'POST') {
    upload(req, res, url).catch((err: unknown) => json(res, 500, { error: String(err) }));
    return;
  }
  if (path.startsWith('/media/')) {
    const file = safeJoin(MEDIA, path.slice('/media/'.length));
    if (file && existsSync(file) && statSync(file).isFile()) return serveFile(res, file, req);
    res.writeHead(404).end();
    return;
  }
  next();
};

/** 빌드 결과(dist) 내보내기 */
const staticDist: Handler = (req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  let file = safeJoin(DIST, url.pathname);
  if (file && existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
  if (file && existsSync(file)) return serveFile(res, file, req);
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('없는 주소입니다');
};

const server = http.createServer();
let fallback: Handler = staticDist;

if (DEV) {
  const { createServer } = await import('vite');
  const vite = await createServer({ root: ROOT, appType: 'mpa', server: { middlewareMode: true, hmr: { server } } });
  fallback = (req, res, next) => vite.middlewares(req, res, next);
} else if (!existsSync(join(DIST, 'index.html'))) {
  console.error('dist/ 가 없습니다. 먼저 npm run build 를 실행하세요 (개발 중이면 npm run dev).');
  process.exit(1);
}

server.on('request', (req, res) => {
  appRoutes(req, res, () =>
    fallback(req, res, () => {
      res.writeHead(404).end();
    }),
  );
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 50 * 1024 * 1024 });
server.on('upgrade', (req, socket, head) => {
  if (new URL(req.url ?? '/', 'http://x').pathname !== '/ws') return; // vite HMR 등은 각자 처리
  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.on('message', (data) => onMessage(ws, String(data)));
    ws.on('close', () => {
      roles.delete(ws);
      broadcastPeers();
    });
  });
});

server.listen(PORT, HOST, () => {
  // 이 PC 에서만 열었으면(HOST=127.0.0.1) 같은 망 주소를 안내하지 않는다
  const loopbackOnly = HOST === '127.0.0.1' || HOST === 'localhost';
  const lan = loopbackOnly
    ? []
    : Object.values(networkInterfaces())
        .flat()
        .filter((a) => a && a.family === 'IPv4' && !a.internal)
        .map((a) => a!.address);
  const base = (h: string) => `http://${h}:${PORT}`;
  console.log(`\n프로젝션 매퍼 ${DEV ? '(개발 모드)' : ''} 실행 중\n`);
  console.log(`  이 PC     ${base('localhost')}/`);
  for (const ip of lan) console.log(`  같은 망   ${base(ip)}/`);
  console.log('\n  출력 화면 /output/   편집기 /editor/   폰 리모컨 /remote/');
  if (lan[0]) {
    console.log(`\n폰으로 아래 QR 을 찍으면 리모컨이 열립니다 (${base(lan[0])}/remote/)\n`);
    qrcode.generate(`${base(lan[0])}/remote/`, { small: true });
  }
});
