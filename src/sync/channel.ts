// 화면 사이 동기화. 같은 PC 의 창끼리는 BroadcastChannel, 폰 등 다른 기기는 Node 서버 WebSocket.
// 둘 다 쓸 수 있으면 둘 다 쓰고, (보낸 화면 id, 순번)으로 중복·늦게 도착한 메시지를 버린다.
//
// 상태의 기준:
//  - 서버에 상태가 있으면 서버가 기준. 새로 접속한 화면은 서버 상태를 받는다.
//  - 서버가 비어 있으면(재시작 등) 처음 접속한 편집기·리모컨의 상태가 기준이 된다.
//  - 편집기·리모컨이 연결이 끊긴 동안 고친 내용은 다시 붙을 때 서버로 올린다.

import { mergeOps, type Message, type Op, type Role } from '../core/ops';
import type { Store } from '../core/store';

const BC_NAME = 'projection-mapper';
const FLUSH_MS = 16;

export type WsState = 'off' | 'connecting' | 'open' | 'closed';

export interface SyncStatus {
  ws: WsState;
  /** 서버 왕복 지연 (ms) */
  rtt: number | null;
  /** 서버 기준 역할별 접속 수 */
  peers: Record<Role, number> | null;
}

export interface SyncOptions {
  role: Role;
  store: Store;
  /** false 면 WebSocket 을 쓰지 않는다 (같은 PC 창끼리만) */
  useServer?: boolean;
  onStatus?: (s: SyncStatus) => void;
  /** 서버에 새 버전이 배포돼 이 화면이 옛 코드일 때 (한 번만 부른다) */
  onOutdated?: () => void;
  /** 처음 받은 서버 상태가 이 화면(브라우저 저장)의 매핑과 달라 덮어쓸 때, 덮어쓰기 전 매핑을 넘겨준다 */
  onLocalReplaced?: (previous: import('../core/project').Project, incoming: import('../core/project').Project) => void;
}

export class SyncChannel {
  readonly id = Math.random().toString(36).slice(2, 10);
  private seq = 0;
  private lastSeen = new Map<string, number>();
  private bc: BroadcastChannel | null = null;
  private ws: WebSocket | null = null;
  private pending: Op[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private lastFlush = 0;
  private dirtyOffline = false;
  private retryMs = 500;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private closed = false;
  private outdated = false;
  /** 서버 상태를 받았거나 서버를 쓰지 않는 상태. 그 전에는 로컬(오래됐을 수 있는) 상태를 남에게 알리지 않는다 */
  private synced: boolean;
  readonly status: SyncStatus = { ws: 'off', rtt: null, peers: null };
  /** 마지막으로 받은 원격 변경의 보낸 시각 (시험·지연 측정용) */
  lastRemoteSentAt = 0;

  private opts: SyncOptions;

  constructor(opts: SyncOptions) {
    this.opts = opts;
    this.synced = opts.useServer === false;
    opts.store.subscribe((_p, op, origin) => {
      if (origin === 'local') this.queue(op);
    });
    if ('BroadcastChannel' in window) {
      this.bc = new BroadcastChannel(BC_NAME);
      this.bc.onmessage = (e: MessageEvent<Message>) => this.receive(e.data, 'bc');
      this.bc.postMessage({ kind: 'hello', from: this.id, role: opts.role } satisfies Message);
    }
    if (opts.useServer !== false) this.connect();
  }

  get canEdit(): boolean {
    return this.opts.role !== 'output';
  }

  private setStatus(patch: Partial<SyncStatus>): void {
    Object.assign(this.status, patch);
    this.opts.onStatus?.(this.status);
  }

  // ---------- 보내기 ----------

  private queue(op: Op): void {
    const last = this.pending[this.pending.length - 1];
    const merged = last ? mergeOps(last, op) : null;
    if (merged) this.pending[this.pending.length - 1] = merged;
    else this.pending.push(op);
    if (!this.flushTimer) {
      const wait = Math.max(0, FLUSH_MS - (performance.now() - this.lastFlush));
      this.flushTimer = setTimeout(() => this.flush(), wait);
    }
  }

  /** 모아 둔 변경분을 바로 보낸다 */
  flush(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    this.lastFlush = performance.now();
    const ops = this.pending;
    this.pending = [];
    for (const op of ops) {
      const env: Message = { kind: 'op', from: this.id, seq: ++this.seq, op, sentAt: Date.now() };
      this.bc?.postMessage(env);
      if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(env));
      else if (this.opts.useServer !== false) this.dirtyOffline = true;
    }
  }

