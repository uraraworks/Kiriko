// 実 Chrome で index.html を開いて操作するための土台。
// アプリ側の入口は window.bme（MCP と同じコマンドを通る）。
import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { join, normalize, extname } from 'node:path';
import puppeteer from 'puppeteer-core';
import { ROOT } from './fixtures.mjs';

const CHROME = process.env.CHROME_PATH
  ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
export const haveChrome = () => existsSync(CHROME);

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.mp4': 'video/mp4', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.svg': 'image/svg+xml',
};

/**
 * テスト用の静的サーバー。
 * ポートは OS に空きを選ばせる（テストファイルが並列に走っても取り合わない）。
 */
export function serve() {
  const srv = createServer((req, res) => {
    const rel = normalize(decodeURIComponent(req.url.split('?')[0])).replace(/^(\.\.[/])+/, '');
    const file = join(ROOT, rel === '/' ? 'index.html' : rel);
    if (!file.startsWith(ROOT) || !existsSync(file) || statSync(file).isDirectory()) {
      res.writeHead(404); res.end('not found'); return;
    }
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
    createReadStream(file).pipe(res);
  });
  let base = null;
  return {
    get base() { return base; },
    stop: () => srv.close(),
    ready: async () => {
      await new Promise((r) => srv.listen(0, '127.0.0.1', r));
      base = `http://127.0.0.1:${srv.address().port}`;
      return base;
    },
  };
}

/** ブラウザを開いて、アプリの準備ができた状態のページを返す */
export async function openApp(base) {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'shell',
    args: [
      '--no-first-run', '--hide-scrollbars', '--autoplay-policy=no-user-gesture-required',
      // CI の Linux ランナーは SUID サンドボックスが設定されておらず起動できない。
      // 手元では既定のまま（サンドボックスを効かせたまま）にしておく
      ...(process.env.CI ? ['--no-sandbox', '--disable-dev-shm-usage'] : []),
    ],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 820, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(`${base}/index.html`, { waitUntil: 'load' });
  await page.waitForFunction('!!window.bme', { timeout: 15000 });
  return { browser, page, errors };
}

/**
 * 作業フォルダを開いた状態にする。
 *
 * showDirectoryPicker は本物のユーザー操作が要るので、
 * 置き場所（OPFS のフォルダ）を返すように差し替えて、
 * あとはアプリの［作業フォルダを開く］をそのまま押す。
 * つまりゲートの解除そのものも、この経路で検証されることになる。
 */
export async function passGate(page) {
  await page.evaluate(`(async () => {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle('work', { create: true });
    window.showDirectoryPicker = async () => dir;
    document.getElementById('btnWorkDir').click();
  })()`);
  await page.waitForFunction(`!document.body.classList.contains('no-workdir')`, { timeout: 10000 });
}

/** 素材をドロップして読み込ませる（実際の drop イベントを通す） */
export async function dropFiles(page, paths) {
  await page.evaluate(`(async () => {
    const dt = new DataTransfer();
    for (const p of ${JSON.stringify(paths)}) {
      const b = await (await fetch('/' + p)).blob();
      dt.items.add(new File([b], p.split('/').pop(), { type: b.type }));
    }
    document.getElementById('workspace')
      .dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
  })()`);
}

/** MCP 由来でない、実害のあるエラーだけ残す */
export const realErrors = (errors) =>
  errors.filter((e) => !/127\.0\.0\.1:8910|WebSocket/.test(e));
