// exporter.js
// 採用区間だけを「デコード → Canvas 合成 → エンコード → mux」で流水処理する。
// 常時メモリに載るのは数フレーム分だけ。
//
//  映像: HEVC/H.264 decode -> canvas(CFR 30fps へ整形) -> H.264 encode
//  音声: AAC decode -> PCM 連結（クリップ間を継ぎ目なく） -> AAC encode

import { Muxer, ArrayBufferTarget, FileSystemWritableFileStreamTarget } from '../vendor/mp4-muxer.mjs';
import { Mp4Source } from './mp4source.js';
import { clipDuration } from './project.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function drain(obj, limit) {
  while (obj.encodeQueueSize > limit || obj.decodeQueueSize > limit) await sleep(2);
}

// H.264 のレベルは解像度とフレームレートで決まる。
// 1080p30 までなら 4.0 で足りるが、1440p や 4K では収まらず configure が失敗する
// （YouTube 向けに元より大きく出す使い方があるため、ここで選び直す）。
//
//        レベル  1フレームのマクロブロック数  毎秒のマクロブロック数
const AVC_LEVELS = [
  { level: 0x28, mbFrame: 8192, mbRate: 245_760 },     // 4.0  1080p30
  { level: 0x2a, mbFrame: 8704, mbRate: 522_240 },     // 4.2  1080p60
  { level: 0x32, mbFrame: 22_080, mbRate: 589_824 },   // 5.0  1440p30
  { level: 0x33, mbFrame: 36_864, mbRate: 983_040 },   // 5.1  4K30
  { level: 0x34, mbFrame: 36_864, mbRate: 2_073_600 }, // 5.2  4K60
];

/**
 * その大きさ・フレームレートで足りるレベルの候補を、低い順に返す。
 * 収まるものが無ければ最上位だけを返す（後は環境任せ）。
 * 計算だけなのでテストできる。
 * @returns {string[]} codec 文字列の候補
 */
export function avcCodecCandidates(width, height, fps) {
  const mbFrame = Math.ceil(width / 16) * Math.ceil(height / 16);
  const mbRate = mbFrame * fps;
  const fits = AVC_LEVELS.filter((l) => l.mbFrame >= mbFrame && l.mbRate >= mbRate);
  return (fits.length ? fits : [AVC_LEVELS[AVC_LEVELS.length - 1]])
    .map((l) => `avc1.6400${l.level.toString(16)}`);
}

/**
 * その大きさ・フレームレートで通る codec 文字列を選ぶ。
 * 足りるレベルから順に isConfigSupported で確かめる（環境によって上限が違うため）。
 */
async function pickAvcCodec(width, height, fps, cfg) {
  const cands = avcCodecCandidates(width, height, fps);
  for (const codec of cands) {
    try {
      const r = await VideoEncoder.isConfigSupported({ codec, ...cfg });
      if (r?.supported) return codec;
    } catch { /* 次の候補へ */ }
  }
  // 判定できない環境では、いちばん高いレベルで試す
  return cands[cands.length - 1];
}

/**
 * @param {object} project
 * @param {Map<string, Mp4Source>} sourceMap
 * @param {object} opts { onProgress, onLog, signal, composeFrame(ctx,frame,t,w,h), audioMix(planar,n,absStart,ch,rate) }
 */
