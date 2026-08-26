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

/**
 * @param {object} project
 * @param {Map<string, Mp4Source>} sourceMap
 * @param {object} opts { onProgress(ratio, text), onLog(text), signal }
 */
export async function exportProject(project, sourceMap, opts = {}) {
  const { onProgress = () => {}, onLog = () => {}, signal } = opts;
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

  const muxer = new Muxer({
    target,
    fastStart: streaming ? false : 'in-memory',
    firstTimestampBehavior: 'offset',
    video: { codec: 'avc', width, height, frameRate: fps },
    audio: audioSrc ? { codec: 'aac', sampleRate: audioRate, numberOfChannels: audioCh } : undefined,
  });

  // ---- エンコーダ ----
  let encError = null;
  const videoEncoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => { encError = e; },
  });
  videoEncoder.configure({
    codec: 'avc1.640028', // High Profile Level 4.0 (1080p30)
    width, height,
    bitrate: project.output.videoBitrate || 12_000_000,
    framerate: fps,
    latencyMode: 'quality',
    avc: { format: 'avc' },
  });

  let audioEncoder = null;
  if (audioSrc) {
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
        ctx, canvas, videoEncoder, fps, width, height, state, signal,
        onProgress: (secDone) => {
          const done = state.timelineBase + secDone;
          onProgress(done / totalOut, `映像 ${fmt(done)} / ${fmt(totalOut)}`);
        },
      });

      if (audioSrc && src.audio) {
        await encodeAudioRange(src, clip, { audioEncoder, audioRate, audioCh, state, signal });
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
  const { ctx, canvas, videoEncoder, fps, width, height, state, signal, onProgress } = o;
  const samples = src.video.samples;
  const startIdx = Mp4Source.syncIndexBefore(samples, clip.in);
  const dur = clipDuration(clip);
  const frameDur = 1 / fps;

  // CFR 整形用。pending =「いま画面に出ているべきフレーム」
  let pending = null;
  let emittedSec = 0; // このクリップで出力済みの秒数

  const emitUntil = async (limitSec) => {
    while (pending && emittedSec + 1e-9 < limitSec) {
      ctx.drawImage(pending, 0, 0, width, height);
      const ts = Math.round((state.timelineBase + emittedSec) * 1e6);
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
  const { audioEncoder, audioRate, audioCh, state, signal } = o;
  const samples = src.audio.samples;
  const startIdx = Mp4Source.indexBefore(samples, clip.in);
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
  const decoder = new AudioDecoder({
    output: (data) => queue.push(data),
    error: (e) => { decodeError = e; },
  });
  decoder.configure({
    codec: src.audio.codec.startsWith('mp4a') ? 'mp4a.40.2' : src.audio.codec,
    sampleRate: src.audio.sampleRate,
    numberOfChannels: src.audio.channels,
    description: src.audio.description,
  });

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

  for (let i = startIdx; i < samples.length; i++) {
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
  await decoder.flush();
  await pump();
  decoder.close();
  if (decodeError) throw decodeError;

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
