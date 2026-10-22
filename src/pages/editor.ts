// PC 편집기: 면 목록·속성·소스 패널 + 출력 미리보기 무대.

import '../ui/style.css';
import '../ui/editor.css';
import { resampleMesh, MESH_MAX, MESH_MIN } from '../core/mesh';
import {
  EDGE_LINE_DEFAULT,
  GRID_BORDER_DEFAULT,
  GRID_CELLS_MAX,
  GRID_CELLS_X_DEFAULT,
  GRID_CELLS_Y_DEFAULT,
  GRID_LINE_DEFAULT,
  GRID_WIDTH_MAX,
  OUTPUT_PATTERNS,
  WHITE_GRID,
  isOldGridImage,
  circleMask,
  createDefaultProject,
  editablePoints,
  makeQuad,
  makeTriangle,
  newId,
  parseProject,
  serializeProject,
  SHADER_PRESETS,
  surfaceToMesh,
  surfaceToQuad,
  surfaceToSphere,
  type OutputPattern,
  type Project,
  type ShaderPreset,
  type Source,
  type Surface,
  type Vec2,
} from '../core/project';
import { Store } from '../core/store';
import { SyncChannel, type SyncStatus } from '../sync/channel';
import { $, download, h, pickFile, showBanner, showUpdateBanner, toast } from '../ui/dom';
import { flushLocal, isUntouchedDefault, loadLocalOrDefault, saveLocal, stashBeforeSync } from '../ui/persist';
import { moveSurface, Stage } from '../ui/stage';

const store = new Store(loadLocalOrDefault());
let fps = 0;
let syncStatus: SyncStatus = { ws: 'off', rtt: null, peers: null };

const stage = new Stage($('#stage'), {
  store,
  withRenderer: true,
  // 손가락으로 쓰는 기기(태블릿)에서는 조절점을 크게 잡는다
  handleRadius: matchMedia('(pointer: coarse)').matches ? 26 : 10,
  trackpad: false,
  rendererOptions: {
    onFps: (f) => {
      fps = f;
      renderStatus();
    },
    onNeedsGesture: () => toast('영상 자동재생이 막혔습니다. 화면을 한 번 클릭하세요'),
    onSourceError: (_id, msg) => toast(msg, 'error'),
  },
  onSelectionChange: () => renderPanels(true),
});

const sync = new SyncChannel({
  role: 'editor',
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
    syncStatus = { ...s };
    renderStatus();
  },
});

store.subscribe(() => {
  saveLocal(store.project);
  renderPanels();
});

// ---------- 공통 동작 ----------

const P = () => store.project;
const sel = stage.sel;

function setProject(next: Project, history = true): void {
  store.dispatch({ type: 'full', project: next }, { history });
}

function patchSurface(id: string, patch: Partial<Surface>, history = true): void {
  store.dispatch({ type: 'surface', id, patch }, { history });
}

function patchSource(id: string, patch: Partial<Source>, history = true): void {
  store.dispatch({ type: 'source', id, patch }, { history });
}

function addSurface(kind: 'quad' | 'triangle'): void {
  const p = P();
  const id = newId('s', p.surfaces.map((s) => s.id));
  const n = p.surfaces.length + 1;
  const offset = ((n - 1) % 6) * 0.03;
  const s = kind === 'quad' ? makeQuad(id, `면 ${n}`, offset) : makeTriangle(id, `삼각 ${n}`, offset);
  // 새 면은 기본 격자로 시작한다 (모서리·각도 맞추기 쉽게). 예전 프로젝트에 없으면 소스를 같이 넣는다
  // 예전 그림 파일 방식(두께 고정)이면 두께 조절 격자로 바꾼다 — 모양은 같다
  const old = p.sources.find((x) => x.id === WHITE_GRID.id);
  const sources = !old ? [structuredClone(WHITE_GRID), ...p.sources] : isOldGridImage(old) ? p.sources.map((x) => (x.id === WHITE_GRID.id ? structuredClone(WHITE_GRID) : x)) : p.sources;
  s.sourceId = WHITE_GRID.id;
  setProject({ ...p, sources, surfaces: [...p.surfaces, s] });
  stage.select(id);
}

function duplicateSurface(): void {
  const s = stage.surface;
  if (!s) return;
  const p = P();
  const id = newId('s', p.surfaces.map((x) => x.id));
  const copy: Surface = { ...structuredClone(s), id, name: `${s.name} 복사`, locked: false };
  Object.assign(copy, moveSurface(copy, 0.02, 0.02));
  const i = p.surfaces.indexOf(s);
  const surfaces = p.surfaces.slice();
  surfaces.splice(i + 1, 0, copy);
  setProject({ ...p, surfaces });
  stage.select(id);
}

