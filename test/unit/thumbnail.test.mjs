// サムネイル。重ね順と、元画像の敷き方（比率を保ったまま画面いっぱい）を見る。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createThumbnail, normalize, thumbOverlays, drawCover, SIZES, FORMATS } from '../../js/thumbnail.js';

/** drawImage の呼び出しだけ記録する 2D コンテキストのかわり */
function fakeCtx() {
  return { calls: [], drawImage(...a) { this.calls.push(a); } };
}

test('新しいサムネは空', () => {
  const t = createThumbnail();
  assert.equal(t.base, null);
  assert.deepEqual(t.telops, []);
  assert.deepEqual(t.images, []);
});

test('normalize は欠けている枠を補い、あるものは残す', () => {
  assert.deepEqual(normalize(undefined), createThumbnail());
  assert.deepEqual(normalize(null), createThumbnail());
  const t = normalize({ base: { kind: 'frame', time: 3 } });
  assert.deepEqual(t.base, { kind: 'frame', time: 3 });
  assert.deepEqual(t.telops, []);
});

test('重ね物は z の小さい順。時刻では絞り込まない', () => {
  const thumb = {
    images: [{ id: 'i1', z: 5 }, { id: 'i2', z: 0 }],
    telops: [{ id: 't1', z: 3 }],
  };
  assert.deepEqual(thumbOverlays(thumb).map((o) => o.item.id), ['i2', 't1', 'i1']);
});

test('z が無いものは 0 として扱う', () => {
  const thumb = { images: [{ id: 'i1' }], telops: [{ id: 't1', z: -1 }] };
  assert.deepEqual(thumbOverlays(thumb).map((o) => o.item.id), ['t1', 'i1']);
});

test('縦長の元画像は、横を合わせて上下をはみ出させる（余白を作らない）', () => {
  const ctx = fakeCtx();
  drawCover(ctx, { width: 1000, height: 2000 }, 1920, 1080);
  const [, dx, dy, dw, dh] = ctx.calls[0];
  assert.equal(dw, 1920);                 // 横はぴったり
  assert.ok(dh >= 1080);                  // 縦ははみ出す
  assert.equal(dx, 0);
  assert.equal(dy, (1080 - dh) / 2);      // はみ出す分は上下に均等
});

test('横長の元画像は、縦を合わせて左右をはみ出させる', () => {
  const ctx = fakeCtx();
  drawCover(ctx, { width: 4000, height: 1000 }, 1920, 1080);
  const [, dx, dy, dw, dh] = ctx.calls[0];
  assert.equal(dh, 1080);
  assert.ok(dw >= 1920);
  assert.equal(dy, 0);
  assert.equal(dx, (1920 - dw) / 2);
});

test('比率が同じならぴったり収まる', () => {
  const ctx = fakeCtx();
  drawCover(ctx, { width: 1280, height: 720 }, 1920, 1080);
  assert.deepEqual(ctx.calls[0].slice(1), [0, 0, 1920, 1080]);
});

test('書き出しの選択肢は 16:9 で、推奨サイズが先頭', () => {
  assert.equal(SIZES[0].id, '1280x720');
  for (const s of SIZES) {
    const [w, h] = s.id.split('x').map(Number);
    assert.equal(Math.round((w / h) * 100), Math.round((16 / 9) * 100));
  }
  // 2MB の上限があるので、既定は軽い方
  assert.equal(FORMATS[0].id, 'image/jpeg');
});
