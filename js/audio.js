// audio.js
// 効果音 / BGM の素材管理・ミックス・プレビュー再生。
//
// 素材は mp3 を AudioBuffer に展開して持つ（SE は数百KB、BGM でも数MB なので常駐で問題ない）。
// AudioContext を出力サンプルレートで作るので、decodeAudioData の時点でリサンプル済みになる。

export const OUTPUT_RATE = 48000;

export class AudioLibrary {
  constructor(rate = OUTPUT_RATE) {
    this.rate = rate;
    this.ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: rate });
    this.buffers = new Map(); // assetId -> AudioBuffer
  }

  async add(file, id) {
    const buf = await this.ctx.decodeAudioData(await file.arrayBuffer());
    this.buffers.set(id, buf);
    return { id, name: file.name, duration: buf.duration, channels: buf.numberOfChannels };
  }

  get(id) { return this.buffers.get(id); }
  has(id) { return this.buffers.has(id); }
}

/** 音量エンベロープ（フェードイン／アウト）。クロスフェードはこれを重ねて作る */
export function gainAt(ac, localSec, master = 1) {
  let g = (ac.volume ?? 1) * master;
  const fi = ac.fadeIn ?? 0, fo = ac.fadeOut ?? 0;
  if (fi > 0 && localSec < fi) g *= localSec / fi;
  const rem = (ac.duration ?? 0) - localSec;
  if (fo > 0 && rem < fo) g *= Math.max(0, rem) / fo;
  return g;
}

/**
 * 出力の [absStart, absStart+n) サンプル区間に、SE/BGM を加算ミックスする。
 * @param {Float32Array} planar チャンネル順に並んだ平面バッファ（長さ n*channels）
 */
export function mixInto(planar, n, absStart, channels, rate, audioClips, library, mix = null) {
  for (const ac of audioClips || []) {
    const buf = library.get(ac.assetId);
    if (!buf) continue;
    const master = (ac.kind === 'bgm' ? mix?.bgm : mix?.se) ?? 1;
    if (master <= 0) continue;
    const start = Math.round(ac.start * rate);
    const len = Math.round((ac.duration ?? buf.duration) * rate);
    const from = Math.max(absStart, start);
    const to = Math.min(absStart + n, start + len);
    if (to <= from) continue;

    const offset = Math.round((ac.offset ?? 0) * rate);
    const loopLen = buf.length - offset; // ループ時に繰り返す長さ
    for (let ch = 0; ch < channels; ch++) {
      const src = buf.getChannelData(Math.min(ch, buf.numberOfChannels - 1));
      const out = planar.subarray(ch * n, ch * n + n);
      for (let i = from; i < to; i++) {
        const local = i - start;
        // ループ指定なら素材の頭に巻き戻して、指定した終了位置まで繰り返す
        const si = ac.loop && loopLen > 0 ? offset + (local % loopLen) : offset + local;
        if (si < 0 || si >= src.length) continue;
        out[i - absStart] += src[si] * gainAt(ac, local / rate, master);
      }
    }
  }
}

/** プログラムモニター再生に合わせて SE/BGM を鳴らす */
export class AudioPreview {
  constructor(library) {
    this.lib = library;
    this.nodes = [];
    this.anchor = null; // { t: タイムライン秒, at: AudioContext 時刻 }
    this.sounding = new Map(); // ac.id -> { when: 鳴り始める AudioContext 時刻, skip: 頭から飛ばした秒数 }
  }

  stop() {
    for (const n of this.nodes) { try { n.stop(); } catch {} }
    this.nodes = [];
    this.anchor = null;
    this.sounding = new Map();
  }

  /** いま鳴っている位置（タイムライン秒）。鳴っていなければ null */
  positionNow() {
    if (!this.anchor) return null;
    return this.anchor.t + (this.lib.ctx.currentTime - this.anchor.at);
  }

  /** timelineSec の位置から再生を開始する */
  start(audioClips, timelineSec, mix = null) {
    const prev = this.sounding;   // 鳴らし直す前に、いま鳴っているものを控えておく
    this.stop();
    const ctx = this.lib.ctx;
    if (ctx.state === 'suspended') ctx.resume();
    const t0 = ctx.currentTime + 0.03;
    this.anchor = { t: timelineSec, at: t0 };

    for (const ac of audioClips || []) {
      const buf = this.lib.get(ac.assetId);
      if (!buf) continue;
      const end = ac.start + (ac.duration ?? buf.duration);
      if (end <= timelineSec) continue;

      let when = t0 + Math.max(0, ac.start - timelineSec);
      let skip = Math.max(0, timelineSec - ac.start);            // 途中から鳴らす分

      // すでに鳴り始めているものは、鳴っている続きから繋ぐ。
      // カットの継ぎ目でシークが長引くと、音だけ実時間で先に進んでから鳴らし直しになるため、
      // 素直にタイムライン位置で組み直すと「鳴り始めた SE がもう一度頭から鳴る」ことがあった。
      // ただし本当のシーク（大きく戻った時）は鳴らし直す。
      const was = prev.get(ac.id);
      if (was && ctx.currentTime > was.when) {
        const nowLocal = was.skip + (ctx.currentTime - was.when); // いま鳴っている素材内の位置
        if (nowLocal > skip && nowLocal - skip < 0.35) { skip = nowLocal; when = t0; }
      }

      const offset = (ac.offset ?? 0) + skip;
      const dur = (ac.duration ?? buf.duration) - skip;
      if (dur <= 0 || offset >= buf.duration) continue;

      const master = (ac.kind === 'bgm' ? mix?.bgm : mix?.se) ?? 1;
      if (master <= 0) continue;

      const src = ctx.createBufferSource();
      src.buffer = buf;
      if (ac.loop) {
        src.loop = true;
        src.loopStart = ac.offset ?? 0;
        src.loopEnd = buf.duration;
      }
      const gain = ctx.createGain();
      // フェードをそのまま自動化カーブとして貼る
      gain.gain.setValueAtTime(gainAt(ac, skip, master), when);
      const fi = ac.fadeIn ?? 0, fo = ac.fadeOut ?? 0;
      if (fi > 0 && skip < fi) gain.gain.linearRampToValueAtTime((ac.volume ?? 1) * master, when + (fi - skip));
      if (fo > 0) gain.gain.linearRampToValueAtTime(0, when + Math.max(0, dur));
      src.connect(gain).connect(ctx.destination);

      // ループ時は素材尺を超えて鳴らせるので、長さは配置した尺で切る
      const startOffset = ac.loop
        ? (ac.offset ?? 0) + (skip % Math.max(0.001, buf.duration - (ac.offset ?? 0)))
        : Math.min(offset, buf.duration - 0.001);
      const playDur = ac.loop ? dur : Math.min(dur, buf.duration - offset);
      src.start(when, startOffset, playDur);
      this.nodes.push(src);
      this.sounding.set(ac.id, { when, skip });
    }
  }
}
