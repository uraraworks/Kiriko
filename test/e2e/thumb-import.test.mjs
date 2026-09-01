// 「他のプロジェクトから取り込む」の結合テスト。
// 実際に壊れたのは 2 点なので、そこだけを見る:
//   1. 出力解像度が違うと大きさがずれる（4K → 1080p でちょうど 2 倍になった）
//   2. 重ね順が崩れて、背景の画像が文字の上に乗ってしまう
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { serve, openApp, haveChrome } from '../helpers/browser.mjs';

/** 4K で作られた、文字 1 つ・画像 2 つ（背景とロゴ）のサムネを持つプロジェクト */
const SRC = {
  version: 1,
  title: '前回',
  output: { width: 3840, height: 2160, fps: 30 },
  imageAssets: [
    { id: 'a_bg', name: '背景.png', width: 1536, height: 1024 },
    { id: 'a_logo', name: 'ロゴ.png', width: 360, height: 360 },
  ],
  thumbnail: {
    base: null,
    images: [
      { id: 'i1', assetId: 'a_bg', start: 0, end: 3, box: { x: 0, y: -200, w: 3840, h: 2560 }, opacity: 1, fit: 'contain', crop: null, z: 1 },
      { id: 'i2', assetId: 'a_logo', start: 0, end: 3, box: { x: 60, y: 80, w: 520, h: 520 }, opacity: 1, fit: 'contain', crop: null, z: 2 },
    ],
    telops: [{
      id: 't1', start: 0, end: 3, track: 0, z: 3,
      box: { x: 100, y: 1000, w: 3600, h: 400 },
      vAlign: 'middle', wrap: true, rowGap: 20, textFree: false, textX: 40, textY: 60,
      bgAssetId: null, bgFree: false, bgBox: { x: 10, y: 20, w: 100, h: 200 },
      bgFillOn: false, bgFill: '#000000', bgOpacity: 1, bgFit: 'contain',
      icon: { assetId: null, side: 'left', size: 120, gap: 20, valign: 'middle', trim: true, free: false, x: 80, y: 40 },
      rows: [{ id: 'r1', text: 'お昼休みチャレンジ', font: 'sans-serif', size: 400, bold: true, fill: '#ffffff', fillMode: 'solid', stroke: '#000000', strokeOn: true, strokeWidth: 30, letterSpacing: 14, lineHeight: 1.18, hAlign: 'center' }],
    }],
  },
};

describe('サムネの取り込み', { skip: !haveChrome() && 'Chrome が見つからない（CHROME_PATH で指定）' }, () => {
  let server, browser, page, errors, got;

  before(async () => {
    server = serve();
    const base = await server.ready();
    ({ browser, page, errors } = await openApp(base));
    page.on('dialog', (d) => d.accept());   // 「画像も一緒に取り込みますか？」→ はい

    // 取り込み先は 1080p。ロゴだけは同じ名前の素材を先に持たせて、名前で繋ぎ直せるか見る
    await page.evaluate(() => {
      const p = window.bme.project;
      window.bme.project = { ...p,
        output: { ...p.output, width: 1920, height: 1080 },
        imageAssets: [{ id: 'mine_logo', name: 'ロゴ.png', width: 360, height: 360 }],
        thumbnail: { base: null, telops: [], images: [] } };
    });
    await page.evaluate((text) => {
      const dt = new DataTransfer();
      dt.items.add(new File([text], '前回.kiriko', { type: 'application/json' }));
      const el = document.getElementById('thImportInput');
      el.files = dt.files;
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }, JSON.stringify(SRC));
    await new Promise((r) => setTimeout(r, 800));

    got = await page.evaluate(() => ({
      thumb: window.bme.project.thumbnail,
      assets: window.bme.project.imageAssets.map((a) => ({ id: a.id, name: a.name })),
    }));
  });
  after(async () => { await browser?.close(); server?.stop(); });

  test('文字も画像も入る', () => {
    assert.equal(got.thumb.telops.length, 1);
    assert.equal(got.thumb.images.length, 2);
    assert.deepEqual(errors, []);
  });

  test('4K のものを 1080p に入れると、大きさが半分になる', () => {
    const t = got.thumb.telops[0];
    assert.deepEqual(t.box, { x: 50, y: 500, w: 1800, h: 200 });
    assert.deepEqual(t.bgBox, { x: 5, y: 10, w: 50, h: 100 });
    assert.equal(t.textX, 20);
    assert.equal(t.textY, 30);
    assert.equal(t.rowGap, 10);
    assert.deepEqual(t.icon.size, 60);
    assert.deepEqual([t.icon.gap, t.icon.x, t.icon.y], [10, 40, 20]);
    assert.equal(t.rows[0].size, 200);
    assert.equal(t.rows[0].strokeWidth, 15);
    assert.equal(t.rows[0].letterSpacing, 7);
    assert.deepEqual(got.thumb.images[0].box, { x: 0, y: -100, w: 1920, h: 1280 });
  });

  test('重ね順は取り込み元のまま（背景が文字の下に来る）', () => {
    const bg = got.thumb.images.find((i) => i.assetId !== 'mine_logo');
    const logo = got.thumb.images.find((i) => i.assetId === 'mine_logo');
    assert.ok(bg.z < logo.z, '背景がロゴより上に来ている');
    assert.ok(logo.z < got.thumb.telops[0].z, '画像が文字より上に来ている');
  });

  test('同じ名前の素材はいまのものに繋ぎ直し、無いものだけ足す', () => {
    assert.equal(got.thumb.images.find((i) => i.z === 2).assetId, 'mine_logo');
    assert.deepEqual(got.assets.map((a) => a.name).sort(), ['ロゴ.png', '背景.png'].sort());
    // 実体が無いので「素材の再リンク」に出る。id は新しく振られている
    assert.notEqual(got.assets.find((a) => a.name === '背景.png').id, 'a_bg');
  });
});
