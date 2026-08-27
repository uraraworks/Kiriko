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

  test('MCP と同じコマンドがページ内から通る', async () => {
    const s = await ev(`bme.call('summary')`);
    assert.ok(s && typeof s === 'object');
    const m = await ev(`bme.call('get_markers')`);
    assert.ok(m);
  });

  test('mp4 を書き出せて、moov が先頭にある', async () => {
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
