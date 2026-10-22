// 브라우저 저장소(localStorage) 자동 저장. 새로고침해도 같은 매핑이 복원된다.

import { createDefaultProject, parseProject, type Project } from '../core/project';

const KEY = 'projection-mapper:project';

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