/** 면과 같은 모양·자리에 '테두리 네온' 효과 면을 바로 위에 만든다. 효과 소스가 없으면 만든다 */
function addEdgeOverlay(s: Surface): void {
  const p = P();
  let sources = p.sources;
  let edge = sources.find((x) => x.type === 'shader' && x.preset === 'edge');
  if (!edge) {
    edge = { id: newId('src', sources.map((x) => x.id)), name: '테두리 네온', type: 'shader', preset: 'edge', params: { speed: 1, color: '#00e5ff', lineWidth: EDGE_LINE_DEFAULT } };
    sources = [...sources, edge];
  }
  const id = newId('s', p.surfaces.map((x) => x.id));
  const overlay: Surface = { ...structuredClone(s), id, name: `${s.name} 테두리`, sourceId: edge.id, mask: { polygon: null, feather: 0 }, opacity: 1, locked: false };
  const surfaces = p.surfaces.slice();
  surfaces.splice(p.surfaces.indexOf(s) + 1, 0, overlay); // 바로 위에 그린다
  setProject({ ...p, sources, surfaces });
  stage.select(id);
  toast(`"${overlay.name}" 를 만들었습니다. 원래 면을 옮기면 이 면도 같이 옮겨 주세요`);
}

function deleteSurface(): void {
  const s = stage.surface;
  if (!s) return;
  setProject({ ...P(), surfaces: P().surfaces.filter((x) => x.id !== s.id) });
  stage.select(null);
  toast(`"${s.name}" 삭제 (실행취소: Ctrl+Z)`);
}

function moveOrder(dir: -1 | 1): void {
  const s = stage.surface;
  if (!s) return;
  const list = P().surfaces.slice();
  const i = list.indexOf(s);
  const j = i + dir;
  if (j < 0 || j >= list.length) return;
  [list[i], list[j]] = [list[j]!, list[i]!];
  setProject({ ...P(), surfaces: list });
}

function undo(): void {
  if (!store.undo()) toast('되돌릴 작업이 없습니다');
}

function redo(): void {
  if (!store.redo()) toast('다시 할 작업이 없습니다');
}

// ---------- 상단 버튼 ----------

$('#btn-new').addEventListener('click', () => {
  if (!confirm('지금 매핑을 지우고 새로 시작할까요? (실행취소로 되돌릴 수 있습니다)')) return;
  setProject(createDefaultProject());
  stage.select(null);
});

$('#btn-save').addEventListener('click', () => {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const name = `mapping-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.json`;
  download(name, serializeProject(P()));
  toast(`${name} 로 저장했습니다`);
});

$('#btn-open').addEventListener('click', async () => {
  const file = await pickFile('application/json,.json');
  if (!file) return;
  try {
    setProject(parseProject(await file.text()));
    stage.select(null);
    toast(`${file.name} 을 불러왔습니다`);
  } catch (err) {
    toast(`불러오기 실패: ${err instanceof Error ? err.message : String(err)}`, 'error');
  }
});

/** 세팅 격자 바꾸기 (실행취소 기록에는 남기지 않는다) */
function setPattern(next: OutputPattern | undefined): void {
  const p = P();
  const output = { width: p.output.width, height: p.output.height, ...(next ? { pattern: next } : {}) };
  setProject({ ...p, output }, false);
}

/** G 키: 끔 → 블랙 → 블루 → 그린 → 끔 */
function cyclePattern(): void {
  const order = [undefined, ...OUTPUT_PATTERNS.map((x) => x.id)];
  setPattern(order[(order.indexOf(P().output.pattern) + 1) % order.length]);
}
const patternSelect = $('#sel-pattern') as HTMLSelectElement;
patternSelect.addEventListener('change', () => setPattern((patternSelect.value || undefined) as OutputPattern | undefined));

$('#btn-undo').addEventListener('click', undo);
$('#btn-redo').addEventListener('click', redo);

$('#btn-output').addEventListener('click', () => {
  const w = window.open(new URL('../output/', location.href).href, 'pm-output', 'popup,width=960,height=540');
  if (!w) toast('팝업이 막혔습니다. 브라우저 주소창 옆에서 팝업을 허용하세요', 'error');
  else toast('출력 창을 프로젝터 화면으로 옮긴 뒤 두 번 클릭하면 전체화면이 됩니다');
});

function toggleFullscreen(): void {
  if (document.fullscreenElement) void document.exitFullscreen();
  else void stage.root.requestFullscreen().catch(() => toast('전체화면을 쓸 수 없습니다', 'error'));
}
$('#btn-full').addEventListener('click', toggleFullscreen);
document.addEventListener('fullscreenchange', () => {
  // 전체화면에서는 출력 비율과 상관없이 화면을 꽉 채운다 (프로젝터에 바로 투사)
  stage.fill = document.fullscreenElement === stage.root;
  stage.root.classList.toggle('is-full', stage.fill);
  stage.layout();
});

function toggleHandles(): void {
  stage.showHandles = !stage.showHandles;
  $('#btn-handles').setAttribute('aria-pressed', String(stage.showHandles));
  stage.requestDraw();
}
$('#btn-handles').addEventListener('click', toggleHandles);

// 자동재생이 막힌 영상은 아무 클릭에서나 다시 재생
addEventListener('pointerdown', () => stage.renderer?.resumeVideos(), { capture: true });

// ---------- 키보드 ----------

