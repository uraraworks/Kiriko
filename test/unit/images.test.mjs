// 画像の配置。テロップ用 PNG が全画面にぴったり乗ることが要。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as I from '../../js/images.js';

const W = 1920, H = 1080;
const near = (a, b, tol = 0.01) => assert.ok(Math.abs(a - b) < tol, `${a} ≒ ${b} でない`);

test('全画面はぴったり画面いっぱい', () => {
  assert.deepEqual(I.placementBox('full', { width: 1920, height: 1080 }, W, H),
    { x: 0, y: 0, w: W, h: H });
});

test('画面下・画面上は 1/3 の帯に収まり、左右中央に来る', () => {
  const asset = { width: 800, height: 200 };
  const b = I.placementBox('bottom', asset, W, H);
  near(b.x + b.w / 2, W / 2);
  assert.ok(b.y >= H - H / 3 - 0.01, '下 1/3 の中に入る');
  assert.ok(b.y + b.h <= H + 0.01);
  const t = I.placementBox('top', asset, W, H);
  assert.ok(t.y >= 0 && t.y + t.h <= H / 3 + 0.01);
});

test('どの配置でも比率は変わらない', () => {
  const asset = { width: 640, height: 480 };
  for (const p of I.PLACEMENTS.map((x) => x.id)) {
    if (p === 'full') continue;
    const b = I.placementBox(p, asset, W, H);
    near(b.w / b.h, 640 / 480);
  }
});

test('知らない配置名は中央に落ちる', () => {
  const asset = { width: 640, height: 480 };
  assert.deepEqual(I.placementBox('なにこれ', asset, W, H), I.placementBox('center', asset, W, H));
});

test('既定配置: 出力と同じ比率なら全画面、違えば中央', () => {
  assert.equal(I.defaultPlacement({ width: 1920, height: 1080 }, W, H), 'full');
  assert.equal(I.defaultPlacement({ width: 3840, height: 2160 }, W, H), 'full');
  assert.equal(I.defaultPlacement({ width: 500, height: 500 }, W, H), 'center');
});

test('createImageClip: 枠は複製される（元を書き換えても影響しない）', () => {
  const box = { x: 1, y: 2, w: 3, h: 4 };
  const im = I.createImageClip('a1', 0, 3, box);
  box.x = 999;
  assert.equal(im.box.x, 1);
  assert.equal(im.fit, 'contain');
  assert.ok(im.id.startsWith('img_'));
});

test('drawnRect: contain は余白ができ、stretch は枠いっぱい', () => {
  const im = { box: { x: 0, y: 0, w: 400, h: 400 }, fit: 'contain' };
  const bmp = { width: 200, height: 100 };
  const r = I.drawnRect(im, bmp);
  assert.deepEqual(r, { x: 0, y: 100, w: 400, h: 200 });
  assert.deepEqual(I.drawnRect({ ...im, fit: 'stretch' }, bmp), im.box);
  assert.deepEqual(I.drawnRect(im, null), im.box, '画像が無い時は枠をそのまま');
});

test('切り出し範囲（crop）を指定できる', () => {
  const bmp = { width: 1000, height: 800 };

  // 指定なしなら画像全体
  assert.deepEqual(I.srcRect({ crop: null }, bmp), { x: 0, y: 0, w: 1000, h: 800 });

  // 指定した範囲をそのまま返す
  assert.deepEqual(I.srcRect({ crop: { x: 100, y: 50, w: 400, h: 300 } }, bmp),
    { x: 100, y: 50, w: 400, h: 300 });

  // 画像からはみ出したら中に丸める（外を読んで透明にならないように）
  assert.deepEqual(I.srcRect({ crop: { x: 900, y: 700, w: 500, h: 500 } }, bmp),
    { x: 900, y: 700, w: 100, h: 100 });
  assert.deepEqual(I.srcRect({ crop: { x: -50, y: -50, w: 200, h: 200 } }, bmp),
    { x: 0, y: 0, w: 200, h: 200 });

  // contain の比率は「切り出した範囲」で決まる。
  // 正方形に切り出したなら、横長の枠に置いても正方形のまま
  const im = { box: { x: 0, y: 0, w: 400, h: 200 }, fit: 'contain',
    crop: { x: 0, y: 0, w: 300, h: 300 } };
  const r = I.drawnRect(im, bmp);
  assert.ok(Math.abs(r.w - r.h) < 0.01, `正方形にならない: ${r.w}×${r.h}`);
  assert.ok(Math.abs(r.h - 200) < 0.01, '枠の高さに収まっていない');
  assert.ok(Math.abs(r.x - 100) < 0.01, '横方向で中央に来ていない');

  // 切り出さない場合は従来どおり画像全体の比率
  const im2 = { box: { x: 0, y: 0, w: 400, h: 200 }, fit: 'contain', crop: null };
  const r2 = I.drawnRect(im2, bmp);
  assert.ok(Math.abs(r2.w / r2.h - 1000 / 800) < 0.01, '元の比率が保たれていない');
});
