// テロップ・画像の枠。画面外へ出さない／端に吸着する、が効かなくなると使い勝手が一気に落ちる。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as B from '../../js/boxes.js';

const W = 1920, H = 1080;

test('clampBox: 画面の外に出さない', () => {
  assert.deepEqual(B.clampBox({ x: -50, y: -50, w: 200, h: 100 }, W, H),
    { x: 0, y: 0, w: 200, h: 100 });
  assert.deepEqual(B.clampBox({ x: 5000, y: 5000, w: 200, h: 100 }, W, H),
    { x: W - 200, y: H - 100, w: 200, h: 100 });
});

test('clampBox: 画面より大きい枠は、はみ出しを両側に許す', () => {
  const b = B.clampBox({ x: 100, y: 0, w: 3000, h: 100 }, W, H);
  assert.ok(b.x <= 0 && b.x >= W - 3000, `x=${b.x}`);
});

test('snapBox: 端・中央・セーフマージンに吸い付く', () => {
  const box = { x: 0, y: 0, w: 400, h: 100 };
  assert.equal(B.snapBox({ ...box, x: 6 }, W, H).box.x, 0);          // 左端
  assert.equal(B.snapBox({ ...box, x: 55 }, W, H).box.x, 60);        // マージン
  assert.equal(B.snapBox({ ...box, x: W / 2 - 200 + 3 }, W, H).box.x, W / 2 - 200); // 中央
  assert.equal(B.snapBox({ ...box, x: W - 400 - 2 }, W, H).box.x, W - 400);         // 右端
});

test('snapBox: 遠ければ動かさない', () => {
  const r = B.snapBox({ x: 500, y: 300, w: 400, h: 100 }, W, H);
  assert.equal(r.box.x, 500);
  assert.equal(r.box.y, 300);
  assert.equal(r.guides.length, 0);
});

test('snapBox: 吸着したらガイド線が返る', () => {
  const r = B.snapBox({ x: 3, y: 3, w: 400, h: 100 }, W, H);
  assert.equal(r.guides.length, 2);
  assert.deepEqual(r.guides.map((g) => g.axis).sort(), ['x', 'y']);
});

test('resizeBox: 各ハンドルが期待どおり動く', () => {
  const o = { x: 100, y: 100, w: 400, h: 200 };
  assert.deepEqual(B.resizeBox(o, 'e', 50, 0), { x: 100, y: 100, w: 450, h: 200 });
  assert.deepEqual(B.resizeBox(o, 'w', 50, 0), { x: 150, y: 100, w: 350, h: 200 });
  assert.deepEqual(B.resizeBox(o, 's', 0, 50), { x: 100, y: 100, w: 400, h: 250 });
  assert.deepEqual(B.resizeBox(o, 'n', 0, 50), { x: 100, y: 150, w: 400, h: 150 });
});

test('resizeBox: 最小サイズより小さくならない', () => {
  const o = { x: 100, y: 100, w: 400, h: 200 };
  const r = B.resizeBox(o, 'e', -1000, 0, { min: 40 });
  assert.equal(r.w, 40);
  // 左を掴んで潰した時は、右端が動かないように x も戻る
  const l = B.resizeBox(o, 'w', 1000, 0, { min: 40 });
  assert.equal(l.w, 40);
  assert.equal(l.x + l.w, o.x + o.w);
});

test('resizeBox: 比率を保つ指定', () => {
  const o = { x: 0, y: 0, w: 400, h: 200 };
  const r = B.resizeBox(o, 'se', 200, 0, { aspect: 2 });
  assert.equal(r.w / r.h, 2);
});

test('fitInto: 画面より大きい枠は収まるまで縮む（比率は保つ）', () => {
  const r = B.fitInto({ x: -100, y: -100, w: 3840, h: 2160 }, W, H);
  assert.ok(r.w <= W + 0.001 && r.h <= H + 0.001, `${r.w}x${r.h}`);
  assert.ok(Math.abs(r.w / r.h - 3840 / 2160) < 1e-6);
});

test('fitInto: 収まっている枠はそのまま', () => {
  const b = { x: 100, y: 100, w: 400, h: 200 };
  assert.deepEqual(B.fitInto(b, W, H), b);
});

test('hitHandle / insideBox', () => {
  const b = { x: 100, y: 100, w: 400, h: 200 };
  assert.equal(B.hitHandle(b, 100, 100, 10), 'nw');
  assert.equal(B.hitHandle(b, 500, 300, 10), 'se');
  assert.equal(B.hitHandle(b, 300, 200, 10), null);   // 真ん中はハンドルでない
  assert.ok(B.insideBox(b, 300, 200));
  assert.ok(!B.insideBox(b, 90, 200));
  assert.deepEqual(Object.keys(B.handlePoints(b)).sort(), [...B.HANDLES].sort());
});

test('snapResize: 掴んだ辺だけが吸着する', () => {
  const b = { x: 3, y: 300, w: 400, h: 100 };
  const r = B.snapResize(b, 'w', W, H);
  assert.equal(r.box.x, 0);
  assert.equal(r.box.y, 300, '掴んでいない辺は動かない');
});
