// 작은 DOM 도우미. 프레임워크 없이 화면을 만든다.

type Attrs = Record<string, string | number | boolean | null | undefined | EventListener>;
type Child = Node | string | number | null | undefined | false;

/** h('button', { class: 'x', onclick: fn }, '라벨') */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k in el && k !== 'list' && k !== 'form' && typeof v !== 'string') (el as unknown as Record<string, unknown>)[k] = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

export function $(sel: string, root: ParentNode = document): HTMLElement {
  const el = root.querySelector<HTMLElement>(sel);
  if (!el) throw new Error(`요소 없음: ${sel}`);
  return el;
}

/** 잠깐 떴다 사라지는 알림 (화면 읽기 프로그램에도 읽힌다) */
export function toast(message: string, kind: 'info' | 'error' = 'info'): void {
  let box = document.getElementById('toasts');
  if (!box) {
    box = h('div', { id: 'toasts', role: 'status', 'aria-live': 'polite' });
    document.body.append(box);
  }
  const t = h('div', { class: `toast toast-${kind}` }, message);
  box.append(t);
  setTimeout(() => t.remove(), kind === 'error' ? 6000 : 2500);
}

/** 위쪽 안내 띠: 글 + 버튼들 (같은 id 는 하나만) */
export function showBanner(id: string, text: string, buttons: { label: string; primary?: boolean; onClick: () => void }[]): void {
  document.getElementById(id)?.remove();
  const bar = h('div', { id, class: 'banner', role: 'alert' }, text + ' ');
  for (const b of buttons) {
    bar.append(h('button', { type: 'button', class: b.primary ? 'primary' : '', onclick: () => (b.onClick(), bar.remove()) }, b.label));
  }
  document.body.append(bar);
}

/** 새 버전 안내 띠 (편집 중일 수 있어 자동으로 새로고침하지 않는다) */
export function showUpdateBanner(): void {
  if (document.getElementById('update-banner')) return;
  const bar = h(
    'div',
    { id: 'update-banner', role: 'alert' },
    '새 버전이 배포됐습니다. 새로고침하면 적용됩니다 (지금 작업은 저장돼 있습니다). ',
    h('button', { type: 'button', class: 'primary', onclick: () => location.reload() }, '지금 새로고침'),
    h('button', { type: 'button', onclick: () => bar.remove() }, '나중에'),
  );
  document.body.append(bar);
}

/** 파일 내려받기 */
export function download(filename: string, text: string, type = 'application/json'): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = h('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** 파일 고르기 */
export function pickFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = h('input', { type: 'file', accept });
    input.addEventListener('change', () => resolve(input.files?.[0] ?? null));
    input.click();
  });
}