addEventListener('keydown', (e) => {
  const t = e.target as HTMLElement;
  if (t.closest('input, select, textarea')) return;
  const ctrl = e.ctrlKey || e.metaKey;
  const step = e.shiftKey ? 10 : 1;
  const arrows: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
  if (e.key in arrows && !ctrl) {
    const [dx, dy] = arrows[e.key]!;
    if (stage.nudge(dx * step, dy * step)) e.preventDefault();
    return;
  }
  if (ctrl && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    if (e.shiftKey) redo();
    else undo();
  } else if (ctrl && e.key.toLowerCase() === 'y') {
    e.preventDefault();
    redo();
  } else if (ctrl && e.key.toLowerCase() === 'd') {
    e.preventDefault();
    duplicateSurface();
  } else if (ctrl && e.key.toLowerCase() === 's') {
    e.preventDefault();
    $('#btn-save').click();
  } else if (e.key === 'Tab' && !ctrl && !t.closest('button, a')) {
    e.preventDefault();
    stage.cyclePoint(e.shiftKey ? -1 : 1);
  } else if (e.key === '[' || e.key === ']') {
    stage.cycleSurface(e.key === ']' ? 1 : -1);
  } else if (ctrl && e.key.toLowerCase() === 'a' && stage.surface) {
    e.preventDefault();
    stage.selectAllPoints();
  } else if (!ctrl && e.key.toLowerCase() === 'b') {
    stage.boxMode = !stage.boxMode;
    renderPanels(true);
    stage.requestDraw();
  } else if (e.key === 'Escape') {
    if (sel.multi.length) stage.clearMulti();
    else if (sel.mask) stage.setMaskMode(false);
    else stage.select(null);
  } else if (e.key === 'Delete' || e.key === 'Backspace') {
    if (t.closest('button, a')) return;
    e.preventDefault();
    if (sel.mask) deleteMaskPoint();
    else deleteSurface();
  } else if (!ctrl && e.key.toLowerCase() === 'f') {
    toggleFullscreen();
  } else if (!ctrl && e.key.toLowerCase() === 'g') {
    cyclePattern();
  } else if (!ctrl && e.key.toLowerCase() === 'h') {
    toggleHandles();
  }
});

// ---------- 상태 표시 ----------

function renderStatus(): void {
  const s = syncStatus;
  const el = $('#status');
  const ws =
    s.ws === 'open'
      ? `<span class="dot ok"></span>서버 연결${s.rtt !== null ? ` ${s.rtt}ms` : ''}${s.peers ? ` · 출력 ${s.peers.output} · 리모컨 ${s.peers.remote}` : ''}`
      : s.ws === 'connecting'
        ? '<span class="dot"></span>서버 연결 중'
        : '<span class="dot bad"></span>서버 없음 (같은 PC 창끼리만 연결)';
  el.innerHTML = `${ws} · ${fps} fps`;
  // renderStatus 는 파일 위쪽(무대·동기화를 만들 때)에서 먼저 불리므로 P() 대신 store 를 직접 쓴다
  const sel = $('#sel-pattern') as HTMLSelectElement;
  sel.value = store.project.output.pattern ?? '';
  sel.classList.toggle('on', !!store.project.output.pattern);
  ($('#btn-undo') as HTMLButtonElement).disabled = !store.canUndo;
  ($('#btn-redo') as HTMLButtonElement).disabled = !store.canRedo;
}

// ---------- 패널 ----------

let panelsPending = false;

/** 패널 다시 그리기. 패널 입력칸을 쓰는 중이면 끝날 때까지 미룬다 (입력이 끊기지 않게) */
function renderPanels(force = false): void {
  const active = document.activeElement;
  if (!force && active instanceof HTMLElement && active.closest('aside') && active.matches('input, select')) {
    panelsPending = true;
    return;
  }
  panelsPending = false;
  renderSurfaceList();
  renderProps();
  renderSources();
  renderStatus();
}
// 패널 밖으로 포커스가 나가면 미뤄 둔 갱신을 한다 (패널 안 다른 입력칸으로 옮겨 가면 계속 미룸)
document.addEventListener('focusout', () => setTimeout(() => panelsPending && renderPanels(), 0));

/** 이벤트가 일어난 시점의 최신 면·소스 (패널을 그린 뒤 상태가 바뀌었을 수 있다) */
const curSurface = (id: string) => P().surfaces.find((x) => x.id === id);


