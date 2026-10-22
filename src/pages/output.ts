// 출력 화면: 프로젝터에 띄운다. 편집 UI 는 전혀 없고 렌더링만 한다.
// 두 번 누르면(또는 Enter·F) 전체화면, I 키는 성능 정보(fps·해상도) 표시. 상태는 편집기·리모컨에서 받는다.

import { Store } from '../core/store';
import { Renderer } from '../render/renderer';
import { SyncChannel } from '../sync/channel';
import { loadLocal } from '../ui/persist';
import { createDefaultProject } from '../core/project';

const canvas = document.getElementById('out') as HTMLCanvasElement;
const gate = document.getElementById('gate')!;
const info = document.getElementById('info')!;

// 같은 PC 에서 마지막으로 편집한 상태가 있으면 먼저 보여 주고, 연결되면 최신 상태로 바뀐다
const cached = loadLocal();
const store = new Store(cached ?? { ...createDefaultProject(), surfaces: [] });

let fps = 0;
const renderer = new Renderer(canvas, {
  maxPixelRatio: 1, // 프로젝터 해상도 그대로 (고해상도 배율로 부하를 늘리지 않음)
  onFps: (f) => {
    fps = f;
    if (info.classList.contains('show')) {
      const p = store.project;
      info.textContent = `${fps} fps · 화면 ${canvas.width}×${canvas.height} · 면 ${p.surfaces.filter((s) => s.visible).length}개 · 서버 ${sync.status.ws === 'open' ? `${sync.status.rtt ?? '-'}ms` : '없음'}`;
    }
  },
  onNeedsGesture: () => gate.classList.add('show'),
});
renderer.setProject(store.project);
renderer.start();
store.subscribe((p) => renderer.setProject(p));

// 새 버전이 배포되면 저절로 새로고침 (프로젝터에 띄워 둔 채로 두는 화면이라). 상태는 서버에서 다시 받는다
const sync = new SyncChannel({ role: 'output', store, onOutdated: () => location.reload() });

function toggleFullscreen(): void {
  if (document.fullscreenElement) void document.exitFullscreen();
  else void document.documentElement.requestFullscreen().catch(() => undefined);
}

// 투사 화면에 포인터가 비치지 않게 평소엔 숨기고, 마우스를 움직이면 2초간 포인터와 안내를 보인다
let idle: ReturnType<typeof setTimeout> | null = null;
addEventListener('pointermove', (e) => {
  if (e.pointerType !== 'mouse') return;
  document.body.classList.add('awake');
  if (idle) clearTimeout(idle);
  idle = setTimeout(() => document.body.classList.remove('awake'), 2000);
});

addEventListener('dblclick', toggleFullscreen);
addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key.toLowerCase() === 'f') toggleFullscreen();
  if (e.key.toLowerCase() === 'i') info.classList.toggle('show');
});
const resume = () => {
  gate.classList.remove('show');
  renderer.resumeVideos();
};
addEventListener('pointerdown', resume);
gate.addEventListener('keydown', (e) => e.key === 'Enter' && resume());

addEventListener('pagehide', () => sync.close());
// 시험용: 지연·fps 측정
Object.assign(window, { __pm: { store, sync, renderer, get fps() { return fps; } } });
