import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LIMITS, createSubtitle, formatTime, toSrt, checkLimits, splitAt, mergeAdjacent, fromSegments,
  normalizeOverlaps,
} from '../../js/subtitles.js';

test('formatTime は SRT のタイムコード形式になる', () => {
  assert.equal(formatTime(0), '00:00:00,000');
  assert.equal(formatTime(83.456), '00:01:23,456');
  assert.equal(formatTime(-1), '00:00:00,000');
});

test('toSrt は開始順に並べ替えて通し番号を振り直す', () => {
  const subs = [
    createSubtitle(5, 7, 'あとから', 'later'),
    createSubtitle(0, 2, 'さいしょ', 'first'),
  ];
  const srt = toSrt(subs, 'ja');
  assert.equal(srt, '1\n00:00:00,000 --> 00:00:02,000\nさいしょ\n\n2\n00:00:05,000 --> 00:00:07,000\nあとから\n\n');
});

test('toSrt は空白のみのエントリをその言語から除外する', () => {
  const subs = [
    createSubtitle(0, 2, 'にほんご', '   '),
    createSubtitle(2, 4, '', 'english'),
  ];
  assert.equal(toSrt(subs, 'en'), '1\n00:00:02,000 --> 00:00:04,000\nenglish\n\n');
  assert.equal(toSrt(subs, 'ja'), '1\n00:00:00,000 --> 00:00:02,000\nにほんご\n\n');
});

test('checkLimits: 空文字は全部 false', () => {
  const sub = createSubtitle(0, 2, '', '');
  assert.deepEqual(checkLimits(sub, 'ja'), { long: false, fast: false, lines: 0, maxLine: 0, cps: 0 });
});

test('checkLimits: long は行の文字数超過または行数超過', () => {
  const long1 = createSubtitle(0, 5, 'あ'.repeat(LIMITS.ja.chars + 1), '');
  assert.equal(checkLimits(long1, 'ja').long, true);
  const long2 = createSubtitle(0, 5, 'あ\nい\nう', '');
  assert.equal(checkLimits(long2, 'ja').long, true);
  const ok = createSubtitle(0, 5, 'みじかい', '');
  assert.equal(checkLimits(ok, 'ja').long, false);
});

test('checkLimits: fast は文字数/秒が cps 超過、表示秒 0 以下なら true', () => {
  // ja cps = 6。1 秒に 10 文字は超過
  const fast = createSubtitle(0, 1, 'あ'.repeat(10), '');
  assert.equal(checkLimits(fast, 'ja').fast, true);
  const slow = createSubtitle(0, 5, 'あ'.repeat(10), '');
  assert.equal(checkLimits(slow, 'ja').fast, false);
  const zeroDur = createSubtitle(3, 3, 'あ', '');
  assert.equal(checkLimits(zeroDur, 'ja').fast, true);
});

test('splitAt: テキストは前半に残り後半は空になる', () => {
  const sub = createSubtitle(0, 10, 'にほんご', 'english');
  sub.id = 'sub1';
  const out = splitAt([sub], 'sub1', 4);
  assert.equal(out.length, 2);
  assert.equal(out[0].start, 0);
  assert.equal(out[0].end, 4);
  assert.equal(out[0].ja, 'にほんご');
  assert.equal(out[0].en, 'english');
  assert.equal(out[1].start, 4);
  assert.equal(out[1].end, 10);
  assert.equal(out[1].ja, '');
  assert.equal(out[1].en, '');
  assert.notEqual(out[1].id, sub.id);
});

test('splitAt: t が範囲の内側でなければ何もしない', () => {
  const sub = createSubtitle(0, 10, 'x', 'y');
  sub.id = 'sub1';
  const out = splitAt([sub], 'sub1', 10);
  assert.equal(out.length, 1);
  assert.equal(out[0], sub);
});

