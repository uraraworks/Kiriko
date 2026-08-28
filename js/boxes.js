// boxes.js
// テロップと画像で共通の「枠（box）」を扱う。
// 座標はすべて出力ピクセル空間（既定 1920×1080）。
//
//   box = { x, y, w, h }
//
// 移動・リサイズ・画面外へ出さないクランプ・端／中央への吸着をここにまとめる。

export const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

const CURSORS = {
  nw: 'nwse-resize', se: 'nwse-resize',
  ne: 'nesw-resize', sw: 'nesw-resize',
  n: 'ns-resize', s: 'ns-resize',
  e: 'ew-resize', w: 'ew-resize',
};
export const handleCursor = (h) => CURSORS[h] ?? 'move';

export function handlePoints(b) {
  const cx = b.x + b.w / 2, cy = b.y + b.h / 2, r = b.x + b.w, bt = b.y + b.h;
  return {
    nw: [b.x, b.y], n: [cx, b.y], ne: [r, b.y],
    e: [r, cy], se: [r, bt], s: [cx, bt],
    sw: [b.x, bt], w: [b.x, cy],
  };
}

/** ハンドルに当たっていればその名前を返す。r は出力ピクセルでの当たり半径 */
export function hitHandle(b, px, py, r) {
  const pts = handlePoints(b);
  for (const name of HANDLES) {
    const [hx, hy] = pts[name];
    if (Math.abs(px - hx) <= r && Math.abs(py - hy) <= r) return name;
  }
  return null;
}

export function insideBox(b, px, py) {
  return px >= b.x && px <= b.x + b.w && py >= b.y && py <= b.y + b.h;
}

/** ハンドルを dx, dy 動かした結果の枠。aspect を渡すと縦横比を保つ */
export function resizeBox(orig, handle, dx, dy, { min = 40, aspect = null } = {}) {
  let { x, y, w, h } = orig;
  if (handle.includes('w')) { x = orig.x + dx; w = orig.w - dx; }
  if (handle.includes('e')) { w = orig.w + dx; }
  if (handle.includes('n')) { y = orig.y + dy; h = orig.h - dy; }
  if (handle.includes('s')) { h = orig.h + dy; }

  if (aspect) {
    // 角のハンドルは対角を固定したまま比率を保つ
    if (handle.length === 2) {
      if (Math.abs(w - orig.w) > Math.abs(h - orig.h)) h = w / aspect;
      else w = h * aspect;
      if (handle.includes('n')) y = orig.y + orig.h - h;
      if (handle.includes('w')) x = orig.x + orig.w - w;
    } else if (handle === 'n' || handle === 's') {
      const nw = h * aspect;
      x = orig.x + (orig.w - nw) / 2; w = nw;
    } else {
      const nh = w / aspect;
      y = orig.y + (orig.h - nh) / 2; h = nh;
    }
  }

  if (w < min) { if (handle.includes('w')) x -= min - w; w = min; }
  if (h < min) { if (handle.includes('n')) y -= min - h; h = min; }
  return { x, y, w, h };
}

/** 画面外へ出さない（枠が画面より大きい時は、はみ出しを均等にする） */
export function clampBox(b, W, H) {
  const x = b.w >= W ? Math.min(0, Math.max(W - b.w, b.x)) : Math.max(0, Math.min(W - b.w, b.x));
  const y = b.h >= H ? Math.min(0, Math.max(H - b.h, b.y)) : Math.max(0, Math.min(H - b.h, b.y));
  return { ...b, x, y };
}

/**
 * 端・中央・セーフマージンへの吸着。
 * @returns {{ box, guides:Array<{axis:'x'|'y', at:number}> }}
 */
