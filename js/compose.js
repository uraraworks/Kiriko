// compose.js
// 1 フレーム分の絵を組み立てる。プレビューと書き出しで共有する唯一の合成経路。
//
//   映像フレーム → （区間ぼかし）→ 重ね物（画像・テロップを z 順に）
//
// ぼかしはプライバシー保護用の全画面ぼかし（企画書の必須機能）。

import { drawTelop } from './telop.js';
import { drawImageClip } from './images.js';

/** 時刻 t に効いている「全画面」ぼかしの強さ（出力ピクセル単位）。無ければ 0 */
export function activeBlur(blurs, t) {
  let max = 0;
  for (const b of blurs || []) {
    if (b.shape === 'rect') continue;
    if (t >= b.start && t < b.end) max = Math.max(max, b.strength || 0);
  }
  return max;
}

/** 時刻 t に効いている矩形ぼかし */
export function activeRectBlurs(blurs, t) {
  return (blurs || []).filter((b) => b.shape === 'rect' && t >= b.start && t < b.end);
}

/**
 * 矩形ぼかしの位置。キーフレームがあれば線形補間する（顔が動くので追従が要る）。
 * キーが無ければ b.rect をそのまま使う。
 */
export function blurRectAt(b, t) {
  const keys = b.keys ?? [];
  if (!keys.length) return { ...(b.rect ?? { x: 760, y: 400, w: 400, h: 280 }) };
  if (keys.length === 1 || t <= keys[0].t) return pick(keys[0]);
  const last = keys[keys.length - 1];
  if (t >= last.t) return pick(last);
  for (let i = 0; i < keys.length - 1; i++) {
    const a = keys[i], c = keys[i + 1];
    if (t >= a.t && t <= c.t) {
      const k = (t - a.t) / Math.max(1e-6, c.t - a.t);
      return {
        x: a.x + (c.x - a.x) * k,
        y: a.y + (c.y - a.y) * k,
        w: a.w + (c.w - a.w) * k,
        h: a.h + (c.h - a.h) * k,
      };
    }
  }
  return pick(last);
}
const pick = (k) => ({ x: k.x, y: k.y, w: k.w, h: k.h });

// ぼかし合成用の作業キャンバス（使い回す）
let scratch = null;
function scratchCtx(w, h) {
  if (!scratch || scratch.canvas.width !== w || scratch.canvas.height !== h) {
    const cv = typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(w, h)
      : Object.assign(document.createElement('canvas'), { width: w, height: h });
    scratch = cv.getContext('2d');
  }
  return scratch;
}

/**
 * 指定した矩形（楕円）だけをぼかす。
 * 縁をそのまま切ると四角が見えてしまうので、外側へ向けて薄くなるマスクで合成する。
 */
export function drawRectBlur(ctx, frame, w, h, b, t) {
  const r = blurRectAt(b, t);
  const px = Math.max(1, b.strength || 30);
  const sc = scratchCtx(w, h);

  // 1) ぼかした絵を作業キャンバスに用意する
  sc.setTransform(1, 0, 0, 1, 0, 0);
  sc.globalCompositeOperation = 'source-over';
  sc.clearRect(0, 0, w, h);
  drawBlurred(sc, frame, w, h, px);

  // 2) 指定範囲だけ残すマスクを掛ける
  const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
  const feather = Math.max(0, Math.min(0.9, b.feather ?? 0.25));
  sc.globalCompositeOperation = 'destination-in';
  if (b.round === false) {
    // 角丸の矩形
    sc.fillStyle = '#fff';
    const rad = Math.min(r.w, r.h) * 0.12;
    sc.beginPath();
    roundRectPath(sc, r.x, r.y, r.w, r.h, rad);
    sc.fill();
  } else {
    // 楕円（顔はこちらの方が自然）。外周を feather ぶんぼかす
    sc.save();
    sc.translate(cx, cy);
    sc.scale(Math.max(1e-3, r.w / 2), Math.max(1e-3, r.h / 2));
    const g = sc.createRadialGradient(0, 0, Math.max(0, 1 - feather), 0, 0, 1);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    sc.fillStyle = g;
    sc.beginPath(); sc.arc(0, 0, 1, 0, Math.PI * 2); sc.fill();
    sc.restore();
  }
  sc.globalCompositeOperation = 'source-over';

  // 3) 元の絵の上に重ねる
  ctx.drawImage(sc.canvas, 0, 0);
}

function roundRectPath(ctx, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/**
 * ぼかしを掛けて描く。
 * filter を掛けたまま等倍で描くと画面のフチが透明を巻き込んで暗くなるので、
 * ぼかし半径のぶんだけ拡大して描いてから切り取る。
 */
// 全画面ぼかし用の作業キャンバス（余白付き。使い回す）
let padded = null;
function paddedCtx(w, h) {
  if (!padded || padded.canvas.width !== w || padded.canvas.height !== h) {
    const cv = typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(w, h)
      : Object.assign(document.createElement('canvas'), { width: w, height: h });
    padded = cv.getContext('2d');
  }
  return padded;
}

/**
 * 全画面ぼかし。**画角は変えない。**
 *
 * ぼかしは画像の外側まで滲むので、そのまま掛けると縁が透けて暗く落ちる。
 * 以前はそれを隠すために映像を 1 割ほど拡大していたが、ぼかしが切れる瞬間に
 * 画角が戻って「びくっ」と動いて見えた。書き出しにもその動きが入っていた。
 *
 * いまは、いったん余白付きのキャンバスへ「引き伸ばした絵（余白埋め）＋本来の絵」を
 * 描いてからぼかし、中央を等倍で取り出す。滲みは余白の中に収まるので、
 * 拡大しなくても縁が落ちない。
 */
export function drawBlurred(ctx, frame, w, h, px) {
  const m = Math.ceil(px * 3);            // 滲みが収まるだけの余白
  const pg = paddedCtx(w + m * 2, h + m * 2);
  pg.filter = 'none';
  pg.drawImage(frame, 0, 0, w + m * 2, h + m * 2);   // 余白を埋めるための引き伸ばし
  pg.drawImage(frame, m, m, w, h);                    // 本来の絵を等倍で上に
  // 余白ごと描いてぼかす。滲んで薄くなるのは余白の縁＝画面の外なので、見える所は濁らない。
  // （先に切り出してからぼかすと、切り口が滲んで縁が透ける）
  ctx.filter = `blur(${px}px)`;
  ctx.drawImage(pg.canvas, -m, -m);
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
    // 部分ぼかし（顔など）は全画面ぼかしの後に重ねる
    for (const b of activeRectBlurs(project.blurs, t)) drawRectBlur(ctx, frame, w, h, b, t);
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
