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
