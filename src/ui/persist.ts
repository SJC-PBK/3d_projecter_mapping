// 브라우저 저장소(localStorage) 자동 저장. 새로고침해도 같은 매핑이 복원된다.

import { createDefaultProject, parseProject, type Project } from '../core/project';

const KEY = 'projection-mapper:project';
const BACKUP_KEY = 'projection-mapper:before-sync';

/** 서버 상태로 덮어쓰기 전 이 브라우저의 매핑을 따로 보관 (되돌리기용, 최근 1개) */
export function stashBeforeSync(p: Project): void {
  try {
    localStorage.setItem(BACKUP_KEY, JSON.stringify({ savedAt: new Date().toISOString(), project: p }));
  } catch (err) {
    console.warn('이전 매핑 보관 실패', err);
  }
}

/** 처음 상태(기본 프로젝트) 그대로인지 — 이런 기기에서는 덮어써도 잃을 것이 없다 */
export function isUntouchedDefault(p: Project): boolean {
  return JSON.stringify(p) === JSON.stringify(createDefaultProject());
}

export function loadLocal(): Project | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? parseProject(raw) : null;
  } catch (err) {
    console.warn('저장된 프로젝트를 읽지 못해 무시합니다', err);
    return null;
  }
}

export function loadLocalOrDefault(): Project {
  return loadLocal() ?? createDefaultProject();
}

let timer: ReturnType<typeof setTimeout> | null = null;
let latest: Project | null = null;

/** 잦은 변경은 0.3초 모아서 저장 */
export function saveLocal(p: Project): void {
  latest = p;
  if (timer) return;
  timer = setTimeout(flushLocal, 300);
}

export function flushLocal(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  if (!latest) return;
  try {
    localStorage.setItem(KEY, JSON.stringify(latest));
  } catch (err) {
    console.warn('브라우저 저장 실패 (용량 초과일 수 있음)', err);
  }
}

addEventListener('pagehide', flushLocal);
