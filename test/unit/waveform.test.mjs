// 波形。小さい音で録れていても無音区間が見えるように、素材ごとに正規化している。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bufferPeaks, BINS_PER_SEC, autoThresholds } from '../../js/waveform.js';

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

// --- autoThresholds ---------------------------------------------------

test('autoThresholds: 空配列 → 空配列', () => {
  assert.deepEqual(autoThresholds([], BINS_PER_SEC), []);
});

test('autoThresholds: levels と同じ長さになる', () => {
  const levels = new Array(137).fill(0.05);
  const th = autoThresholds(levels, BINS_PER_SEC);
  assert.equal(th.length, levels.length);
});

test('autoThresholds: うるさい区間の方が静かな区間よりしきい値が高くなる', () => {
  const bps = BINS_PER_SEC;
  const quietSec = 40, loudSec = 40;
  const levels = [
    ...new Array(quietSec * bps).fill(0.02),
    ...new Array(loudSec * bps).fill(0.15),
  ];
  const th = autoThresholds(levels, bps, { windowSec: 20 });
  // 各区間の内側（境界の補間の影響を避ける）で比較する
  const quietTh = th[5 * bps];
  const loudTh = th[(quietSec + loudSec - 5) * bps];
  assert.ok(loudTh > quietTh, `うるさい側 ${loudTh} が静かな側 ${quietTh} より高いはず`);
});

test('autoThresholds: min / max で頭打ちになる', () => {
  const bps = BINS_PER_SEC;
  const levels = new Array(10 * bps).fill(0.9); // mult をかけると max を超える
  const th = autoThresholds(levels, bps, { min: 0.03, max: 0.2 });
  assert.ok(th.every((v) => v <= 0.2 && v >= 0.03));

  const silent = new Array(10 * bps).fill(0); // mult をかけると min を下回る
  const th2 = autoThresholds(silent, bps, { min: 0.03, max: 0.5 });
  assert.ok(th2.every((v) => v === 0.03));
});

test('autoThresholds: 節の間は線形補間になっている', () => {
  const bps = BINS_PER_SEC;
  // 前半は静か、後半はうるさい。1 秒ごとの節の値から中間点を予測できるはず
  const levels = [
    ...new Array(5 * bps).fill(0.02),
    ...new Array(5 * bps).fill(0.2),
  ];
  const th = autoThresholds(levels, bps, { windowSec: 40 }); // 広い窓でなめらかにする
  const nodeStep = bps;
  // ある節 i0 と次の節 i1 の中間点が、その 2 値の平均に近いことを確認
  const i0 = 3 * nodeStep, i1 = 4 * nodeStep, mid = Math.floor((i0 + i1) / 2);
  const predicted = (th[i0] + th[i1]) / 2;
  assert.ok(Math.abs(th[mid] - predicted) < 1e-6, `補間値 ${th[mid]} ≒ ${predicted}`);
});
