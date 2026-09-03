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

// ---------------------------------------------------------------- サムネイル
//
// サムネは「文字は AI が入れる、レイアウトは人がドラッグで決める」という分担。
// 書式や座標を壊さないことと、途中まで適用されないことを見る。

/** テロップ 2 つ（1 行と 2 行）・画像 1 つのサムネを持つ ctx */
function makeThumbCommands() {
  const project = P.createProject();
  project.clips.push({ id: 'c1', sourceId: 's1', in: 0, out: 100, volume: 1 });
  project.imageAssets.push({ id: 'a_logo', name: 'ロゴ.png', width: 360, height: 360 });
  project.thumbnail = {
    base: null,
    images: [{ id: 'i1', assetId: 'a_logo', start: 0, end: 3, box: { x: 10, y: 20, w: 100, h: 100 }, z: 1 }],
    telops: [
      { id: 't1', z: 2, box: { x: 0, y: 0, w: 100, h: 50 }, rows: [{ id: 'r1', text: '一行', size: 200 }] },
      { id: 't2', z: 3, box: { x: 0, y: 0, w: 100, h: 50 }, rows: [{ id: 'r2', text: '上', size: 100 }, { id: 'r3', text: '下', size: 80 }] },
    ],
  };
  const S = { project };
  const base = [];
  const ctx = {
    S, P, T: null,
    commit: () => {}, renderAll: () => {}, status: () => {},
    tc: (t) => `${t}s`,
    setThumbBase: (b) => { project.thumbnail.base = b; base.push(b); },
  };
  return { cmds: createCommands(ctx), S };
}

test('get_thumbnail: 文字と id は返すが、書式は返さない', async () => {
  const { cmds } = makeThumbCommands();
  const r = await cmds.get_thumbnail();
  assert.deepEqual(r.telops, [
    { id: 't1', z: 2, rows: ['一行'] },
    { id: 't2', z: 3, rows: ['上', '下'] },
  ]);
  assert.equal(r.images[0].name, 'ロゴ.png');
  assert.equal(r.base, null);
});

test('set_thumbnail_text: 文字だけ変わり、書式は残る', async () => {
  const { cmds, S } = makeThumbCommands();
  const r = await cmds.set_thumbnail_text({ texts: [{ id: 't1', text: '時給857円' }] });
  assert.equal(r.updated, 1);
  const tel = S.project.thumbnail.telops[0];
  assert.equal(tel.rows[0].text, '時給857円');
  assert.equal(tel.rows[0].size, 200);          // 書式はそのまま
  assert.deepEqual(tel.box, { x: 0, y: 0, w: 100, h: 50 });
});

test('set_thumbnail_text: 改行で行に分かれる', async () => {
  const { cmds, S } = makeThumbCommands();
  await cmds.set_thumbnail_text({ texts: [{ id: 't2', text: '六甲\nアイランド' }] });
  assert.deepEqual(S.project.thumbnail.telops[1].rows.map((r) => r.text), ['六甲', 'アイランド']);
});

test('set_thumbnail_text: 行数が合わなければエラー。何も書き換えない', async () => {
  const { cmds, S } = makeThumbCommands();
  await assert.rejects(
    () => cmds.set_thumbnail_text({ texts: [{ id: 't1', text: 'あ\nい' }] }),
    /1 行です（2 行が渡されました）/,
  );
  assert.equal(S.project.thumbnail.telops[0].rows[0].text, '一行');
});

test('set_thumbnail_text: 1 件でも駄目なら、他の件も適用されない', async () => {
  const { cmds, S } = makeThumbCommands();
  await assert.rejects(() => cmds.set_thumbnail_text({
    texts: [{ id: 't1', text: '変わるはず' }, { id: 'no-such', text: 'x' }],
  }), /見つかりません/);
  assert.equal(S.project.thumbnail.telops[0].rows[0].text, '一行');
});

test('set_thumbnail_base: 時刻・素材名・外す', async () => {
  const { cmds, S } = makeThumbCommands();
  assert.deepEqual(await cmds.set_thumbnail_base({ time: 12.5 }), { kind: 'frame', time: 12.5 });
  assert.deepEqual(await cmds.set_thumbnail_base({ assetName: 'ロゴ.png' }),
    { kind: 'asset', assetId: 'a_logo', name: 'ロゴ.png' });
  assert.equal(await cmds.set_thumbnail_base({ clear: true }), null);
  assert.equal(S.project.thumbnail.base, null);
});

test('set_thumbnail_base: 名前は NFC / NFD の違いを吸収する', async () => {
  const { cmds } = makeThumbCommands();
  const nfd = 'ロゴ.png'.normalize('NFD');
  assert.notEqual(nfd, 'ロゴ.png');   // 前提（濁点が分かれている）
  assert.deepEqual(await cmds.set_thumbnail_base({ assetName: nfd }),
    { kind: 'asset', assetId: 'a_logo', name: 'ロゴ.png' });
});

test('set_thumbnail_base: 尺の外や、2 つ以上渡すとエラー', async () => {
  const { cmds } = makeThumbCommands();
  await assert.rejects(() => cmds.set_thumbnail_base({ time: 999 }), /範囲内/);
  await assert.rejects(() => cmds.set_thumbnail_base({ time: 1, clear: true }), /どれか 1 つだけ/);
  await assert.rejects(() => cmds.set_thumbnail_base({}), /どれか 1 つだけ/);
  await assert.rejects(() => cmds.set_thumbnail_base({ assetName: '無い.png' }), /見つかりません/);
});

test('save_project: ハンドルが無ければ、保存せずに分かりやすいエラーを投げる', async () => {
  const { cmds, S } = makeCommands();
  S.projectFile = null;
  await assert.rejects(() => cmds.save_project(), /名前を付けて保存/);
});

test('save_project: ハンドルがあれば ctx.writeToOpenHandle だけを呼び、マーカー数を返す（履歴には積まない）', async () => {
  const { S } = makeCommands();
  S.project.markers = [{ id: 'm1', time: 1, kind: 'keep' }, { id: 'm2', time: 2, kind: 'keep' }];
  S.projectFile = { name: 'テスト.kiriko', handle: {} };
  let called = 0;
  const ctx = {
    S, P, T: null,
    commit: () => { throw new Error('save_project は commit してはいけない'); },
    renderAll: () => {}, status: () => {},
    writeToOpenHandle: async () => { called++; return true; },
  };
  const cmds = createCommands(ctx);
  const r = await cmds.save_project();
  assert.equal(called, 1);
  assert.equal(r.ok, true);
  assert.equal(r.name, 'テスト.kiriko');
  assert.equal(r.markers, 2);
  assert.ok(typeof r.savedAt === 'string');
});

test('save_project: 書き込みに失敗したらエラーを投げる', async () => {
  const { S } = makeCommands();
  S.projectFile = { name: 'テスト.kiriko', handle: {} };
  const ctx = {
    S, P, T: null,
    commit: () => {}, renderAll: () => {}, status: () => {},
    writeToOpenHandle: async () => false,
  };
  const cmds = createCommands(ctx);
  await assert.rejects(() => cmds.save_project(), /保存に失敗/);
});
