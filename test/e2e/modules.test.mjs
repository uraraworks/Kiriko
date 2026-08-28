// DOMParser や Canvas が要るモジュールは、実ブラウザの中で確かめる。
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { serve, openApp, haveChrome } from '../helpers/browser.mjs';

describe('ブラウザが要るモジュール', { skip: haveChrome() ? false : 'Chrome が見つからない' }, () => {
  let server, browser, page;
  before(async () => {
    server = serve();
    ({ browser, page } = await openApp(await server.ready()));
  });
  after(async () => { await browser?.close(); server?.stop(); });
  const ev = (js) => page.evaluate(js);

  // 実素材では V1 の隙間を V2 が埋めていて、V1 だけ読むと 12 クリップ落ちた。
  const MLT = `<?xml version="1.0"?>
<mlt profile="atsc_1080p_30">
  <producer id="p1"><property name="resource">/movie/a.mp4</property></producer>
  <playlist id="playlist0">
    <entry producer="p1" in="00:00:00.000" out="00:00:00.999"/>
    <blank length="00:00:02.000"/>
    <entry producer="p1" in="00:00:10.000" out="00:00:10.999"/>
  </playlist>
  <playlist id="playlist1"/>
  <playlist id="playlist2">
    <blank length="00:00:01.000"/>
    <entry producer="p1" in="00:00:20.000" out="00:00:20.999"/>
  </playlist>
  <playlist id="playlist3"/>
  <tractor id="tractor0">
    <track producer="playlist0" hide="audio"/>
    <track producer="playlist1" hide="audio"/>
  </tractor>
  <tractor id="tractor1">
    <track producer="playlist2" hide="audio"/>
    <track producer="playlist3" hide="audio"/>
  </tractor>
</mlt>`;

  test('Kdenlive: 複数の映像トラックを位置順に統合する', async () => {
    const r = await ev(`(async () => {
      const K = await import('/js/kdenlive.js');
      const p = K.parseKdenlive(${JSON.stringify(MLT)});
      return { fps: p.fps, n: p.cuts.length, ins: p.cuts.map(c => +c.in.toFixed(2)),
               files: p.files, tracks: p.trackIds?.length ?? 0 };
    })()`);
    assert.equal(r.n, 3, 'トラックをまたいだクリップが落ちている');
    // 位置順: playlist0 の 0s → playlist2 の 1s → playlist0 の 3s
    assert.deepEqual(r.ins, [0, 20, 10]);
    assert.ok(r.files.some((f) => f.includes('a.mp4')));
  });

  test('Kdenlive: 長さは out - in + 1 フレーム', async () => {
    const r = await ev(`(async () => {
      const K = await import('/js/kdenlive.js');
      const p = K.parseKdenlive(${JSON.stringify(MLT)});
      return { fps: p.fps, len: +(p.cuts[0].out - p.cuts[0].in).toFixed(4) };
    })()`);
    assert.ok(Math.abs(r.len - (0.999 + 1 / r.fps)) < 0.01, `長さが合わない: ${r.len}`);
  });

  test('Kdenlive: basename が取れる', async () => {
    assert.equal(await ev(`(async () => (await import('/js/kdenlive.js')).basename('/a/b/c.mp4'))()`), 'c.mp4');
  });

  test('テロップ: 折り返しと寸法が取れる', async () => {
    const r = await ev(`(async () => {
      const T = await import('/js/telop.js');
      const ctx = new OffscreenCanvas(1920, 1080).getContext('2d');
      const t = T.createTelop(0, 3, {}, 'あいうえお');
      const lay = T.layoutTelop(ctx, t);
      const wide = T.wrapRow(ctx, { ...t.rows[0], text: 'あ'.repeat(60) }, 400, true);
      const narrow = T.wrapRow(ctx, { ...t.rows[0], text: 'あ'.repeat(60) }, 400, false);
      return { lines: lay.lines?.length ?? lay.rows?.length ?? 0,
               wrapped: wide.length, unwrapped: narrow.length };
    })()`);
    assert.ok(r.wrapped > 1, '折り返しが効いていない');
    assert.equal(r.unwrapped, 1, '折り返し無しなのに分割された');
  });

  // canvas の measureText は最後の文字のうしろにも字間を足すので、
  // それを引かないと寄せた時に半分ずれる
  test('テロップ: 字間を広げると横に伸び、寄せはずれない', async () => {
    const r = await ev(`(async () => {
      const T = await import('/js/telop.js');
      const ctx = new OffscreenCanvas(1920, 1080).getContext('2d');
      const mk = (sp) => {
        const t = T.createTelop(0, 3, { letterSpacing: sp, hAlign: 'center', wrap: false }, 'あいうえお');
        return T.textBounds(ctx, t);
      };
      const a = mk(0), b = mk(20), c = mk(-10);
      return {
        w0: Math.round(a.w), w20: Math.round(b.w), wm10: Math.round(c.w),
        c0: Math.round(a.x + a.w / 2), c20: Math.round(b.x + b.w / 2),
      };
    })()`);
    // 5 文字なので、間は 4 つぶん広がる
    assert.ok(Math.abs((r.w20 - r.w0) - 80) < 4, `広がりが合わない: ${r.w0} → ${r.w20}`);
    assert.ok(r.wm10 < r.w0, '負の字間で詰まらない');
    assert.ok(Math.abs(r.c20 - r.c0) <= 1, `中央がずれた: ${r.c0} → ${r.c20}`);
  });

  test('テロップ: 字間は折り返し幅にも効く', async () => {
    const r = await ev(`(async () => {
      const T = await import('/js/telop.js');
      const ctx = new OffscreenCanvas(1920, 1080).getContext('2d');
      const row = { ...T.DEFAULT_STYLE, text: 'あ'.repeat(20) };
      return {
        tight: T.wrapRow(ctx, { ...row, letterSpacing: 0 }, 600, true).length,
        wide: T.wrapRow(ctx, { ...row, letterSpacing: 40 }, 600, true).length,
      };
    })()`);
    assert.ok(r.wide > r.tight, `字間を広げても行数が増えない: ${r.tight} → ${r.wide}`);
  });

  test('テロップ: 測っても共有の ctx に字間が残らない', async () => {
    const left = await ev(`(async () => {
      const T = await import('/js/telop.js');
      const ctx = new OffscreenCanvas(1920, 1080).getContext('2d');
      T.wrapRow(ctx, { ...T.DEFAULT_STYLE, text: 'あいう', letterSpacing: 40 }, 600, true);
      return ctx.letterSpacing;
    })()`);
    assert.equal(left, '0px');
  });

  test('テロップ: 背景画像とアイコンを枠の左上からの位置で置ける', async () => {
    const r = await ev(`(async () => {
      const T = await import('/js/telop.js');
      const ctx = new OffscreenCanvas(1920, 1080).getContext('2d');
      const bmp = { width: 400, height: 120 };
      const lib = { get: () => bmp };
      const t = T.createTelop(0, 3, { box: { x: 200, y: 700, w: 1000, h: 300 } }, 'あ');
      t.bgAssetId = 'a'; t.icon.assetId = 'a'; t.icon.size = 120;

      // 自由配置：枠の左上 + 指定した分
      t.bgFree = true; t.bgBox = { x: 50, y: 20, w: 300, h: 90 };
      t.icon.free = true; t.icon.x = 600; t.icon.y = 40;
      const bg = T.bgRect(t, bmp);
      const icon = T.layoutTelop(ctx, t, lib).icon;

      // 枠ごと動かすと、画像も付いてくる
      t.box = { ...t.box, x: 300, y: 800 };
      const bg2 = T.bgRect(t, bmp);
      const icon2 = T.layoutTelop(ctx, t, lib).icon;

      // 幅・高さ 0 なら画像そのままの大きさ
      t.bgBox = { x: 0, y: 0, w: 0, h: 0 };
      const raw = T.bgRect(t, bmp);
      return {
        bg: [bg.x, bg.y, bg.w, bg.h], icon: [icon.x, icon.y],
        bg2: [bg2.x, bg2.y], icon2: [icon2.x, icon2.y],
        raw: [raw.w, raw.h],
      };
    })()`);
    assert.deepEqual(r.bg, [250, 720, 300, 90], '背景画像が枠の左上基準になっていない');
    assert.deepEqual(r.icon, [800, 740], 'アイコンが枠の左上基準になっていない');
    assert.deepEqual(r.bg2, [350, 820], '枠を動かしても背景画像が付いてこない');
    assert.deepEqual(r.icon2, [900, 840], '枠を動かしてもアイコンが付いてこない');
    assert.deepEqual(r.raw, [400, 120], '幅 0 で画像そのままの大きさにならない');
  });

  test('テロップ: 自由配置にしても文字の領域は削られない', async () => {
    const r = await ev(`(async () => {
      const T = await import('/js/telop.js');
      const ctx = new OffscreenCanvas(1920, 1080).getContext('2d');
      const lib = { get: () => ({ width: 400, height: 120 }) };
      const t = T.createTelop(0, 3, {}, 'あ');
      t.icon.assetId = 'a';
      const anchored = T.layoutTelop(ctx, t, lib).textBox.w;
      t.icon.free = true;
      const free = T.layoutTelop(ctx, t, lib).textBox.w;
      return { anchored, free, box: t.box.w };
    })()`);
    assert.ok(r.anchored < r.box, '寄せ配置ではアイコンのぶん狭くなる');
    assert.equal(r.free, r.box, '自由配置なのに文字の領域が狭められている');
  });

  test('テロップ: 文字の位置も枠の左上からずらせる', async () => {
    const r = await ev(`(async () => {
      const T = await import('/js/telop.js');
      const ctx = new OffscreenCanvas(1920, 1080).getContext('2d');
      const t = T.createTelop(0, 3, { wrap: false, box: { x: 200, y: 700, w: 1000, h: 300 } }, 'あいう');
      const a = T.textBounds(ctx, t);
      t.textFree = true; t.textX = 120; t.textY = -40;
      const b = T.textBounds(ctx, t);
      // 枠ごと動かせば文字も付いてくる
      t.box = { ...t.box, x: 400 };
      const c = T.textBounds(ctx, t);
      return { dx: Math.round(b.x - a.x), dy: Math.round(b.y - a.y), dx2: Math.round(c.x - b.x) };
    })()`);
    assert.equal(r.dx, 120, '右へずれていない');
    assert.equal(r.dy, -40, '上へずれていない');
    assert.equal(r.dx2, 200, '枠を動かしても文字が付いてこない');
  });

  test('テロップ: 太字・斜体・下線・取り消し線は組み合わせられる', async () => {
    const r = await ev(`(async () => {
      const T = await import('/js/telop.js');
      // 縁取りと影は外して測る。付けたままだと下線がフチの中に隠れて画素数が変わらない
      const px = (style) => {
        const cv = new OffscreenCanvas(600, 200);
        const ctx = cv.getContext('2d');
        const t = T.createTelop(0, 3, { ...style, size: 60, wrap: false, hAlign: 'center',
          strokeWidth: 0, outerScale: 0, shadow: 0,
          box: { x: 0, y: 0, w: 600, h: 200 }, vAlign: 'middle' }, 'あいう');
        T.drawTelop(ctx, t);
        const d = ctx.getImageData(0, 0, 600, 200).data;
        let n = 0;
        for (let i = 3; i < d.length; i += 4) if (d[i] > 10) n++;
        return n;
      };
      return {
        plain: px({}),
        underline: px({ underline: true }),
        strike: px({ strike: true }),
        both: px({ underline: true, strike: true }),
      };
    })()`);
    // 下線と取り消し線は自分で矩形を引くので、書体が無い環境でも結果が変わらない。
    // 太字・斜体は書体側の話（代替フォントだと差が出ないことがある）なので、
    // ここでは見ない。指定が保たれることは単体テストで確かめている
    assert.ok(r.underline > r.plain, '下線が描かれていない');
    assert.ok(r.strike > r.plain, '取り消し線が描かれていない');
    assert.ok(r.both > r.underline && r.both > r.strike, '両方は重ねられるはず');
  });

  test('テロップ: 文字をグラデーションで塗れる（縦・横）', async () => {
    const r = await ev(`(async () => {
      const T = await import('/js/telop.js');
      // 塗りの色だけを見たいので、フチと影は外す。
      // 「■」を並べて中身の詰まった面を作り、その中の色を拾う
      const draw = (style) => {
        const cv = new OffscreenCanvas(600, 200);
        const ctx = cv.getContext('2d');
        const t = T.createTelop(0, 3, { ...style, size: 120, wrap: false, hAlign: 'center',
          strokeWidth: 0, outerScale: 0, shadow: 0,
          box: { x: 0, y: 0, w: 600, h: 200 }, vAlign: 'middle' }, '■■■');
        T.drawTelop(ctx, t);
        const at = (x, y) => [...ctx.getImageData(x, y, 1, 1).data].slice(0, 3);
        return { top: at(300, 62), bottom: at(300, 138), left: at(200, 100), right: at(400, 100) };
      };
      return {
        solid: draw({ fill: '#ff0000' }),
        vert: draw({ fill: '#ff0000', fill2: '#0000ff', fillMode: 'gradient', fillDir: 'v' }),
        horz: draw({ fill: '#ff0000', fill2: '#0000ff', fillMode: 'gradient', fillDir: 'h' }),
      };
    })()`);
    const red = (c) => c[0] > 150 && c[2] < 100;
    const blue = (c) => c[2] > 150 && c[0] < 100;
    assert.ok(red(r.solid.top) && red(r.solid.bottom), `単色が塗れていない: ${JSON.stringify(r.solid)}`);
    assert.ok(red(r.vert.top), `縦: 上が 1 色目でない: ${JSON.stringify(r.vert)}`);
    assert.ok(blue(r.vert.bottom), `縦: 下が 2 色目でない: ${JSON.stringify(r.vert)}`);
    assert.ok(red(r.horz.left), `横: 左が 1 色目でない: ${JSON.stringify(r.horz)}`);
    assert.ok(blue(r.horz.right), `横: 右が 2 色目でない: ${JSON.stringify(r.horz)}`);
  });

  test('テロップ: 文字の外形が枠の中に収まる', async () => {
    const r = await ev(`(async () => {
      const T = await import('/js/telop.js');
      const ctx = new OffscreenCanvas(1920, 1080).getContext('2d');
      const t = T.createTelop(0, 3, {}, 'テスト');
      const b = T.textBounds(ctx, t);
      return { b, box: t.box };
    })()`);
    assert.ok(r.b.w > 0 && r.b.h > 0, '外形が取れない');
    assert.ok(r.b.x >= r.box.x - 1 && r.b.x + r.b.w <= r.box.x + r.box.w + 1,
      `枠からはみ出している: ${JSON.stringify(r.b)} / ${JSON.stringify(r.box)}`);
  });
});
