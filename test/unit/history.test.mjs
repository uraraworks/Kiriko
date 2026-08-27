// アンドゥ／リドゥ。丸ごとスナップショット方式。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { History } from '../../js/history.js';

function make(limit) {
  let state = { n: 0 };
  const h = new History(() => JSON.stringify(state), (json) => { state = JSON.parse(json); }, limit);
  return { h, get: () => state, set: (n) => { state = { n }; } };
}

test('commit した時点まで戻る', () => {
  const { h, get, set } = make();
  h.commit('1 にする'); set(1);
  h.commit('2 にする'); set(2);
  assert.equal(get().n, 2);
  assert.equal(h.undo(), '2 にする');
  assert.equal(get().n, 1);
  assert.equal(h.undo(), '1 にする');
  assert.equal(get().n, 0);
  assert.equal(h.undo(), null, 'これ以上は戻らない');
});

test('redo で進み直せる', () => {
  const { h, get, set } = make();
  h.commit('a'); set(1);
  h.undo();
  assert.equal(get().n, 0);
  assert.equal(h.redo(), 'a');
  assert.equal(get().n, 1);
});

test('新しい操作をすると redo は捨てられる', () => {
  const { h, set } = make();
  h.commit('a'); set(1);
  h.undo();
  assert.ok(h.canRedo);
  h.commit('b'); set(9);
  assert.ok(!h.canRedo);
});

// ドラッグ中は 1 操作にまとめたい。key が同じ間は積まない。
test('同じ key の連続操作は 1 つにまとまる', () => {
  const { h, get, set } = make();
  h.commit('move', 'drag:1'); set(1);
  h.commit('move', 'drag:1'); set(2);
  h.commit('move', 'drag:1'); set(3);
  assert.equal(h.undo(), 'move');
  assert.equal(get().n, 0, 'ドラッグ全体が 1 回で戻る');
});

test('endGroup で次の同じ key は別扱いになる', () => {
  const { h, get, set } = make();
  h.commit('move', 'drag:1'); set(1);
  h.endGroup();
  h.commit('move', 'drag:1'); set(2);
  h.undo();
  assert.equal(get().n, 1);
});

test('上限を超えると古いものから捨てる', () => {
  const { h, set } = make(3);
  for (let i = 1; i <= 5; i++) { h.commit(`s${i}`); set(i); }
  let count = 0;
  while (h.undo()) count++;
  assert.equal(count, 3);
});

test('canUndo / canRedo / ラベル', () => {
  const { h, set } = make();
  assert.ok(!h.canUndo && !h.canRedo);
  h.commit('切り取り'); set(1);
  assert.ok(h.canUndo);
  assert.equal(h.undoLabel, '切り取り');
  h.undo();
  assert.equal(h.redoLabel, '切り取り');
  h.clear();
  assert.ok(!h.canUndo && !h.canRedo);
});