function renderSurfaceList(): void {
  const p = P();
  const box = $('#surfaces');
  const list = h('ul', { class: 'list', 'aria-label': '면 목록' });
  for (const s of p.surfaces) {
    const selected = s.id === sel.surfaceId;
    list.append(
      h(
        'li',
        { class: selected ? 'sel' : '' },
        h('button', { type: 'button', class: 'name', 'aria-current': selected ? 'true' : null, onclick: () => stage.select(s.id) }, s.name, h('span', { class: 'muted small' }, ` ${kindLabel(s)}`)),
        h('button', { type: 'button', class: 'icon', 'aria-label': `${s.name} ${s.visible ? '숨기기' : '보이기'}`, 'aria-pressed': String(!s.visible), onclick: () => patchSurface(s.id, { visible: !s.visible }) }, s.visible ? '보임' : '숨김'),
        h('button', { type: 'button', class: 'icon', 'aria-label': `${s.name} ${s.locked ? '잠금 풀기' : '잠그기'}`, 'aria-pressed': String(s.locked), onclick: () => patchSurface(s.id, { locked: !s.locked }) }, s.locked ? '잠김' : '풀림'),
      ),
    );
  }
  const has = !!stage.surface;
  box.replaceChildren(
    h('h2', {}, `면 (${p.surfaces.length})`),
    h('div', { class: 'row' }, h('button', { type: 'button', onclick: () => addSurface('quad') }, '+ 사각형'), h('button', { type: 'button', onclick: () => addSurface('triangle') }, '+ 삼각형')),
    list,
    h(
      'div',
      { class: 'row' },
      h('button', { type: 'button', disabled: !has, onclick: duplicateSurface }, '복제'),
      h('button', { type: 'button', disabled: !has, onclick: () => moveOrder(1), 'aria-label': '앞으로 (위에 그리기)' }, '앞으로'),
      h('button', { type: 'button', disabled: !has, onclick: () => moveOrder(-1), 'aria-label': '뒤로 (아래에 그리기)' }, '뒤로'),
      h('button', { type: 'button', class: 'danger', disabled: !has, onclick: deleteSurface }, '삭제'),
    ),
  );
}

function kindLabel(s: Surface): string {
  return s.kind === 'quad' ? '사각형' : s.kind === 'triangle' ? '삼각형' : `메시 ${s.mesh?.cols}×${s.mesh?.rows}`;
}

function sourceOptions(selected: string | null): HTMLSelectElement {
  const select = h('select', {});
  select.append(h('option', { value: '' }, '(없음)'));
  for (const src of P().sources) select.append(h('option', { value: src.id, selected: src.id === selected }, `${src.name} · ${typeLabel(src)}`));
  return select;
}

function typeLabel(s: Source): string {
  return { image: '이미지', video: '영상', shader: '효과', color: '단색' }[s.type];
}

/** 슬라이더: 누를 때 실행취소 지점 한 번, 움직이는 동안은 기록 없이 */
function slider(attrs: { min: number; max: number; step: number; value: number; label: string }, onValue: (v: number) => void): HTMLInputElement {
  const input = h('input', { type: 'range', min: attrs.min, max: attrs.max, step: attrs.step, value: String(attrs.value), 'aria-label': attrs.label });
  input.addEventListener('pointerdown', () => store.checkpoint());
  input.addEventListener('keydown', () => store.checkpoint());
  input.addEventListener('input', () => onValue(Number(input.value)));
  return input;
}

