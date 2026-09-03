// タイムラインの時刻計算。ここが狂うとテロップや音が映像とずれる。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  dropIndex, rippleTime, insertTime, trimShift, cutRangesFromKeep, keepRangesFromStarts,
} from '../../js/edit.js';

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

test('残す区間から切る区間を求める（マーカーの外を切る）', () => {
  // 100 秒の中に 2 箇所だけ残す
  const keep = [[20, 25], [60, 70]];
  assert.deepEqual(cutRangesFromKeep(keep, 100), [[0, 20], [25, 60], [70, 100]]);

  // のりしろを付けると残す方が広がる
  assert.deepEqual(cutRangesFromKeep(keep, 100, 3), [[0, 17], [28, 57], [73, 100]]);

  // のりしろで隣同士がくっつくと、間は切らない
  assert.deepEqual(cutRangesFromKeep([[20, 25], [30, 35]], 100, 3), [[0, 17], [38, 100]]);

  // 短い隙間は切らずに残す（細切れ防止）
  assert.deepEqual(cutRangesFromKeep([[10, 20], [23, 40]], 100, 0, 5), [[0, 10], [40, 100]]);

  // 端まで残す場合は、その外に切る所を作らない
  assert.deepEqual(cutRangesFromKeep([[0, 100]], 100), []);

  // 重なったマーカーは 1 つにまとめる
  assert.deepEqual(cutRangesFromKeep([[10, 30], [20, 40]], 100), [[0, 10], [40, 100]]);
});

test('しゃべり出しの点から残す区間を組み立てる（基本形）', () => {
  // 10 秒でしゃべり出し、20 秒から無音。次のしゃべり出しは 40 秒
  const starts = [10, 40];
  const silence = [{ start: 20, end: 35 }];
  // 10 秒のしゃべり出し: 手前 lead=0.4 を残し、20 秒の無音開始 + tail=0.6 で終わる
  // 40 秒のしゃべり出し: 手前は同じく lead
  assert.deepEqual(keepRangesFromStarts(starts, silence, 100, 0.4, 0.6), [
    [9.6, 20.6],
    [39.6, 100],
  ]);
});

test('しゃべり出しの点: 無音が見つからなければ total まで伸びる', () => {
  assert.deepEqual(keepRangesFromStarts([10], [], 100, 0.4, 0.6), [[9.6, 100]]);
});

test('しゃべり出しの点: 次のしゃべり出しの手前で打ち切られる', () => {
  // 無音が見つかっても、次のしゃべり出しの lead 手前より後ろには伸びない
  const starts = [10, 15];
  const silence = [{ start: 30, end: 50 }];   // 無音は遠くにしかなく…
  assert.deepEqual(keepRangesFromStarts(starts, silence, 100, 0.4, 0.6), [
    [9.6, 14.6],    // 次のしゃべり出し(15) - lead(0.4) で打ち切り
    [14.6, 30.6],   // 15 秒側は遠くの無音(30) + tail(0.6) まで伸びる
  ]);
});

test('しゃべり出しの点: 次のしゃべり出しが近すぎても s 自体は下限にする', () => {
  // s=10, s_next=10.2 のとき s_next-lead(9.8) は s(10) より小さいので、下限は s
  const starts = [10, 10.2];
  const silence = [];
  const ranges = keepRangesFromStarts(starts, silence, 100, 0.4, 0.6);
  assert.equal(ranges[0][1], 10);   // s を下回らない
});

test('しゃべり出しの点: starts が空なら空配列', () => {
  assert.deepEqual(keepRangesFromStarts([], [], 100), []);
});

test('しゃべり出しの点: lead で 0 を下回らない', () => {
  const ranges = keepRangesFromStarts([0.1], [], 100, 0.4, 0.6);
  assert.equal(ranges[0][0], 0);
});