export function snapBox(b, W, H, tol = 14, margin = 60) {
  const guides = [];
  let { x, y, w, h } = b;

  const xTargets = [
    [0, 0], [margin, 0], [W / 2 - w / 2, W / 2], [W - margin - w, W - margin], [W - w, W],
  ];
  const yTargets = [
    [0, 0], [margin, 0], [H / 2 - h / 2, H / 2], [H - margin - h, H - margin], [H - h, H],
  ];
  for (const [target, guideAt] of xTargets) {
    if (Math.abs(x - target) <= tol) { x = target; guides.push({ axis: 'x', at: guideAt }); break; }
  }
  for (const [target, guideAt] of yTargets) {
    if (Math.abs(y - target) <= tol) { y = target; guides.push({ axis: 'y', at: guideAt }); break; }
  }
  return { box: { x, y, w, h }, guides };
}

/**
 * 近くにある別の枠へ揃える吸着（移動中だけ）。
 *
 * 縦や横の位置を揃えたい時のためのもので、次の 4 通りに吸わせる。
 *  - 同じ側の端どうし（左と左、右と右／上と上、下と下）
 *  - 中心どうし
 *  - 相手のすぐ外側に接する位置（右端に左端をぴったり付ける、など）
 * どれも一番近いものを 1 つだけ選ぶ。
 *
 * @param {{x,y,w,h}} b 動かしている枠
 * @param {Array<{x,y,w,h}>} others 他の枠（自分は入れない）
 * @param {number} tol 吸着する距離
 * @param {Array<'x'|'y'>} skip 既に画面端へ吸着した軸（そちらを優先して触らない）
 * @returns {{ box, guides:Array<{axis:'x'|'y', at:number}> }}
 */
export function snapToBoxes(b, others, tol = 14, skip = []) {
  const guides = [];
  let { x, y, w, h } = b;

  // [合わせる座標, 目印を出す位置]
  const pick = (value, cands) => {
    let best = null, bd = Infinity;
    for (const [target, at] of cands) {
      const d = Math.abs(value - target);
      if (d <= tol && d < bd) { bd = d; best = [target, at]; }
    }
    return best;
  };

  if (!skip.includes('x')) {
    const cands = [];
    for (const o of others) {
      cands.push([o.x, o.x]);                            // 左端をそろえる
      cands.push([o.x + o.w - w, o.x + o.w]);            // 右端をそろえる
      cands.push([o.x + o.w / 2 - w / 2, o.x + o.w / 2]); // 中心をそろえる
      cands.push([o.x + o.w, o.x + o.w]);                // 相手の右にくっつける
      cands.push([o.x - w, o.x]);                        // 相手の左にくっつける
    }
    const hit = pick(x, cands);
    if (hit) { x = hit[0]; guides.push({ axis: 'x', at: hit[1] }); }
  }
  if (!skip.includes('y')) {
    const cands = [];
    for (const o of others) {
      cands.push([o.y, o.y]);
      cands.push([o.y + o.h - h, o.y + o.h]);
      cands.push([o.y + o.h / 2 - h / 2, o.y + o.h / 2]);
      cands.push([o.y + o.h, o.y + o.h]);
      cands.push([o.y - h, o.y]);
    }
    const hit = pick(y, cands);
    if (hit) { y = hit[0]; guides.push({ axis: 'y', at: hit[1] }); }
  }
  return { box: { x, y, w, h }, guides };
}

/**
 * リサイズ中の吸着。ドラッグしている辺だけを、画面端・中央・セーフマージンに合わせる。
 * @returns {{ box, guides }}
 */
