// テロップライブラリの並び。手で並べ替えた順を、保存日時より優先する。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sortSets, headOrder, setLabel } from '../../js/library.js';

const S = (id, savedAt, order) => (order === undefined ? { id, savedAt } : { id, savedAt, order });

test('並べ替えていなければ、保存日時の新しい順', () => {
  const r = sortSets([S('a', 100), S('b', 300), S('c', 200)]);
  assert.deepEqual(r.map((e) => e.id), ['b', 'c', 'a']);
});

test('並べ替えた順が優先される', () => {
  const r = sortSets([S('a', 100, 2), S('b', 300, 0), S('c', 200, 1)]);
  assert.deepEqual(r.map((e) => e.id), ['b', 'c', 'a']);
});

test('並べ替え前に保存したものが混ざっても落ちない（並べ替え済みが先）', () => {
  const r = sortSets([S('old1', 500), S('a', 100, 1), S('b', 300, 0), S('old2', 400)]);
  assert.deepEqual(r.map((e) => e.id), ['b', 'a', 'old1', 'old2']);
});

test('新しく保存したものは先頭に来る', () => {
  const sets = [S('a', 100, 0), S('b', 200, 1)];
  const r = sortSets([...sets, S('new', 300, headOrder(sets))]);
  assert.equal(r[0].id, 'new');
});

test('headOrder は空の一覧でも使える', () => {
  assert.equal(typeof headOrder([]), 'number');
  assert.ok(headOrder([]) < 0);
});

test('元の配列は書き換えない', () => {
  const src = [S('a', 100), S('b', 300)];
  sortSets(src);
  assert.deepEqual(src.map((e) => e.id), ['a', 'b']);
});

test('見出しは先頭の行の文字（空なら断り書き）', () => {
  assert.equal(setLabel({ telop: { rows: [{ text: 'あ' }, { text: 'い' }] } }), 'あ / い');
  assert.equal(setLabel({ telop: { rows: [] } }), '（文字なし）');
});
