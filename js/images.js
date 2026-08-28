// images.js
// 画像素材（テロップ用 PNG、スクリーンショット等）の読み込みと描画。
// テロップと同じ「枠（box）」で位置と大きさを持つ。

export class ImageLibrary {
  constructor() {
    this.bitmaps = new Map(); // assetId -> ImageBitmap
    this.contents = new Map(); // assetId -> 中身の矩形（透明な余白を除いた範囲）
  }

  async add(file, id) {
    const bmp = await createImageBitmap(file);
    this.bitmaps.set(id, bmp);
    this.contents.set(id, contentRect(bmp));
    return { id, name: file.name, width: bmp.width, height: bmp.height };
  }

  get(id) { return this.bitmaps.get(id); }

  /**
   * 透明な余白を除いた「中身」の範囲。
   * テロップ用 PNG は 1920×1080 の中に小さくロゴが載っているだけ、ということが多いので、
   * アイコンとして使うときはここだけを描く。
   */
  content(id) {
    const bmp = this.bitmaps.get(id);
    if (!bmp) return null;
    if (!this.contents.has(id)) this.contents.set(id, contentRect(bmp));
    return this.contents.get(id);
  }
}

/** 不透明な画素のバウンディングボックス（全部不透明なら画像全体） */
function contentRect(bmp) {
  const full = { x: 0, y: 0, w: bmp.width, h: bmp.height };
  try {
    const cv = new OffscreenCanvas(bmp.width, bmp.height);
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bmp, 0, 0);
    const d = ctx.getImageData(0, 0, bmp.width, bmp.height).data;
    let x0 = bmp.width, y0 = bmp.height, x1 = -1, y1 = -1;
    for (let y = 0; y < bmp.height; y++) {
      for (let x = 0; x < bmp.width; x++) {
        if (d[(y * bmp.width + x) * 4 + 3] > 8) {
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
        }
      }
    }
    if (x1 < x0 || y1 < y0) return full;
    return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
  } catch {
    return full;
  }
}

/** 配置プリセット。素材のアスペクト比に合わせて枠を決める */
export const PLACEMENTS = [
  { id: 'full', name: '全画面' },
  { id: 'top', name: '画面上' },
  { id: 'center', name: '画面中央' },
  { id: 'bottom', name: '画面下' },
  { id: 'left', name: '画面左' },
  { id: 'right', name: '画面右' },
];

/**
 * 配置プリセットから枠を作る。
 * 素材が出力と同じアスペクト比なら全画面がぴったり合う（テロップ用 PNG がこれ）。
 */
export function placementBox(placement, asset, W, H) {
  if (placement === 'full') return { x: 0, y: 0, w: W, h: H };

  // 画面の 1/3 の帯に収める（中央は 60% の高さ）
  const regions = {
    top: { x: 0, y: 0, w: W, h: H / 3 },
    bottom: { x: 0, y: H - H / 3, w: W, h: H / 3 },
    center: { x: 0, y: H * 0.2, w: W, h: H * 0.6 },
    left: { x: 0, y: 0, w: W / 3, h: H },
    right: { x: W - W / 3, y: 0, w: W / 3, h: H },
  };
  const r = regions[placement] ?? regions.center;
  // 領域に contain で収める
  const s = Math.min(r.w / asset.width, r.h / asset.height);
  const w = asset.width * s, h = asset.height * s;
  return { x: r.x + (r.w - w) / 2, y: r.y + (r.h - h) / 2, w, h };
}

/** 追加したときの既定配置。出力と同じ比率なら全画面、そうでなければ中央 */
export function defaultPlacement(asset, W, H) {
  const ar = asset.width / asset.height;
  return Math.abs(ar - W / H) < 0.02 ? 'full' : 'center';
}

export function createImageClip(assetId, start, end, box, opacity = 1) {
  return {
    id: `img_${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`,
    assetId, start, end,
    box: { ...box },
    opacity,
    fit: 'contain', // contain | stretch
    crop: null,     // 素材のどこを使うか（画素単位）。null なら画像全体
  };
}

/**
 * 素材のどこを使うか（画素単位）。null / はみ出しは画像の中に丸める。
 *
 * 元画像を画像編集ソフトで切り出しておく手間を無くすためのもの。
 * 素材は 1 枚のまま登録しておき、置くときに「この範囲だけ」と指定する。
 * 同じ画像から別の範囲を何度でも取れる。
 */
export function srcRect(im, bmp) {
  const full = { x: 0, y: 0, w: bmp.width, h: bmp.height };
  const c = im?.crop;
  if (!c) return full;
  const x = Math.max(0, Math.min(bmp.width - 1, Number(c.x) || 0));
  const y = Math.max(0, Math.min(bmp.height - 1, Number(c.y) || 0));
  const w = Math.max(1, Math.min(bmp.width - x, Number(c.w) || 0));
  const h = Math.max(1, Math.min(bmp.height - y, Number(c.h) || 0));
  return { x, y, w, h };
}

/** 枠の中で画像が実際に描かれる矩形（contain のときは余白ができる） */
export function drawnRect(im, bmp) {
  const b = im.box;
  if (im.fit === 'stretch' || !bmp) return { ...b };
  const src = srcRect(im, bmp);   // 切り出した範囲の比率で収める
  const s = Math.min(b.w / src.w, b.h / src.h);
  const w = src.w * s, h = src.h * s;
  return { x: b.x + (b.w - w) / 2, y: b.y + (b.h - h) / 2, w, h };
}

export function drawImageClip(ctx, im, library) {
  const bmp = library?.get(im.assetId);
  if (!bmp) return;
  const r = drawnRect(im, bmp);
  const s = srcRect(im, bmp);
  ctx.save();
  ctx.globalAlpha = im.opacity ?? 1;
  ctx.drawImage(bmp, s.x, s.y, s.w, s.h, r.x, r.y, r.w, r.h);
  ctx.restore();
}

export function drawImagesAt(ctx, images, t, library) {
  for (const im of images || []) {
    if (t >= im.start && t < im.end) drawImageClip(ctx, im, library);
  }
}
