// テロップのデータ構造。旧形式のプロジェクトを開けなくなると致命的なので、移行を厚めに見る。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as T from '../../js/telop.js';

test('createTelop: セットの形になっている', () => {
  const t = T.createTelop(1, 4, {}, 'あいう');
  assert.equal(t.start, 1);
  assert.equal(t.end, 4);
  assert.equal(t.rows.length, 1);
  assert.equal(t.rows[0].text, 'あいう');
  assert.ok(t.box && typeof t.box.w === 'number');
  assert.equal(t.bgAssetId, null);
  assert.equal(t.icon.assetId, null);
  assert.ok(t.id.startsWith('tel_'));
});

test('createTelop: 枠は複製される', () => {
  const box = { x: 1, y: 2, w: 3, h: 4 };
  const t = T.createTelop(0, 1, { box });
  box.x = 999;
  assert.equal(t.box.x, 1);
});

test('createRow: 行に枠や縦寄せは持たせない（セット側の持ち物）', () => {
  const r = T.createRow('あ');
  assert.equal(r.box, undefined);
  assert.equal(r.vAlign, undefined);
  assert.equal(r.wrap, undefined);
  assert.equal(r.size, T.DEFAULT_STYLE.size);
});

// 旧形式 = 1 行ぶんの text と x/y だけを持っていた頃のもの
test('migrateTelop: 旧形式（text + x/y）を読み替える', () => {
  const old = { id: 'tel_x', start: 0, end: 3, x: 960, y: 940, size: 80, text: '昔のテロップ', align: 'center' };
  const t = T.migrateTelop(old);
  assert.equal(t.rows.length, 1);
  assert.equal(t.rows[0].text, '昔のテロップ');
  assert.ok(t.box, '枠が作られる');
  assert.ok(t.icon, 'アイコン欄が補われる');
  assert.equal(t.bgOpacity, 1);
  assert.equal(t.rowGap, 0);
  assert.equal(t.id, 'tel_x', 'id は変えない');
  assert.equal(t.start, 0);
  assert.equal(t.end, 3);
});

test('migrateTelop: 今の形はそのまま通る（何度かけても変わらない）', () => {
  const t = T.createTelop(0, 3, {}, 'あ');
  const once = T.migrateTelop(t);
  const twice = T.migrateTelop(T.migrateTelop(t));
  assert.deepEqual(twice, once);
});

test('migrateTelop: 行の書式に既定値が入る', () => {
  const t = T.migrateTelop({ id: 'a', start: 0, end: 1, box: { x: 0, y: 0, w: 10, h: 10 },
    rows: [{ text: 'あ' }] });
  assert.equal(t.rows[0].size, T.DEFAULT_STYLE.size);
  assert.equal(t.rows[0].color, T.DEFAULT_STYLE.color);
});

test('字間は行ごとの書式で、既定は 0', () => {
  assert.equal(T.DEFAULT_STYLE.letterSpacing, 0);
  assert.equal(T.createRow('あ').letterSpacing, 0);
  assert.equal(T.createTelop(0, 1, { letterSpacing: 12 }, 'あ').rows[0].letterSpacing, 12);
});

test('migrateTelop: 字間を持たない古い行にも 0 が入る', () => {
  const t = T.migrateTelop({ id: 'a', start: 0, end: 1, box: { x: 0, y: 0, w: 10, h: 10 },
    rows: [{ text: 'あ' }] });
  assert.equal(t.rows[0].letterSpacing, 0);
});

test('内縁は既定で入り、切れる', () => {
  assert.equal(T.DEFAULT_STYLE.strokeOn, true);
  assert.equal(T.createRow('あ').strokeOn, true);
  assert.equal(T.createRow('あ', { strokeOn: false }).strokeOn, false);
});

test('背景色は既定で無し。色は覚えておく', () => {
  const t = T.createTelop(0, 1);
  assert.equal(t.bgFillOn, false);
  assert.ok(/^#[0-9a-f]{6}$/i.test(t.bgFill), '既定の色が入っていない');
});

test('migrateTelop: 古いテロップにも内縁 ON と背景色の欄が入る', () => {
  const t = T.migrateTelop({ id: 'a', start: 0, end: 1, box: { x: 0, y: 0, w: 10, h: 10 },
    rows: [{ text: 'あ' }] });
  assert.equal(t.rows[0].strokeOn, true, '既存のテロップの見た目が変わってしまう');
  assert.equal(t.bgFillOn, false);
  assert.equal(t.bgFill, '#000000');
});

test('プリセットは枠と縦寄せをセットで持つ', () => {
  assert.ok(T.DEFAULT_PRESETS.length >= 4);
  for (const p of T.DEFAULT_PRESETS) {
    assert.ok(p.name, '名前がある');
    assert.ok(p.style.box, `${p.name} に枠がない`);
    assert.ok(p.style.vAlign, `${p.name} に縦寄せがない`);
    assert.ok(p.style.size > 0);
  }
});

test('既定の枠は 1920x1080 の中に収まっている', () => {
  const b = T.DEFAULT_BOX;
  assert.ok(b.x >= 0 && b.y >= 0 && b.x + b.w <= 1920 && b.y + b.h <= 1080, JSON.stringify(b));
});
