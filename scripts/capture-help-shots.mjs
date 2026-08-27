// public/help/*.png（使い方ページの説明用スクリーンショット）を撮り直す。
//
//   node scripts/capture-help-shots.mjs
//
// サーバーは中で立てるので、別ターミナルでの起動は要らない。
//
// 実素材は同梱できないので、撮影用の短い動画・音源・画像はこのスクリプトが
// その場で作る（ffmpeg / Canvas）。撮影用プロファイルは毎回捨てるので、
// 手元のブラウザ環境には影響しない。

import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import puppeteer from 'puppeteer-core';
import { serve } from './static-server.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = process.env.CHROME_PATH
  ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const OUT_DIR = join(ROOT, 'public/help');
const SAMPLE_DIR = join(ROOT, 'public/help/_sample');

const VIEWPORT = { width: 1280, height: 820, deviceScaleFactor: 2 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 撮影用のサンプル素材を作る（実素材は同梱しないため） */
function buildSamples() {
  if (!existsSync(SAMPLE_DIR)) execFileSync('mkdir', ['-p', SAMPLE_DIR]);
  const mp4 = join(SAMPLE_DIR, 'sample.mp4');
  if (!existsSync(mp4)) {
    // 色が変わっていく 40 秒のテスト映像＋音（カットの説明に使う）
    execFileSync('ffmpeg', ['-v', 'error', '-y',
      '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30:duration=40',
      '-f', 'lavfi', '-i', 'sine=frequency=300:duration=40',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', mp4]);
  }
  const mp3 = join(SAMPLE_DIR, 'bgm.mp3');
  if (!existsSync(mp3)) {
    execFileSync('ffmpeg', ['-v', 'error', '-y',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=30', '-c:a', 'libmp3lame', mp3]);
  }
  const png = join(SAMPLE_DIR, 'logo.png');
  if (!existsSync(png)) {
    execFileSync('ffmpeg', ['-v', 'error', '-y',
      '-f', 'lavfi', '-i', 'color=c=0x2f6fd0@1:size=420x140,format=rgba',
      '-frames:v', '1', png]);
  }
  return { mp4: 'public/help/_sample/sample.mp4', mp3: 'public/help/_sample/bgm.mp3', png: 'public/help/_sample/logo.png' };
}

/** ページ内で素材を読み込む（fetch → File にして bme.addFiles） */
const loadFiles = (paths) => `(async () => {
  const files = [];
  for (const p of ${JSON.stringify(paths)}) {
    const b = await (await fetch('/' + p)).blob();
    files.push(new File([b], p.split('/').pop(), { type: b.type }));
  }
  await window.bme.addFiles(files);
})()`;

async function main() {
  const S = buildSamples();
  await mkdir(OUT_DIR, { recursive: true });
  const server = serve();
  const BASE_URL = await server.ready();
  const profile = await mkdtemp(join(tmpdir(), 'kiriko-shots-'));
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    userDataDir: profile,
    headless: 'shell',
    args: ['--no-first-run', '--hide-scrollbars', '--autoplay-policy=no-user-gesture-required'],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport(VIEWPORT);
    page.on('pageerror', (e) => console.error('[page]', e.message));
    await page.goto(BASE_URL, { waitUntil: 'load' });
    await page.waitForFunction('!!window.bme');

    const shot = async (name) => {
      await sleep(400);
      await page.screenshot({ path: join(OUT_DIR, `${name}.png`) });
      console.error(`  ${name}.png`);
    };
    const run = (code) => page.evaluate(code);

    console.error('撮影中:');

    // 1) 起動直後（作業フォルダを開く案内）
    await shot('01-start');

    // 以降の撮影用に案内を閉じる。
    // showDirectoryPicker はユーザー操作が要るので自動では出せない。
    // ここではフォルダを開いた後と同じ状態にしてから撮る
    await run(`(() => {
      document.body.classList.remove('no-workdir');
      document.getElementById('welcome').classList.add('hidden');
    })()`);
    await sleep(200);

    // 2) 素材を読み込んだところ
    await run(loadFiles([S.mp4]));
    await page.waitForFunction('window.bme.project.sources.length > 0', { timeout: 60000 });
    await sleep(600);
    await shot('02-media');

    // 3) タイムラインに置いたところ
    await run(`document.querySelector('.bin-item .bin-add').click()`);
    await sleep(1500);
    await run(`document.getElementById('btnZoomFit').click()`);
    await sleep(2500);   // サムネイルと波形が出るまで待つ
    await shot('03-timeline');

    // 4) 範囲を選んだところ（カットの説明）
    await run(`(() => {
      const S = window.bme.state;
      S.programTime = 8; document.getElementById('btnZoneIn').click();
      S.programTime = 18; document.getElementById('btnZoneOut').click();
      window.bme.render();
    })()`);
    await sleep(800);
    await shot('04-cut');

    // 5) テロップ編集
    await run(`(() => {
      const S = window.bme.state;
      document.getElementById('btnZoneClear').click();
      S.programTime = 4;
      document.getElementById('btnAddTelop').click();
    })()`);
    await sleep(700);
    await run(`(() => {
      const t = window.bme.project.telops[0];
      t.rows[0].text = 'お昼休みチャレンジ';
      t.start = 0; t.end = 12;
      window.bme.render();
    })()`);
    await sleep(900);
    // 設定が増えたので、既定より広げて写す（実際に右下のつまみで広げられる）
    await run(`(() => {
      const d = document.getElementById('telopDialog');
      d.style.width = '390px'; d.style.height = '740px'; d.style.maxHeight = 'none';
    })()`);
    await sleep(400);
    await shot('05-telop');

    // 6) 画像と音源
    await run(`document.getElementById('telopDialogClose').click()`);
    await run(loadFiles([S.png, S.mp3]));
    await page.waitForFunction('window.bme.project.audioAssets.length > 0', { timeout: 60000 });
    await run(`(() => {
      const P = window.bme.project, S = window.bme.state;
      S.programTime = 2; window.bme.placeImage(P.imageAssets[0].id, 'center');
      S.programTime = 0; window.bme.placeAudio(P.audioAssets[0].id);
      S.selectedImageId = null;
      window.bme.render();
    })()`);
    await sleep(1200);
    await shot('06-image-audio');

    // 7) マーカー
    await run(`(async () => {
      const S = window.bme.state;
      window.bme.addMarker(5, 'ここから喋っている', 6, 'keep');
      window.bme.addMarker(14, '無音', 4, 'cut');
      S.selectedMarkerId = window.bme.project.markers[0].id;
      window.bme.render();
    })()`);
    await sleep(900);
    await shot('07-marker');

    // 8) 書き出し設定
    await run(`document.querySelector('.insptab[data-insp=output]').click()`);
    await sleep(500);
    await shot('08-export');

    // 9) フォント選び（テロップ編集を開き直してから）
    await run(`(() => {
      window.bme.state.selectedTelopId = window.bme.project.telops[0].id;
      document.getElementById('btnAddTelop').click();
    })()`);
    await sleep(600);
    await run(`document.getElementById('telFontBtn').click()`);
    await sleep(700);
    await shot('09-font');
    await run(`document.getElementById('fontPickClose').click()`);
    await run(`document.getElementById('telopDialogClose').click()`);

    // 10) テロップライブラリ（ライブラリフォルダの説明に使う）
    //    フォルダ選択はユーザー操作が要るので、撮影用に置き場所だけ差し替えて
    //    実際のボタンの処理（setLibDir → 表示更新）を通す
    await run(`(async () => {
      const Lib = await import('/js/library.js');
      const now = Date.now();
      const mk = (name, text) => ({
        id: 'shot_' + name, name, savedAt: now,
        telop: { rows: [{ text, font: '', size: 96 }] }, assets: [],
      });
      for (const e of [mk('見出しセット', 'お昼休みチャレンジ'),
                       mk('金額セット', '1,450 円'),
                       mk('注釈セット', '※ 配達件数は日によって変わります')]) {
        await Lib.putSet(e);
      }
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle('テロップ素材', { create: true });
      window.showDirectoryPicker = async () => dir;
      document.querySelector('button.bintab[data-bin=lib]').click();
      document.getElementById('libDirPick').click();
    })()`);
    await sleep(700);
    await run(`document.getElementById('libRefresh').click()`);
    await sleep(900);
    await shot('10-library');

    console.error(`出力先: ${OUT_DIR}`);
  } finally {
    await browser.close();
    server.stop();
    await rm(profile, { recursive: true, force: true });
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