test('mergeAdjacent: 隣り合う 2 つを 1 つにまとめる', () => {
  const a = createSubtitle(0, 2, 'あ', 'a');
  a.id = 'a';
  const b = createSubtitle(2, 4, 'い', 'b');
  b.id = 'b';
  const out = mergeAdjacent([a, b], 'a', 'b');
  assert.equal(out.length, 1);
  assert.equal(out[0].start, 0);
  assert.equal(out[0].end, 4);
  assert.equal(out[0].ja, 'あ\nい');
  assert.equal(out[0].en, 'a\nb');
});

test('mergeAdjacent: 隣接していなければ何もしない', () => {
  const a = createSubtitle(0, 2, 'あ', '');
  a.id = 'a';
  const b = createSubtitle(2, 4, 'い', '');
  b.id = 'b';
  const c = createSubtitle(4, 6, 'う', '');
  c.id = 'c';
  const list = [a, b, c];
  const out = mergeAdjacent(list, 'a', 'c');
  assert.equal(out, list);
});

test('fromSegments: 句点で分割し、時刻を文字数比で按分する', () => {
  // LIMITS.ja.chars * lines = 32 文字を超える長さにして、分割が起きるようにする
  const s1 = 'これはとても長い最初の文でありまして。'; // 19 文字
  const s2 = 'これも同じくらい長い二番目の文です。'; // 18 文字
  const segs = [{ start: 0, end: 10, text: s1 + s2 }];
  const draft = fromSegments(segs);
  assert.equal(draft.length, 2);
  assert.equal(draft[0].ja, s1);
  assert.equal(draft[1].ja, s2);
  assert.equal(draft[0].start, 0);
  const expectedSplit = 10 * (s1.length / (s1.length + s2.length));
  assert.ok(Math.abs(draft[0].end - expectedSplit) < 0.01);
  assert.equal(draft[1].end, 10);
  assert.equal(draft[0].en, '');
});

test('fromSegments: 重ならないように詰める', () => {
  const segs = [
    { start: 0, end: 0.5, text: 'みじかい' },
    { start: 0.6, end: 2, text: 'つぎ' },
  ];
  const draft = fromSegments(segs, { minDur: 1.2 });
  assert.ok(draft[0].end <= draft[1].start + 1e-9);
});

test('fromSegments: 最短表示秒を下回るものは伸ばす', () => {
  const segs = [{ start: 0, end: 0.3, text: 'みじかい' }];
  const draft = fromSegments(segs, { minDur: 1.2 });
  assert.ok(draft[0].end - draft[0].start >= 1.2 - 1e-9);
});

test('normalizeOverlaps: start 昇順に並べ替えて重なりを詰める', () => {
  const a = createSubtitle(4.9, 10, 'あと', '');
  const b = createSubtitle(0, 5, 'まえ', '');
  const { subtitles, dropped } = normalizeOverlaps([a, b]);
  assert.equal(subtitles.length, 2);
  assert.equal(subtitles[0].start, 0);
  assert.equal(subtitles[0].end, 4.9);
  assert.equal(subtitles[1].start, 4.9);
  assert.equal(dropped, 0);
});

test('normalizeOverlaps: 詰めた結果 minSec 未満になったものは落とす', () => {
  const a = createSubtitle(0, 5, 'まえ', '');
  const b = createSubtitle(4.9, 5.0, 'ちいさい', '');
  const { subtitles, dropped } = normalizeOverlaps([a, b], 0.3);
  assert.equal(dropped, 1);
  assert.equal(subtitles.length, 1);
  assert.equal(subtitles[0].ja, 'まえ');
});

test('normalizeOverlaps: 重なっていなければそのまま', () => {
  const a = createSubtitle(0, 2, 'あ', '');
  const b = createSubtitle(3, 5, 'い', '');
  const { subtitles, dropped } = normalizeOverlaps([a, b]);
  assert.equal(dropped, 0);
  assert.equal(subtitles[0].end, 2);
  assert.equal(subtitles[1].start, 3);
});