export async function exportProject(project, sourceMap, opts = {}) {
  const {
    onProgress = () => {}, onLog = () => {}, signal,
    composeFrame = null,   // ぼかし＋テロップの合成（未指定なら素の映像のみ）
    audioMix = null,       // SE / BGM の加算ミックス
  } = opts;
  const clips = project.clips.filter((c) => clipDuration(c) > 0.001);
  if (clips.length === 0) throw new Error('書き出すクリップがありません');

  const first = sourceMap.get(clips[0].sourceId);
  const width = project.output.width || first.video.width;
  const height = project.output.height || first.video.height;
  const fps = project.output.fps || 30;

  // ---- 出力先 ----
  // ファイルハンドルがあればディスクへ直接ストリーム書き（15分ものでもメモリに載らない）
  let target, writable = null;
  const streaming = !!opts.fileHandle;
  if (streaming) {
    writable = await opts.fileHandle.createWritable();
    target = new FileSystemWritableFileStreamTarget(writable);
  } else {
    target = new ArrayBufferTarget();
  }

  const audioSrc = first.audio;
  const audioRate = audioSrc ? audioSrc.sampleRate : 48000;
  const audioCh = audioSrc ? Math.min(2, audioSrc.channels) : 2;

  // mp4 の索引（moov）はファイルの先頭に置く。
  // 末尾にあると、Web に置いて再生する時に索引を探しに行く分だけ再生開始が遅れる
  // （YouTube やローカル再生では差は出ないが、先頭に置いて損をする場面は無い）。
  //
  // ディスクへ直接書く場合は、先に moov の場所を空けておく必要があるので、
  // フレーム数を前もって見積もる。足りないと書き出しの最後で失敗するため多めに取る。
  // 余った分は free ボックスで埋まるだけで、無駄になるのは数 MB。
  const totalSec = clips.reduce((a, c) => a + clipDuration(c), 0);
  const room = (n) => Math.ceil(n * 1.2) + 1000;
  const muxer = new Muxer({
    target,
    fastStart: streaming
      ? {
        expectedVideoChunks: room(totalSec * fps),
        expectedAudioChunks: room((totalSec * audioRate) / 1024),  // AAC は 1024 サンプルで 1 個
      }
      : 'in-memory',
    firstTimestampBehavior: 'offset',
    video: { codec: 'avc', width, height, frameRate: fps },
    audio: { codec: 'aac', sampleRate: audioRate, numberOfChannels: audioCh },
  });

  // ---- エンコーダ ----
  let encError = null;
  const videoEncoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => { encError = e; },
  });
  const vcfg = {
    width, height,
    bitrate: project.output.videoBitrate || 12_000_000,
    framerate: fps,
    latencyMode: 'quality',
    avc: { format: 'avc' },
  };
  videoEncoder.configure({ codec: await pickAvcCodec(width, height, fps, vcfg), ...vcfg });

  let audioEncoder = null;
  {
    audioEncoder = new AudioEncoder({
      output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
      error: (e) => { encError = e; },
    });
    audioEncoder.configure({
      codec: 'mp4a.40.2',
      sampleRate: audioRate,
      numberOfChannels: audioCh,
      bitrate: project.output.audioBitrate || 192_000,
    });
  }

  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });

  const totalOut = clips.reduce((a, c) => a + clipDuration(c), 0);
  const state = {
    outFrame: 0,          // 出力済みフレーム数（CFR なので時刻はこれで決まる）
    outAudioSamples: 0,   // 出力済み音声サンプル数
    timelineBase: 0,      // 現在クリップの出力タイムライン開始秒
  };

  try {
    for (let i = 0; i < clips.length; i++) {
      if (signal?.aborted) throw new Error('中断しました');
      const clip = clips[i];
      const src = sourceMap.get(clip.sourceId);
      if (!src) throw new Error(`素材が読み込まれていません: ${clip.sourceId}`);
      onLog(`クリップ ${i + 1}/${clips.length}: ${src.name} ${fmt(clip.in)} → ${fmt(clip.out)}`);

      await encodeVideoRange(src, clip, {
        ctx, canvas, videoEncoder, fps, width, height, state, signal, composeFrame,
        onProgress: (secDone) => {
          const done = state.timelineBase + secDone;
          onProgress(done / totalOut, `映像 ${fmt(done)} / ${fmt(totalOut)}`);
        },
      });

      if (audioEncoder) {
        await encodeAudioRange(src, clip, { audioEncoder, audioRate, audioCh, state, signal, audioMix });
      }

      state.timelineBase += clipDuration(clip);
      if (encError) throw encError;
    }

    onProgress(0.99, 'flush 中…');
    await videoEncoder.flush();
    if (audioEncoder) await audioEncoder.flush();
    muxer.finalize();
    if (writable) await writable.close();
    onProgress(1, '完了');
    return streaming ? null : target.buffer;
  } finally {
    if (videoEncoder.state !== 'closed') videoEncoder.close();
    if (audioEncoder && audioEncoder.state !== 'closed') audioEncoder.close();
    if (writable && signal?.aborted) { try { await writable.abort(); } catch {} }
  }
}

