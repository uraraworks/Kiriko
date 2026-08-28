import test from 'node:test';
import assert from 'node:assert/strict';
import { cut, restore, seams, seamNear, releaseSegments, segmentsDuration, consumeAt } from '../../js/trims.js';

const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 0.001, `${msg ?? ''} ${a} != ${b}`);

/** 素材 1 本を丸ごと置いただけのプロジェクト */
function base(duration = 60) {
  return {
    clips: [{ id: 'c1', sourceId: 's1', in: 0, out: duration, volume: 1 }],
    trims: [],
  };
}
const dur = (p) => p.clips.reduce((a, c) => a + (c.out - c.in), 0);
const apply = (p, r) => ({ ...p, clips: r.clips, trims: r.trims });

test('カットすると消した区間がトリムに残る', () => {
  const p = apply(base(), cut(base(), 10, 13.2, { label: '無音' }));
  near(dur(p), 56.8, '尺');
  assert.equal(p.trims.length, 1);
  near(segmentsDuration(p.trims[0].segments), 3.2, '在庫');
  assert.deepEqual(p.trims[0].segments.map((s) => [s.sourceId, s.in, s.out]), [['s1', 10, 13.2]]);
  assert.equal(p.trims[0].label, '無音');
});

test('継ぎ目はカットした位置に立つ', () => {
  const p = apply(base(), cut(base(), 10, 13.2));
  const s = seams(p);
  assert.equal(s.length, 1);
  near(s[0].atSec, 10, '継ぎ目');
  near(s[0].remainingSec, 3.2, '残り');
});

test('前を 1 秒戻すと手前のクリップが伸びる（クリップは増えない）', () => {
  let p = apply(base(), cut(base(), 10, 13.2));
  const r = restore(p, { time: 10, seconds: 1, side: 'head' });
  p = apply(p, r);
  assert.equal(p.clips.length, 2, 'クリップは増えない');
  near(p.clips[0].out, 11, '手前のクリップの終端');
  near(p.clips[1].in, 13.2, '次のクリップの頭は動かない');
  near(r.restoredSec, 1);
  near(r.remainingSec, 2.2, '在庫の残り');
  near(dur(p), 57.8, '尺が 1 秒伸びる');
  near(seams(p)[0].atSec, 11, '継ぎ目も一緒に動く');
});

test('後を 1 秒戻すと次のクリップの頭が戻る', () => {
  let p = apply(base(), cut(base(), 10, 13.2));
  const r = restore(p, { time: 10, seconds: 1, side: 'tail' });
  p = apply(p, r);
  assert.equal(p.clips.length, 2);
  near(p.clips[0].out, 10, '手前は動かない');
  near(p.clips[1].in, 12.2, '次のクリップの頭');
  near(r.atSec, 10, '継ぎ目の位置は変わらない');
  near(dur(p), 57.8);
});

test('在庫を使い切るとトリムは消える', () => {
  let p = apply(base(), cut(base(), 10, 13.2));
  const r = restore(p, { time: 10, seconds: 5, side: 'head' });
  p = apply(p, r);
  near(r.restoredSec, 3.2, '頼まれた 5 秒ではなく、あるだけ返す');
  near(r.requestedSec, 5);
  assert.equal(p.trims.length, 0);
  near(dur(p), 60, '元の尺に戻る');
});

test('カーソルが継ぎ目から離れていると戻せない', () => {
  const p = apply(base(), cut(base(), 10, 13.2));
  assert.throws(() => restore(p, { time: 30, seconds: 1 }), /継ぎ目がありません/);
});

test('カーソルが少しずれていても近い継ぎ目に吸着する', () => {
  const p = apply(base(), cut(base(), 10, 13.2));
  const r = restore(p, { time: 10.3, seconds: 1, tolerance: 0.5 });
  near(r.atSec, 10, '10 秒の継ぎ目として解釈する');
});

test('同じ継ぎ目で二度カットすると 1 件にまとまる', () => {
  let p = apply(base(), cut(base(), 10, 12));       // 素材 10〜12 を消す
  p = apply(p, cut(p, 10, 11));                     // 続けて素材 12〜13 を消す
  assert.equal(p.trims.length, 1, '継ぎ目ごとに 1 件');
  near(segmentsDuration(p.trims[0].segments), 3);
  // 戻す時は素材の順（10〜13）で返ってくる
  const r = restore(p, { time: 10, seconds: 3, side: 'head' });
  p = apply(p, r);
  assert.equal(p.clips.length, 1, '全部戻せば元の 1 本に戻る');
  near(p.clips[0].out, 60);
});

