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

// --- 出力の大きさを変えた時の作り直し ---

const sample = () => ({
  output: { width: 1920, height: 1080 },
  telops: [{
    id: 't1', box: { x: 160, y: 820, w: 1600, h: 200 },
    textX: 40, textY: -20, rowGap: 10,
    bgBox: { x: 10, y: 20, w: 100, h: 50 },
    icon: { size: 120, gap: 20, x: 30, y: 40 },
    rows: [{ size: 96, strokeWidth: 16, letterSpacing: 4, fill: '#fff' }],
  }],
  images: [{ id: 'i1', box: { x: 100, y: 200, w: 400, h: 300 }, crop: { x: 5, y: 6, w: 7, h: 8 } }],
  blurs: [{ id: 'b1', strength: 40, rect: { x: 760, y: 400, w: 400, h: 280 },
            keys: [{ t: 1, x: 100, y: 100, w: 200, h: 100 }] }],
  telopPresets: [{ name: 'p', style: { size: 92, strokeWidth: 16, box: { x: 160, y: 820, w: 1600, h: 200 } } }],
  thumbnail: {
    base: { kind: 'frame', time: 12 },
    telops: [{ id: 'tt1', box: { x: 160, y: 820, w: 1600, h: 200 }, rows: [{ size: 96, strokeWidth: 16 }] }],
    images: [{ id: 'ti1', box: { x: 100, y: 200, w: 400, h: 300 } }],
  },
});

test('rescale: FHD → 4K で位置も大きさも 2 倍になる', () => {
  const p = P.rescale(sample(), 2, 2);
  assert.deepEqual(p.telops[0].box, { x: 320, y: 1640, w: 3200, h: 400 });
  assert.deepEqual(p.images[0].box, { x: 200, y: 400, w: 800, h: 600 });
  assert.equal(p.telops[0].rows[0].size, 192);
  assert.equal(p.telops[0].rows[0].strokeWidth, 32);
  assert.equal(p.telops[0].rows[0].letterSpacing, 8);
  assert.equal(p.telops[0].rowGap, 20);
  assert.deepEqual(p.blurs[0].rect, { x: 1520, y: 800, w: 800, h: 560 });
  assert.deepEqual(p.blurs[0].keys[0], { t: 1, x: 200, y: 200, w: 400, h: 200 });
});

test('rescale: サムネイルの枠も付いてくる（座標は同じ出力画素で持っているため）', () => {
  const p = P.rescale(sample(), 2, 2);
  assert.deepEqual(p.thumbnail.telops[0].box, { x: 320, y: 1640, w: 3200, h: 400 });
  assert.equal(p.thumbnail.telops[0].rows[0].size, 192);
  assert.deepEqual(p.thumbnail.images[0].box, { x: 200, y: 400, w: 800, h: 600 });
  // 元画像は「どこから取るか」なので触らない
  assert.deepEqual(p.thumbnail.base, { kind: 'frame', time: 12 });
});

test('rescale: サムネイルが無い旧いプロジェクトでも落ちない', () => {
  const s0 = sample();
  delete s0.thumbnail;
  assert.doesNotThrow(() => P.rescale(s0, 2, 2));
});

test('rescale: 文字の位置・背景画像・アイコンも付いてくる', () => {
  const p = P.rescale(sample(), 2, 2);
  const t = p.telops[0];
  assert.equal(t.textX, 80);
  assert.equal(t.textY, -40);
  assert.deepEqual(t.bgBox, { x: 20, y: 40, w: 200, h: 100 });
  assert.deepEqual(t.icon, { size: 240, gap: 40, x: 60, y: 80 });
});

test('rescale: 画像の使う範囲（素材側の画素）は触らない', () => {
  const p = P.rescale(sample(), 2, 2);
  assert.deepEqual(p.images[0].crop, { x: 5, y: 6, w: 7, h: 8 });
});

test('rescale: 縦横の比が違う時、大きさは小さい方に合わせる', () => {
  // 1920×1080 → 1080×1920（縦動画）。横は 0.5625 倍、縦は 1.777 倍
  const p = P.rescale(sample(), 1080 / 1920, 1920 / 1080);
  assert.equal(p.telops[0].box.x, 90);
  assert.equal(Math.round(p.telops[0].rows[0].size), 54, '文字が縦に合わせて膨らむと画面から溢れる');
});

test('rescale: ぼかしの強さはスライダーの範囲に収める', () => {
  const p = P.rescale(sample(), 4, 4);
  assert.equal(p.blurs[0].strength, 120);
  const q = P.rescale(sample(), 0.01, 0.01);
  assert.equal(q.blurs[0].strength, 4);
});

test('rescale: プリセットも一緒に直る', () => {
  const p = P.rescale(sample(), 2, 2);
  assert.deepEqual(p.telopPresets[0].style.box, { x: 320, y: 1640, w: 3200, h: 400 });
  assert.equal(p.telopPresets[0].style.size, 184);
});

test('rescale: 倍率が 1 なら何も変えない', () => {
  const before = JSON.stringify(sample());
  assert.equal(JSON.stringify(P.rescale(sample(), 1, 1)), before);
});

test('rescale: 中身が足りなくても落ちない', () => {
  assert.doesNotThrow(() => P.rescale({}, 2, 2));
  assert.doesNotThrow(() => P.rescale(P.createProject(), 2, 2));
});

// --- 空いたトラックを詰める ---

test('compactTracks: 間が空いた行を上から詰める', () => {
  const list = [{ track: 0 }, { track: 4 }, { track: 7 }];
  P.compactTracks(list);
  assert.deepEqual(list.map((x) => x.track), [0, 1, 2]);
});

test('compactTracks: 同じ行のものは同じ行のまま（重ならない）', () => {
  const list = [{ id: 'a', track: 5 }, { id: 'b', track: 5 }, { id: 'c', track: 2 }];
  P.compactTracks(list);
  assert.deepEqual(list.map((x) => x.track), [1, 1, 0]);
});

test('compactTracks: 上下の並びは変わらない', () => {
  const list = [{ id: '下', track: 9 }, { id: '上', track: 1 }];
  P.compactTracks(list);
  assert.equal(list.find((x) => x.id === '上').track, 0);
  assert.equal(list.find((x) => x.id === '下').track, 1);
});

test('compactTracks: track を持たないものは 0 とみなす', () => {
  const list = [{}, { track: 3 }];
  P.compactTracks(list);
  assert.deepEqual(list.map((x) => x.track), [0, 1]);
});

test('compactTracks: 空でも落ちない', () => {
  assert.doesNotThrow(() => P.compactTracks([]));
  assert.doesNotThrow(() => P.compactTracks(undefined));
});