function renderProps(): void {
  const box = $('#props');
  const s = stage.surface;
  if (!s) {
    box.replaceChildren(...projectProps());
    return;
  }
  const name = h('input', { type: 'text', value: s.name, 'aria-label': '면 이름' });
  name.addEventListener('change', () => patchSurface(s.id, { name: name.value.trim() || s.name }));
  const src = sourceOptions(s.sourceId);
  src.setAttribute('aria-label', '이 면에 투사할 소스');
  src.addEventListener('change', () => patchSurface(s.id, { sourceId: src.value || null }));
  const opacityOut = h('span', { class: 'muted small' }, `${Math.round(s.opacity * 100)}%`);
  const opacity = slider({ min: 0, max: 1, step: 0.01, value: s.opacity, label: '불투명도' }, (v) => {
    opacityOut.textContent = `${Math.round(v * 100)}%`;
    patchSurface(s.id, { opacity: v }, false);
  });

  const kind: Node[] = [];
  if (s.kind === 'mesh' && s.mesh) {
    const cols = h('input', { type: 'number', min: MESH_MIN, max: MESH_MAX, value: String(s.mesh.cols), 'aria-label': '가로 격자점 수' });
    const rows = h('input', { type: 'number', min: MESH_MIN, max: MESH_MAX, value: String(s.mesh.rows), 'aria-label': '세로 격자점 수' });
    const apply = () => {
      const now = curSurface(s.id)?.mesh;
      if (!now) return;
      const c = clampInt(cols.value, MESH_MIN, MESH_MAX);
      const r = clampInt(rows.value, MESH_MIN, MESH_MAX);
      if (c === now.cols && r === now.rows) return;
      patchSurface(s.id, { mesh: resampleMesh(now, c, r) });
    };
    cols.addEventListener('change', apply);
    rows.addEventListener('change', apply);
    kind.push(
      h('label', {}, '격자점 수 (가로 × 세로)'),
      h('div', { class: 'row' }, h('div', { class: 'grow' }, cols), '×', h('div', { class: 'grow' }, rows)),
      h('div', { class: 'row', style: 'margin-top:6px' }, h('button', { type: 'button', onclick: () => patchSurface(s.id, surfaceToQuad(s)) }, '사각형으로 되돌리기'), sphereButton(s)),
    );
  } else {
    kind.push(
      h(
        'div',
        { class: 'row', style: 'margin-top:6px' },
        h('button', { type: 'button', onclick: () => patchSurface(s.id, surfaceToMesh(s, 4, 4)) }, '메시로 바꾸기 (4×4)'),
        s.kind === 'triangle' ? h('button', { type: 'button', onclick: () => patchSurface(s.id, surfaceToQuad(s)) }, '사각형으로') : null,
        sphereButton(s),
      ),
    );
  }

  const poly = s.mask.polygon;
  const feather = h('input', { type: 'number', min: 0, max: 200, value: String(s.mask.feather), 'aria-label': '마스크 가장자리 페더 (px)' });
  feather.addEventListener('change', () => {
    const now = curSurface(s.id);
    if (now) patchSurface(s.id, { mask: { ...now.mask, feather: clampInt(feather.value, 0, 200) } });
  });
  const maskBlock: Node[] = poly
    ? [
        h(
          'div',
          { class: 'row' },
          h('button', { type: 'button', 'aria-pressed': String(sel.mask), onclick: () => stage.setMaskMode(!sel.mask) }, sel.mask ? '마스크 편집 끝' : '마스크 편집'),
          h('button', { type: 'button', disabled: !sel.mask || sel.point === null || poly.length <= 3, onclick: deleteMaskPoint }, '점 삭제'),
          h('button', { type: 'button', class: 'danger', onclick: () => (stage.setMaskMode(false), patchSurface(s.id, { mask: { polygon: null, feather: 0 } })) }, '마스크 없애기'),
        ),
        h('div', { class: 'row', style: 'margin-top:6px' }, h('button', { type: 'button', onclick: () => createCircleMask(s) }, '원형으로 다시 맞추기')),
        h('label', {}, `페더 (출력 px) · 점 ${poly.length}개`),
        feather,
      ]
    : [h('div', { class: 'row' }, h('button', { type: 'button', onclick: () => createMask(s) }, '마스크 만들기'), h('button', { type: 'button', onclick: () => createCircleMask(s) }, '원형 마스크'))];

  box.replaceChildren(
    h('h2', {}, '면 속성'),
    h('label', {}, '이름'),
    name,
    h('label', {}, '소스'),
    src,
    h('label', {}, '불투명도 ', opacityOut),
    opacity,
    h('label', {}, `종류: ${kindLabel(s)}${s.locked ? ' · 잠김' : ''}`),
    ...kind,
    h('label', {}, '테두리'),
    h('div', { class: 'row' }, h('button', { type: 'button', title: '이 면과 같은 모양·자리에 테두리만 빛나는 면을 바로 위에 만듭니다 (안쪽은 투명)', onclick: () => addEdgeOverlay(s) }, '테두리 네온 두르기')),
    h('label', {}, '한꺼번에 조절'),
    ...groupBlock(s),
    h('label', {}, '마스크 (면 바깥 잘라내기)'),
    ...maskBlock,
    h('label', {}, '선택한 점'),
    h('div', { class: 'small' }, pointInfo(s)),
  );
}

/** 크기 조절 상자·원으로 맞추기·여러 점 선택 */
function groupBlock(s: Surface): Node[] {
  const n = sel.multi.length;
  const toggle = (label: string, on: boolean, title: string, fn: () => void) =>
    h('button', { type: 'button', 'aria-pressed': String(on), title, onclick: fn }, label);
  return [
    h(
      'div',
      { class: 'row' },
      toggle('크기 조절 상자', stage.boxMode, '위·아래·좌·우 변을 끌면 그쪽만, 모서리는 비율 유지, 가운데는 이동 (B)', () => {
        stage.boxMode = !stage.boxMode;
        renderPanels(true);
        stage.requestDraw();
      }),
      h('button', { type: 'button', disabled: s.locked, title: '가로·세로 픽셀 길이를 같게 — 타원을 원으로', onclick: () => stage.makeCircle() && toast('원으로 맞췄습니다') }, '원으로 맞추기'),
    ),
    h(
      'div',
      { class: 'row', style: 'margin-top:6px' },
      toggle('여러 점 선택', stage.pickMode, '켜면 점을 톡 = 고르기/빼기, 빈 곳 끌기 = 사각형으로 고르기. PC 는 Shift 를 누른 채로도 됩니다', () => {
        stage.pickMode = !stage.pickMode;
        renderPanels(true);
      }),
      h('button', { type: 'button', onclick: () => stage.selectAllPoints() }, '모든 점'),
      s.kind === 'mesh' && !sel.mask
        ? h('button', { type: 'button', disabled: sel.point === null, title: '고른 점이 있는 가로줄 전체', onclick: () => stage.selectMeshLine('row') }, '이 줄')
        : null,
      s.kind === 'mesh' && !sel.mask
        ? h('button', { type: 'button', disabled: sel.point === null, title: '고른 점이 있는 세로줄 전체', onclick: () => stage.selectMeshLine('col') }, '이 열')
        : null,
      h('button', { type: 'button', disabled: n === 0, onclick: () => stage.clearMulti() }, '선택 해제'),
    ),
    h(
      'p',
      { class: 'muted small', style: 'margin:6px 0 0' },
      n >= 2
        ? `점 ${n}개를 골랐습니다. 끌거나 방향키로 함께 움직이고, 크기 조절 상자·원으로 맞추기도 이 점들에만 적용됩니다.`
        : '점을 고르지 않으면 상자·원으로 맞추기는 면 전체에 적용됩니다. 같은 자리에 겹친 점(구의 위·아래 끝)은 함께 움직입니다.',
    ),
  ];
}

