// compose.js
// 1 フレーム分の絵を組み立てる。プレビューと書き出しで共有する唯一の合成経路。
//
//   映像フレーム → （区間ぼかし）→ テロップ
//
// ぼかしはプライバシー保護用の全画面ぼかし（企画書の必須機能）。

import { drawTelopsAt } from './telop.js';

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
 */
export function composeFrame(ctx, frame, t, w, h, project) {
  if (frame) {
    const px = activeBlur(project.blurs, t);
    if (px > 0) drawBlurred(ctx, frame, w, h, px);
    else ctx.drawImage(frame, 0, 0, w, h);
  }
  drawTelopsAt(ctx, project.telops || [], t);
}