// ---------------------------------------------------------------- 映像

async function encodeVideoRange(src, clip, o) {
  const { ctx, canvas, videoEncoder, fps, width, height, state, signal, onProgress, composeFrame } = o;
  const samples = src.video.samples;
  const startIdx = Mp4Source.syncIndexBefore(samples, clip.in);
  const dur = clipDuration(clip);
  const frameDur = 1 / fps;

  // CFR 整形用。pending =「いま画面に出ているべきフレーム」
  let pending = null;
  let emittedSec = 0; // このクリップで出力済みの秒数

  const emitUntil = async (limitSec) => {
    while (pending && emittedSec + 1e-9 < limitSec) {
      const timelineSec = state.timelineBase + emittedSec;
      // ぼかし・テロップの合成はプレビューと同じ関数を通す
      if (composeFrame) composeFrame(ctx, pending, timelineSec, width, height);
      else ctx.drawImage(pending, 0, 0, width, height);
      const ts = Math.round(timelineSec * 1e6);
      const frame = new VideoFrame(canvas, { timestamp: ts, duration: Math.round(frameDur * 1e6) });
      videoEncoder.encode(frame, { keyFrame: state.outFrame % (fps * 2) === 0 });
      frame.close();
      state.outFrame++;
      emittedSec += frameDur;
      await drain(videoEncoder, 12);
    }
  };

  // output コールバックは同期でキューに積むだけにする（await すると順序が壊れる）
  const queue = [];
  let decodeError = null;
  const decoder = new VideoDecoder({
    output: (frame) => queue.push(frame),
    error: (e) => { decodeError = e; },
  });
  decoder.configure({
    codec: src.video.codec,
    codedWidth: src.video.width,
    codedHeight: src.video.height,
    description: src.video.description,
    hardwareAcceleration: 'prefer-hardware',
    optimizeForLatency: false,
  });

  const pump = async () => {
    while (queue.length) {
      const frame = queue.shift();
      const srcTime = frame.timestamp / 1e6;
      if (srcTime + 1e-6 < clip.in) { frame.close(); continue; } // in 点より前は捨てる
      const rel = srcTime - clip.in;
      if (pending) {
        await emitUntil(Math.min(rel, dur));
        pending.close();
      }
      pending = frame;
    }
  };

  let lastReport = 0;
  for (let i = startIdx; i < samples.length; i++) {
    if (signal?.aborted) throw new Error('中断しました');
    const s = samples[i];
    if (s.time >= clip.out) break;
    const data = await src.readSample(s, 'video');
    decoder.decode(new EncodedVideoChunk({
      type: s.sync ? 'key' : 'delta',
      timestamp: Math.round(s.time * 1e6),
      duration: Math.round(s.duration * 1e6),
      data: data.slice(),
    }));
    await pump();
    while (decoder.decodeQueueSize > 16) { await sleep(2); await pump(); }
    if (decodeError) throw decodeError;
    if (s.time - lastReport > 0.5) { lastReport = s.time; onProgress(Math.max(0, s.time - clip.in)); }
  }
  await decoder.flush();
  await pump();
  decoder.close();
  if (decodeError) throw decodeError;

  // 末尾まで埋める（最後のフレームを out 点まで持たせる）
  await emitUntil(dur);
  if (pending) { pending.close(); pending = null; }
  for (const f of queue) f.close();
  queue.length = 0;
}

// ---------------------------------------------------------------- 音声