function pointInfo(s: Surface): string {
  if (sel.multi.length >= 2) return `${sel.multi.length}개 선택됨`;
  const pts = sel.mask ? (s.mask.polygon ?? []) : editablePoints(s);
  if (sel.point === null || !pts[sel.point]) return '없음 — 점을 클릭하거나 Tab';
  const [x, y] = pts[sel.point]!;
  const { width, height } = P().output;
  return `${sel.mask ? '마스크 ' : ''}${sel.point + 1}번 · x ${Math.round(x * width)}px, y ${Math.round(y * height)}px`;
}

function createMask(s: Surface): void {
  const polygon: Vec2[] = s.points.map((p) => [p[0], p[1]]);
  patchSurface(s.id, { mask: { polygon, feather: 0 } });
  stage.setMaskMode(true);
  toast('분홍 점을 끌어 마스크 모양을 맞추세요. 테두리를 두 번 클릭하면 점이 생깁니다');
}

/** 면 안에 꼭 맞는 원(타원) 마스크. 원판·둥근 표지판·공 모형 */
function createCircleMask(s: Surface): void {
  const now = curSurface(s.id) ?? s;
  stage.setMaskMode(false);
  patchSurface(s.id, { mask: { polygon: circleMask(now), feather: now.mask.feather } });
  toast('면 안에 꼭 맞는 원을 만들었습니다. 면 모서리를 먼저 맞춘 뒤 누르면 정확합니다');
}

/** 공(구) 모양 메시 버튼: 면을 공에 꼭 맞는 정사각형으로 맞춘 뒤 누른다 */
function sphereButton(s: Surface): HTMLButtonElement {
  return h(
    'button',
    {
      type: 'button',
      title: '먼저 네 모서리를 공을 딱 감싸는 정사각형에 맞춘 뒤 누르세요',
      onclick: () => {
        const now = curSurface(s.id) ?? s;
        patchSurface(s.id, { ...surfaceToSphere(now), mask: { polygon: null, feather: now.mask.feather } });
        toast('공 모양 메시로 바꿨습니다. 테두리 점을 끌어 공의 윤곽에 맞추세요');
      },
    },
    '공(구) 모양으로',
  );
}

function deleteMaskPoint(): void {
  const s = stage.surface;
  const poly = s?.mask.polygon;
  if (!s || !poly || sel.point === null) return;
  if (poly.length <= 3) return toast('마스크는 점이 3개 이상이어야 합니다');
  patchSurface(s.id, { mask: { ...s.mask, polygon: poly.filter((_, i) => i !== sel.point) } });
  stage.select(s.id, null, true);
}

function projectProps(): Node[] {
  const p = P();
  const w = h('input', { type: 'number', min: 16, max: 7680, value: String(p.output.width), 'aria-label': '출력 가로 px' });
  const hh = h('input', { type: 'number', min: 16, max: 4320, value: String(p.output.height), 'aria-label': '출력 세로 px' });
  const apply = () => {
    setProject({ ...p, output: { ...p.output, width: clampInt(w.value, 16, 7680), height: clampInt(hh.value, 16, 4320) } });
    stage.layout();
  };
  w.addEventListener('change', apply);
  hh.addEventListener('change', apply);
  return [
    h('h2', {}, '프로젝트'),
    h('p', { class: 'muted small' }, '면을 클릭하면 그 면의 속성이 나옵니다.'),
    h('label', {}, '출력 해상도 (프로젝터 해상도, 미세이동 1px 의 기준)'),
    h('div', { class: 'row' }, h('div', { class: 'grow' }, w), '×', h('div', { class: 'grow' }, hh)),
  ];
}

// ---------- 소스 ----------

function renderSources(): void {
  const p = P();
  const box = $('#sources');
  const items = p.sources.map((src) => sourceEditor(src, p.surfaces.filter((s) => s.sourceId === src.id).length));
  box.replaceChildren(
    h('h2', {}, `소스 (${p.sources.length})`),
    h(
      'div',
      { class: 'row' },
      h('button', { type: 'button', onclick: uploadSource }, '+ 파일'),
      h('button', { type: 'button', onclick: addUrlSource }, '+ 주소'),
      h('button', { type: 'button', onclick: () => addSource({ type: 'shader', name: '효과', preset: 'scanlines', params: { speed: 1, color: '#00e5ff' } }) }, '+ 효과'),
      h('button', { type: 'button', onclick: () => addSource({ type: 'color', name: '단색', value: '#ffffff' }) }, '+ 단색'),
    ),
    h('div', { class: 'sources' }, ...items),
  );
}

type NewSource = Source extends infer S ? (S extends Source ? Omit<S, 'id'> : never) : never;

