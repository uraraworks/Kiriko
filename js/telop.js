// telop.js
// テロップの描画コア。プレビューと書き出しで **同じ関数** を使う。
// （Canvas の 2D コンテキストなら OffscreenCanvas でも同じ挙動になる）
//
// 座標は出力ピクセル空間（既定 1920×1080）。プレビュー側の canvas も
// 同じ解像度をバッキングストアに持たせるので、見たまま書き出される。

import * as FN from './fontname.js';

export const DEFAULT_STYLE = {
  font: 'Hiragino Maru Gothic ProN',
  size: 96,
  bold: true,
  fill: '#f5e04b',
  stroke: '#4a3b00',      // 内側の濃い縁
  strokeOn: true,         // 内縁を描くか（白フチは outerScale 0 で消せる）
  strokeWidth: 16,
  outerStroke: '#ffffff', // 外側の白フチ
  outerScale: 2.2,        // strokeWidth に対する倍率（0 で白フチなし）
  shadow: 0.45,           // 0〜1。影の濃さ
  lineHeight: 1.18,
  letterSpacing: 0,       // 文字と文字の間（px）。マイナスで詰められる
  hAlign: 'center',       // left | center | right … 枠の中での横の寄せ
  vAlign: 'bottom',       // top | middle | bottom … 枠の中での縦の寄せ
  wrap: true,             // 枠の幅で折り返す
};

/** 枠の既定値（1920×1080 基準。下段の帯） */
export const DEFAULT_BOX = { x: 160, y: 820, w: 1600, h: 200 };

/** 内蔵 Web フォント（index.html で読み込む） */
export const WEB_FONTS = [
  { css: 'M PLUS Rounded 1c', label: 'M PLUS Rounded（丸ゴ太字）' },
  { css: 'RocknRoll One', label: 'ロックンロール One' },
  { css: 'Dela Gothic One', label: 'デラゴシック（極太）' },
  { css: 'Yusei Magic', label: '油性マジック（手書き風）' },
  { css: 'Kiwi Maru', label: 'Kiwi Maru（やわらか明朝）' },
];

/** OS 同梱でだいたい入っているもの */
export const SYSTEM_FONTS = [
  { css: 'Hiragino Maru Gothic ProN', label: 'ヒラギノ丸ゴ（いつもの）' },
  { css: 'Hiragino Sans', label: 'ヒラギノ角ゴ' },
  { css: 'Klee', label: 'クレー（手書き風）' },
];

/** 行 1 本を作る */
export function createRow(text = 'テロップ', style = {}) {
  const { box, vAlign, wrap, ...rowStyle } = { ...DEFAULT_STYLE, ...style };
  return { id: `row_${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`, text, ...rowStyle };
}

/**
 * テロップ 1 個。
 * 背景画像と複数行をひとまとめに持つ「セット」で、行ごとに書式を変えられる。
 * （Keynote で 1 枚の PNG に焼いていたものを、そのまま構造として持てるようにしたもの）
 */
export function createTelop(t0, t1, style = {}, text = 'テロップ') {
  const s = { ...DEFAULT_STYLE, ...style };
  return {
    id: `tel_${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`,
    start: t0,
    end: t1,
    box: { ...(s.box ?? DEFAULT_BOX) },
    vAlign: s.vAlign ?? 'bottom',
    wrap: s.wrap ?? true,
    rowGap: 0,
    bgAssetId: null,      // 背景画像（枠に合わせて敷く）
    bgFillOn: false,      // 背景色を敷くか
    bgFill: '#000000',
    bgOpacity: 1,
    bgFit: 'contain',
    // アイコン画像（ロゴなど）。文字の左右上下に添える
    icon: { assetId: null, side: 'left', size: 120, gap: 20, valign: 'middle', trim: true },
    rows: [createRow(text, s)],
  };
}

