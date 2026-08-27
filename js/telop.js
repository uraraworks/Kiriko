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

export function createTelop(t0, t1, style = {}, text = 'テロップ') {
  const { box, ...rest } = { ...DEFAULT_STYLE, ...style };
  return {
    id: `tel_${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`,
    text,
    start: t0,
    end: t1,
    box: { ...(box ?? DEFAULT_BOX) },
    ...rest,
  };
}

/** 旧形式（x, y, align）で保存されたテロップを枠形式に読み替える */
export function migrateTelop(t) {
  if (t.box) {
    if (!t.hAlign) t.hAlign = t.align ?? 'center';
    if (!t.vAlign) t.vAlign = 'middle';
    return t;
  }
  const size = t.size ?? DEFAULT_STYLE.size;
  const w = 1600, h = Math.max(size * 1.6, 160);
  const cx = t.x ?? 960, cy = t.y ?? 940;
  const align = t.align ?? 'center';
  const x = align === 'left' ? cx : align === 'right' ? cx - w : cx - w / 2;
  return { ...t, box: { x, y: cy - h / 2, w, h }, hAlign: align, vAlign: 'middle', wrap: t.wrap ?? true };
}

/** 既定プリセット（スタイル＋位置をセットで持つのが本企画の要件） */
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

function fontSpec(t) {
  const fam = /^[\w-]+$/.test(t.font) ? t.font : `"${t.font}"`;
  return `${t.bold ? 'bold ' : ''}${t.size}px ${fam}, "Hiragino Maru Gothic ProN", sans-serif`;
}

/**
 * 枠幅で折り返した行を返す。
 * 日本語は単語境界が無いので基本は 1 文字ずつ詰め、空白があればそこを優先して折る。
 */
export function layoutLines(ctx, t) {
  ctx.font = fontSpec(t);
  const raw = String(t.text ?? '').split('\n');
  if (!t.wrap) return raw;
  const maxW = Math.max(20, t.box.w);
  const out = [];
  for (const para of raw) {
    if (!para) { out.push(''); continue; }
    let line = '';
    for (const ch of para) {
      const next = line + ch;
      if (line && ctx.measureText(next).width > maxW) {
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
}

/** 各行の描画位置（textAlign / textBaseline は middle 基準） */
function layout(ctx, t) {
  const lines = layoutLines(ctx, t);
  const lh = t.size * (t.lineHeight ?? 1.18);
  const blockH = (lines.length - 1) * lh + t.size;
  const b = t.box;

  let firstY;
  if (t.vAlign === 'top') firstY = b.y + t.size / 2;
  else if (t.vAlign === 'bottom') firstY = b.y + b.h - blockH + t.size / 2;
  else firstY = b.y + b.h / 2 - (lines.length - 1) * lh / 2;

  const x = t.hAlign === 'left' ? b.x : t.hAlign === 'right' ? b.x + b.w : b.x + b.w / 2;
  return { lines, lh, firstY, x, blockH };
}

/** テロップ 1 個を描く */
export function drawTelop(ctx, t) {
  if (!t.box) return;
  ctx.save();
  ctx.font = fontSpec(t);
  const { lines, lh, firstY, x } = layout(ctx, t);
  ctx.textAlign = t.hAlign || 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.miterLimit = 2;

  const w = t.strokeWidth || 0;
  for (let i = 0; i < lines.length; i++) {
    const y = firstY + i * lh;
    if (!lines[i]) continue;

    // 影は一番外側の縁にだけ乗せる
    if (t.shadow > 0) {
      ctx.shadowColor = `rgba(0,0,0,${t.shadow})`;
      ctx.shadowBlur = t.size * 0.14;
      ctx.shadowOffsetY = t.size * 0.05;
    }
    // 外→内→塗り の順で重ねると YouTube 風の二重縁になる
    if (w > 0 && (t.outerScale ?? 0) > 0) {
      ctx.strokeStyle = t.outerStroke;
      ctx.lineWidth = w * t.outerScale;
      ctx.strokeText(lines[i], x, y);
    }
    ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
    if (w > 0) {
      ctx.strokeStyle = t.stroke;
      ctx.lineWidth = w;
      ctx.strokeText(lines[i], x, y);
    }
    ctx.fillStyle = t.fill;
    ctx.fillText(lines[i], x, y);
  }
  ctx.restore();
}

/** タイムライン時刻 t に出ているテロップをすべて描く */
export function drawTelopsAt(ctx, telops, t) {
  for (const tel of telops) {
    if (t >= tel.start && t < tel.end) drawTelop(ctx, tel);
  }
}

/** 実際に文字が占めている範囲（枠より狭いことがある。当たり判定の補助に使う） */
export function textBounds(ctx, t) {
  ctx.save();
  ctx.font = fontSpec(t);
  const { lines, lh, firstY, blockH } = layout(ctx, t);
  let maxW = 0;
  for (const l of lines) maxW = Math.max(maxW, ctx.measureText(l).width);
  ctx.restore();
  const b = t.box;
  const x = t.hAlign === 'left' ? b.x : t.hAlign === 'right' ? b.x + b.w - maxW : b.x + (b.w - maxW) / 2;
  const pad = (t.strokeWidth || 0) * (t.outerScale || 1) * 0.5;
  return { x: x - pad, y: firstY - t.size / 2 - pad, w: maxW + pad * 2, h: blockH + pad * 2, lh };
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
export async function queryInstalledFonts() {
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
  for (const f of fonts) if (!byFamily.has(f.family)) byFamily.set(f.family, f.fullName);
  return [...byFamily.keys()].sort();
}
