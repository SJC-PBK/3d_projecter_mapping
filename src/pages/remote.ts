// 폰 리모컨: 면을 고르고, 점을 골라 끌거나(터치패드 방식) 방향 버튼으로 1px·10px 씩 옮긴다.

import '../ui/style.css';
import '../ui/remote.css';
import { editablePoints } from '../core/project';
import { Store } from '../core/store';
import { SyncChannel } from '../sync/channel';
import { $, h, showBanner, showUpdateBanner, toast } from '../ui/dom';
import { isUntouchedDefault, loadLocalOrDefault, saveLocal, stashBeforeSync } from '../ui/persist';
import { Stage } from '../ui/stage';

const store = new Store(loadLocalOrDefault());
let stage = makeStage(false);

function makeStage(withRenderer: boolean): Stage {
  const box = $('#stage');
  box.replaceChildren();
  return new Stage(box, {
    store,
    withRenderer,
    handleRadius: 26,
    trackpad: true,
    onSelectionChange: render,
  });
}

const sync = new SyncChannel({
  role: 'remote',
  store,
  onOutdated: showUpdateBanner,
  // 서버의 매핑이 이 기기에 저장된 매핑과 달라 덮어썼을 때: 이전 것을 보관하고 되돌릴 수 있게 한다
  onLocalReplaced: (previous, incoming) => {
    if (isUntouchedDefault(previous)) return;
    stashBeforeSync(previous);
    showBanner('restore-banner', `서버의 매핑(면 ${incoming.surfaces.length}개)으로 바뀌었습니다. 이 기기에 있던 매핑(면 ${previous.surfaces.length}개)은 따로 보관했습니다.`, [
      { label: '이 기기의 매핑으로 되돌리기', primary: true, onClick: () => store.dispatch({ type: 'full', project: previous }, { history: true }) },
      { label: '서버 것 그대로 쓰기', onClick: () => undefined },
    ]);
  },
  onStatus: (s) => {
    const el = $('#status');
    if (s.ws === 'open') {
      el.innerHTML = `<span class="dot ok"></span>${s.rtt ?? '-'}ms · 출력 ${s.peers?.output ?? 0}`;
    } else if (s.ws === 'connecting') {
      el.innerHTML = '<span class="dot"></span>연결 중';
    } else {
      el.innerHTML = '<span class="dot bad"></span>끊김 — 다시 연결 중';
    }
  },
});

store.subscribe((p) => {
  saveLocal(p);
  render();
});

let step = 1;
let zoomLevel = 1;

function render(): void {
  const p = store.project;
  const select = $('#surface-select') as HTMLSelectElement;
  select.replaceChildren(h('option', { value: '' }, p.surfaces.length ? '면 고르기' : '면 없음 (편집기에서 추가)'));
  for (const s of p.surfaces) select.append(h('option', { value: s.id, selected: s.id === stage.sel.surfaceId }, `${s.name}${s.locked ? ' 🔒' : ''}${s.visible ? '' : ' (숨김)'}`));
  const s = stage.surface;
  const pts = s ? editablePoints(s) : [];
  const label = $('#pt-label');
  if (!s) label.textContent = '면을 고르세요';
  else if (stage.sel.point === null) label.textContent = `${s.name} · 면 전체`;
  else {
    const [x, y] = pts[stage.sel.point]!;
    label.textContent = `${stage.sel.point + 1}/${pts.length}번 점 · ${Math.round(x * p.output.width)}, ${Math.round(y * p.output.height)}`;
  }
  $('#toggle-vis').textContent = s?.visible === false ? '보이기' : '숨기기';
  $('#toggle-lock').textContent = s?.locked ? '잠금 풀기' : '잠그기';
  for (const id of ['#toggle-vis', '#toggle-lock', '#prev-pt', '#next-pt']) ($(id) as HTMLButtonElement).disabled = !s;
  ($('#undo') as HTMLButtonElement).disabled = !store.canUndo;
  ($('#redo') as HTMLButtonElement).disabled = !store.canRedo;
}

$('#surface-select').addEventListener('change', (e) => {
  const id = (e.target as HTMLSelectElement).value || null;
  stage.select(id, id ? 0 : null);
});
$('#prev-pt').addEventListener('click', () => stage.cyclePoint(-1));
$('#next-pt').addEventListener('click', () => stage.cyclePoint(1));

// 방향 버튼: 누르고 있으면 반복
for (const btn of document.querySelectorAll<HTMLButtonElement>('[data-dir]')) {
  const [dx, dy] = btn.dataset.dir!.split(',').map(Number) as [number, number];
  let timer: ReturnType<typeof setTimeout> | null = null;
  const fire = () => {
    if (!stage.nudge(dx * step, dy * step)) toast(stage.surface?.locked ? '잠긴 면입니다' : '먼저 면을 고르세요');
  };
  const stop = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  btn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    fire();
    const repeat = (delay: number) => (timer = setTimeout(() => (fire(), repeat(60)), delay));
    repeat(400);
  });
  btn.addEventListener('pointerup', stop);
  btn.addEventListener('pointerleave', stop);
  btn.addEventListener('pointercancel', stop);
  btn.addEventListener('keydown', (e) => e.key === 'Enter' && fire());
}

$('#step').addEventListener('click', () => {
  step = step === 1 ? 10 : 1;
  $('#step').textContent = `${step}px`;
});

$('#fine').addEventListener('click', () => {
  stage.precision = stage.precision === 1 ? 0.25 : 1;
  $('#fine').setAttribute('aria-pressed', String(stage.precision !== 1));
});

$('#zoom').addEventListener('click', () => {
  zoomLevel = zoomLevel === 1 ? 2 : zoomLevel === 2 ? 4 : 1;
  const s = stage.surface;
  const pts = s ? editablePoints(s) : [];
  const focus = stage.sel.point !== null ? pts[stage.sel.point] : s ? s.points[0] : undefined;
  stage.setZoom(zoomLevel, focus ? [focus[0], focus[1]] : undefined);
  $('#zoom').textContent = `확대 ${zoomLevel}×`;
});

$('#preview').addEventListener('click', () => {
  const on = !stage.renderer;
  const { sel, center } = stage;
  const box = stage.boxMode;
  stage = makeStage(on);
  stage.boxMode = box;
  stage.setZoom(zoomLevel, center);
  stage.select(sel.surfaceId, sel.point);
  $('#preview').setAttribute('aria-pressed', String(on));
});

$('#box').addEventListener('click', () => {
  stage.boxMode = !stage.boxMode;
  $('#box').setAttribute('aria-pressed', String(stage.boxMode));
  stage.requestDraw();
});
$('#circle').addEventListener('click', () => {
  if (!stage.makeCircle()) toast(stage.surface?.locked ? '잠긴 면입니다' : '먼저 면을 고르세요');
});

$('#undo').addEventListener('click', () => store.undo());
$('#redo').addEventListener('click', () => store.redo());
$('#toggle-vis').addEventListener('click', () => {
  const s = stage.surface;
  if (s) store.dispatch({ type: 'surface', id: s.id, patch: { visible: !s.visible } }, { history: true });
});
$('#toggle-lock').addEventListener('click', () => {
  const s = stage.surface;
  if (s) store.dispatch({ type: 'surface', id: s.id, patch: { locked: !s.locked } }, { history: true });
});

render();
addEventListener('pagehide', () => sync.close());
Object.assign(window, { __pm: { store, get stage() { return stage; }, sync } });