/** 旧形式（1 行だけ・x,y 指定）を現在の形に読み替える */
export function migrateTelop(t) {
  let out = t;
  if (!out.box) {
    const size = out.size ?? DEFAULT_STYLE.size;
    const w = 1600, h = Math.max(size * 1.6, 160);
    const cx = out.x ?? 960, cy = out.y ?? 940;
    const align = out.align ?? 'center';
    const x = align === 'left' ? cx : align === 'right' ? cx - w : cx - w / 2;
    out = { ...out, box: { x, y: cy - h / 2, w, h }, hAlign: align, vAlign: 'middle' };
  }
  if (!out.rows) {
    const { id, start, end, box, z, vAlign, wrap, text, ...style } = out;
    out = {
      id, start, end, box, z,
      vAlign: vAlign ?? 'middle',
      wrap: wrap ?? true,
      rowGap: 0,
      bgAssetId: null, bgFillOn: false, bgFill: '#000000', bgOpacity: 1, bgFit: 'contain',
      rows: [createRow(text ?? '', style)],
    };
  }
  out.rows = out.rows.map((r) => ({ ...DEFAULT_STYLE, ...r }));
  out.icon = { assetId: null, side: 'left', size: 120, gap: 20, valign: 'middle', trim: true, ...(out.icon ?? {}) };
  out.bgFillOn = out.bgFillOn ?? false;
  out.bgFill = out.bgFill ?? '#000000';
  out.bgOpacity = out.bgOpacity ?? 1;
  out.bgFit = out.bgFit ?? 'contain';
  out.rowGap = out.rowGap ?? 0;
  return out;
}

/**
 * 既定プリセット。スタイル＋枠＋縦の寄せをセットで持つ（本企画の要件）。
 * 適用すると「編集中の行の書式」と「セットの枠・縦寄せ」が入る。
 */
export const DEFAULT_PRESETS = [
  {
    name: '実況（下段中央）',
    style: { ...DEFAULT_STYLE, size: 92, box: { x: 160, y: 820, w: 1600, h: 200 }, hAlign: 'center', vAlign: 'bottom' },
  },
  {
    name: '金額（右上）',
    style: {
      ...DEFAULT_STYLE, size: 104, box: { x: 1020, y: 60, w: 810, h: 160 }, hAlign: 'right', vAlign: 'top',
      fill: '#ffffff', stroke: '#0f5c2e', strokeWidth: 18,
    },
  },
  {
    name: '見出し（上段中央・大）',
    style: {
      ...DEFAULT_STYLE, size: 132, box: { x: 110, y: 70, w: 1700, h: 260 }, hAlign: 'center', vAlign: 'top',
      fill: '#f5e04b', stroke: '#3a2c00', strokeWidth: 22,
    },
  },
  {
    name: '注釈（左下・小）',
    style: {
      ...DEFAULT_STYLE, size: 56, box: { x: 80, y: 900, w: 900, h: 120 }, hAlign: 'left', vAlign: 'bottom',
      fill: '#ffffff', stroke: '#222222', strokeWidth: 10, outerScale: 0,
    },
  },
];

// ---------------------------------------------------------------- 描画

function fontSpec(r) {
  const fam = /^[\w-]+$/.test(r.font) ? r.font : `"${r.font}"`;
  return `${r.bold ? 'bold ' : ''}${r.size}px ${fam}, "Hiragino Maru Gothic ProN", sans-serif`;
}

/** 文字送り（px）。行ごとの設定 */
const spacingOf = (r) => Math.max(-200, Math.min(400, Number(r.letterSpacing) || 0));

/** 書体と文字送りをまとめて当てる。測る時も描く時も必ずこれを通す */
function applyFont(ctx, r) {
  ctx.font = fontSpec(r);
  if ('letterSpacing' in ctx) ctx.letterSpacing = `${spacingOf(r)}px`;
}

/**
 * 文字が実際に占める幅。
 * canvas の measureText は**最後の文字のうしろにも**文字送りを足した値を返すので、
 * その分を引く。引かないと、寄せた時に文字送りの半分だけ左へ寄って見える。
 */
function inkWidth(ctx, r, text) {
  const w = ctx.measureText(text).width;
  return text ? Math.max(0, w - spacingOf(r)) : 0;
}

/** 寄せに応じた描き出し位置の補正（上と同じ理由） */
function alignShift(r) {
  const sp = spacingOf(r);
  return r.hAlign === 'right' ? sp : r.hAlign === 'left' ? 0 : sp / 2;
}

