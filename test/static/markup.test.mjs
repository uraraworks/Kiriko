// HTML / CSS / ドキュメントの静的検査。
// ビルドが無いぶん、壊れても実行するまで気付けない類の間違いをここで拾う。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const PAGES = ['index.html', 'help.html', 'about.html'];
const all = (re, s) => [...s.matchAll(re)].map((m) => m[1]);

// id が重複すると getElementById は最初の 1 つしか返さない。
// 実際に「プレビュー用 canvas と書き出しダイアログが同じ id」で、
// ダイアログが一度も表示されないまま気付かなかった。
test('ページの中に同じ id が 2 つ以上ない', () => {
  for (const page of PAGES) {
    const ids = all(/\bid="([^"]+)"/g, read(page));
    const dup = ids.filter((v, i) => ids.indexOf(v) !== i);
    assert.deepEqual([...new Set(dup)], [], `${page} で id が重複している`);
  }
});

test('$(...) で引く id が index.html か js の生成物に存在する', () => {
  const html = read('index.html');
  const known = new Set(all(/\bid="([^"]+)"/g, html));
  // 動的に組み立てている要素の id も拾う
  for (const f of ['main.js']) for (const id of all(/\bid="([a-zA-Z0-9_-]+)"/g, read(`js/${f}`))) known.add(id);

  const src = read('js/main.js');
  const used = new Set([
    ...all(/\$\('([a-zA-Z0-9_-]+)'\)/g, src),
    ...all(/getElementById\('([a-zA-Z0-9_-]+)'\)/g, src),
  ]);
  const missing = [...used].filter((id) => !known.has(id));
  assert.deepEqual(missing, [], '存在しない id を引いている');
});

test('使っていない id が index.html に残っていない', () => {
  const html = read('index.html');
  // JS・CSS からの参照に加えて、ページ内の href="#..."（SVG アイコンなど）も参照とみなす
  const src = read('js/main.js') + read('css/app.css') + all(/href="#([^"]+)"/g, html).join(' ');
  const unused = all(/\bid="([^"]+)"/g, html).filter((id) => !src.includes(id));
  assert.deepEqual(unused, [], 'どこからも参照されない id');
});

test('SVG アイコンの参照先が同じページにある', () => {
  for (const page of PAGES) {
    const s = read(page);
    const defined = new Set(all(/<symbol\s+id="([^"]+)"/g, s));
    for (const ref of new Set(all(/<use\s+href="#([^"]+)"/g, s))) {
      assert.ok(defined.has(ref), `${page}: #${ref} という symbol が無い`);
    }
  }
});

test('ページが読むローカルファイルが実在する', () => {
  for (const page of PAGES) {
    const s = read(page);
    const refs = [
      ...all(/<img[^>]+src="([^"]+)"/g, s),
      ...all(/<link[^>]+href="([^"]+)"/g, s),
      ...all(/<script[^>]+src="([^"]+)"/g, s),
      ...all(/<a[^>]+href="([^"]+)"/g, s),
    ];
    for (const r of refs) {
      if (/^(https?:|mailto:|#|data:)/.test(r)) continue;
      const p = r.split('#')[0].split('?')[0];
      if (!p) continue;
      assert.ok(existsSync(join(ROOT, p)), `${page} → ${r} が無い`);
    }
  }
});

test('css で使う変数が定義されている', () => {
  // 実行時に JS が入れるものもある（例: タイムラインの高さ）
  const fromJs = new Set(all(/setProperty\('(--[a-z0-9-]+)'/g, read('js/main.js')));
  for (const f of ['css/app.css', 'css/doc.css']) {
    const s = read(f);
    const defined = new Set([...all(/(--[a-z0-9-]+)\s*:/g, s), ...fromJs]);
    // var(--x, 既定値) は未定義でも成立するので対象外
    const used = new Set(all(/var\((--[a-z0-9-]+)\s*\)/g, s));
    const missing = [...used].filter((v) => !defined.has(v));
    assert.deepEqual(missing, [], `${f} で未定義の変数を使っている`);
  }
});

test('js の import 先がすべて実在する', () => {
  const files = ['main.js', 'compose.js', 'exporter.js', 'telop.js', 'library.js',
                 'filestore.js', 'commands.js', 'bridge.js', 'edit.js'];
  for (const f of files) {
    for (const spec of all(/from\s+'(\.[^']+)'/g, read(`js/${f}`))) {
      const p = normalize(join('js', spec));
      // version.js は gen-version.mjs が作る（git 管理外）
      if (p.endsWith('version.js')) continue;
      assert.ok(existsSync(join(ROOT, p)), `js/${f} → ${spec} が無い`);
    }
  }
});

test('ドキュメントの相対リンクが実在する', () => {
  for (const f of ['README.md', 'docs/DESIGN.md', 'docs/AUTOMATION.md', 'mcp/README.md']) {
    const base = dirname(f);
    for (const [, , target] of read(f).matchAll(/\[([^\]]+)\]\(([^)]+)\)/g)) {
      if (/^(https?:|mailto:|#)/.test(target)) continue;
      const p = target.split('#')[0];
      if (!p) continue;
      assert.ok(existsSync(join(ROOT, base, p)), `${f} → ${target} が無い`);
    }
  }
});

test('使い方ページの画面写真がそろっている', () => {
  const used = all(/<img[^>]+src="(public\/help\/[^"]+)"/g, read('help.html'));
  assert.ok(used.length >= 5, `スクショが少なすぎる: ${used.length}`);
  for (const p of used) assert.ok(existsSync(join(ROOT, p)), `${p} が無い`);
});

test('package.json の scripts が指すファイルが実在する', () => {
  const pkg = JSON.parse(read('package.json'));
  for (const [name, cmd] of Object.entries(pkg.scripts)) {
    for (const m of cmd.matchAll(/\b((?:scripts|tools|test)\/[\w./-]+)/g)) {
      assert.ok(existsSync(join(ROOT, m[1])), `scripts.${name} → ${m[1]} が無い`);
    }
  }
});
