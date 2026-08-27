#!/usr/bin/env node
// js/version.js を作る。git の commit 時刻とハッシュから決まるので、
// 同じコミットからは何度実行しても同じ内容になる。
//
//   node scripts/gen-version.mjs
//
// 生成物は git 管理しない（自分をコミットすると tree が変わって値がずれるため）。
// 公開時は GitHub Actions でデプロイ前に実行する。

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { formatVersion, UNKNOWN_VERSION } from '../tools/version.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const git = (args) => execFileSync('git', args, { cwd: root }).toString().trim();

let v;
try {
  v = formatVersion(Number(git(['log', '-1', '--format=%ct'])), git(['rev-parse', '--short=7', 'HEAD']),
    git(['status', '--porcelain']) !== '');
} catch {
  v = UNKNOWN_VERSION;
}

writeFileSync(join(root, 'js/version.js'),
  `// scripts/gen-version.mjs が作る。手で編集しない。\n`
  + `export const VERSION_FOOTER = ${JSON.stringify(v.footer)};\n`
  + `export const BUILD_ID = ${JSON.stringify(v.buildId)};\n`);
console.error(v.footer);