async function encodeAudioRange(src, clip, o) {
  const { audioEncoder, audioRate, audioCh, state, signal, audioMix } = o;
  const hasAudio = !!src.audio;
  const samples = hasAudio ? src.audio.samples : [];
  const startIdx = hasAudio ? Mp4Source.indexBefore(samples, clip.in) : 0;
  const FRAME = 1024;

  // クリップ内 PCM を貯めて 1024 サンプル単位で吐く（クリップ間の継ぎ目が出ないよう連番で timestamp を振る）
  const pcm = Array.from({ length: audioCh }, () => []);
  let queued = 0;
  const wantSamples = Math.round(clipDuration(clip) * audioRate);
  let accepted = 0;

  const flushQueue = async (force) => {
    while (queued >= FRAME || (force && queued > 0)) {
      const n = Math.min(FRAME, queued);
      const planar = new Float32Array(n * audioCh);
      for (let ch = 0; ch < audioCh; ch++) {
        const view = planar.subarray(ch * n, ch * n + n);
        let filled = 0;
        while (filled < n) {
          const head = pcm[ch][0];
          const take = Math.min(n - filled, head.length);
          view.set(head.subarray(0, take), filled);
          filled += take;
          if (take === head.length) pcm[ch].shift();
          else pcm[ch][0] = head.subarray(take);
        }
      }
      queued -= n;
      // SE / BGM をこの区間に加算する（出力サンプル位置で引き当てる）
      if (audioMix) audioMix(planar, n, state.outAudioSamples, audioCh, audioRate);
      const ad = new AudioData({
        format: 'f32-planar',
        sampleRate: audioRate,
        numberOfFrames: n,
        numberOfChannels: audioCh,
        timestamp: Math.round((state.outAudioSamples / audioRate) * 1e6),
        data: planar,
      });
      audioEncoder.encode(ad);
      ad.close();
      state.outAudioSamples += n;
      await drain(audioEncoder, 12);
    }
  };

  const gain = clip.volume ?? 1;
  const queue = [];
  let decodeError = null;
  const decoder = hasAudio ? new AudioDecoder({
    output: (data) => queue.push(data),
    error: (e) => { decodeError = e; },
  }) : null;
  if (decoder) {
    decoder.configure({
      codec: src.audio.codec.startsWith('mp4a') ? 'mp4a.40.2' : src.audio.codec,
      sampleRate: src.audio.sampleRate,
      numberOfChannels: src.audio.channels,
      description: src.audio.description,
    });
  }

  const pump = async () => {
    while (queue.length) {
      const data = queue.shift();
      const srcStart = data.timestamp / 1e6;
      const n = data.numberOfFrames;
      // in/out 点でサンプル単位にトリム
      let from = 0, to = n;
      if (srcStart < clip.in) from = Math.min(n, Math.round((clip.in - srcStart) * audioRate));
      const srcEnd = srcStart + n / audioRate;
      if (srcEnd > clip.out) to = Math.max(from, n - Math.round((srcEnd - clip.out) * audioRate));
      let len = to - from;
      if (len > 0 && accepted + len > wantSamples) len = Math.max(0, wantSamples - accepted);
      if (len > 0) {
        for (let ch = 0; ch < audioCh; ch++) {
          const buf = new Float32Array(n);
          data.copyTo(buf, { planeIndex: Math.min(ch, data.numberOfChannels - 1), format: 'f32-planar' });
          const seg = buf.slice(from, from + len);
          if (gain !== 1) for (let k = 0; k < seg.length; k++) seg[k] *= gain;
          pcm[ch].push(seg);
        }
        queued += len;
        accepted += len;
        await flushQueue(false);
      }
      data.close();
    }
  };

  for (let i = startIdx; hasAudio && i < samples.length; i++) {
    if (signal?.aborted) throw new Error('中断しました');
    const s = samples[i];
    if (s.time >= clip.out) break;
    const data = await src.readSample(s, 'audio');
    decoder.decode(new EncodedAudioChunk({
      type: 'key',
      timestamp: Math.round(s.time * 1e6),
      duration: Math.round(s.duration * 1e6),
      data: data.slice(),
    }));
    await pump();
    while (decoder.decodeQueueSize > 32) { await sleep(2); await pump(); }
    if (decodeError) throw decodeError;
  }
  if (decoder) {
    await decoder.flush();
    await pump();
    decoder.close();
    if (decodeError) throw decodeError;
  }

  // 端数を無音で埋めて映像尺と合わせる
  if (accepted < wantSamples) {
    const pad = wantSamples - accepted;
    for (let ch = 0; ch < audioCh; ch++) pcm[ch].push(new Float32Array(pad));
    queued += pad;
  }
  await flushQueue(true);
}

function fmt(sec) {
  sec = Math.max(0, sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const f = Math.floor((sec % 1) * 100);
  return `${h ? String(h).padStart(2, '0') + ':' : ''}${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(f).padStart(2, '0')}`;
}