function addSource(src: NewSource): string {
  const p = P();
  const id = newId('src', p.sources.map((s) => s.id));
  const full = { id, ...src } as Source;
  const next: Project = { ...p, sources: [...p.sources, full] };
  // 선택한 면이 있으면 바로 연결
  const s = stage.surface;
  if (s) next.surfaces = next.surfaces.map((x) => (x.id === s.id ? { ...x, sourceId: id } : x));
  setProject(next);
  return id;
}

function sourceEditor(src: Source, used: number): HTMLElement {
  const name = h('input', { type: 'text', value: src.name, 'aria-label': '소스 이름' });
  name.addEventListener('change', () => patchSource(src.id, { name: name.value.trim() || src.name }));
  const fields: Node[] = [];
  if (src.type === 'image' && isOldGridImage(src)) {
    fields.push(
      h('p', { class: 'muted small', style: 'margin:0' }, '예전 방식의 기본 격자(두께 고정)입니다.'),
      h('button', { type: 'button', onclick: () => upgradeGrid() }, '두께 조절 격자로 바꾸기'),
    );
  } else if (src.type === 'image' || src.type === 'video') {
    const uri = h('input', { type: 'text', value: src.uri, 'aria-label': '파일 주소' });
    uri.addEventListener('change', () => patchSource(src.id, { uri: uri.value.trim() }));
    fields.push(uri);
    if (src.type === 'video') {
      const loop = h('input', { type: 'checkbox', checked: src.loop });
      loop.addEventListener('change', () => patchSource(src.id, { loop: loop.checked }));
      fields.push(h('label', { class: 'inline' }, loop, ' 반복 재생'));
    }
  } else if (src.type === 'color') {
    const color = h('input', { type: 'color', value: src.value, 'aria-label': '색' });
    color.addEventListener('pointerdown', () => store.checkpoint());
    color.addEventListener('input', () => patchSource(src.id, { value: color.value }, false));
    fields.push(color);
  } else {
    const preset = h('select', { 'aria-label': '효과 종류' });
    for (const ps of SHADER_PRESETS) preset.append(h('option', { value: ps.id, selected: ps.id === src.preset }, ps.label));
    preset.addEventListener('change', () => patchSource(src.id, { preset: preset.value as ShaderPreset }));
    const color = h('input', { type: 'color', value: src.params.color, 'aria-label': '효과 색' });
    color.addEventListener('pointerdown', () => store.checkpoint());
    color.addEventListener('input', () => patchSource(src.id, { params: { ...currentParams(src.id), color: color.value } }, false));
    if (src.preset === 'grid') {
      // 격자: 속도 대신 선·테두리 두께 (출력 px)
      color.setAttribute('aria-label', '격자 선 색');
      const widthCtl = (key: 'lineWidth' | 'borderWidth' | 'cellsX' | 'cellsY', label: string, min: number, def: number, max = GRID_WIDTH_MAX, unit = 'px') => {
        const out = h('span', { class: 'muted small' }, `${src.params[key] ?? def}${unit}`);
        const s = slider({ min, max, step: 1, value: src.params[key] ?? def, label }, (v) => {
          out.textContent = `${v}${unit}`;
          patchSource(src.id, { params: { ...currentParams(src.id), [key]: v } }, false);
        });
        return [h('label', {}, `${label} `, out), s];
      };
      fields.push(
        h('div', { class: 'row' }, h('div', { class: 'grow' }, preset), color),
        ...widthCtl('lineWidth', '선 두께', 1, GRID_LINE_DEFAULT),
        ...widthCtl('borderWidth', '테두리 두께', 0, GRID_BORDER_DEFAULT),
        ...widthCtl('cellsX', '가로 칸 수', 1, GRID_CELLS_X_DEFAULT, GRID_CELLS_MAX, '칸'),
        ...widthCtl('cellsY', '세로 칸 수', 1, GRID_CELLS_Y_DEFAULT, GRID_CELLS_MAX, '칸'),
      );
    } else {
      const speed = slider({ min: 0, max: 5, step: 0.1, value: src.params.speed, label: '효과 속도' }, (v) =>
        patchSource(src.id, { params: { ...currentParams(src.id), speed: v } }, false),
      );
      fields.push(h('div', { class: 'row' }, h('div', { class: 'grow' }, preset), color), h('label', {}, src.preset === 'edge' ? '속도 (1 = 8초에 한 바퀴)' : '속도'), speed);
      if (src.preset === 'edge') {
        // 테두리 네온: 안쪽이 투명하므로 다른 면 위에 같은 모양으로 겹쳐 쓰면 된다
        color.setAttribute('aria-label', '네온 색');
        const out = h('span', { class: 'muted small' }, `${src.params.lineWidth ?? EDGE_LINE_DEFAULT}px`);
        const lw = slider({ min: 1, max: GRID_WIDTH_MAX, step: 1, value: src.params.lineWidth ?? EDGE_LINE_DEFAULT, label: '네온 선 두께' }, (v) => {
          out.textContent = `${v}px`;
          patchSource(src.id, { params: { ...currentParams(src.id), lineWidth: v } }, false);
        });
        fields.push(h('label', {}, '선 두께 ', out), lw, h('p', { class: 'muted small', style: 'margin:0' }, '안쪽은 투명합니다. 영상이 나오는 면을 복제해 이 효과를 지정하면 그 영상에 테두리를 두를 수 있습니다.'));
      }
    }
  }
  const del = h('button', { type: 'button', class: 'icon danger', 'aria-label': `${src.name} 삭제`, onclick: () => deleteSource(src) }, '삭제');
  return h(
    'div',
    { class: 'source' },
    h('div', { class: 'row' }, h('span', { class: 'badge' }, typeLabel(src)), h('div', { class: 'grow' }, name), del),
    ...fields,
    h('div', { class: 'muted small' }, used ? `면 ${used}개에서 사용` : '사용하는 면 없음'),
  );
}

