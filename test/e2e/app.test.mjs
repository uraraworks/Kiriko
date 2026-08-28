// 実 Chrome での結合テスト。
// 「読み込む → カット → テロップ → 書き出し」が通ることと、
// レイアウトが崩れていないことを実測で確かめる。
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ensureFixtures, haveFfmpeg } from '../helpers/fixtures.mjs';
import { serve, openApp, passGate, dropFiles, haveChrome, realErrors } from '../helpers/browser.mjs';

const skip = !haveChrome() ? 'Chrome が見つからない（CHROME_PATH で指定）'
  : !haveFfmpeg() ? 'ffmpeg が無い' : false;

describe('ブラウザ結合', { skip }, () => {
  let server, browser, page, errors, F;

  before(async () => {
    F = ensureFixtures();
    server = serve();
    const base = await server.ready();
    ({ browser, page, errors } = await openApp(base));
  });
  after(async () => { await browser?.close(); server?.stop(); });

  const ev = (js) => page.evaluate(js);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  test('起動直後は案内が出て、編集操作は止まっている', async () => {
    assert.equal(await ev(`document.body.classList.contains('no-workdir')`), true);
    assert.equal(await ev(`!document.getElementById('welcome').classList.contains('hidden')`), true);
    for (const id of ['btnSaveProj', 'btnLoadProj', 'btnExport', 'btnUndo', 'btnRedo']) {
      assert.equal(await ev(`document.getElementById('${id}').disabled`), true, `${id} が押せてしまう`);
    }
    // 作業フォルダのボタンとヘルプだけは触れる
    assert.equal(await ev(`document.getElementById('btnWorkDir').disabled`), false);
    assert.equal(await ev(`getComputedStyle(document.getElementById('btnWorkDir')).pointerEvents`), 'auto');
  });

  test('作業フォルダを開くとゲートが外れる', async () => {
    await passGate(page);
    assert.equal(await ev(`document.body.classList.contains('no-workdir')`), false);
    assert.equal(await ev(`document.getElementById('welcome').classList.contains('hidden')`), true);
    assert.equal(await ev(`document.getElementById('btnSaveProj').disabled`), false);
    assert.equal(await ev(`document.getElementById('workDirName').textContent`), 'work');
  });

  test('タイムラインとフッターの高さが正しい', async () => {
    // グリッドの行がずれると、タイムラインが数 px に潰れてフッターが伸びる
    const r = await ev(`(() => {
      const g = (s) => { const e = document.querySelector(s); const b = e.getBoundingClientRect();
        return { h: Math.round(b.height) }; };
      return { timeline: g('.timeline').h, footer: g('.statusbar').h, toolbar: g('.toolbar').h };
    })()`);
    assert.ok(r.timeline > 150, `タイムラインが潰れている: ${r.timeline}px`);
    assert.ok(r.footer >= 20 && r.footer <= 40, `フッターの高さがおかしい: ${r.footer}px`);
    assert.equal(r.toolbar, 40);
  });

  test('mp4 を読み込むとモニターに載る', async () => {
    await dropFiles(page, [F.video]);
    await page.waitForFunction('window.bme.project.sources.length > 0', { timeout: 60000 });
    assert.equal(await ev(`getComputedStyle(document.getElementById('noMedia')).display`), 'none');
    assert.ok((await ev(`document.getElementById('monName').textContent`)).includes('clip.mp4'));
  });

  test('「全体を置く」でタイムラインに乗る', async () => {
    await ev(`document.querySelector('#binList .bin-add').click()`);
    await wait(800);
    const p = await ev(`({ clips: bme.project.clips.length, dur: bme.project.clips[0].out - bme.project.clips[0].in })`);
    assert.equal(p.clips, 1);
    assert.ok(Math.abs(p.dur - 20) < 0.2, `尺が合わない: ${p.dur}`);
  });

  test('1 フレーム送りで毎回きちんと絵が動く', async () => {
    // タイムコードだけ進んで映像が取り残される、という退行を捕まえる。
    // seekProgram の「同じ位置なら飛ばす」閾値がフレーム間隔より粗いと、
    // 1 フレーム送りが 2 回に 1 回しか効かなくなる
    await ev(`(() => { bme.state.programTime = 0; })()`);
    await ev(`document.getElementById('btnHome').click()`);
    await wait(400);
    const seen = [];
    for (let i = 0; i < 6; i++) {
      await ev(`document.getElementById('btnFwd1').click()`);
      await wait(250);
      seen.push(await ev(`document.getElementById('video').currentTime`));
    }
    const stuck = seen.filter((v, i) => i > 0 && Math.abs(v - seen[i - 1]) < 0.001);
    assert.equal(stuck.length, 0,
      `絵が動かなかった回がある: ${seen.map((v) => v.toFixed(4)).join(', ')}`);
    // 1 フレームぶんずつ進んでいる
    const fps = await ev(`bme.project.output.fps`);
    for (let i = 1; i < seen.length; i++) {
      assert.ok(Math.abs((seen[i] - seen[i - 1]) - 1 / fps) < 0.01,
        `送り幅がおかしい: ${seen.join(', ')}`);
    }
    await ev(`document.getElementById('btnHome').click()`);
    await wait(300);
  });

  test('範囲を切り取ると後ろが詰まり、テロップも一緒に動く', async () => {
    await ev(`(() => {
      const S = bme.state;
      S.programTime = 10;
      document.getElementById('btnAddTelop').click();
    })()`);
    await wait(500);
    await ev(`(() => {
      const t = bme.project.telops[0];
      t.start = 10; t.end = 13;
      document.getElementById('telopDialogClose').click();
      bme.addMarker(12, '目印', 1);
      const S = bme.state;
      S.programTime = 2; document.getElementById('btnZoneIn').click();
      S.programTime = 6; document.getElementById('btnZoneOut').click();
      document.getElementById('btnExtract').click();
    })()`);
    await wait(600);
    const r = await ev(`({
      dur: bme.project.clips.reduce((a, c) => a + (c.out - c.in), 0),
      telop: bme.project.telops[0].start,
      marker: bme.project.markers[0].time,
      zone: [bme.state.zoneIn, bme.state.zoneOut],
    })`);
    assert.ok(Math.abs(r.dur - 16) < 0.2, `4 秒切れていない: ${r.dur}`);
    assert.ok(Math.abs(r.telop - 6) < 0.05, `テロップが詰まっていない: ${r.telop}`);
    assert.ok(Math.abs(r.marker - 8) < 0.05, `マーカーが詰まっていない: ${r.marker}`);
    assert.deepEqual(r.zone, [null, null], '切り取った後は範囲が解除される');
  });

  test('元に戻す・やり直すが効く', async () => {
    const before = await ev(`bme.project.clips.reduce((a,c)=>a+(c.out-c.in),0)`);
    await ev(`document.getElementById('btnUndo').click()`);
    await wait(400);
    const undone = await ev(`bme.project.clips.reduce((a,c)=>a+(c.out-c.in),0)`);
    assert.ok(undone > before, '戻っていない');
    assert.ok(Math.abs(await ev(`bme.project.telops[0].start`) - 10) < 0.05, 'テロップも戻る');
    await ev(`document.getElementById('btnRedo').click()`);
    await wait(400);
    assert.ok(Math.abs(await ev(`bme.project.clips.reduce((a,c)=>a+(c.out-c.in),0)`) - before) < 0.01);
  });

  test('切りすぎた分を継ぎ目から戻せる（[ で戻す / { で削り直す）', async () => {
    const key = (k) => ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(k)}, bubbles: true }))`);
    const snap = () => ev(`({
      dur: bme.project.clips.reduce((a, c) => a + (c.out - c.in), 0),
      telop: bme.project.telops[0].start,
      trims: bme.project.trims.reduce((a, t) => a + t.segments.reduce((x, s) => x + (s.out - s.in), 0), 0),
      clips: bme.project.clips.length,
    })`);

    const before = await snap();
    assert.ok(Math.abs(before.trims - 4) < 0.05, `切った 4 秒が在庫に残っていない: ${before.trims}`);

    // 継ぎ目送りで切った所へ飛ぶ
    await ev(`bme.state.programTime = 0`);
    await key('>');
    await wait(300);
    const at = await ev(`bme.state.programTime`);
    assert.ok(Math.abs(at - 2) < 0.05, `継ぎ目へ飛べていない: ${at}`);

    // 前を 0.5 秒戻す。尺が伸び、テロップも一緒に後ろへ動く
    await key('[');
    await wait(400);
    const after = await snap();
    assert.ok(Math.abs(after.dur - before.dur - 0.5) < 0.05, `0.5 秒戻っていない: ${after.dur}`);
    assert.ok(Math.abs(after.telop - before.telop - 0.5) < 0.05, `テロップが動いていない: ${after.telop}`);
    assert.ok(Math.abs(after.trims - 3.5) < 0.05, `在庫が減っていない: ${after.trims}`);
    assert.equal(after.clips, before.clips, '戻してもクリップは増えない');

    // 戻しすぎたら同じ場所で削り直せる
    await key('{');
    await wait(400);
    const back = await snap();
    assert.ok(Math.abs(back.dur - before.dur) < 0.05, `削り直せていない: ${back.dur}`);
    assert.ok(Math.abs(back.telop - before.telop) < 0.05, `テロップが戻っていない: ${back.telop}`);
    assert.ok(Math.abs(back.trims - 4) < 0.05, `削った分が在庫に戻っていない: ${back.trims}`);
  });

  test('マーカーを素材の時刻で立てられる（書き起こし中に編集してもずれない）', async () => {
    // 2〜6 秒を切った後。素材 10 秒は、前が 4 秒詰まってタイムライン 6 秒になるはず
    const r = await ev(`bme.call('add_markers', { markers: [
      { source: 'clip.mp4', sourceFrom: 10, sourceTo: 12, text: '素材時刻' },
    ] })`);
    assert.equal(r.added, 1);
    const m = await ev(`bme.project.markers.find(x => x.text === '素材時刻')`);
    assert.ok(Math.abs(m.time - 6) < 0.1, `変換がずれている: ${m.time}`);
    assert.ok(Math.abs(m.duration - 2) < 0.1, `長さがずれている: ${m.duration}`);

    // のりしろを付けると前後に広がる
    const r2 = await ev(`bme.call('add_markers', { markers: [
      { source: 'clip.mp4', sourceFrom: 10, sourceTo: 12, text: 'のりしろ' },
    ], pad: 1 })`);
    assert.equal(r2.added, 1);
    const m2 = await ev(`bme.project.markers.find(x => x.text === 'のりしろ')`);
    assert.ok(Math.abs(m2.time - 5) < 0.1, `のりしろが効いていない: ${m2.time}`);
    assert.ok(Math.abs(m2.duration - 4) < 0.1, `のりしろが効いていない: ${m2.duration}`);

    // 切られてしまった範囲は、黙って変な所に置かず落とす
    const r3 = await ev(`bme.call('add_markers', { markers: [
      { source: 'clip.mp4', sourceFrom: 3, sourceTo: 5, text: '消えた所' },
    ] })`);
    assert.equal(r3.added, 0);
    assert.equal(r3.dropped, 1);
    assert.equal(await ev(`bme.project.markers.some(x => x.text === '消えた所')`), false);

    await ev(`(() => { bme.project.markers = bme.project.markers.filter(
      m => !['素材時刻','のりしろ'].includes(m.text)); bme.render(); })()`);
  });

  test('マーカーの外を切る見積もりが出せる（dryRun は何も変えない）', async () => {
    const before = await ev(`({
      dur: bme.project.clips.reduce((a, c) => a + (c.out - c.in), 0),
      clips: bme.project.clips.length,
      trims: bme.project.trims.length,
    })`);
    // 「目印」マーカー（8 秒から 1 秒）だけが残す区間。のりしろ 2 秒を足すと 6〜11 秒が残る
    const r = await ev(`bme.call('cut_outside_markers', { pad: 2, dryRun: true })`);
    assert.equal(r.dryRun, true);
    assert.equal(r.keepMarkers, 1);
    assert.ok(r.removedSec > 0 && r.removedSec < before.dur, `見積もりがおかしい: ${r.removedSec}`);
    assert.ok(Math.abs(r.durationSec - (before.dur - r.removedSec)) < 0.05, '残り尺が合わない');
    assert.ok(r.ranges.every(([a, b]) => b > a), '範囲が壊れている');

    const after = await ev(`({
      dur: bme.project.clips.reduce((a, c) => a + (c.out - c.in), 0),
      clips: bme.project.clips.length,
      trims: bme.project.trims.length,
    })`);
    assert.deepEqual(after, before, 'dryRun なのに変わってしまった');
  });

  test('人間がドラッグしている間は MCP の書き込みを待たせる', async () => {
    // タイムラインのクリップを掴む（ドラッグ開始）
    const grabbed = await ev(`(() => {
      const cv = document.getElementById('tlCanvas');
      const r = cv.getBoundingClientRect();
      // クリップが乗っている行を上から探す
      for (let y = 40; y < r.height - 4; y += 4) {
        cv.dispatchEvent(new PointerEvent('pointerdown', {
          clientX: r.left + 40, clientY: r.top + y, bubbles: true, pointerId: 1, button: 0, buttons: 1,
        }));
        if (window.bme.busy()) return y;
        cv.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1 }));
      }
      return null;
    })()`);
    assert.ok(grabbed !== null, 'クリップを掴めなかった');

    // 掴んでいる間はマーカーが立たない
    await ev(`(() => { window.__mk = window.bme.call('add_markers', {
      markers: [{ time: 1, duration: 1, text: '待たされる' }] }); })()`);
    await wait(500);
    assert.equal(await ev(`bme.project.markers.some(m => m.text === '待たされる')`), false,
      'ドラッグ中なのに書き込まれた');

    // 手を離したら通る
    await ev(`document.getElementById('tlCanvas').dispatchEvent(
      new PointerEvent('pointerup', { bubbles: true, pointerId: 1 }))`);
    await ev(`window.__mk`);
    assert.equal(await ev(`bme.project.markers.some(m => m.text === '待たされる')`), true,
      '手を離しても書き込まれない');
    assert.equal(await ev(`bme.busy()`), false);

    await ev(`(() => { bme.project.markers = bme.project.markers.filter(
      m => m.text !== '待たされる'); bme.render(); })()`);
  });

  test('ぼかしは画面外まで動かせる（テロップは画面内に留まる）', async () => {
    // 人が画面の外へ歩いて消えていく時、枠も外へ送れないと最後まで追えない
    const r = await ev(`(async () => {
      const ov = document.getElementById('overlay');
      const rc = ov.getBoundingClientRect();
      const at = (x, y) => ({ clientX: rc.left + (x / ov.width) * rc.width,
                              clientY: rc.top + (y / ov.height) * rc.height });
      const ev2 = (t, x, y, o = {}) => ov.dispatchEvent(new PointerEvent(t,
        { ...at(x, y), bubbles: true, pointerId: 1, button: 0, buttons: 1, ...o }));

      bme.addBlur();
      const bl = bme.project.blurs[bme.project.blurs.length - 1];
      bl.shape = 'rect'; bl.start = 0; bl.end = 100; bl.keys = [];
      bl.rect = { x: 1400, y: 400, w: 300, h: 300 };
      Object.assign(bme.state, { selectedTelopId: null, selectedImageId: null,
        selectedBlurId: bl.id });
      bme.render();
      await new Promise((r2) => setTimeout(r2, 200));
      ev2('pointerdown', 1550, 550);
      ev2('pointermove', 2600, 550, { altKey: true });   // Alt で吸着を切る
      ev2('pointerup', 2600, 550);
      await new Promise((r2) => setTimeout(r2, 150));
      const blurX = bme.project.blurs[bme.project.blurs.length - 1].rect.x;

      bme.project.blurs = bme.project.blurs.filter((b) => b.shape !== 'rect');
      bme.state.selectedBlurId = null;
      bme.render();
      return { blurX, W: ov.width };
    })()`);
    assert.ok(r.blurX > r.W, `ぼかしが画面外へ出せない: x=${r.blurX}（画面幅 ${r.W}）`);
  });

  test('⌘ドラッグでテロップの中身だけを動かせる', async () => {
    const r = await ev(`(async () => {
      const tel = bme.project.telops[0];
      tel.textFree = false; tel.textX = 0; tel.textY = 0;
      Object.assign(bme.state, { selectedBlurId: null, selectedImageId: null,
        selectedMarkerId: null, selectedTelopId: tel.id });
      await bme.call('seek', { time: (tel.start + tel.end) / 2 });
      bme.render();
      await new Promise((r2) => setTimeout(r2, 200));

      const ov = document.getElementById('overlay');
      const rc = ov.getBoundingClientRect();
      const at = (x, y) => ({ clientX: rc.left + (x / ov.width) * rc.width,
                              clientY: rc.top + (y / ov.height) * rc.height });
      const ev2 = (t, x, y, o = {}) => ov.dispatchEvent(new PointerEvent(t,
        { ...at(x, y), bubbles: true, pointerId: 1, button: 0, buttons: 1, ...o }));
      const box0 = { ...tel.box };
      const cx = box0.x + box0.w / 2, cy = box0.y + box0.h / 2;
      ev2('pointerdown', cx, cy, { metaKey: true });
      ev2('pointermove', cx + 120, cy - 40, { metaKey: true });
      ev2('pointerup', cx + 120, cy - 40, { metaKey: true });
      await new Promise((r2) => setTimeout(r2, 200));
      return { box0, box: { ...tel.box }, textFree: tel.textFree,
               textX: tel.textX, textY: tel.textY };
    })()`);
    assert.equal(r.textFree, true, '「自由に決める」が入っていない');
    assert.ok(Math.abs(r.textX - 120) < 2, `文字が横に動いていない: ${r.textX}`);
    assert.ok(Math.abs(r.textY + 40) < 2, `文字が縦に動いていない: ${r.textY}`);
    assert.deepEqual(r.box, r.box0, '枠まで動いてしまっている');

    await ev(`(() => { const t = bme.project.telops[0];
      t.textFree = false; t.textX = 0; t.textY = 0; bme.render(); })()`);
  });

  test('テロップダイアログの中身がダイアログの外へはみ出さない', async () => {
    await ev(`(() => {
      bme.state.selectedTelopId = bme.project.telops[0].id;
      document.getElementById('btnAddTelop').click();
    })()`);
    await wait(500);
    const r = await ev(`(() => {
      const d = document.getElementById('telopDialog').getBoundingClientRect();
      const b = document.getElementById('telSaveLib').getBoundingClientRect();
      const body = document.querySelector('#telopDialog .fl-body');
      return { inside: b.top >= d.top && b.bottom <= d.bottom + 1,
               scrollable: body.scrollHeight > body.clientHeight,
               overflow: getComputedStyle(body).overflowY };
    })()`);
    assert.ok(r.inside, '［★ ライブラリに保存］がダイアログの外にある');
    assert.ok(r.overflow === 'auto' || r.overflow === 'scroll', '中身がスクロールできない');
    await ev(`document.getElementById('telopDialogClose').click()`);
  });

  test('フォントは一覧から選べて、名前がその書体で出る', async () => {
    const r = await ev(`(async () => {
      bme.state.selectedTelopId = bme.project.telops[0].id;
      document.getElementById('btnAddTelop').click();
      await new Promise((r) => setTimeout(r, 300));
      document.getElementById('telFontBtn').click();
      await new Promise((r) => setTimeout(r, 200));
      const rows = [...document.querySelectorAll('#fontPickList .font-row')];
      const styled = rows.every((b) => {
        const f = getComputedStyle(b.querySelector('.font-name')).fontFamily;
        return f.includes(b.dataset.css);
      });
      // 絞り込み
      const q = document.getElementById('fontSearch');
      q.value = 'ヒラギノ';
      q.dispatchEvent(new Event('input', { bubbles: true }));
      const filtered = document.querySelectorAll('#fontPickList .font-row').length;
      q.value = '';
      q.dispatchEvent(new Event('input', { bubbles: true }));

      // 選ぶ
      const target = [...document.querySelectorAll('#fontPickList .font-row')]
        .find((b) => b.dataset.css !== bme.project.telops.at(-1).rows[0].font);
      const want = target.dataset.css;
      target.click();
      await new Promise((r) => setTimeout(r, 200));
      return { rows: rows.length, styled, filtered, want,
               got: bme.project.telops.at(-1).rows[0].font,
               closed: document.getElementById('fontPick').classList.contains('hidden') };
    })()`);
    assert.ok(r.rows >= 5, `一覧が少なすぎる: ${r.rows}`);
    assert.ok(r.styled, '名前がその書体で描かれていない');
    assert.ok(r.filtered > 0 && r.filtered < r.rows, `絞り込みが効いていない: ${r.filtered}/${r.rows}`);
    assert.equal(r.got, r.want, '選んだ書体が反映されない');
    assert.ok(r.closed, '選んだのに閉じない');
    await ev(`document.getElementById('telopDialogClose').click()`);
  });

  // 一覧（queryLocalFonts）に載らないのに CSS からは使えるフォントがあるため
  test('一覧に無いフォントを名前で足せる／無い名前は断る', async () => {
    const r = await ev(`(async () => {
      bme.state.selectedTelopId = bme.project.telops.at(-1).id;
      document.getElementById('btnAddTelop').click();
      await new Promise((r) => setTimeout(r, 300));
      document.getElementById('telFontBtn').click();
      await new Promise((r) => setTimeout(r, 200));

      const input = document.getElementById('fontManual');
      const note = document.getElementById('fontManualNote');
      // 存在しない名前は断る
      input.value = '__ぜったいに無いフォント__';
      document.getElementById('fontManualAdd').click();
      await new Promise((r) => setTimeout(r, 200));
      const rejected = { cls: note.className, added: bme.state.manualFonts.length,
                         open: !document.getElementById('fontPick').classList.contains('hidden') };

      // 使える名前は足せる（この環境で確実に使えるものを選ぶ）
      const T = await import('/js/telop.js');
      const ok = ['serif', 'monospace', 'sans-serif'].find((f) => T.fontAvailable(f));
      let accepted = null;
      if (ok) {
        input.value = ok;
        document.getElementById('fontManualAdd').click();
        await new Promise((r) => setTimeout(r, 300));
        accepted = { list: bme.state.manualFonts, font: bme.project.telops.at(-1).rows[0].font,
                     closed: document.getElementById('fontPick').classList.contains('hidden') };
      }
      return { rejected, accepted, ok };
    })()`);
    assert.equal(r.rejected.cls, 'manual-note bad', '無い名前を受け付けてしまった');
    assert.equal(r.rejected.added, 0);
    assert.ok(r.rejected.open, '断った時は開いたままにする');
    if (r.accepted) {
      assert.ok(r.accepted.list.includes(r.ok), '一覧に足されていない');
      assert.equal(r.accepted.font, r.ok, '選んだ書体が反映されない');
      assert.ok(r.accepted.closed);
    }
    await ev(`document.getElementById('telopDialogClose').click()`);
  });

  // 文字の位置の自由指定が、画像の設定より後ろに埋もれていて見つからなかった
  test('テロップの設定は「文字 → 背景と画像」の順に並ぶ', async () => {
    const r = await ev(`(async () => {
      bme.state.selectedTelopId = bme.project.telops.at(-1).id;
      document.getElementById('btnAddTelop').click();
      await new Promise((r) => setTimeout(r, 300));
      const form = document.getElementById('telopForm');
      const at = (sel) => [...form.querySelectorAll('*')].indexOf(form.querySelector(sel));
      const cb = document.getElementById('telTextFree');
      cb.checked = true; cb.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 300));
      return {
        textFree: at('#telTextFree'),
        bgFill: at('#telBgFillOn'),
        bgImg: at('#telBg'),
        hasXY: !!document.getElementById('telTextX') && !!document.getElementById('telTextY'),
        headers: [...form.querySelectorAll('.panel-head')].map((e) => e.textContent.trim()),
      };
    })()`);
    assert.ok(r.hasXY, '自由指定にしても位置の欄が出ない');
    assert.ok(r.textFree > 0, '文字の位置の指定が見当たらない');
    assert.ok(r.textFree < r.bgFill && r.textFree < r.bgImg,
      '文字の設定が背景・画像より後ろに埋もれている');
    assert.deepEqual(r.headers, ['文字の配置（セット全体）', '背景と画像']);
    await ev(`document.getElementById('telopDialogClose').click()`);
  });

  test('テロップの背景色と内縁の切り替えが効く', async () => {
    const r = await ev(`(async () => {
      const t = bme.project.telops.at(-1);
      bme.state.selectedTelopId = t.id;
      document.getElementById('btnAddTelop').click();
      await new Promise((r) => setTimeout(r, 300));
      const tel = bme.project.telops.at(-1);
      const before = { bg: tel.bgFillOn, stroke: tel.rows[0].strokeOn };

      const bg = document.getElementById('telBgFillOn');
      bg.checked = true; bg.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 200));
      const picker = !!document.getElementById('telBgFill');

      const st = document.getElementById('telStrokeOn');
      st.checked = false; st.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 200));
      const strokeColorHidden = !document.getElementById('telStroke');

      // 色の見本を押すと色が入る
      const chip = document.querySelector('#telopForm .chips[data-for=telFill] .chip[data-color="#ff5a5a"]');
      chip.click();
      await new Promise((r) => setTimeout(r, 200));

      return { before, picker, strokeColorHidden,
               bgOn: tel.bgFillOn ?? bme.project.telops.at(-1).bgFillOn,
               strokeOn: bme.project.telops.at(-1).rows[0].strokeOn,
               fill: bme.project.telops.at(-1).rows[0].fill };
    })()`);
    assert.equal(r.before.bg, false, '背景色は既定で無し');
    assert.equal(r.before.stroke, true, '内縁は既定で有り');
    assert.ok(r.picker, '背景色を ON にしても色を選べない');
    assert.equal(r.bgOn, true);
    assert.equal(r.strokeOn, false);
    assert.ok(r.strokeColorHidden, '内縁 OFF なのに色欄が残っている');
    assert.equal(r.fill, '#ff5a5a', '色の見本が効かない');
    await ev(`document.getElementById('telopDialogClose').click()`);
  });

  test('コマ送りしたら、ぼかしもそのフレームに合わせて描き直される', async () => {
    // 部分ぼかしは <video> の絵を写して作るので、シーク完了後に描き直さないと
    // 前のフレームのぼかしが残り、コマ送りのたびにちらついて見える
    const at0 = await ev(`bme.state.programTime`);
    await ev(`(() => {
      bme.addBlur();
      const b = bme.project.blurs[bme.project.blurs.length - 1];
      b.shape = 'rect'; b.start = 0; b.end = 100; b.strength = 30;
      b.rect = { x: 40, y: 40, w: 400, h: 200 }; b.keys = [];
      bme.render();
    })()`);
    await wait(400);
    // renderOverlay は必ず clearRect から始まるので、その回数で描き直しを数える
    const n = await ev(`(async () => {
      const g = document.getElementById('overlay').getContext('2d');
      const orig = g.clearRect.bind(g);
      let n = 0;
      g.clearRect = (...a) => { n++; return orig(...a); };
      document.getElementById('btnFwd1').click();
      await new Promise((r) => setTimeout(r, 120));   // timeupdate（約250ms）より短く見る
      g.clearRect = orig;
      return n;
    })()`);
    assert.ok(n >= 2, `シーク後に描き直していない（描画 ${n} 回）`);

    // 後のテストに影響しないよう、ぼかしと再生位置を戻す
    await ev(`(() => {
      bme.project.blurs = bme.project.blurs.filter((b) => b.shape !== 'rect');
      bme.state.selectedBlurId = null;
      bme.render();
    })()`);
    await ev(`bme.call('seek', { time: ${at0} })`);
    await wait(300);
  });

  test('ぼかしの端をまたぐコマ送りで、絵と表示がずれない', async () => {
    // 画面にはまだ前のフレームが映っているのに、新しい時刻の表示を先に当てると
    // 「ぼかしの無い絵」が一瞬見える。全画面ぼかしは映像を 1 割ほど拡大するので特に目立つ
    const r = await ev(`(async () => {
      const dur = bme.project.clips.reduce((a, c) => a + (c.out - c.in), 0);
      const end = Math.min(6.8, dur - 1);
      bme.project.blurs = [{ id: 'bTest', shape: 'full', start: 0, end, strength: 40, keys: [] }];
      bme.render();
      await bme.call('seek', { time: end - 0.02 });
      await new Promise((r2) => setTimeout(r2, 500));
      const v = document.getElementById('video');
      const before = v.style.filter;
      document.getElementById('btnFwd1').click();
      const justAfter = v.style.filter;              // 押した直後（前のフレームがまだ映っている）
      await new Promise((r2) => setTimeout(r2, 700));
      const settled = v.style.filter;                // 新しいフレームが出た後
      bme.project.blurs = [];
      bme.render();
      return { before, justAfter, settled, t: bme.state.programTime, end };
    })()`);
    assert.ok(r.before.includes('blur'), 'そもそもぼかしが掛かっていない');
    assert.ok(r.t > r.end, `ぼかしの端をまたげていない: ${r.t} <= ${r.end}`);
    assert.equal(r.justAfter, r.before, '前のフレームが映ったままぼかしが外れている（ちらつく）');
    assert.equal(r.settled, '', '新しいフレームが出てもぼかしが外れない');
  });

  test('1 フレームに満たないクリップを知らせて取り除ける', async () => {
    const r = await ev(`(async () => {
      const P = bme.project;
      const sid = P.sources[0].id;
      const before = P.clips.map((c) => ({ ...c }));
      const fps = P.output.fps;
      // 実際のプロジェクトで見つかった形：まったく別の場所の 1 フレームが挟まっている
      P.clips = [
        { id: 'sv1', sourceId: sid, in: 3.0, out: 9.8, volume: 1 },
        { id: 'sv2', sourceId: sid, in: 16.5, out: 16.5 + 0.9 / fps, volume: 1 },
        { id: 'sv3', sourceId: sid, in: 16.6, out: 19.6, volume: 1 },
      ];
      P.trims = [];
      bme.render();
      await new Promise((r2) => setTimeout(r2, 300));
      const bar = document.getElementById('sliverBar');
      const shown = !bar.classList.contains('hidden');
      const text = bar.querySelector('.sv-text').textContent;
      document.getElementById('svFix').click();
      await new Promise((r2) => setTimeout(r2, 400));
      const after = bme.project.clips.length;
      const shownAfter = !document.getElementById('sliverBar').classList.contains('hidden');
      bme.project.clips = before; bme.project.trims = []; bme.render();
      return { shown, text, after, shownAfter };
    })()`);
    assert.ok(r.shown, 'かけらがあるのに知らせていない');
    assert.ok(r.text.includes('1 個'), `件数が出ていない: ${r.text}`);
    assert.equal(r.after, 2, `取り除けていない（クリップ ${r.after} 個）`);
    assert.equal(r.shownAfter, false, '取り除いたのに案内が残っている');
  });

  test('画像と効果音を置ける', async () => {
    await dropFiles(page, [F.image, F.audio]);
    await page.waitForFunction('window.bme.project.audioAssets.length > 0 && window.bme.project.imageAssets.length > 0',
      { timeout: 60000 });
    await ev(`(() => {
      const P = bme.project, S = bme.state;
      S.programTime = 2; bme.placeImage(P.imageAssets[0].id, 'center');
      S.programTime = 3; bme.placeAudio(P.audioAssets[0].id);
    })()`);
    await wait(500);
    assert.equal(await ev(`bme.project.images.length`), 1);
    assert.equal(await ev(`bme.project.audioClips.length`), 1);
  });

  test('画像は元ファイルを切り出さずに、使う範囲を指定できる', async () => {
    const a = await ev(`bme.project.imageAssets[0]`);
    // 右下の 1/4 だけを使う
    const r = await ev(`(async () => {
      const I = await import('./js/images.js');
      const im = bme.project.images[0];
      const a = bme.project.imageAssets[0];
      im.crop = { x: a.width / 2, y: a.height / 2, w: a.width / 2, h: a.height / 2 };
      im.box = { x: 100, y: 100, w: 600, h: 600 };
      im.fit = 'contain';
      const bmp = bme.state.imageLib.get(im.assetId);
      return { src: I.srcRect(im, bmp), drawn: I.drawnRect(im, bmp) };
    })()`);
    assert.ok(Math.abs(r.src.w - a.width / 2) < 0.01, '切り出し幅が違う');
    assert.ok(Math.abs(r.src.x - a.width / 2) < 0.01, '切り出し位置が違う');
    // 枠は正方形。切り出した範囲の比率で収まる
    const ar = (a.width / 2) / (a.height / 2);
    assert.ok(Math.abs(r.drawn.w / r.drawn.h - ar) < 0.02,
      `切り出した範囲の比率になっていない: ${r.drawn.w}×${r.drawn.h}`);

    // 実際に描くと、切り出した範囲の画素だけが出る
    const same = await ev(`(async () => {
      const I = await import('./js/images.js');
      const im = bme.project.images[0];
      const bmp = bme.state.imageLib.get(im.assetId);
      const cv = new OffscreenCanvas(1920, 1080);
      const g = cv.getContext('2d');
      I.drawImageClip(g, im, bme.state.imageLib);
      const d = I.drawnRect(im, bmp);
      // 描画先の中の 1 点と、元画像の対応する画素を比べる
      const px = g.getImageData(Math.round(d.x + d.w * 0.5), Math.round(d.y + d.h * 0.5), 1, 1).data;
      const src = I.srcRect(im, bmp);
      const cv2 = new OffscreenCanvas(bmp.width, bmp.height);
      const g2 = cv2.getContext('2d');
      g2.drawImage(bmp, 0, 0);
      const px2 = g2.getImageData(Math.round(src.x + src.w * 0.5), Math.round(src.y + src.h * 0.5), 1, 1).data;
      return [[...px].slice(0, 3), [...px2].slice(0, 3)];
    })()`);
    const dist = Math.abs(same[0][0] - same[1][0]) + Math.abs(same[0][1] - same[1][1])
      + Math.abs(same[0][2] - same[1][2]);
    assert.ok(dist < 30, `切り出した所と違う画素が出ている: ${JSON.stringify(same)}`);

    // 全体に戻せる
    await ev(`(() => { bme.project.images[0].crop = null; bme.render(); })()`);
    const full = await ev(`(async () => {
      const I = await import('./js/images.js');
      const im = bme.project.images[0];
      return I.srcRect(im, bme.state.imageLib.get(im.assetId));
    })()`);
    assert.equal(full.x, 0);
    assert.equal(full.w, a.width);
  });

  test('使う範囲のピッカーは、カーソルの形で操作が分かる', async () => {
    const cur = await ev(`(() => {
      const im = bme.project.images[0];
      const a = bme.project.imageAssets[0];
      im.crop = { x: a.width * 0.25, y: a.height * 0.25, w: a.width * 0.5, h: a.height * 0.5 };
      // renderFxForm はマーカー・ぼかし・音源を先に見るので、まとめて外す
      Object.assign(bme.state, { selectedMarkerId: null, selectedBlurId: null,
        selectedAudioId: null, selectedTelopId: null, selectedImageId: im.id });
      bme.render();
      const cv = document.getElementById('imCrop');
      const r = cv.getBoundingClientRect();
      const at = (px, py) => ({
        clientX: r.left + (px / a.width) * r.width,
        clientY: r.top + (py / a.height) * r.height,
      });
      const probe = (px, py) => {
        cv.dispatchEvent(new PointerEvent('pointermove', { ...at(px, py), bubbles: true, pointerId: 1 }));
        return cv.style.cursor;
      };
      const c = im.crop;
      const out = {
        tl: probe(c.x, c.y),
        tr: probe(c.x + c.w, c.y),
        bl: probe(c.x, c.y + c.h),
        br: probe(c.x + c.w, c.y + c.h),
        inside: probe(c.x + c.w / 2, c.y + c.h / 2),
        outside: probe(2, 2),
      };
      cv.dispatchEvent(new PointerEvent('pointerdown', {
        ...at(c.x + c.w / 2, c.y + c.h / 2), bubbles: true, pointerId: 1, button: 0, buttons: 1 }));
      out.dragging = cv.style.cursor;
      cv.dispatchEvent(new PointerEvent('pointerup', {
        ...at(c.x + c.w / 2, c.y + c.h / 2), bubbles: true, pointerId: 1 }));
      return out;
    })()`);
    assert.equal(cur.tl, 'nwse-resize', '左上が斜めのリサイズになっていない');
    assert.equal(cur.br, 'nwse-resize', '右下が斜めのリサイズになっていない');
    assert.equal(cur.tr, 'nesw-resize', '右上の向きが逆');
    assert.equal(cur.bl, 'nesw-resize', '左下の向きが逆');
    assert.equal(cur.inside, 'grab', '内側が手のひらになっていない');
    assert.equal(cur.dragging, 'grabbing', '掴んでいる間の形が変わらない');
    assert.equal(cur.outside, 'crosshair', '範囲の外が十字になっていない');

    await ev(`(() => { bme.project.images[0].crop = null; bme.render(); })()`);
  });

  test('メディア欄の画像は既定で畳まれていて、開くと配置ボタンが出る', async () => {
    const r = await ev(`(() => {
      const el = [...document.querySelectorAll('.bin-item.image')][0];
      const before = {
        placeRows: el.querySelectorAll('.place-row').length,
        thumb: !!el.querySelector('canvas.thumb'),
        name: !!el.querySelector('.n'),
        add: !!el.querySelector('.bin-add'),
        caret: el.querySelector('.bin-more').textContent,
      };
      el.querySelector('.bin-more').click();
      const el2 = [...document.querySelectorAll('.bin-item.image')][0];
      const after = {
        placeRows: el2.querySelectorAll('.place-row').length,
        caret: el2.querySelector('.bin-more').textContent,
        thumb: !!el2.querySelector('canvas.thumb'),
      };
      el2.querySelector('.bin-more').click();
      const closed = [...document.querySelectorAll('.bin-item.image')][0]
        .querySelectorAll('.place-row').length;
      return { before, after, closed };
    })()`);
    assert.equal(r.before.placeRows, 0, '既定で配置ボタンが出てしまっている');
    assert.ok(r.before.thumb, 'サムネイルが出ていない');
    assert.ok(r.before.name, 'ファイル名が出ていない');
    assert.ok(r.before.add, '置くボタン（＋）が無い');
    assert.equal(r.after.placeRows, 1, '開いても配置ボタンが出ない');
    assert.ok(r.after.thumb, '開いたらサムネイルが消えた');
    assert.notEqual(r.before.caret, r.after.caret, '開閉の印が変わらない');
    assert.equal(r.closed, 0, '閉じられない');
  });

  test('範囲でまとめてコピーし、間隔を保って貼り付けられる', async () => {
    const r = await ev(`(async () => {
      const S = bme.state, P = bme.project;
      // この検証だけの状態にする（テロップ 1 個＋効果音 1 個を 0.5 秒差で）
      P.telops = P.telops.slice(0, 1);
      P.audioClips = P.audioClips.slice(0, 1);
      P.telops[0].start = 1; P.telops[0].end = 3;
      P.audioClips[0].start = 1.5;
      S.selectedTelopId = null; S.selectedAudioId = null;
      const key = (k) => document.dispatchEvent(
        new KeyboardEvent('keydown', { key: k, metaKey: true, bubbles: true, cancelable: true }));
      S.zoneIn = 0.5; S.zoneOut = 4; bme.render();
      key('c');
      await new Promise((r) => setTimeout(r, 200));
      S.programTime = 12; key('v');
      await new Promise((r) => setTimeout(r, 400));
      return {
        telops: P.telops.map((t) => +t.start.toFixed(2)).sort((a, b) => a - b),
        audio: P.audioClips.map((a) => +a.start.toFixed(2)).sort((a, b) => a - b),
        zone: [S.zoneIn, S.zoneOut],
      };
    })()`);
    assert.deepEqual(r.telops, [1, 12], 'テロップが再生位置に来ていない');
    assert.deepEqual(r.audio, [1.5, 12.5], '効果音の間隔が保たれていない');
    assert.deepEqual(r.zone, [null, null], '貼り付け後は範囲が解除される');
  });

  test('プロジェクトの保存と読み込みで中身が保たれる', async () => {
    const r = await ev(`(() => {
      const json = bme.exportProjectJSON();
      const before = JSON.parse(json);
      bme.loadProjectJSON(json);
      const after = bme.project;
      return {
        clips: [before.clips.length, after.clips.length],
        telops: [before.telops.length, after.telops.length],
        audio: [before.audioClips.length, after.audioClips.length],
        images: [before.images.length, after.images.length],
        markers: [before.markers.length, after.markers.length],
        sources: [before.sources.length, after.sources.length],
      };
    })()`);
    for (const [k, [a, b]] of Object.entries(r)) assert.equal(b, a, `${k} が保存で失われた`);
  });

  // 開いたプロジェクト名を覚えていないと、保存で「無題プロジェクト.kiriko」になってしまう
  test('開いたプロジェクトは、同じ名前で保存される', async () => {
    const r = await ev(`(async () => {
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle('work', { create: true });
      const NAME = '2025.10.01_配達.kiriko';

      // タイトルを持たないプロジェクトを、その名前で置いておく
      const src = JSON.parse(bme.exportProjectJSON());
      delete src.title;
      const fh = await dir.getFileHandle(NAME, { create: true });
      const w0 = await fh.createWritable();
      await w0.write(JSON.stringify(src)); await w0.close();

      // 開く（作業フォルダから開いた時と同じ経路）
      await bme.loadProject(await fh.getFile(), fh);
      const afterOpen = { file: bme.state.projectFile?.name, title: bme.project.title };

      // 編集してから保存
      bme.project.markers.push({ id: 'm_test', time: 1, duration: 0, text: '印' });
      await bme.saveProject();

      const names = [];
      for await (const [n] of dir.entries()) names.push(n);
      const saved = JSON.parse(await (await (await dir.getFileHandle(NAME)).getFile()).text());
      return { afterOpen, names, hasMarker: saved.markers.some((m) => m.id === 'm_test') };
    })()`);
    assert.equal(r.afterOpen.file, '2025.10.01_配達.kiriko', '開いたファイル名を覚えていない');
    assert.equal(r.afterOpen.title, '2025.10.01_配達', 'タイトルがファイル名から入らない');
    assert.ok(!r.names.includes('無題プロジェクト.kiriko'), `別名で保存された: ${r.names.join(', ')}`);
    assert.ok(r.names.includes('2025.10.01_配達.kiriko'));
    assert.ok(r.hasMarker, '編集内容が書き戻されていない');
  });

  test('MCP と同じコマンドがページ内から通る', async () => {
    const s = await ev(`bme.call('summary')`);
    assert.ok(s && typeof s === 'object');
    const m = await ev(`bme.call('get_markers')`);
    assert.ok(m);
  });

  test('mp4 を書き出せて、moov が先頭にある', async (t) => {
    // Chromium の素のビルドには H.264 / AAC が無い。
    // 環境の都合で赤くしても仕方ないので、その時は正直に飛ばす
    const canEncode = await ev(`(async () => {
      try {
        const v = await VideoEncoder.isConfigSupported(
          { codec: 'avc1.640028', width: 1280, height: 720, bitrate: 4e6, framerate: 30 });
        const a = await AudioEncoder.isConfigSupported(
          { codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 2, bitrate: 128000 });
        return !!(v?.supported && a?.supported);
      } catch { return false; }
    })()`);
    if (!canEncode) return t.skip('このブラウザは H.264 / AAC を書き出せない');

    const r = await ev(`(async () => {
      const root = await navigator.storage.getDirectory();
      try { await root.removeEntry('out.mp4'); } catch {}
      const fh = await root.getFileHandle('out.mp4', { create: true });
      window.showSaveFilePicker = async () => fh;      // 保存先だけ差し替える
      document.getElementById('optRes').value = '1280x720';
      document.getElementById('btnExport').click();
      for (let i = 0; i < 200; i++) {
        await new Promise((r) => setTimeout(r, 250));
        if (!bme.state.exporting) break;
      }
      const f = await (await root.getFileHandle('out.mp4')).getFile();
      // 先頭のボックスを順に読む
      const head = new DataView(await f.slice(0, Math.min(f.size, 4 * 1024 * 1024)).arrayBuffer());
      const td = new TextDecoder();
      const boxes = [];
      let p = 0;
      while (p + 8 <= head.byteLength && boxes.length < 8) {
        let sz = head.getUint32(p);
        const ty = td.decode(new Uint8Array(head.buffer, p + 4, 4));
        let hdr = 8;
        if (sz === 1) { sz = Number(head.getBigUint64(p + 8)); hdr = 16; }
        if (sz === 0 || sz < hdr) break;
        boxes.push(ty);
        p += sz;
      }
      // 実際に再生できるか
      const v = document.createElement('video');
      v.muted = true;
      v.src = URL.createObjectURL(f);
      const meta = await new Promise((res) => {
        v.onloadedmetadata = () => res({ dur: v.duration, w: v.videoWidth, h: v.videoHeight });
        v.onerror = () => res(null);
        setTimeout(() => res(null), 8000);
      });
      URL.revokeObjectURL(v.src);
      return { size: f.size, boxes, meta, status: document.getElementById('status').textContent };
    })()`, { timeout: 180000 });

    assert.ok(r.size > 10000, `出力が小さすぎる: ${r.size}`);
    assert.equal(r.boxes[0], 'ftyp');
    assert.equal(r.boxes[1], 'moov', `moov が先頭に無い: ${r.boxes.join(' → ')}`);
    assert.ok(r.boxes.includes('mdat'));
    assert.ok(r.meta, '書き出した mp4 が再生できない');
    assert.equal(r.meta.w, 1280);
    assert.equal(r.meta.h, 720);
    const want = await ev(`bme.project.clips.reduce((a,c)=>a+(c.out-c.in),0)`);
    assert.ok(Math.abs(r.meta.dur - want) < 0.5, `尺がずれている: ${r.meta.dur} vs ${want}`);
  });

  test('ここまでで JavaScript のエラーが出ていない', () => {
    assert.deepEqual(realErrors(errors), []);
  });
});
