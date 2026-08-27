// thumbs.js
// タイムライン V1 のサムネイル（フィルムストリップ）。
//
// 1.5 時間の素材を先に全部作るのは無理なので、**画面に見えている範囲だけ**を
// 遅延生成してキャッシュする。生成は <video> のシークでやるため 1 枚ずつ順番に処理し、
// 表示範囲が変わったら未処理の要求は捨てる。

export const THUMB_H = 40;
export const THUMB_W = Math.round((THUMB_H * 16) / 9);

export class ThumbCache {
  /** @param {(?)=>void} onReady 1 枚できるたびに呼ばれる（再描画用） */
  constructor(onReady = () => {}) {
    this.onReady = onReady;
    this.cache = new Map();   // `${sourceId}:${sec}` -> ImageBitmap | 'failed'
    this.videos = new Map();  // sourceId -> HTMLVideoElement
    this.queue = [];
    this.busy = false;
    this.enabled = true;
    this.max = 600;           // 保持枚数の上限（超えたら古いものから捨てる）
  }

  key(sourceId, sec) { return `${sourceId}:${sec}`; }

  /** 即座に返せるものだけ返す。無ければ生成を予約して null */
  get(source, sec) {
    if (!this.enabled) return null;
    const t = Math.max(0, Math.round(sec));
    const k = this.key(source.id, t);
    const hit = this.cache.get(k);
    if (hit) return hit === 'failed' ? null : hit;
    this.request(source, t);
    return null;
  }

  request(source, t) {
    const k = this.key(source.id, t);
    if (this.cache.has(k) || this.queue.some((q) => q.k === k)) return;
    this.queue.push({ k, source, t });
    this.pump();
  }

  /** 表示範囲が変わったら、まだ手を付けていない要求は捨てる */
  clearPending() { this.queue.length = 0; }

  setEnabled(on) {
    this.enabled = on;
    if (!on) this.clearPending();
  }

  async videoFor(source) {
    let v = this.videos.get(source.id);
    if (v) return v;
    v = document.createElement('video');
    v.preload = 'auto';
    v.muted = true;
    v.src = source.previewUrl;
    await new Promise((res, rej) => {
      const ok = () => { cleanup(); res(); };
      const ng = () => { cleanup(); rej(new Error('thumb video load failed')); };
      const cleanup = () => { v.removeEventListener('loadeddata', ok); v.removeEventListener('error', ng); };
      v.addEventListener('loadeddata', ok);
      v.addEventListener('error', ng);
    });
    this.videos.set(source.id, v);
    return v;
  }

  async pump() {
    if (this.busy || !this.queue.length) return;
    this.busy = true;
    try {
      while (this.queue.length) {
        const job = this.queue.shift();
        if (this.cache.has(job.k)) continue;
        try {
          const v = await this.videoFor(job.source);
          await seek(v, job.t);
          const bmp = await createImageBitmap(v, {
            resizeWidth: THUMB_W, resizeHeight: THUMB_H, resizeQuality: 'low',
          });
          this.put(job.k, bmp);
        } catch {
          this.put(job.k, 'failed');
        }
        this.onReady();
      }
    } finally {
      this.busy = false;
    }
  }

  put(k, value) {
    this.cache.set(k, value);
    if (this.cache.size > this.max) {
      const drop = this.cache.size - this.max;
      let i = 0;
      for (const key of this.cache.keys()) {
        if (i++ >= drop) break;
        const v = this.cache.get(key);
        if (v && v !== 'failed') v.close?.();
        this.cache.delete(key);
      }
    }
  }

  dispose(sourceId) {
    for (const [k, v] of [...this.cache]) {
      if (k.startsWith(`${sourceId}:`)) { if (v !== 'failed') v.close?.(); this.cache.delete(k); }
    }
    this.videos.delete(sourceId);
  }
}

function seek(v, sec) {
  return new Promise((res, rej) => {
    if (Math.abs(v.currentTime - sec) < 0.001 && v.readyState >= 2) return res();
    const ok = () => { cleanup(); res(); };
    const ng = () => { cleanup(); rej(new Error('seek failed')); };
    const cleanup = () => {
      v.removeEventListener('seeked', ok); v.removeEventListener('error', ng); clearTimeout(timer);
    };
    const timer = setTimeout(ng, 4000); // 壊れたフレームで固まらないように
    v.addEventListener('seeked', ok);
    v.addEventListener('error', ng);
    v.currentTime = Math.max(0, sec);
  });
}
