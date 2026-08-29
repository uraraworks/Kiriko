// thumbnail.js
// YouTube 用サムネイル（1 枚絵）の合成。
//
// 動画とは別物だが、中身は「元画像 → 画像・テロップを z 順に重ねる」だけなので、
// テロップと画像の描画は動画側とまったく同じ関数を使う（telop.js / images.js）。
// 座標系も出力解像度（既定 1920×1080）のままにしてあるので、
// タイムラインのテロップをコピーしてそのまま貼れる。書き出す時だけ縮める。

import { drawTelop } from './telop.js';
import { drawImageClip } from './images.js';

/** 書き出しの大きさ。YouTube の推奨は 1280×720 で、上限は 2MB */
export const SIZES = [
  { id: '1280x720', name: '1280 × 720（推奨）' },
  { id: '1920x1080', name: '1920 × 1080' },
];

export const FORMATS = [
  { id: 'image/jpeg', name: 'JPEG（軽い）', ext: 'jpg', quality: 0.92 },
  { id: 'image/png', name: 'PNG（くっきり）', ext: 'png', quality: undefined },
];

/** 空のサムネイル */
export function createThumbnail() {
  return { base: null, telops: [], images: [] };
}

/** 旧いプロジェクトにも枠を用意する */
export function normalize(thumb) {
  const t = { ...createThumbnail(), ...(thumb ?? {}) };
  t.telops = t.telops ?? [];
  t.images = t.images ?? [];
  return t;
}

/**
 * 元画像を画面いっぱいに敷く（比率は保ったまま、はみ出す分は切る）。
 * サムネの元は 16:9 とは限らない（スマホで撮った縦写真など）ので、
 * 余白が出るより切れる方が「サムネらしい」絵になる。
 */
export function drawCover(ctx, bmp, w, h) {
  const s = Math.max(w / bmp.width, h / bmp.height);
  const dw = bmp.width * s, dh = bmp.height * s;
  ctx.drawImage(bmp, (w - dw) / 2, (h - dh) / 2, dw, dh);
}

/**
 * 重ね物を z の小さい順に。動画側の overlaysAt と違い、時刻での絞り込みは無い
 * （サムネは 1 枚絵なので、置いたものは全部映る）。
 */
export function thumbOverlays(thumb) {
  const items = [
    ...(thumb.images ?? []).map((im) => ({ kind: 'image', item: im, z: im.z ?? 0 })),
    ...(thumb.telops ?? []).map((tl) => ({ kind: 'telop', item: tl, z: tl.z ?? 0 })),
  ];
  items.sort((a, b) => a.z - b.z);
  return items;
}

/**
 * サムネ 1 枚を組み立てる。プレビューと書き出しで共有する唯一の合成経路。
 * @param {ImageBitmap|HTMLVideoElement|null} baseBmp 元画像（無ければ敷かない）
 */
export function composeThumbnail(ctx, thumb, w, h, imageLib, baseBmp) {
  if (baseBmp) drawCover(ctx, baseBmp, w, h);
  for (const o of thumbOverlays(thumb)) {
    if (o.kind === 'image') drawImageClip(ctx, o.item, imageLib);
    else drawTelop(ctx, o.item, imageLib);
  }
}

/**
 * 書き出し用の画像を作る。
 *
 * 枠の座標はプロジェクトの出力解像度で持っているので、**まずその大きさで描いてから**
 * 指定の大きさへ縮める。先に小さいキャンバスへ描くと、位置がずれるうえ
 * 文字の縁が細って別物になる。
 */
export async function renderBlob(thumb, imageLib, baseBmp, { outW, outH, width, height, type, quality }) {
  const src = new OffscreenCanvas(outW, outH);
  composeThumbnail(src.getContext('2d'), thumb, outW, outH, imageLib, baseBmp);
  if (outW === width && outH === height) return await src.convertToBlob({ type, quality });

  const out = new OffscreenCanvas(width, height);
  const octx = out.getContext('2d');
  octx.imageSmoothingQuality = 'high';
  octx.drawImage(src, 0, 0, width, height);
  return await out.convertToBlob({ type, quality });
}
