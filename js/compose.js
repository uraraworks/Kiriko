// compose.js
// 1 フレーム分の絵を組み立てる。プレビューと書き出しで共有する唯一の合成経路。
//
//   映像フレーム → （区間ぼかし）→ 重ね物（画像・テロップを z 順に）
//
// ぼかしはプライバシー保護用の全画面ぼかし（企画書の必須機能）。

import { drawTelop } from './telop.js';
import { drawImageClip } from './images.js';

/** 時刻 t に効いているぼかしの強さ（出力ピクセル単位）。無ければ 0 */
export function activeBlur(blurs, t) {
  let max = 0;
  for (const b of blurs || []) {
    if (t >= b.start && t < b.end) max = Math.max(max, b.strength || 0);
  }
  return max;
}

/**
 * ぼかしを掛けて描く。
 * filter を掛けたまま等倍で描くと画面のフチが透明を巻き込んで暗くなるので、
 * ぼかし半径のぶんだけ拡大して描いてから切り取る。
 */
export function drawBlurred(ctx, frame, w, h, px) {
  const s = 1 + (px * 4) / Math.min(w, h);
  const dw = w * s, dh = h * s;
  ctx.filter = `blur(${px}px)`;
  ctx.drawImage(frame, (w - dw) / 2, (h - dh) / 2, dw, dh);
  ctx.filter = 'none';
}

/**
 * 出力 1 フレームを合成する。
 * @param {CanvasRenderingContext2D|OffscreenCanvasRenderingContext2D} ctx
 * @param {*} frame VideoFrame / HTMLVideoElement / null（null なら映像は描かない）
 * @param {number} t 出力タイムライン秒
 * @param {ImageLibrary} imageLib 画像素材
 */
export function composeFrame(ctx, frame, t, w, h, project, imageLib = null) {
  if (frame) {
    const px = activeBlur(project.blurs, t);
    if (px > 0) drawBlurred(ctx, frame, w, h, px);
    else ctx.drawImage(frame, 0, 0, w, h);
  }
  drawOverlaysAt(ctx, project, t, imageLib);
}

/**
 * 画像とテロップを z の小さい順に重ねる。
 * z は「最前面へ / 最背面へ」で振り直すだけなので、値が他と重ならなければ何でもよい。
 */
export function overlaysAt(project, t) {
  const items = [];
  for (const im of project.images || []) {
    if (t >= im.start && t < im.end) items.push({ kind: 'image', item: im, z: im.z ?? 0 });
  }
  for (const tl of project.telops || []) {
    if (t >= tl.start && t < tl.end) items.push({ kind: 'telop', item: tl, z: tl.z ?? 0 });
  }
  items.sort((a, b) => a.z - b.z);
  return items;
}

export function drawOverlaysAt(ctx, project, t, imageLib) {
  for (const o of overlaysAt(project, t)) {
    if (o.kind === 'image') drawImageClip(ctx, o.item, imageLib);
    else drawTelop(ctx, o.item, imageLib);
  }
}
