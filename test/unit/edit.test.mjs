// タイムラインの時刻計算。ここが狂うとテロップや音が映像とずれる。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dropIndex, rippleTime, insertTime, trimShift } from '../../js/edit.js';

test('dropIndex: 枠の前半なら手前、後半なら次へ', () => {
  const others = [4, 4, 4];   // 0-4, 4-8, 8-12
  assert.equal(dropIndex(others, 0), 0);
  assert.equal(dropIndex(others, 1.9), 0);
  assert.equal(dropIndex(others, 2.1), 1);
  assert.equal(dropIndex(others, 6.1), 2);
  assert.equal(dropIndex(others, 11), 3);   // 末尾
  assert.equal(dropIndex(others, 99), 3);   // 尺の外でも末尾
});

test('dropIndex: 空の並びなら 0', () => {
  assert.equal(dropIndex([], 5), 0);
});

// かつて「掴んでいるものを含んだ並び」で計算していて、
// 入れ替わるたびに答えが反転し、同じ位置で行ったり来たりしていた。
test('dropIndex: 何度当てても同じ結果になる（振動しない）', () => {
  const LENS = [1, 2, 3, 5, 10];
  let checked = 0;
  for (const a of LENS) for (const b of LENS) for (const c of LENS) {
    for (let t = 0; t <= a + b + c + 5; t += 0.25) {
      for (let dragged = 0; dragged < 3; dragged++) {
        let order = [{ n: 'A', d: a }, { n: 'B', d: b }, { n: 'C', d: c }];
        const item = order[dragged];
        const seen = [];
        for (let k = 0; k < 6; k++) {
          const others = order.filter((x) => x !== item);
          const to = dropIndex(others.map((x) => x.d), t);
          others.splice(to, 0, item);
          order = others;
          seen.push(order.map((x) => x.n).join(''));
        }
        checked++;
        assert.equal(seen.at(-1), seen.at(-2),
          `振動した lens=${[a, b, c]} t=${t} drag=${item.n}: ${seen.join(' → ')}`);
      }
    }
  }
  assert.ok(checked > 20000, `総当たりが少なすぎる: ${checked}`);
});

test('rippleTime: 範囲より後ろは詰まり、範囲の中は開始へ潰れる', () => {
  assert.equal(rippleTime(2, 4, 9), 2);    // 手前はそのまま
  assert.equal(rippleTime(4, 4, 9), 4);    // 開始ちょうどはそのまま
  assert.equal(rippleTime(6, 4, 9), 4);    // 範囲の中は潰れる
  assert.equal(rippleTime(9, 4, 9), 4);    // 終了ちょうどは詰まって開始と同じ
  assert.equal(rippleTime(12, 4, 9), 7);   // 後ろは長さぶん前へ
});

test('insertTime: 境目以降だけ後ろへずれる', () => {
  assert.equal(insertTime(3, 5, 2), 3);
  assert.equal(insertTime(5, 5, 2), 7);
  assert.equal(insertTime(8, 5, 2), 10);
});

test('trimShift: 端ごとに境目と量が決まる', () => {
  // 後ろの端を 4 秒 → 2 秒（2 秒縮める）。境目はクリップの新しい終わり
  assert.deepEqual(trimShift('out', 0, 4, 2), { edge: 2, delta: -2 });
  // 後ろの端を伸ばす。境目は元の終わり
  assert.deepEqual(trimShift('out', 0, 4, 5), { edge: 4, delta: 1 });
  // 頭の端はクリップの先頭が境目
  assert.deepEqual(trimShift('in', 10, 4, 3), { edge: 10, delta: -1 });
  assert.deepEqual(trimShift('in', 10, 4, 6), { edge: 10, delta: 2 });
});

test('rippleTime と insertTime は互いに戻せる', () => {
  for (const v of [0, 3, 5, 7, 12]) {
    assert.equal(rippleTime(insertTime(v, 5, 2), 5, 7), v);
  }
});
