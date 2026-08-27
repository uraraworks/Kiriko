// 波形。小さい音で録れていても無音区間が見えるように、素材ごとに正規化している。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bufferPeaks, BINS_PER_SEC } from '../../js/waveform.js';

// Float32Array なので厳密比較はしない
const near = (a, b, tol = 1e-6) => assert.ok(Math.abs(a - b) < tol, `${a} ≒ ${b} でない`);

/** AudioBuffer のかわり */
function fakeBuffer(samples, sampleRate = 48000) {
  return {
    sampleRate,
    duration: samples.length / sampleRate,
    length: samples.length,
    numberOfChannels: 1,
    getChannelData: () => Float32Array.from(samples),
  };
}

test('区間ごとの最大値を拾う', () => {
  const rate = 100, bins = BINS_PER_SEC;   // 1 秒 = 100 サンプル、20 ビン → 5 サンプル/ビン
  const s = new Array(100).fill(0);
  s[0] = 0.5;    // 1 ビン目
  s[7] = 0.9;    // 2 ビン目
  const { peaks } = bufferPeaks(fakeBuffer(s, rate), bins);
  assert.equal(peaks.length, bins);
  near(peaks[0], 0.5);
  near(peaks[1], 0.9);
  near(peaks[5], 0);
});

test('小さい音は引き伸ばして見えるようにする', () => {
  const one = (v) => { const a = new Array(100).fill(0); a[0] = v; return fakeBuffer(a, 100); };
  const quiet = bufferPeaks(one(0.1));
  const loud = bufferPeaks(one(1.0));
  assert.ok(quiet.scale > loud.scale, '小さい音ほど拡大率が大きい');
  near(quiet.peaks[0] * quiet.scale, 1);
});

test('無音でも 0 除算にならない', () => {
  const { scale, peaks } = bufferPeaks(fakeBuffer(new Array(100).fill(0), 100));
  assert.ok(Number.isFinite(scale) && scale > 0);
  assert.ok(peaks.every((v) => v === 0));
});

test('負の振幅も絶対値で拾う', () => {
  const a = new Array(100).fill(0); a[0] = -0.8;
  const { peaks } = bufferPeaks(fakeBuffer(a, 100));
  near(peaks[0], 0.8);
});
