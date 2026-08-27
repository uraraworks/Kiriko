// プロジェクトのデータモデル。保存と読み込みで壊れないことが最優先。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as P from '../../js/project.js';

test('createProject: 必要な入れ物が全部ある', () => {
  const p = P.createProject();
  for (const k of ['sources', 'clips', 'telops', 'imageAssets', 'images',
                   'audioAssets', 'audioClips', 'blurs', 'markers']) {
    assert.ok(Array.isArray(p[k]), `${k} が配列でない`);
  }
  assert.equal(p.output.width, 1920);
  assert.equal(p.output.fps, 30);
  assert.equal(p.version, P.PROJECT_VERSION);
});

test('newId: 重複しない', () => {
  const ids = new Set();
  for (let i = 0; i < 500; i++) ids.add(P.newId('clip'));
  assert.equal(ids.size, 500);
  assert.ok([...ids][0].startsWith('clip_'));
});

test('clipDuration / totalDuration', () => {
  const p = P.createProject();
  p.clips = [{ in: 0, out: 4 }, { in: 10, out: 12.5 }];
  assert.equal(P.clipDuration(p.clips[0]), 4);
  assert.equal(P.totalDuration(p), 6.5);
  assert.equal(P.totalDuration(P.createProject()), 0);
});

test('withTimelineOffsets: 隙間なく並ぶ', () => {
  const p = P.createProject();
  p.clips = [{ in: 0, out: 4 }, { in: 0, out: 2 }, { in: 0, out: 3 }];
  assert.deepEqual(P.withTimelineOffsets(p).map((e) => e.offset), [0, 4, 6]);
});

test('serialize → deserialize で中身が保たれる', () => {
  const p = P.createProject();
  p.title = 'テスト';
  p.clips = [{ id: 'c1', sourceId: 's1', in: 1, out: 2, volume: 0.5 }];
  p.telops = [{ id: 't1', start: 0, end: 3, rows: [{ text: 'あ' }] }];
  p.markers = [{ id: 'm1', time: 5, duration: 2, text: 'ここ' }];
  const back = P.deserialize(P.serialize(p));
  assert.deepEqual(back.clips, p.clips);
  assert.deepEqual(back.telops, p.telops);
  assert.deepEqual(back.markers, p.markers);
  assert.equal(back.title, 'テスト');
});

// 保存されていない項目が undefined にならないこと。
// 古いプロジェクトを開いた時に落ちる原因になる。
test('deserialize: 足りない項目は既定値で埋まる', () => {
  const back = P.deserialize(JSON.stringify({ version: P.PROJECT_VERSION, clips: [] }));
  assert.deepEqual(back.telops, []);
  assert.deepEqual(back.audioClips, []);
  assert.deepEqual(back.markers, []);
  assert.equal(back.output.width, 1920);
  assert.equal(back.mix.se, 1);
});

test('deserialize: 素材の一覧が消えない', () => {
  const src = [{ id: 's1', name: 'a.mp4', duration: 10 }];
  const back = P.deserialize(JSON.stringify({ version: P.PROJECT_VERSION, sources: src }));
  assert.deepEqual(back.sources, src);
});
