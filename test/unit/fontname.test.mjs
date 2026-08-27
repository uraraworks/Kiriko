// フォントファイルから日本語の書体名を読む部分。
// 実フォントは同梱できないので、name テーブルを組み立てて確かめる。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { headerPlan, firstFontOffset, findNameTable, readFamilyNames } from '../../js/fontname.js';

const utf16be = (s) => {
  const b = new Uint8Array(s.length * 2);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    b[i * 2] = c >> 8; b[i * 2 + 1] = c & 0xff;
  }
  return b;
};

/** name テーブルを作る。records = [{platformID, encodingID, languageID, nameID, bytes}] */
function nameTable(records) {
  const head = 6 + records.length * 12;
  const strings = [];
  let at = 0;
  const recs = records.map((r) => {
    const o = at; at += r.bytes.length; strings.push(r.bytes);
    return { ...r, off: o };
  });
  const total = head + at;
  const buf = new ArrayBuffer(total);
  const v = new DataView(buf);
  v.setUint16(0, 0);                 // format
  v.setUint16(2, records.length);    // count
  v.setUint16(4, head);              // stringOffset
  recs.forEach((r, i) => {
    const o = 6 + i * 12;
    v.setUint16(o, r.platformID); v.setUint16(o + 2, r.encodingID);
    v.setUint16(o + 4, r.languageID); v.setUint16(o + 6, r.nameID);
    v.setUint16(o + 8, r.bytes.length); v.setUint16(o + 10, r.off);
  });
  const out = new Uint8Array(buf);
  recs.forEach((r) => out.set(r.bytes, head + r.off));
  return buf;
}

const WIN_EN = { platformID: 3, encodingID: 1, languageID: 0x0409 };
const WIN_JA = { platformID: 3, encodingID: 1, languageID: 0x0411 };

test('日本語名と英語名の両方を取り出す', () => {
  const t = nameTable([
    { ...WIN_EN, nameID: 1, bytes: utf16be('Hiragino Kaku Gothic ProN') },
    { ...WIN_JA, nameID: 1, bytes: utf16be('ヒラギノ角ゴ ProN') },
  ]);
  assert.deepEqual(readFamilyNames(t), { ja: 'ヒラギノ角ゴ ProN', en: 'Hiragino Kaku Gothic ProN' });
});

test('推奨ファミリ名（16）をファミリ名（1）より優先する', () => {
  const t = nameTable([
    { ...WIN_JA, nameID: 1, bytes: utf16be('游ゴシック体 M') },
    { ...WIN_JA, nameID: 16, bytes: utf16be('游ゴシック体') },
  ]);
  assert.equal(readFamilyNames(t).ja, '游ゴシック体');
});

test('日本語名が無ければ ja は null', () => {
  const t = nameTable([{ ...WIN_EN, nameID: 1, bytes: utf16be('Helvetica') }]);
  assert.deepEqual(readFamilyNames(t), { ja: null, en: 'Helvetica' });
});

test('Mac プラットフォームの日本語レコードも読む', () => {
  const sjis = Buffer.from([0x83, 0x71, 0x83, 0x89]);   // 「ヒラ」
  const t = nameTable([
    { platformID: 1, encodingID: 1, languageID: 11, nameID: 1, bytes: new Uint8Array(sjis) },
  ]);
  assert.equal(readFamilyNames(t).ja, 'ヒラ');
});

test('壊れたデータでも落ちない', () => {
  assert.deepEqual(readFamilyNames(new ArrayBuffer(0)), { ja: null, en: null });
  assert.deepEqual(readFamilyNames(new ArrayBuffer(4)), { ja: null, en: null });
  // 件数だけ多くて中身が無い
  const b = new ArrayBuffer(6);
  new DataView(b).setUint16(2, 999);
  assert.deepEqual(readFamilyNames(b), { ja: null, en: null });
});

test('name テーブルの位置を探せる', () => {
  const numTables = 2;
  const buf = new ArrayBuffer(12 + numTables * 16);
  const v = new DataView(buf);
  v.setUint32(0, 0x00010000); v.setUint16(4, numTables);
  const put = (i, tag, off, len) => {
    const o = 12 + i * 16;
    for (let k = 0; k < 4; k++) v.setUint8(o + k, tag.charCodeAt(k));
    v.setUint32(o + 8, off); v.setUint32(o + 12, len);
  };
  put(0, 'cmap', 100, 10);
  put(1, 'name', 500, 42);
  assert.deepEqual(findNameTable(buf), { offset: 500, length: 42, base: 0 });
  assert.equal(findNameTable(new ArrayBuffer(12 + 16)), null, '無ければ null');
});

test('ヘッダの読み方: 普通のフォントと ttc', () => {
  const one = new ArrayBuffer(12);
  const v = new DataView(one);
  v.setUint32(0, 0x00010000); v.setUint16(4, 5);
  assert.deepEqual(headerPlan(one), { start: 0, need: 12 + 5 * 16 });

  const ttc = new ArrayBuffer(16);
  const t = new DataView(ttc);
  t.setUint32(0, 0x74746366);   // 'ttcf'
  t.setUint32(12, 4096);
  assert.equal(headerPlan(ttc).start, -1, 'ttc は先頭フォントを読み直す');
  assert.equal(firstFontOffset(ttc), 4096);

  assert.equal(headerPlan(new ArrayBuffer(4)), null, '短すぎるものは null');
});