/** 枠幅で折り返した行を返す。日本語は単語境界が無いので基本は 1 文字ずつ詰める */
export function wrapRow(ctx, row, maxW, wrap = true) {
  const raw = String(row.text ?? '').split('\n');
  if (!wrap) return raw;
  ctx.save();                 // 文字送りを共有の ctx に残さない
  try {
    applyFont(ctx, row);
    const out = [];
    for (const para of raw) {
      if (!para) { out.push(''); continue; }
      let line = '';
      for (const ch of para) {
        const next = line + ch;
        if (line && inkWidth(ctx, row, next) > Math.max(20, maxW)) {
          const sp = line.lastIndexOf(' ');
          if (sp > 0 && line.length - sp < 12) { out.push(line.slice(0, sp)); line = line.slice(sp + 1) + ch; }
          else { out.push(line); line = ch; }
        } else {
          line = next;
        }
      }
      out.push(line);
    }
    return out;
  } finally { ctx.restore(); }
}

/** アイコンとして描く元の範囲。既定では透明な余白を切り詰める */
export function iconSourceRect(t, imageLib) {
  const bmp = imageLib?.get(t.icon?.assetId);
  if (!bmp) return null;
  if (t.icon.trim === false) return { x: 0, y: 0, w: bmp.width, h: bmp.height };
  return imageLib.content?.(t.icon.assetId) ?? { x: 0, y: 0, w: bmp.width, h: bmp.height };
}

/** アイコンの大きさ（比率は素材の中身に合わせる） */
function iconSize(t, imageLib) {
  const ic = t.icon;
  if (!ic?.assetId) return null;
  const src = iconSourceRect(t, imageLib);
  const ar = src ? src.w / src.h : 1;
  const h = Math.max(8, ic.size);
  return { w: h * ar, h };
}

/**
 * 全行をまとめて配置する。行ごとに書体・大きさ・横の寄せが違ってよい。
 * アイコンがある場合は、その分だけ文字の領域を狭めて場所を空ける。
 */
export function layoutTelop(ctx, t, imageLib = null) {
  const b = t.box;
  const ic = t.icon;
  const isz = iconSize(t, imageLib);

  // 文字を流し込む領域（アイコンのぶんを除いたところ）
  const tb = { ...b };
  if (isz) {
    if (ic.side === 'left') { tb.x += isz.w + ic.gap; tb.w -= isz.w + ic.gap; }
    else if (ic.side === 'right') { tb.w -= isz.w + ic.gap; }
    else if (ic.side === 'top') { tb.y += isz.h + ic.gap; tb.h -= isz.h + ic.gap; }
    else if (ic.side === 'bottom') { tb.h -= isz.h + ic.gap; }
    tb.w = Math.max(40, tb.w); tb.h = Math.max(20, tb.h);
  }

  const rows = (t.rows ?? []).map((row) => {
    const lines = wrapRow(ctx, row, tb.w, t.wrap);
    const lh = row.size * (row.lineHeight ?? 1.18);
    return { row, lines, lh, height: (lines.length - 1) * lh + row.size };
  });
  const gap = t.rowGap ?? 0;
  const totalH = rows.reduce((a, r) => a + r.height, 0) + gap * Math.max(0, rows.length - 1);

  const top = t.vAlign === 'top' ? tb.y
    : t.vAlign === 'bottom' ? tb.y + tb.h - totalH
    : tb.y + (tb.h - totalH) / 2;

  let y = top;
  for (const r of rows) {
    r.firstY = y + r.row.size / 2;
    r.x = r.row.hAlign === 'left' ? tb.x : r.row.hAlign === 'right' ? tb.x + tb.w : tb.x + tb.w / 2;
    y += r.height + gap;
  }

  // アイコンは文字のかたまりに揃える（左右に置いた時に浮かないように）
  let icon = null;
  if (isz) {
    let ix, iy;
    if (ic.side === 'left') ix = b.x;
    else if (ic.side === 'right') ix = b.x + b.w - isz.w;
    else ix = b.x + (b.w - isz.w) / 2;

    if (ic.side === 'top') iy = b.y;
    else if (ic.side === 'bottom') iy = b.y + b.h - isz.h;
    else if (ic.valign === 'top') iy = top;
    else if (ic.valign === 'bottom') iy = top + totalH - isz.h;
    else iy = top + (totalH - isz.h) / 2;

    icon = { x: ix, y: iy, w: isz.w, h: isz.h };
  }
  return { rows, totalH, textBox: tb, icon };
}

