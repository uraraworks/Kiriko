// images.js
// 画像素材（テロップ用 PNG、スクリーンショット等）の読み込みと描画。
// テロップと同じ「枠（box）」で位置と大きさを持つ。

export class ImageLibrary {
  constructor() {
    this.bitmaps = new Map(); // assetId -> ImageBitmap
  }

  async add(file, id) {
    const bmp = await createImageBitmap(file);
    this.bitmaps.set(id, bmp);
    return { id, name: file.name, width: bmp.width, height: bmp.height };
  }

  get(id) { return this.bitmaps.get(id); }
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
  const ar = asset.width / asset.height;
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
  };
}

export function drawImagesAt(ctx, images, t, library) {
  for (const im of images || []) {
    if (t < im.start || t >= im.end) continue;
    const bmp = library?.get(im.assetId);
    if (!bmp) continue;
    ctx.save();
    ctx.globalAlpha = im.opacity ?? 1;
    const b = im.box;
    if (im.fit === 'stretch') {
      ctx.drawImage(bmp, b.x, b.y, b.w, b.h);
    } else {
      const s = Math.min(b.w / bmp.width, b.h / bmp.height);
      const w = bmp.width * s, h = bmp.height * s;
      ctx.drawImage(bmp, b.x + (b.w - w) / 2, b.y + (b.h - h) / 2, w, h);
    }
    ctx.restore();
  }
}
