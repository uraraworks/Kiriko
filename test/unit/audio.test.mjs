// SE / BGM のプレビュー再生。カットの継ぎ目で鳴らし直しても二度鳴りしないこと。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AudioPreview } from '../../js/audio.js';

/** AudioContext のかわり。start された内容だけ記録する */
function fakeCtx() {
  const ctx = {
    currentTime: 0,
    state: 'running',
    destination: {},
    started: [],   // { when, offset, duration }
    resume() {},
    createGain() {
      return { gain: { setValueAtTime() {}, linearRampToValueAtTime() {} }, connect: () => ctx.destination };
    },
    createBufferSource() {
      const node = {
        buffer: null, loop: false, loopStart: 0, loopEnd: 0,
        connect: (dst) => dst,
        stop() { node.stopped = true; },
        start(when, offset, duration) { ctx.started.push({ when, offset, duration }); },
      };
      return node;
    },
  };
  return ctx;
}

const fakeBuffer = (duration) => ({
  duration, length: Math.round(duration * 48000), numberOfChannels: 1,
  getChannelData: () => new Float32Array(0),
});

function fakeLib(ctx, duration = 1) {
  return { ctx, get: () => fakeBuffer(duration) };
}

const SE = [{ id: 'se1', assetId: 'a', kind: 'se', start: 10, duration: 1, volume: 1 }];

test('頭から鳴らす', () => {
  const ctx = fakeCtx();
  const pv = new AudioPreview(fakeLib(ctx));
  pv.start(SE, 10);
  assert.equal(ctx.started.length, 1);
  assert.equal(ctx.started[0].offset, 0);
});

test('鳴り始めた直後の鳴らし直しでは、頭に戻さず続きから鳴らす', () => {
  const ctx = fakeCtx();
  const pv = new AudioPreview(fakeLib(ctx));
  pv.start(SE, 10);
  const first = ctx.started[0];
  ctx.currentTime = first.when + 0.08;   // 鳴り始めて 80ms 後にシークが終わって鳴らし直し
  pv.start(SE, 10);
  assert.equal(ctx.started.length, 2);
  const second = ctx.started[1];
  assert.ok(second.offset >= 0.07, `続きから鳴るはず（offset=${second.offset}）`);
  assert.ok(second.duration <= 1 - 0.07, '残りの長さも縮む');
});

test('大きく戻るシークでは、ちゃんと頭から鳴らし直す', () => {
  const ctx = fakeCtx();
  const pv = new AudioPreview(fakeLib(ctx));
  pv.start(SE, 10);
  ctx.currentTime = ctx.started[0].when + 0.5;
  pv.start(SE, 10);   // 0.35 秒より離れているので鳴らし直し
  assert.equal(ctx.started[1].offset, 0);
});

test('停止するとつながりの記録も消える', () => {
  const ctx = fakeCtx();
  const pv = new AudioPreview(fakeLib(ctx));
  pv.start(SE, 10);
  ctx.currentTime = ctx.started[0].when + 0.08;
  pv.stop();
  pv.start(SE, 10);
  assert.equal(ctx.started[1].offset, 0);
});
