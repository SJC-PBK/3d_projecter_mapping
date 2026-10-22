// 소스(이미지·영상)를 불러와 WebGL 텍스처로 올린다. 같은 소스를 여러 면이 써도 텍스처는 하나다.
// 셰이더·단색 소스는 텍스처가 필요 없으므로 여기서 다루지 않는다.

import type { Source } from '../../core/project';

interface Entry {
  key: string; // 종류+주소. 바뀌면 다시 불러온다
  tex: WebGLTexture;
  ready: boolean;
  video?: HTMLVideoElement;
  frameDirty: boolean;
  error?: string;
}

/** 'assets/x.png' 같은 상대 주소는 어느 화면(/editor/, /output/)에서든 사이트 루트 기준으로 */
export function resolveUri(uri: string): string {
  if (/^(https?:|data:|blob:|\/)/.test(uri)) return uri;
  return new URL(uri, new URL(import.meta.env.BASE_URL, location.origin)).href;
}

export class SourceManager {
  private entries = new Map<string, Entry>();
  /** 자동재생이 막혀 사용자 터치가 필요한 영상이 생기면 호출 */
  onNeedsGesture: (() => void) | null = null;
  /** 소스를 불러오지 못했을 때 */
  onError: ((sourceId: string, message: string) => void) | null = null;

  private gl: WebGL2RenderingContext;

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
  }

  /** 프로젝트의 소스 목록과 맞춘다 (새로 생긴 것 불러오기, 없어진 것 정리) */
  sync(sources: readonly Source[]): void {
    const wanted = new Map<string, MediaSource>();
    for (const s of sources) if (isMedia(s)) wanted.set(s.id, s);
    for (const [id, e] of this.entries) {
      const s = wanted.get(id);
      if (!s || keyOf(s) !== e.key) this.release(id);
    }
    for (const [id, s] of wanted) {
      const e = this.entries.get(id);
      if (!e) this.load(s);
      else if (s.type === 'video' && e.video) e.video.loop = s.loop;
    }
  }

  /** 그릴 수 있는 텍스처. 아직 준비 안 됐으면 null */
  texture(sourceId: string): WebGLTexture | null {
    const e = this.entries.get(sourceId);
    return e?.ready ? e.tex : null;
  }

  /** 매 프레임: 새 영상 프레임이 있으면 텍스처 갱신 */
  update(): void {
    const gl = this.gl;
    for (const e of this.entries.values()) {
      const v = e.video;
      if (!v || v.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || !e.frameDirty) continue;
      gl.bindTexture(gl.TEXTURE_2D, e.tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, v);
      e.ready = true;
      // requestVideoFrameCallback 이 없는 브라우저는 매 프레임 올린다
      if ('requestVideoFrameCallback' in v) e.frameDirty = false;
    }
  }

  /** 사용자 터치 후 멈춘 영상 다시 재생 */
  resumeVideos(): void {
    for (const e of this.entries.values()) e.video?.play().catch(() => undefined);
  }

  dispose(): void {
    for (const id of [...this.entries.keys()]) this.release(id);
  }

  private newTexture(): WebGLTexture {
    const gl = this.gl;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    return tex;
  }

  private load(s: MediaSource): void {
    const gl = this.gl;
    const e: Entry = { key: keyOf(s), tex: this.newTexture(), ready: false, frameDirty: true };
    this.entries.set(s.id, e);
    const fail = (msg: string) => {
      e.error = msg;
      this.onError?.(s.id, msg);
    };
    if (!s.uri) return fail('주소가 비어 있습니다');
    const url = resolveUri(s.uri);

    if (s.type === 'image') {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.decoding = 'async';
      img.onload = () => {
        if (this.entries.get(s.id) !== e) return;
        gl.bindTexture(gl.TEXTURE_2D, e.tex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
        // 작게 축소돼 그려질 때 자글거리지 않게 밉맵
        gl.generateMipmap(gl.TEXTURE_2D);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
        // 비스듬히 기운 면에서 선이 뭉개지지 않게 비등방성 필터 (지원하는 기기만)
        const aniso = gl.getExtension('EXT_texture_filter_anisotropic');
        if (aniso) {
          const max = gl.getParameter(aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT) as number;
          gl.texParameterf(gl.TEXTURE_2D, aniso.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(8, max));
        }
        e.ready = true;
      };
      img.onerror = () => fail(`이미지를 불러오지 못했습니다: ${s.uri}`);
      img.src = url;
      return;
    }

    const v = document.createElement('video');
    // 모바일 Safari 자동재생 조건: 음소거 + playsinline
    v.muted = true;
    v.defaultMuted = true;
    v.playsInline = true;
    v.setAttribute('playsinline', '');
    v.setAttribute('muted', '');
    v.loop = s.type === 'video' && s.loop;
    v.crossOrigin = 'anonymous';
    v.preload = 'auto';
    v.src = url;
    e.video = v;
    const onFrame = () => {
      e.frameDirty = true;
      if (this.entries.get(s.id) === e) v.requestVideoFrameCallback(onFrame);
    };
    if ('requestVideoFrameCallback' in v) v.requestVideoFrameCallback(onFrame);
    v.onerror = () => fail(`영상을 불러오지 못했습니다: ${s.uri}`);
    v.play().catch((err: unknown) => {
      if (err instanceof DOMException && err.name === 'NotAllowedError') this.onNeedsGesture?.();
    });
  }

  private release(id: string): void {
    const e = this.entries.get(id);
    if (!e) return;
    this.entries.delete(id);
    if (e.video) {
      e.video.pause();
      e.video.removeAttribute('src');
      e.video.load();
    }
    this.gl.deleteTexture(e.tex);
  }
}

type MediaSource = Extract<Source, { type: 'image' | 'video' }>;

function isMedia(s: Source): s is MediaSource {
  return s.type === 'image' || s.type === 'video';
}

function keyOf(s: MediaSource): string {
  return `${s.type}:${s.uri}`;
}