test('既にある継ぎ目をまたいでカットしても在庫は失われない', () => {
  let p = apply(base(), cut(base(), 20, 22));       // 継ぎ目が 20 秒に立つ
  p = apply(p, cut(p, 15, 30));                     // それをまたいで切る
  assert.equal(p.trims.length, 1);
  near(segmentsDuration(p.trims[0].segments), 17, '2 + 15 秒');
  near(dur(p), 43);
  // まとめて戻せば元通り
  p = apply(p, restore(p, { time: 15, seconds: 99, side: 'head' }));
  near(dur(p), 60);
});

test('末尾を切っても戻せる', () => {
  let p = apply(base(), cut(base(), 55, 60));
  near(seams(p)[0].atSec, 55, '末尾に継ぎ目');
  p = apply(p, restore(p, { time: 55, seconds: 2, side: 'head' }));
  near(dur(p), 57);
});

test('先頭を切っても戻せる', () => {
  let p = apply(base(), cut(base(), 0, 5));
  near(seams(p)[0].atSec, 0, '先頭に継ぎ目');
  const r = restore(p, { time: 0, seconds: 2, side: 'tail' });
  p = apply(p, r);
  near(p.clips[0].in, 3, '頭が 2 秒戻る');
  near(dur(p), 57);
});

test('複数箇所を切っても、指定した継ぎ目だけが戻る', () => {
  let p = base();
  p = apply(p, cut(p, 40, 45));                     // 後ろから切る
  p = apply(p, cut(p, 10, 13));
  assert.equal(p.trims.length, 2);
  const before = seams(p).map((s) => s.atSec);
  assert.deepEqual(before.map((v) => +v.toFixed(2)), [10, 37]);
  p = apply(p, restore(p, { time: 37, seconds: 1, side: 'head' }));
  const after = seams(p).map((s) => +s.atSec.toFixed(2));
  assert.deepEqual(after, [10, 38], '手前の継ぎ目は動かない');
});

test('クリップを見失ったトリムは戻せないものとして残る', () => {
  const p = apply(base(), cut(base(), 10, 13));
  p.clips = [];                                     // 何かの拍子にクリップが消えた
  const s = seams({ ...p, trims: p.trims.map((t) => ({ ...t, prevClipId: 'gone' })) });
  assert.equal(s[0].atSec, null);
  assert.throws(() => restore({ ...p, clips: [], trims: p.trims.map((t) => ({ ...t, prevClipId: 'gone' })) },
    { time: 10 }), /継ぎ目がありません/);
});

test('releaseSegments は端から必要な分だけ切り出す', () => {
  const segs = [{ sourceId: 's1', in: 0, out: 2 }, { sourceId: 's1', in: 5, out: 8 }];
  const front = releaseSegments(segs, 3, true);
  assert.equal(front.sec, 3);
  assert.deepEqual(front.taken.map((s) => [s.in, s.out]), [[0, 2], [5, 6]]);
  assert.deepEqual(front.rest.map((s) => [s.in, s.out]), [[6, 8]]);

  const back = releaseSegments(segs, 3, false);
  assert.deepEqual(back.taken.map((s) => [s.in, s.out]), [[5, 8]]);
  assert.deepEqual(back.rest.map((s) => [s.in, s.out]), [[0, 2]]);
});

test('端を伸ばした分は在庫から差し引く（二重に戻らない）', () => {
  const p = apply(base(), cut(base(), 10, 13.2));
  // クリップの端を手でドラッグして 1 秒伸ばした、という想定
  p.clips[0].out = 11;
  p.trims = consumeAt(p, 'c1', 'out', 1);
  near(segmentsDuration(p.trims[0].segments), 2.2, '在庫が減っている');
  assert.equal(p.trims[0].segments[0].in, 11);
});

test('seamNear は許容外なら null', () => {
  const p = apply(base(), cut(base(), 10, 13.2));
  assert.equal(seamNear(p, 12, 0.5), null);
  assert.ok(seamNear(p, 10.4, 0.5));
});