function drawRowLine(ctx, row, text, x, y) {
  if (!text) return;
  const w = row.strokeWidth || 0;
  if (row.shadow > 0) {
    ctx.shadowColor = `rgba(0,0,0,${row.shadow})`;
    ctx.shadowBlur = row.size * 0.14;
    ctx.shadowOffsetY = row.size * 0.05;
  }
  // 外→内→塗り の順で重ねると YouTube 風の二重縁になる
  if (w > 0 && (row.outerScale ?? 0) > 0) {
    ctx.strokeStyle = row.outerStroke;
    ctx.lineWidth = w * row.outerScale;
    ctx.strokeText(text, x, y);
  }
  ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
  if (w > 0 && row.strokeOn !== false) {
    ctx.strokeStyle = row.stroke;
    ctx.lineWidth = w;
    ctx.strokeText(text, x, y);
  }
  ctx.fillStyle = row.fill;
  ctx.fillText(text, x, y);
}

/** 背景色を枠に敷く（画像より下） */
function drawTelopFill(ctx, t) {
  if (!t.bgFillOn || !t.bgFill) return;
  ctx.save();
  ctx.globalAlpha = t.bgOpacity ?? 1;
  ctx.fillStyle = t.bgFill;
  const b = t.box;
  ctx.fillRect(b.x, b.y, b.w, b.h);
  ctx.restore();
}

/** 背景画像を枠に敷く */
function drawTelopBg(ctx, t, imageLib) {
  const bmp = t.bgAssetId && imageLib?.get(t.bgAssetId);
  if (!bmp) return;
  const b = t.box;
  ctx.save();
  ctx.globalAlpha = t.bgOpacity ?? 1;
  if (t.bgFit === 'stretch') {
    ctx.drawImage(bmp, b.x, b.y, b.w, b.h);
  } else {
    const s = Math.min(b.w / bmp.width, b.h / bmp.height);
    const w = bmp.width * s, h = bmp.height * s;
    ctx.drawImage(bmp, b.x + (b.w - w) / 2, b.y + (b.h - h) / 2, w, h);
  }
  ctx.restore();
}

/** テロップ 1 個（背景画像＋全行）を描く */
export function drawTelop(ctx, t, imageLib = null) {
  if (!t.box) return;
  drawTelopFill(ctx, t);
  drawTelopBg(ctx, t, imageLib);
  ctx.save();
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.miterLimit = 2;
  const { rows, icon } = layoutTelop(ctx, t, imageLib);
  if (icon) {
    const bmp = imageLib?.get(t.icon.assetId);
    const src = iconSourceRect(t, imageLib);
    if (bmp && src) ctx.drawImage(bmp, src.x, src.y, src.w, src.h, icon.x, icon.y, icon.w, icon.h);
  }
  for (const r of rows) {
    applyFont(ctx, r.row);
    ctx.textAlign = r.row.hAlign || 'center';
    const x = r.x + alignShift(r.row);
    for (let i = 0; i < r.lines.length; i++) {
      drawRowLine(ctx, r.row, r.lines[i], x, r.firstY + i * r.lh);
    }
  }
  ctx.restore();
}

export function drawTelopsAt(ctx, telops, t, imageLib = null) {
  for (const tel of telops) {
    if (t >= tel.start && t < tel.end) drawTelop(ctx, tel, imageLib);
  }
}

/** 実際に中身が占めている範囲（枠より狭いことがある。当たり判定の補助に使う） */
export function textBounds(ctx, t, imageLib = null) {
  ctx.save();
  const { rows, icon } = layoutTelop(ctx, t, imageLib);
  let left = Infinity, right = -Infinity, top = Infinity, bottom = -Infinity;
  for (const r of rows) {
    applyFont(ctx, r.row);
    let maxW = 0;
    for (const l of r.lines) maxW = Math.max(maxW, inkWidth(ctx, r.row, l));
    const x = r.row.hAlign === 'left' ? r.x : r.row.hAlign === 'right' ? r.x - maxW : r.x - maxW / 2;
    const outer = (r.row.outerScale ?? 0) > 0 ? (r.row.outerScale || 1) : (r.row.strokeOn === false ? 0 : 1);
    const pad = (r.row.strokeWidth || 0) * outer * 0.5;
    left = Math.min(left, x - pad);
    right = Math.max(right, x + maxW + pad);
    top = Math.min(top, r.firstY - r.row.size / 2 - pad);
    bottom = Math.max(bottom, r.firstY + (r.lines.length - 1) * r.lh + r.row.size / 2 + pad);
  }
  if (icon) {
    left = Math.min(left, icon.x); right = Math.max(right, icon.x + icon.w);
    top = Math.min(top, icon.y); bottom = Math.max(bottom, icon.y + icon.h);
  }
  ctx.restore();
  if (!Number.isFinite(left)) return { ...t.box };
  // 背景画像がある時は枠そのものが当たり判定になる
  if (t.bgAssetId) return { ...t.box };
  return { x: left, y: top, w: right - left, h: bottom - top };
}