export function snapResize(b, handle, W, H, tol = 14, margin = 60) {
  const guides = [];
  let { x, y, w, h } = b;

  const snapTo = (value, targets) => {
    for (const t of targets) if (Math.abs(value - t) <= tol) return t;
    return null;
  };

  if (handle.includes('w')) {
    const t = snapTo(x, [0, margin, W / 2]);
    if (t !== null) { w += x - t; x = t; guides.push({ axis: 'x', at: t }); }
  }
  if (handle.includes('e')) {
    const t = snapTo(x + w, [W, W - margin, W / 2]);
    if (t !== null) { w = t - x; guides.push({ axis: 'x', at: t }); }
  }
  if (handle.includes('n')) {
    const t = snapTo(y, [0, margin, H / 2]);
    if (t !== null) { h += y - t; y = t; guides.push({ axis: 'y', at: t }); }
  }
  if (handle.includes('s')) {
    const t = snapTo(y + h, [H, H - margin, H / 2]);
    if (t !== null) { h = t - y; guides.push({ axis: 'y', at: t }); }
  }
  return { box: { x, y, w: Math.max(20, w), h: Math.max(20, h) }, guides };
}

/** 枠を canvas に収まる大きさへ（比率は保つ）。中心は保つ */
export function fitInto(b, W, H) {
  const s = Math.min(1, W / b.w, H / b.h);
  const w = b.w * s, h = b.h * s;
  return clampBox({ x: b.x + (b.w - w) / 2, y: b.y + (b.h - h) / 2, w, h }, W, H);
}

/** 選択枠とハンドルを描く。scale は「出力px / 表示px」なので、見た目の太さを一定に保てる */
export function drawBoxChrome(ctx, b, scale = 1, { color = '#4c9aff', handles = true } = {}) {
  const lw = 2 * scale;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = lw;
  ctx.setLineDash([9 * scale, 6 * scale]);
  ctx.strokeRect(b.x, b.y, b.w, b.h);
  ctx.setLineDash([]);
  if (handles) {
    const r = 5 * scale;
    const pts = handlePoints(b);
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5 * scale;
    for (const name of HANDLES) {
      const [hx, hy] = pts[name];
      ctx.beginPath();
      ctx.rect(hx - r, hy - r, r * 2, r * 2);
      ctx.fill(); ctx.stroke();
    }
  }
  ctx.restore();
}

export function drawGuides(ctx, guides, W, H, scale = 1) {
  if (!guides.length) return;
  ctx.save();
  ctx.strokeStyle = '#ff5fa2';
  ctx.lineWidth = 1.5 * scale;
  ctx.setLineDash([12 * scale, 8 * scale]);
  ctx.beginPath();
  for (const g of guides) {
    if (g.axis === 'x') { ctx.moveTo(g.at, 0); ctx.lineTo(g.at, H); }
    else { ctx.moveTo(0, g.at); ctx.lineTo(W, g.at); }
  }
  ctx.stroke();
  ctx.restore();
}

/**
 * テロップの中身（文字・背景画像・アイコン）を、**枠の**端と中央に吸着させる。
 *
 * 枠の外へ出したい場合もあるので、吸着だけで押し込めはしない（clampBox は掛けない）。
 *
 * @param {{x,y,w,h}} r 中身の矩形（画面の座標）
 * @param {{x,y,w,h}} box テロップの枠
 * @returns {{dx:number, dy:number, guides:Array<{axis:'x'|'y', at:number}>}} 吸着で動かす量
 */
export function snapInside(r, box, tol = 12) {
  const guides = [];
  let dx = 0, dy = 0;
  const xTargets = [
    [box.x, box.x],                                   // 左端
    [box.x + box.w / 2 - r.w / 2, box.x + box.w / 2], // 中央
    [box.x + box.w - r.w, box.x + box.w],             // 右端
  ];
  const yTargets = [
    [box.y, box.y],
    [box.y + box.h / 2 - r.h / 2, box.y + box.h / 2],
    [box.y + box.h - r.h, box.y + box.h],
  ];
  for (const [target, at] of xTargets) {
    if (Math.abs(r.x - target) <= tol) { dx = target - r.x; guides.push({ axis: 'x', at }); break; }
  }
  for (const [target, at] of yTargets) {
    if (Math.abs(r.y - target) <= tol) { dy = target - r.y; guides.push({ axis: 'y', at }); break; }
  }
  return { dx, dy, guides };
}