/** 예전 그림 파일 기본 격자 → 두께 조절 격자 (같은 id 라 이 소스를 쓰는 면이 모두 바뀐다) */
function upgradeGrid(): void {
  const p = P();
  setProject({ ...p, sources: p.sources.map((x) => (isOldGridImage(x) ? structuredClone(WHITE_GRID) : x)) });
  toast('두께 조절 격자로 바꿨습니다. 아래에서 선·테두리 두께를 조절하세요');
}

function currentParams(id: string) {
  const s = P().sources.find((x) => x.id === id);
  return s?.type === 'shader' ? s.params : { speed: 1, color: '#ffffff' };
}

function deleteSource(src: Source): void {
  const p = P();
  const used = p.surfaces.filter((s) => s.sourceId === src.id).length;
  if (used && !confirm(`"${src.name}" 을(를) 면 ${used}개가 쓰고 있습니다. 지울까요?`)) return;
  setProject({
    ...p,
    sources: p.sources.filter((s) => s.id !== src.id),
    surfaces: p.surfaces.map((s) => (s.sourceId === src.id ? { ...s, sourceId: null } : s)),
  });
}

function addUrlSource(): void {
  const url = prompt('이미지·영상 주소 (예: https://…/clip.mp4, assets/grid.png)');
  if (!url?.trim()) return;
  const u = url.trim();
  // 영상 '페이지' 주소는 파일이 아니라서 화면에 그릴 수 없다. 이유를 바로 알려 준다
  if (/(^|\.)(youtube\.com|youtu\.be)\//i.test(u.replace(/^https?:\/\//, ''))) {
    return toast('유튜브 주소는 쓸 수 없습니다. 유튜브는 영상 파일을 내주지 않아 면에 맞춰 휠 수 없습니다. 영상 파일(mp4)을 받아 + 파일로 올려 주세요', 'error');
  }
  if (/(^|\.)(drive\.google\.com|docs\.google\.com)\//i.test(u.replace(/^https?:\/\//, ''))) {
    return toast('구글 드라이브 공유 주소는 쓸 수 없습니다. 파일을 내려받아 + 파일로 올려 주세요', 'error');
  }
  const isVideo = /\.(mp4|webm|mov|m4v)(\?|#|$)/i.test(u);
  const name = decodeURIComponent(u.split('/').pop() || u).slice(0, 40);
  addSource(isVideo ? { type: 'video', name, uri: u, loop: true } : { type: 'image', name, uri: u });
}

async function uploadSource(): Promise<void> {
  const file = await pickFile('image/*,video/*');
  if (!file) return;
  const isVideo = file.type.startsWith('video/');
  if (syncStatus.ws === 'open') {
    // 서버가 있으면 서버에 올려 다른 기기(출력·폰)에서도 열리게 한다
    toast(`${file.name} 올리는 중…`);
    try {
      const res = await fetch(`/api/upload?name=${encodeURIComponent(file.name)}`, { method: 'POST', body: file });
      const body = (await res.json()) as { uri?: string; error?: string; type?: 'image' | 'video' };
      if (!res.ok || !body.uri) throw new Error(body.error ?? res.statusText);
      addSource(body.type === 'video' ? { type: 'video', name: file.name, uri: body.uri, loop: true } : { type: 'image', name: file.name, uri: body.uri });
      toast('올렸습니다');
    } catch (err) {
      toast(`올리기 실패: ${err instanceof Error ? err.message : String(err)}`, 'error');
    }
    return;
  }
  // 서버 없이: 이미지는 프로젝트 안에 넣는다 (8MB 까지). 영상은 서버가 필요하다.
  if (isVideo) return toast('영상 파일은 서버(npm run dev / npm start)로 실행했을 때 올릴 수 있습니다. 또는 주소로 추가하세요', 'error');
  if (file.size > 8 * 1024 * 1024) return toast('서버 없이 넣을 수 있는 이미지는 8MB 까지입니다', 'error');
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
  addSource({ type: 'image', name: file.name, uri: dataUrl });
}

function clampInt(v: string, min: number, max: number): number {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : min;
}

// 시작
renderPanels(true);
addEventListener('pagehide', () => {
  flushLocal();
  sync.close();
});
// 시험·디버깅용 (콘솔에서 확인)
Object.assign(window, { __pm: { store, stage, sync } });
