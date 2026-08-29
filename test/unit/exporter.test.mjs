// 書き出し設定の計算。ここを間違えると「4K を選ぶと必ず失敗する」ような形で出る。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { avcCodecCandidates, encodeRatio, ENCODE_SHARE } from '../../js/exporter.js';

const first = (w, h, f) => avcCodecCandidates(w, h, f)[0];

// 実機の Chrome で isConfigSupported を総当たりして得た対応表と一致させている。
test('解像度とフレームレートに足りるレベルを選ぶ', () => {
  assert.equal(first(1280, 720, 30), 'avc1.640028');   // 4.0
  assert.equal(first(1920, 1080, 30), 'avc1.640028');  // 4.0
  assert.equal(first(1920, 1080, 60), 'avc1.64002a');  // 4.2
  assert.equal(first(2560, 1440, 30), 'avc1.640032');  // 5.0
  assert.equal(first(3840, 2160, 30), 'avc1.640033');  // 5.1
  assert.equal(first(3840, 2160, 60), 'avc1.640034');  // 5.2
});

// レベル 4.0 固定にしていて 1440p 以上が configure で失敗していた。
test('1440p 以上でレベル 4.0 を選ばない', () => {
  for (const [w, h] of [[2560, 1440], [3840, 2160]]) {
    for (const fps of [24, 30, 60]) {
      assert.ok(!avcCodecCandidates(w, h, fps).includes('avc1.640028'),
        `${w}x${h}@${fps} で 4.0 が候補に入っている`);
    }
  }
});

test('候補は低いレベルから順に並ぶ', () => {
  const c = avcCodecCandidates(1920, 1080, 30);
  const levels = c.map((s) => parseInt(s.slice(-2), 16));
  assert.deepEqual(levels, [...levels].sort((a, b) => a - b));
  assert.ok(c.length >= 2, '上位レベルへのフォールバックが残っている');
});

test('規格を超える大きさでも空にはならない', () => {
  const c = avcCodecCandidates(7680, 4320, 60);
  assert.equal(c.length, 1);
  assert.equal(c[0], 'avc1.640034', '最上位に任せる');
});

// --- 進み具合 ---
//
// 映像を焼き終えた時点で 100% に届いてしまい、「仕上げ中…」に移った瞬間に
// ゲージが 99% へ戻って見えた（長い素材ほど目立つ）。

test('映像の進み具合は、仕上げの取り分より先には行かない', () => {
  assert.equal(encodeRatio(5700, 5700), ENCODE_SHARE);
  // 最後の刻みが端数で行き過ぎても、はみ出さない
  assert.equal(encodeRatio(5701, 5700), ENCODE_SHARE);
  assert.ok(encodeRatio(5699.9, 5700) < ENCODE_SHARE);
});

test('進み具合は増える一方', () => {
  let prev = -1;
  for (let done = 0; done <= 5700; done += 57) {
    const r = encodeRatio(done, 5700);
    assert.ok(r >= prev, `戻った: ${prev} → ${r}`);
    prev = r;
  }
  // 仕上げに移っても戻らない
  assert.ok(ENCODE_SHARE >= prev);
});

test('尺が 0 でも 0 除算にならない', () => {
  assert.equal(encodeRatio(0, 0), 0);
  assert.equal(encodeRatio(5, 0), 0);
});
