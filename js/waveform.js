// waveform.js
// A1（素材音）の波形。無音区間が見えるとカット位置を探すのが速くなる。
//
// 1.5 時間ぶんを先に全部デコードするのは重いので、**見えている範囲だけ**を
// 区間単位でデコードしてピーク値を貯める。解像度は 20 個/秒（50ms）で、
// 1.5 時間でも 40 万個程度＝約 1.6MB なので常駐して問題ない。

import { Mp4Source } from './mp4source.js';

export const BINS_PER_SEC = 20;
const SEGMENT = 20; // 秒。この単位でデコードする

export class WaveformCache {
  constructor(onReady = () => {}) {
    this.onReady = onReady;
    this.peaks = new Map();     // sourceId -> Float32Array（全長ぶん）
    this.maxSeen = new Map();   // sourceId -> これまでに見えた最大ピーク
    this.done = new Map();      // sourceId -> Set<segIndex>
    this.pending = new Set();   // `${sourceId}:${seg}`
    this.queue = [];
    this.busy = false;
    this.enabled = true;
  }

  peaksFor(source) {
    let p = this.peaks.get(source.id);
    if (!p) {
      p = new Float32Array(Math.ceil((source.duration + 1) * BINS_PER_SEC));
      this.peaks.set(source.id, p);
      this.done.set(source.id, new Set());
      this.maxSeen.set(source.id, 0);
    }
    return p;
  }

  /**
   * 表示用の倍率。素材が小さい音で録れていると等倍では平らに見えてしまうので、
   * これまでに見えた最大値でそろえる。下限を置いて、無音区間がノイズで
   * 持ち上がらないようにする。
   */
  scaleFor(source) {
    const m = this.maxSeen.get(source.id) ?? 0;
    return 1 / Math.max(0.06, m);
  }

  hasSegment(source, seg) { return this.done.get(source.id)?.has(seg) ?? false; }

  /** [t0, t1) を表示するのに必要な区間を予約する */
  ensure(source, t0, t1) {
    if (!this.enabled || !source.audio) return;
    const from = Math.max(0, Math.floor(t0 / SEGMENT));
    const to = Math.floor(Math.min(source.duration, t1) / SEGMENT);
    for (let seg = from; seg <= to; seg++) {
      const key = `${source.id}:${seg}`;
      if (this.hasSegment(source, seg) || this.pending.has(key)) continue;
      this.pending.add(key);
      this.queue.push({ key, source, seg });
    }
    this.pump();
  }

  clearPending() {
    for (const j of this.queue) this.pending.delete(j.key);
    this.queue.length = 0;
  }

  setEnabled(on) {
    this.enabled = on;
    if (!on) this.clearPending();
  }

  async pump() {
    if (this.busy || !this.queue.length) return;
    this.busy = true;
    try {
      while (this.queue.length) {
        const job = this.queue.shift();
        try {
          await this.decodeSegment(job.source, job.seg);
          this.done.get(job.source.id).add(job.seg);
        } catch (e) {
          this.done.get(job.source.id)?.add(job.seg); // 失敗した区間は諦めて再試行しない
        }
        this.pending.delete(job.key);
        this.onReady();
      }
    } finally {
      this.busy = false;
    }
  }

  async decodeSegment(source, seg) {
    const t0 = seg * SEGMENT, t1 = Math.min(source.duration, t0 + SEGMENT);
    const peaks = this.peaksFor(source);
    const samples = source.audio.samples;
    const startIdx = Mp4Source.indexBefore(samples, t0);

    const out = [];
    let err = null;
    const decoder = new AudioDecoder({ output: (d) => out.push(d), error: (e) => { err = e; } });
    decoder.configure({
      codec: source.audio.codec.startsWith('mp4a') ? 'mp4a.40.2' : source.audio.codec,
      sampleRate: source.audio.sampleRate,
      numberOfChannels: source.audio.channels,
      description: source.audio.description,
    });

    const rate = source.audio.sampleRate;
    let max = this.maxSeen.get(source.id) ?? 0;
    const drain = () => {
      while (out.length) {
        const d = out.shift();
        const n = d.numberOfFrames;
        const buf = new Float32Array(n);
        d.copyTo(buf, { planeIndex: 0, format: 'f32-planar' });
        const base = d.timestamp / 1e6;
        for (let i = 0; i < n; i++) {
          const t = base + i / rate;
          if (t < t0 || t >= t1) continue;
          const bin = Math.floor(t * BINS_PER_SEC);
          const v = Math.abs(buf[i]);
          if (bin < peaks.length && v > peaks[bin]) peaks[bin] = v;
          if (v > max) max = v;
        }
        d.close();
      }
    };

    for (let i = startIdx; i < samples.length; i++) {
      const s = samples[i];
      if (s.time >= t1) break;
      const data = await source.readSample(s, 'audio');
      decoder.decode(new EncodedAudioChunk({
        type: 'key',
        timestamp: Math.round(s.time * 1e6),
        duration: Math.round(s.duration * 1e6),
        data: data.slice(),
      }));
      drain();
      if (err) throw err;
      while (decoder.decodeQueueSize > 40) { await new Promise((r) => setTimeout(r, 1)); drain(); }
    }
    await decoder.flush();
    drain();
    decoder.close();
    this.maxSeen.set(source.id, max);
    if (err) throw err;
  }
}

/** AudioBuffer（SE / BGM）からピーク列を作る。こちらはメモリ上にあるので即時 */
/** @returns {{ peaks: Float32Array, scale: number }} */
export function bufferPeaks(buf, binsPerSec = BINS_PER_SEC) {
  const n = Math.ceil(buf.duration * binsPerSec);
  const peaks = new Float32Array(n);
  const ch = buf.getChannelData(0);
  const per = buf.sampleRate / binsPerSec;
  let top = 0;
  for (let b = 0; b < n; b++) {
    const from = Math.floor(b * per), to = Math.min(ch.length, Math.floor((b + 1) * per));
    let m = 0;
    for (let i = from; i < to; i++) { const v = Math.abs(ch[i]); if (v > m) m = v; }
    peaks[b] = m;
    if (m > top) top = m;
  }
  return { peaks, scale: 1 / Math.max(0.06, top) };
}
