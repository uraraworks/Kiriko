// telop.js
// テロップの描画コア。プレビューと書き出しで **同じ関数** を使う。
// （Canvas の 2D コンテキストなら OffscreenCanvas でも同じ挙動になる）
//
// 座標は出力ピクセル空間（既定 1920×1080）。プレビュー側の canvas も
// 同じ解像度をバッキングストアに持たせるので、見たまま書き出される。

export const DEFAULT_STYLE = {
  font: 'Hiragino Maru Gothic ProN',
  size: 96,
  bold: true,
  fill: '#f5e04b',
  stroke: '#4a3b00',      // 内側の濃い縁
  strokeWidth: 16,
  outerStroke: '#ffffff', // 外側の白フチ
  outerScale: 2.2,        // strokeWidth に対する倍率（0 で白フチなし）
  shadow: 0.45,           // 0〜1。影の濃さ
  lineHeight: 1.18,
  align: 'center',        // left | center | right
};

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

export function createTelop(t0, t1, style = {}, text = 'テロップ') {
  const s = { ...DEFAULT_STYLE, ...style };
  return {
    id: `tel_${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`,
    text,
    start: t0,
    end: t1,
    x: s.x ?? 960,
    y: s.y ?? 940,
    ...s,
  };
}

/** 既定プリセット（スタイル＋位置をセットで持つのが本企画の要件） */
export const DEFAULT_PRESETS = [
  {
    name: '実況（下段中央）',
    style: { ...DEFAULT_STYLE, size: 92, x: 960, y: 940, align: 'center' },
  },
  {
    name: '金額（右上）',
    style: {
      ...DEFAULT_STYLE, size: 104, x: 1830, y: 130, align: 'right',
      fill: '#ffffff', stroke: '#0f5c2e', strokeWidth: 18,
    },
  },
  {
    name: '見出し（上段中央・大）',
    style: {
      ...DEFAULT_STYLE, size: 132, x: 960, y: 180, align: 'center',
      fill: '#f5e04b', stroke: '#3a2c00', strokeWidth: 22,
    },
  },
  {
    name: '注釈（左下・小）',
    style: {
      ...DEFAULT_STYLE, size: 56, x: 90, y: 980, align: 'left',
      fill: '#ffffff', stroke: '#222222', strokeWidth: 10, outerScale: 0,
    },
  },
];

// ---------------------------------------------------------------- 描画

function fontSpec(t) {
  const fam = /^[\w-]+$/.test(t.font) ? t.font : `"${t.font}"`;
  return `${t.bold ? 'bold ' : ''}${t.size}px ${fam}, "Hiragino Maru Gothic ProN", sans-serif`;
}

const lines = (t) => String(t.text ?? '').split('\n');

/** テロップ 1 個を描く */
export function drawTelop(ctx, t) {
  const ls = lines(t);
  if (!ls.length) return;
  ctx.save();
  ctx.font = fontSpec(t);
  ctx.textAlign = t.align || 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.miterLimit = 2;

  const lh = t.size * (t.lineHeight ?? 1.18);
  const y0 = t.y - ((ls.length - 1) * lh) / 2;

  if (t.shadow > 0) {
    ctx.shadowColor = `rgba(0,0,0,${t.shadow})`;
    ctx.shadowBlur = t.size * 0.14;
    ctx.shadowOffsetY = t.size * 0.05;
  }

  const w = t.strokeWidth || 0;
  // 外→内→塗り の順で重ねると YouTube 風の二重縁になる
  for (let i = 0; i < ls.length; i++) {
    const y = y0 + i * lh;
    if (w > 0 && (t.outerScale ?? 0) > 0) {
      ctx.strokeStyle = t.outerStroke;
      ctx.lineWidth = w * t.outerScale;
      ctx.strokeText(ls[i], t.x, y);
    }
    // 影は一番外の縁にだけ乗せる
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;
    if (w > 0) {
      ctx.strokeStyle = t.stroke;
      ctx.lineWidth = w;
      ctx.strokeText(ls[i], t.x, y);
    }
    ctx.fillStyle = t.fill;
    ctx.fillText(ls[i], t.x, y);
  }
  ctx.restore();
}

/** タイムライン時刻 t に出ているテロップをすべて描く */
export function drawTelopsAt(ctx, telops, t) {
  for (const tel of telops) {
    if (t >= tel.start && t < tel.end) drawTelop(ctx, tel);
  }
}

/** テロップの外接矩形（当たり判定・ドラッグ用） */
export function telopBounds(ctx, t) {
  ctx.save();
  ctx.font = fontSpec(t);
  const ls = lines(t);
  let maxW = 0;
  for (const l of ls) maxW = Math.max(maxW, ctx.measureText(l).width);
  ctx.restore();
  const lh = t.size * (t.lineHeight ?? 1.18);
  const h = (ls.length - 1) * lh + t.size;
  const pad = (t.strokeWidth || 0) * (t.outerScale || 1);
  let x = t.x;
  if (t.align === 'center') x = t.x - maxW / 2;
  else if (t.align === 'right') x = t.x - maxW;
  return { x: x - pad, y: t.y - h / 2 - pad, w: maxW + pad * 2, h: h + pad * 2 };
}

export function hitTelop(ctx, telops, t, px, py) {
  // 手前（後ろに描かれたもの）から拾う
  const active = telops.filter((tel) => t >= tel.start && t < tel.end);
  for (let i = active.length - 1; i >= 0; i--) {
    const b = telopBounds(ctx, active[i]);
    if (px >= b.x && px <= b.x + b.w && py >= b.y && py <= b.y + b.h) return active[i];
  }
  return null;
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

/** Local Font Access API でインストール済みフォントを列挙する */
export async function queryInstalledFonts() {
  if (!('queryLocalFonts' in window)) throw new Error('このブラウザは Local Font Access API 非対応です');
  const fonts = await window.queryLocalFonts();
  const byFamily = new Map();
  for (const f of fonts) if (!byFamily.has(f.family)) byFamily.set(f.family, f.fullName);
  return [...byFamily.keys()].sort();
}
