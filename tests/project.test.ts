import { describe, expect, it } from 'vitest';
import {
  createDefaultProject,
  makeTriangle,
  parseProject,
  ProjectError,
  serializeProject,
  surfaceToMesh,
  surfaceToQuad,
  type Project,
} from '../src/core/project';
import { applyOp, mergeOps } from '../src/core/ops';
import { Store } from '../src/core/store';

function richProject(): Project {
  const p = createDefaultProject();
  p.sources.push({ id: 'fx', name: '스캔라인', type: 'shader', preset: 'scanlines', params: { speed: 1.5, color: '#00ffcc' } });
  const tri = makeTriangle('roof', '지붕', 0.05);
  tri.sourceId = 'fx';
  tri.mask = { polygon: [[0.3, 0.2], [0.7, 0.2], [0.5, 0.6]], feather: 12 };
  const mesh = surfaceToMesh({ ...p.surfaces[0]!, id: 'side', name: '옆면' }, 5, 4);
  mesh.opacity = 0.5;
  mesh.locked = true;
  p.surfaces.push(tri, mesh);
  return p;
}

describe('프로젝트 저장/불러오기', () => {
  it('저장 → 불러오기 왕복 후 상태가 같다', () => {
    const p = richProject();
    const back = parseProject(serializeProject(p));
    expect(back).toEqual(p);
    expect(serializeProject(back)).toBe(serializeProject(p));
  });

  it('계획서 예시 JSON 을 읽는다', () => {
    const p = parseProject({
      version: 1,
      output: { width: 1920, height: 1080 },
      sources: [
        { id: 'src1', type: 'video', uri: 'assets/ghost.mp4', loop: true },
        { id: 'src2', type: 'shader', preset: 'scanlines', params: { speed: 1.0 } },
        { id: 'src3', type: 'color', value: '#ffffff' },
      ],
      surfaces: [
        {
          id: 'front', name: '정면 벽', kind: 'quad',
          points: [[0.31, 0.42], [0.55, 0.38], [0.57, 0.8], [0.3, 0.83]],
          mesh: null, sourceId: 'src1', uv: [[0, 0], [1, 0], [1, 1], [0, 1]],
          mask: { polygon: null, feather: 0 }, opacity: 1.0, visible: true, locked: false,
        },
      ],
    });
    expect(p.surfaces[0]!.points[2]).toEqual([0.57, 0.8]);
    expect(p.sources[1]).toMatchObject({ type: 'shader', params: { speed: 1, color: '#ffffff' } });
  });

  it('세팅 격자 값은 저장·불러오기되고, 꺼져 있으면 파일에 적지 않는다', () => {
    const p = { ...createDefaultProject(), output: { width: 1280, height: 720, pattern: 'green' as const } };
    expect(parseProject(serializeProject(p)).output).toEqual({ width: 1280, height: 720, pattern: 'green' });
    expect(serializeProject(createDefaultProject())).not.toContain('pattern');
    expect(parseProject({ output: { width: 10, height: 10, pattern: 'pink' } }).output).toEqual({ width: 10, height: 10 });
  });

  it('격자 효과 두께는 저장·불러오기되고 0~60px 로 제한된다', () => {
    const p = createDefaultProject();
    expect(p.sources[0]).toMatchObject({ id: 'grid-white', type: 'shader', preset: 'grid', params: { lineWidth: 2, borderWidth: 6, cellsX: 8, cellsY: 4 } });
    const q = parseProject({ sources: [{ id: 'g', type: 'shader', preset: 'grid', params: { lineWidth: 500, borderWidth: -3 } }, { id: 's', type: 'shader', preset: 'noise', params: { speed: 2 } }] });
    expect(q.sources[0]).toMatchObject({ params: { lineWidth: 60, borderWidth: 0 } });
    expect(parseProject({ sources: [{ id: 'g', type: 'shader', preset: 'grid', params: { cellsX: 0, cellsY: 99.6 } }] }).sources[0]).toMatchObject({ params: { cellsX: 1, cellsY: 40 } });
    expect(parseProject({ output: { width: 10, height: 10, pattern: 'black' } }).output.pattern).toBe('black');
    expect(q.sources[1]).toEqual({ id: 's', name: 's', type: 'shader', preset: 'noise', params: { speed: 2, color: '#ffffff' } }); // 두께 없는 효과는 그대로
  });

  it('잘못된 파일은 이유와 함께 거부한다', () => {
    expect(() => parseProject('[]')).toThrow(ProjectError);
    expect(() => parseProject({ surfaces: [{ id: 'a', kind: 'quad', points: [[0, 0]] }] })).toThrow(/점이 4개/);
    expect(() => parseProject({ version: 99 })).toThrow(/새 버전/);
  });

  it('쿼드 ↔ 메시 전환이 모양을 유지한다', () => {
    const q = createDefaultProject().surfaces[0]!;
    const back = surfaceToQuad(surfaceToMesh(q, 4, 4));
    back.points.forEach((pt, i) => {
      expect(pt[0]).toBeCloseTo(q.points[i]![0], 9);
      expect(pt[1]).toBeCloseTo(q.points[i]![1], 9);
    });
  });
});

describe('변경분(op)', () => {
  it('면 패치는 해당 면만 새 객체로 만든다', () => {
    const p = richProject();
    const next = applyOp(p, { type: 'surface', id: 'roof', patch: { opacity: 0.3 } });
    expect(next.surfaces[1]!.opacity).toBe(0.3);
    expect(next.surfaces[0]).toBe(p.surfaces[0]);
    expect(p.surfaces[1]!.opacity).toBe(1); // 원본은 그대로
  });

  it('연속 패치를 합친다', () => {
    const m = mergeOps(
      { type: 'surface', id: 'a', patch: { opacity: 0.1 } },
      { type: 'surface', id: 'a', patch: { visible: false } },
    );
    expect(m).toEqual({ type: 'surface', id: 'a', patch: { opacity: 0.1, visible: false } });
    expect(mergeOps({ type: 'surface', id: 'a', patch: {} }, { type: 'surface', id: 'b', patch: {} })).toBeNull();
  });

  it('실행취소/다시실행', () => {
    const store = new Store(richProject());
    const before = store.project;
    store.dispatch({ type: 'surface', id: 'front', patch: { opacity: 0.2 } }, { history: true });
    store.checkpoint();
    store.dispatch({ type: 'surface', id: 'front', patch: { points: [[0, 0], [1, 0], [1, 1], [0, 1]] } });
    store.dispatch({ type: 'surface', id: 'front', patch: { points: [[0.1, 0], [1, 0], [1, 1], [0, 1]] } });
    expect(store.undo()).toBe(true);
    expect(store.project.surfaces[0]!.opacity).toBe(0.2);
    expect(store.undo()).toBe(true);
    expect(store.project).toBe(before);
    expect(store.redo()).toBe(true);
    expect(store.project.surfaces[0]!.opacity).toBe(0.2);
  });
});