  // ---------- 받기 ----------

  private receive(msg: Message, via: 'bc' | 'ws'): void {
    switch (msg.kind) {
      case 'hello':
        // 같은 PC 에서 새 창이 열렸다: 편집 화면이 현재 상태를 알려 준다
        if (via === 'bc' && this.canEdit && this.synced && msg.from !== this.id) {
          this.queue({ type: 'full', project: this.opts.store.project });
          this.flush();
        }
        return;
      case 'op': {
        const last = this.lastSeen.get(msg.from);
        if (last !== undefined && msg.seq <= last) return; // 이미 받았거나 더 오래된 것
        this.lastSeen.set(msg.from, msg.seq);
        if (via === 'ws' && !this.synced && msg.op.type === 'full' && this.canEdit) {
          // 서버 기준 상태가 이 화면의 매핑을 덮어쓰기 직전: 다르면 이전 것을 넘겨 되돌릴 수 있게 한다
          const local = this.opts.store.project;
          if (JSON.stringify(local) !== JSON.stringify(msg.op.project)) this.opts.onLocalReplaced?.(local, msg.op.project);
        }
        if (via === 'ws') this.synced = true;
        this.lastRemoteSentAt = msg.sentAt;
        this.opts.store.dispatch(msg.op, { origin: 'remote' });
        // 서버로 받은 것은 같은 PC 의 다른 창에도 전달 (그 창이 서버에 못 붙어 있을 수도 있다)
        if (via === 'ws') this.bc?.postMessage(msg);
        return;
      }
      case 'peers':
        this.setStatus({ peers: msg.peers });
        return;
      case 'server': {
        // 이 화면이 불러온 스크립트 파일 이름과 서버가 알려 준 지금 배포본을 비교
        const mine = document.querySelector<HTMLScriptElement>('script[type="module"][src*="/assets/"]')?.src.split('/').pop();
        if (msg.build && mine && msg.build !== mine && !this.outdated) {
          this.outdated = true;
          this.opts.onOutdated?.();
        }
        return;
      }
      case 'pong':
        this.setStatus({ rtt: Math.round(performance.now() - msg.t) });
        return;
      case 'ping':
        return;
    }
  }

  // ---------- 서버 연결 ----------

  private connect(): void {
    if (this.closed) return;
    const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
    this.setStatus({ ws: 'connecting' });
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.onopen = () => {
      this.retryMs = 500;
      const hello: Message = { kind: 'hello', from: this.id, role: this.opts.role };
      if (this.canEdit) {
        hello.project = this.opts.store.project;
        hello.push = this.dirtyOffline;
      }
      ws.send(JSON.stringify(hello));
      this.dirtyOffline = false;
      this.setStatus({ ws: 'open' });
      this.ping();
      this.pingTimer = setInterval(() => this.ping(), 3000);
    };
    ws.onmessage = (e) => {
      try {
        this.receive(JSON.parse(String(e.data)) as Message, 'ws');
      } catch (err) {
        console.warn('알 수 없는 메시지', err);
      }
    };
    ws.onclose = () => {
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pingTimer = null;
      this.ws = null;
      this.synced = true; // 서버가 없으면 로컬 상태가 기준
      this.setStatus({ ws: 'closed', rtt: null, peers: null });
      if (this.closed) return;
      setTimeout(() => this.connect(), this.retryMs);
      this.retryMs = Math.min(this.retryMs * 2, 5000);
    };
  }

  private ping(): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ kind: 'ping', t: performance.now() } satisfies Message));
  }

  close(): void {
    this.closed = true;
    this.flush();
    this.ws?.close();
    this.bc?.close();
  }
}
