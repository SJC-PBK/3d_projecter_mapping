// 상태 변경 단위(op)와 적용 함수. 화면 사이에는 전체 상태가 아니라 이 변경분을 주고받는다.
// 서버(node)도 이 파일을 그대로 불러오므로 값 import 없이 타입 import 만 둔다.

import type { Project, Source, Surface } from './project';

export type Op =
  /** 전체 교체 — 처음 연결, 면 추가·삭제, 실행취소 등 구조가 바뀔 때 */
  | { type: 'full'; project: Project }
  /** 면 하나의 일부 필드 교체 — 모서리 드래그 등 (면 id + 바뀐 값만) */
  | { type: 'surface'; id: string; patch: Partial<Surface> }
  /** 소스 하나의 일부 필드 교체 */
  | { type: 'source'; id: string; patch: Partial<Source> };

/** op 를 적용한 새 프로젝트. 바뀐 면·소스만 새 객체가 된다 (나머지는 공유) */
export function applyOp(p: Project, op: Op): Project {
  switch (op.type) {
    case 'full':
      return op.project;
    case 'surface': {
      const i = p.surfaces.findIndex((s) => s.id === op.id);
      if (i < 0) return p;
      const surfaces = p.surfaces.slice();
      surfaces[i] = { ...surfaces[i]!, ...op.patch, id: op.id };
      return { ...p, surfaces };
    }
    case 'source': {
      const i = p.sources.findIndex((s) => s.id === op.id);
      if (i < 0) return p;
      const sources = p.sources.slice();
      sources[i] = { ...sources[i]!, ...op.patch, id: op.id } as Source;
      return { ...p, sources };
    }
  }
}

/** 같은 대상의 연속 op 를 하나로 합칠 수 있으면 합친다 (드래그 중 전송량 줄이기) */
export function mergeOps(a: Op, b: Op): Op | null {
  if (b.type === 'full') return b;
  if (a.type === 'full') return { type: 'full', project: applyOp(a.project, b) };
  if (a.type === b.type && a.id === b.id) {
    return { ...a, patch: { ...a.patch, ...b.patch } } as Op;
  }
  return null;
}

// ---------- 전송 봉투 ----------

export type Role = 'editor' | 'output' | 'remote';

/** 화면 → 서버/다른 화면 */
export type Message =
  /** 접속 인사. 서버가 비어 있거나 끊긴 동안 고친 내용이 있으면 project 를 함께 보낸다 */
  | { kind: 'hello'; from: string; role: Role; project?: Project; push?: boolean }
  /** 변경분. (from, seq) 로 중복·역순 도착을 걸러낸다 */
  | { kind: 'op'; from: string; seq: number; op: Op; sentAt: number }
  /** 서버 상태 알림 (역할별 접속 수) */
  | { kind: 'peers'; from: string; peers: Record<Role, number> }
  /** 서버가 접속한 화면에 알려 주는 지금 배포된 그 화면의 스크립트 파일 이름 (다르면 옛 화면) */
  | { kind: 'server'; build: string | null }
  /** 왕복 지연 측정 (서버가 같은 t 로 pong 응답) */
  | { kind: 'ping'; t: number }
  | { kind: 'pong'; t: number };
