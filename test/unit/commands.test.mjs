import test from 'node:test';
import assert from 'node:assert/strict';
import * as P from '../../js/project.js';
import { createCommands } from '../../js/commands.js';

/** set_subtitles のテスト用に最小限の ctx を組み立てる */
function makeCommands(durationSec = 100) {
  const project = P.createProject();
  project.clips.push({ id: 'c1', sourceId: 's1', in: 0, out: durationSec, volume: 1 });
  const S = { project };
  const ctx = {
    S, P, T: null,
    commit: () => {}, renderAll: () => {}, status: () => {},
  };
  return { cmds: createCommands(ctx), S };
}

test('set_subtitles: id 指定は渡されたフィールドだけ更新する', async () => {
  const { cmds, S } = makeCommands();
  S.project.subtitles = [{ id: 'sub1', start: 0, end: 2, ja: 'にほんご', en: '' }];
  const r = await cmds.set_subtitles({ subtitles: [{ id: 'sub1', en: 'english' }] });
  assert.equal(r.updated, 1);
  assert.equal(r.added, 0);
  const sub = S.project.subtitles.find((s) => s.id === 'sub1');
  assert.equal(sub.ja, 'にほんご'); // 保持される
  assert.equal(sub.en, 'english'); // 更新される
  assert.equal(sub.start, 0);
  assert.equal(sub.end, 2);
});

test('set_subtitles: id が見つからなければ skipped で数える（エラーにしない）', async () => {
  const { cmds, S } = makeCommands();
  S.project.subtitles = [];
  const r = await cmds.set_subtitles({ subtitles: [{ id: 'no-such', en: 'x' }] });
  assert.equal(r.skipped, 1);
  assert.equal(r.updated, 0);
  assert.equal(S.project.subtitles.length, 0);
});

test('set_subtitles: id 無しは新規追加される', async () => {
  const { cmds, S } = makeCommands();
  S.project.subtitles = [];
  const r = await cmds.set_subtitles({ subtitles: [{ start: 0, end: 2, ja: 'あ' }] });
  assert.equal(r.added, 1);
  assert.equal(S.project.subtitles.length, 1);
});

test('set_subtitles: mode replace は既存を全部捨てる', async () => {
  const { cmds, S } = makeCommands();
  S.project.subtitles = [{ id: 'old', start: 0, end: 2, ja: 'ふるい', en: '' }];
  const r = await cmds.set_subtitles({
    subtitles: [{ start: 5, end: 7, ja: 'あたらしい' }],
    mode: 'replace',
  });
  assert.equal(S.project.subtitles.length, 1);
  assert.equal(S.project.subtitles[0].ja, 'あたらしい');
  assert.equal(r.added, 1);
});

test('set_subtitles: 重なりは start 昇順に詰め、0.3 秒未満は落とす', async () => {
  const { cmds, S } = makeCommands();
  S.project.subtitles = [];
  const r = await cmds.set_subtitles({
    subtitles: [
      { start: 0, end: 5, ja: 'まえ' },     // 5 に詰められる
      { start: 4.9, end: 10, ja: 'あと' },  // 前を 4.9 まで削る
    ],
  });
  const list = S.project.subtitles.slice().sort((a, b) => a.start - b.start);
  assert.equal(list.length, 2);
  assert.ok(list[0].end <= list[1].start + 1e-9);
  assert.equal(list[1].start, 4.9);
  assert.equal(r.dropped, 0);
});

test('set_subtitles: 重なりを詰めた結果 0.3 秒未満になれば落とす', async () => {
  const { cmds, S } = makeCommands();
  S.project.subtitles = [];
  const r = await cmds.set_subtitles({
    subtitles: [
      { start: 0, end: 5, ja: 'まえ' },
      { start: 4.9, end: 10, ja: 'あと' }, // 前が 4.9 秒に詰められる程度なのでこちらは残る
      { start: 4.95, end: 5.0, ja: 'ちいさい' }, // 挟まれて 0.3 秒未満になり落ちる想定
    ],
  });
  assert.ok(r.dropped >= 1);
  const list = S.project.subtitles.slice().sort((a, b) => a.start - b.start);
  for (let i = 0; i < list.length - 1; i++) {
    assert.ok(list[i].end - list[i].start >= 0.3 - 1e-9);
  }
});

test('set_subtitles: タイムライン全体の長さを超える分は clamp する', async () => {
  const { cmds, S } = makeCommands(10);
  S.project.subtitles = [];
  await cmds.set_subtitles({ subtitles: [{ start: 8, end: 20, ja: 'はみだし' }] });
  const sub = S.project.subtitles[0];
  assert.equal(sub.end, 10);
});

test('set_subtitles: autoSplit は新規追加のみに効き、id 指定の更新には効かない', async () => {
  const { cmds, S } = makeCommands();
  S.project.subtitles = [{ id: 'keep', start: 50, end: 52, ja: '元のまま', en: '' }];
  const longText = 'これはとても長い最初の文でありまして。これも同じくらい長い二番目の文です。';
  const r = await cmds.set_subtitles({
    subtitles: [
      { id: 'keep', ja: '書き換え' }, // 更新（autoSplit の対象外）
      { start: 0, end: 10, ja: longText }, // 新規（分割される）
    ],
    autoSplit: true,
  });
  assert.equal(r.updated, 1);
  assert.ok(r.added >= 2); // 長文が複数エントリに分割される
  const kept = S.project.subtitles.find((s) => s.id === 'keep');
  assert.equal(kept.ja, '書き換え');
});

test('get_subtitles: 長すぎ・速すぎに警告が付く', async () => {
  const { cmds, S } = makeCommands();
  S.project.subtitles = [
    { id: 'a', start: 0, end: 1, ja: 'あ'.repeat(20), en: '' }, // 長すぎ・速すぎ
    { id: 'b', start: 2, end: 5, ja: 'みじかい', en: '' },       // 問題なし
  ];
  const r = await cmds.get_subtitles();
  assert.equal(r.total, 2);
  assert.equal(r.warned, 1);
  const a = r.subtitles.find((s) => s.id === 'a');
  assert.ok(a.warnings.length >= 1);
  const b = r.subtitles.find((s) => s.id === 'b');
  assert.equal(b.warnings.length, 0);
});
