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

test('ずれが大きくても、鳴っている限り頭には戻さない', () => {
  // 継ぎ目のシークが長引くと 0.4 秒近く先行することがある（実測）。
  // ずれの大きさで打ち切ると、そこで二度鳴りが復活してしまう
  const ctx = fakeCtx();
  const pv = new AudioPreview(fakeLib(ctx));
  pv.start(SE, 10);
  ctx.currentTime = ctx.started[0].when + 0.45;
  pv.start(SE, 10);
  assert.ok(ctx.started[1].offset >= 0.44, `続きから鳴るはず（offset=${ctx.started[1].offset}）`);
});

test('鳴り終わったものは鳴らし直さない', () => {
  const ctx = fakeCtx();
  const pv = new AudioPreview(fakeLib(ctx));
  pv.start(SE, 10);
  ctx.currentTime = ctx.started[0].when + 1.2;   // 1 秒の SE を鳴らし切った後
  pv.start(SE, 10);
  assert.equal(ctx.started.length, 1);
});

test('forget() すれば頭から鳴らし直す（見たい所へ飛んだ時）', () => {
  const ctx = fakeCtx();
  const pv = new AudioPreview(fakeLib(ctx));
  pv.start(SE, 10);
  ctx.currentTime = ctx.started[0].when + 0.08;
  pv.forget();
  pv.start(SE, 10);
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

test('継ぎ目をまたぐ SE は、跨いだ瞬間に鳴っている所へ戻されない', () => {
  // A B C と並ぶうち B の頭に置いた SE が C にまたがっている場合、
  // B→C の継ぎ目で鳴らし直しが走る。ここでタイムライン位置で組み直すと、
  // 先行して鳴っていた分だけ SE が巻き戻って二重に聞こえていた
  const ctx = fakeCtx();
  const pv = new AudioPreview(fakeLib(ctx, 6));
  const long = [{ id: 'se1', assetId: 'a', kind: 'se', start: 5, duration: 6, volume: 1 }];
  pv.start(long, 5);
  ctx.currentTime = ctx.started[0].when + 5.4;   // 音が 0.4 秒先行したまま継ぎ目へ
  pv.start(long, 10);
  assert.ok(ctx.started[1].offset >= 5.39, `巻き戻さない（offset=${ctx.started[1].offset}）`);
});

// --- 終了位置まで繰り返す（ループ）---

// 2 秒の素材を 10 秒ぶん置いて、ループさせたもの
const LOOP = [{ id: 'bgm1', assetId: 'a', kind: 'bgm', start: 0, offset: 0,
                duration: 10, volume: 1, loop: true }];

test('ループ: 素材の尺を過ぎた所から再生しても鳴る', () => {
  const ctx = fakeCtx();
  const pv = new AudioPreview(fakeLib(ctx, 2));
  pv.start(LOOP, 5);            // 素材 2 秒に対して 5 秒地点
  assert.equal(ctx.started.length, 1, '丸ごと落ちている（波形は出るのに聞こえない）');
  assert.ok(Math.abs(ctx.started[0].offset - 1) < 1e-6, `素材の頭に巻き戻す（offset=${ctx.started[0].offset}）`);
  assert.equal(ctx.started[0].duration, 5, '残りの尺ぶん鳴らす');
});

test('ループ: 鳴らし直しでも落ちない（継ぎ目のたびに消えていた）', () => {
  const ctx = fakeCtx();
  const pv = new AudioPreview(fakeLib(ctx, 2));
  pv.start(LOOP, 0);
  ctx.currentTime = ctx.started[0].when + 3;   // 素材 2 秒より長く鳴った後の鳴らし直し
  pv.start(LOOP, 3);
  assert.equal(ctx.started.length, 2, '2 回目が鳴っていない');
  assert.ok(Math.abs(ctx.started[1].offset - 1) < 1e-6, `巻き戻した位置から続ける（offset=${ctx.started[1].offset}）`);
});

test('ループ: 頭出し（offset）があれば、そこから繰り返す', () => {
  const ctx = fakeCtx();
  const pv = new AudioPreview(fakeLib(ctx, 2));
  const clips = [{ ...LOOP[0], offset: 0.5 }];   // 素材の 0.5 秒から 1.5 秒ぶんを繰り返す
  pv.start(clips, 2);                            // 0.5 + (2 % 1.5) = 1.0
  assert.ok(Math.abs(ctx.started[0].offset - 1) < 1e-6, `offset=${ctx.started[0].offset}`);
});

test('ループしないものは、素材を鳴らし切ったら鳴らさない', () => {
  const ctx = fakeCtx();
  const pv = new AudioPreview(fakeLib(ctx, 2));
  pv.start([{ ...LOOP[0], loop: false }], 5);
  assert.equal(ctx.started.length, 0);
});

test('ループしないものは、素材の残りぶんで切る', () => {
  const ctx = fakeCtx();
  const pv = new AudioPreview(fakeLib(ctx, 2));
  pv.start([{ ...LOOP[0], loop: false }], 1.5);
  assert.equal(ctx.started[0].offset, 1.5);
  assert.ok(Math.abs(ctx.started[0].duration - 0.5) < 1e-6, '素材の終わりで止める');
});