// ---------------------------------------------------------------- フォント

/** 書き出し前に、使っているフォントが実際に読み込まれているか確かめる */
export async function ensureFontsLoaded(telops) {
  const specs = new Set();
  for (const t of telops) specs.add(`${t.bold ? 'bold ' : ''}${t.size}px "${t.font}"`);
  await Promise.all([...specs].map((s) => document.fonts.load(s).catch(() => {})));
  await document.fonts.ready;
}

/** ユーザーが追加した .ttf / .otf を読み込む */
export async function loadFontFile(file) {
  const name = file.name.replace(/\.(ttf|otf|woff2?|ttc)$/i, '');
  const face = new FontFace(name, await file.arrayBuffer());
  await face.load();
  document.fonts.add(face);
  return name;
}

/**
 * Local Font Access API でインストール済みフォントを列挙する。
 *
 * 注意点が 2 つある。
 *  - 権限が denied のとき queryLocalFonts() は **例外を投げず空配列を返す**ので、
 *    空だった時に権限を調べて理由を伝える
 *  - ユーザー操作の直後にしか呼べない。permissions.query() を先に await すると
 *    そのユーザー操作が失効して権限ダイアログが出なくなるので、必ず先に呼ぶ
 */
/**
 * インストール済みフォントの一覧。
 * @param {(done:number,total:number)=>void} [onProgress]
 * @returns {Promise<Array<{css:string,label:string,en:string}>>}
 */
export async function queryInstalledFonts(onProgress = null) {
  if (!('queryLocalFonts' in window)) {
    throw new Error('このブラウザは Local Font Access API 非対応です（Chrome / Edge をお使いください）');
  }
  let fonts = [];
  try {
    fonts = await window.queryLocalFonts();
  } catch (e) {
    if (e.name === 'SecurityError') throw new Error('フォント一覧の取得はボタンを押した直後にしか行えません');
    throw new Error(`フォント一覧を取得できませんでした（${e.name}）`);
  }

  if (!fonts.length) {
    let state = 'prompt';
    try { state = (await navigator.permissions.query({ name: 'local-fonts' })).state; } catch {}
    throw new Error(state === 'denied'
      ? 'フォントへのアクセスがブロックされています。アドレスバー左のアイコン →「フォント」を「許可」にしてから、もう一度押してください'
      : '許可ダイアログをキャンセルしたため取得できませんでした。もう一度押して「許可」を選んでください');
  }

  const byFamily = new Map();
  for (const f of fonts) if (!byFamily.has(f.family)) byFamily.set(f.family, f);
  const families = [...byFamily.keys()].sort();

  // 日本語名はフォント自身が持っている（API は英語名しか返さない）。
  // ファイル全部は読まず、name テーブルだけ切り出して読む
  const out = [];
  for (const family of families) {
    const ja = await japaneseName(byFamily.get(family)).catch(() => null);
    out.push({ css: family, label: ja && ja !== family ? ja : family, en: family });
  }
  if (onProgress) onProgress(out.length, out.length);
  return out;
}

/** フォントファイルから日本語のファミリ名を読む。取れなければ null */
async function japaneseName(fontData) {
  const blob = await fontData.blob();
  const probe = await blob.slice(0, 16).arrayBuffer();
  let plan = FN.headerPlan(probe);
  if (!plan) return null;

  let base = 0;
  if (plan.start === -1) {                    // TrueType Collection
    base = FN.firstFontOffset(probe);
    const p2 = await blob.slice(base, base + 12).arrayBuffer();
    plan = FN.headerPlan(p2);
    if (!plan) return null;
  }
  const header = await blob.slice(base, base + plan.need).arrayBuffer();
  const tbl = FN.findNameTable(header, base);
  if (!tbl) return null;
  const at = base + tbl.offset;
  const table = await blob.slice(at, at + tbl.length).arrayBuffer();
  return FN.readFamilyNames(table).ja;
}
