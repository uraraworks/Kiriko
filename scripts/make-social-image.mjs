#!/usr/bin/env node
// 共有時に出る画像（OGP / GitHub の Social preview）を作る。
//
//   npm run social
//
// 1280×640 は GitHub の Social preview と各 SNS の推奨に合う大きさ。
// アイコンと同じ「江戸切子の瑠璃色＋放射の切り込み」で揃えている。
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import puppeteer from 'puppeteer-core';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = process.env.CHROME_PATH
  ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const OUT = join(ROOT, 'public/social.png');
const OUT_JPG = join(ROOT, 'public/social.jpg');
const W = 1280, H = 640;

const icon = readFileSync(join(ROOT, 'assets/icon-512.png')).toString('base64');

const html = `<!doctype html><meta charset="utf-8">
<style>
  * { margin: 0; box-sizing: border-box; }
  body {
    width: ${W}px; height: ${H}px; overflow: hidden;
    font-family: "Hiragino Sans", "Hiragino Kaku Gothic ProN", "Noto Sans JP", sans-serif;
    color: #eef2f8;
    background:
      radial-gradient(1100px 700px at 78% 18%, #1d4e8f33, transparent 60%),
      linear-gradient(150deg, #10131a 0%, #141a26 55%, #0d1017 100%);
    display: grid; grid-template-columns: 1fr auto; align-items: center;
    padding: 0 82px; gap: 60px; position: relative;
  }
  /* 切子の切り込みを思わせる薄い放射線 */
  .cuts { position: absolute; inset: 0; opacity: .10; }
  .cuts i {
    position: absolute; left: 50%; top: 50%; width: 1400px; height: 1px;
    background: linear-gradient(90deg, transparent, #7fb6ff, transparent);
    transform-origin: 0 0;
  }
  .name { font-size: 92px; font-weight: 800; letter-spacing: .06em; line-height: 1; }
  .lead { margin-top: 22px; font-size: 31px; font-weight: 700; color: #cfe0f5; letter-spacing: .01em; }
  .sub  { margin-top: 14px; font-size: 21px; color: #93a6c0; line-height: 1.75; }
  .tags { margin-top: 30px; display: flex; gap: 10px; }
  .tags span {
    font-size: 18px; padding: 7px 16px; border-radius: 999px;
    border: 1px solid #2f4a72; color: #b9cbe4;
  }
  .icon { width: 300px; height: 300px; border-radius: 68px; box-shadow: 0 30px 80px #0009; }
  .url {
    position: absolute; left: 82px; bottom: 46px;
    font-size: 19px; color: #6f86a6; letter-spacing: .02em;
  }
</style>
<div class="cuts">${Array.from({ length: 18 }, (_, i) =>
  `<i style="transform: rotate(${i * 20}deg)"></i>`).join('')}</div>
<div>
  <div class="name">Kiriko</div>
  <div class="lead">ブラウザだけで完結する動画編集ツール</div>
  <div class="sub">カット・テロップ・効果音・ぼかしから mp4 書き出しまで。<br>
    インストールも、動画のアップロードも要りません。</div>
  <div class="tags"><span>WebCodecs</span><span>完全ローカル処理</span><span>MIT ライセンス</span></div>
</div>
<img class="icon" src="data:image/png;base64,${icon}" alt="">
<div class="url">uraraworks.github.io/Kiriko</div>
`;

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'shell',
  args: ['--no-first-run', '--hide-scrollbars',
    ...(process.env.CI ? ['--no-sandbox'] : [])],
});
const page = await browser.newPage();
await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });
await page.setContent(html, { waitUntil: 'load' });
await page.evaluate(() => document.fonts.ready);
mkdirSync(dirname(OUT), { recursive: true });
await page.screenshot({ path: OUT });
// 共有カード用は軽い方が取り込まれやすいので jpeg も出す（og:image はこちらを指す）
await page.screenshot({ path: OUT_JPG, type: 'jpeg', quality: 92 });
await browser.close();
console.error(`作りました:\n  ${OUT}（GitHub の Social preview 用）\n  ${OUT_JPG}（OGP 用）`);
