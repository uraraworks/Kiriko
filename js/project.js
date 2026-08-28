// project.js
// 編集内容を表す JSON プロジェクトファイル。
// 「AI が下ごしらえ → 人間が仕上げ」を狙って、素直に読み書きできる形にしてある。
// Phase 0 で使うのは sources / clips だけだが、以降のフェーズで足す枠は先に切ってある。

export const PROJECT_VERSION = 1;

export function createProject() {
  return {
    version: PROJECT_VERSION,
    title: '無題プロジェクト',
    notes: '',   // 作業メモ（進捗管理用。書き出しには影響しない）
    output: { width: 1920, height: 1080, fps: 30, videoBitrate: 12_000_000, audioBitrate: 192_000 },
    sources: [],   // { id, name, size, duration }
    clips: [],     // { id, sourceId, in, out, volume }
    telops: [],     // { id, text, start, end, box:{x,y,w,h}, hAlign, vAlign, ...style }
    imageAssets: [],// { id, name, width, height }
    images: [],     // { id, assetId, start, end, box, opacity, fit }
    telopPresets: null, // null なら telop.js の既定プリセットを使う
    audioAssets: [],// { id, name, duration } SE / BGM 素材
    audioClips: [], // { id, assetId, kind, start, offset, duration, volume, fadeIn, fadeOut, loop }
    mix: { se: 1, bgm: 1 }, // 効果音 / BGM のマスター音量
    blurs: [],      // { id, start, end, strength } 区間ぼかし（プライバシー保護）
    // カットで消した区間の在庫。継ぎ目から秒単位で戻せるようにするためのもの（trims.js）。
    // { id, prevClipId, nextClipId, segments:[{sourceId,in,out,volume}], label, group }
    trims: [],
    // メモ用マーカー。duration > 0 なら「区間マーカー」＝ここは残す、という印になる。
    // AI に「セリフのある所に区間マーカーを立てて」と頼む使い方を想定している。
    markers: [],    // { id, time, duration, text, color }
  };
}

let seq = 0;
export function newId(prefix) {
  return `${prefix}_${Date.now().toString(36)}${(seq++).toString(36)}`;
}

export function clipDuration(clip) {
  return Math.max(0, clip.out - clip.in);
}

export function totalDuration(project) {
  return project.clips.reduce((a, c) => a + clipDuration(c), 0);
}

/** クリップ列の中で「出力タイムライン上の開始秒」を積算して返す */
export function withTimelineOffsets(project) {
  let t = 0;
  return project.clips.map((clip) => {
    const entry = { clip, offset: t };
    t += clipDuration(clip);
    return entry;
  });
}

export function serialize(project) {
  return JSON.stringify(project, null, 2);
}

export function deserialize(text) {
  const p = JSON.parse(text);
  if (p.version !== PROJECT_VERSION) {
    console.warn(`プロジェクトのバージョンが違います (${p.version} != ${PROJECT_VERSION})`);
  }
  return { ...createProject(), ...p };
}

/**
 * 1 フレームに満たない「かけら」クリップ。
 *
 * カットの切り残しでできる。まったく別の場所の映像が一瞬だけ挟まって見えるうえ、
 * 短すぎてタイムラインを拡大しないと見つけられないので、まとめて知らせる。
 *
 * @returns {Array<{index:number, startSec:number, durationSec:number, clip:object}>}
 */
export function sliverClips(project, minLen) {
  const out = [];
  let t = 0;
  (project.clips ?? []).forEach((clip, index) => {
    const d = clipDuration(clip);
    if (d < minLen) out.push({ index, startSec: t, durationSec: d, clip });
    t += d;
  });
  return out;
}

/**
 * 出力の大きさが変わった時に、置いてあるものの位置と大きさを合わせ直す。
 *
 * FHD で作ったものを 4K にすると、座標をそのままにしては画面の左上へ寄ってしまう。
 * 見た目の割合を保つため、横は sx、縦は sy で引き伸ばす。
 *
 * 文字の大きさ・縁の太さ・ぼかしの強さのように「向きを持たない量」は、
 * 縦横で比が違う時（16:9 → 9:16 など）にはみ出さないよう、**小さい方**に合わせる。
 *
 * 画像の `crop` は素材側の画素なので触らない（出力の大きさとは無関係）。
 *
 * @param {object} project 中身を書き換える
 */
export function rescale(project, sx, sy) {
  if (!(sx > 0) || !(sy > 0) || (sx === 1 && sy === 1)) return project;
  const s = Math.min(sx, sy);
  const box = (b) => { if (!b) return; b.x *= sx; b.y *= sy; b.w *= sx; b.h *= sy; };
  const styleSizes = (o) => {
    if (!o) return;
    if (typeof o.size === 'number') o.size *= s;
    if (typeof o.strokeWidth === 'number') o.strokeWidth *= s;
    if (typeof o.letterSpacing === 'number') o.letterSpacing *= s;
  };

  for (const t of project.telops ?? []) {
    box(t.box);
    box(t.bgBox);
    if (typeof t.textX === 'number') t.textX *= sx;
    if (typeof t.textY === 'number') t.textY *= sy;
    if (typeof t.rowGap === 'number') t.rowGap *= s;
    if (t.icon) {
      if (typeof t.icon.size === 'number') t.icon.size *= s;
      if (typeof t.icon.gap === 'number') t.icon.gap *= s;
      if (typeof t.icon.x === 'number') t.icon.x *= sx;
      if (typeof t.icon.y === 'number') t.icon.y *= sy;
    }
    for (const r of t.rows ?? []) styleSizes(r);
  }
  for (const im of project.images ?? []) box(im.box);
  for (const b of project.blurs ?? []) {
    box(b.rect);
    for (const k of b.keys ?? []) box(k);
    // 強さはスライダーの範囲（4〜120）に収める
    if (typeof b.strength === 'number') b.strength = Math.max(4, Math.min(120, b.strength * s));
  }
  for (const p of project.telopPresets ?? []) {
    box(p.style?.box);
    styleSizes(p.style);
  }
  return project;
}

/**
 * 使われていないトラックを詰める（`track` を 0 から順に振り直す）。
 *
 * トラックの本数は「使っている一番下＋空き 1 本」で決まるので、間の行が空くと
 * **その行を消すすべが無くなる**（T2〜T5 が空なのに T6 まで並ぶ、など）。
 * ものを消した後にここを通す。
 *
 * 並び順は変えない（上にあったものは上のまま）。番号の付け替えだけなので、
 * 同じ行にあったものは同じ行のまま残り、重なりも起きない。
 * 掴んで動かしている最中には呼ばないこと（空いている行へ運ぶ途中で引き戻されてしまう）。
 */
export function compactTracks(list) {
  const used = [...new Set((list ?? []).map((x) => x.track ?? 0))].sort((a, b) => a - b);
  const map = new Map(used.map((v, i) => [v, i]));
  for (const x of list ?? []) x.track = map.get(x.track ?? 0) ?? 0;
  return list;
}
