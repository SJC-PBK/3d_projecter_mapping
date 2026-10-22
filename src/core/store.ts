// 상태 저장소 + 변경 이벤트 + 실행취소/다시실행. DOM 에 의존하지 않는다.

import { applyOp, type Op } from './ops';
import type { Project } from './project';

/** local = 이 화면에서 바꿈(다른 화면에 보내야 함), remote = 다른 화면에서 받음 */
export type Origin = 'local' | 'remote';
export type Listener = (project: Project, op: Op, origin: Origin) => void;

const HISTORY_LIMIT = 200;

export class Store {
  private state: Project;
  private listeners = new Set<Listener>();
  private undoStack: Project[] = [];
  private redoStack: Project[] = [];

  constructor(initial: Project) {
    this.state = initial;
  }

  get project(): Project {
    return this.state;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /**
   * op 적용. history=true 면 적용 전 상태를 실행취소 기록에 남긴다.
   * 드래그처럼 연속 변경은 시작할 때 checkpoint() 한 번 + history=false 로 보낸다.
   */
  dispatch(op: Op, opts: { history?: boolean; origin?: Origin } = {}): void {
    const origin = opts.origin ?? 'local';
    if (opts.history && origin === 'local') this.checkpoint();
    this.state = applyOp(this.state, op);
    for (const fn of this.listeners) fn(this.state, op, origin);
  }

  /** 현재 상태를 실행취소 지점으로 기록 */
  checkpoint(): void {
    this.undoStack.push(this.state);
    if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift();
    this.redoStack = [];
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  undo(): boolean {
    const prev = this.undoStack.pop();
    if (!prev) return false;
    this.redoStack.push(this.state);
    this.dispatch({ type: 'full', project: prev });
    return true;
  }

  redo(): boolean {
    const next = this.redoStack.pop();
    if (!next) return false;
    this.undoStack.push(this.state);
    this.dispatch({ type: 'full', project: next });
    return true;
  }
}
