#!/usr/bin/env node
// push の前に軽いテスト（単体＋静的検査）を通す git フックを入れる。
//
//   npm run hooks:install
//
// 数秒で終わるものだけにしてある。ブラウザを起動する結合テストは
// npm run test:e2e で手動、または GitHub Actions のデプロイ前に回す。
import { writeFileSync, readFileSync, chmodSync, existsSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const dir = execFileSync('git', ['rev-parse', '--git-path', 'hooks']).toString().trim();
mkdirSync(dir, { recursive: true });
const path = join(dir, 'pre-push');

const body = `#!/bin/sh
# Kiriko: push の前に単体テストと静的検査を通す（npm run hooks:install が作る）
# 急ぐときは git push --no-verify で飛ばせる
exec npm test --silent
`;

if (existsSync(path)) {
  const cur = readFileSync(path, 'utf8');
  if (!cur.includes('Kiriko')) {
    console.error(`既に別の pre-push があります: ${path}`);
    console.error('中身を確認して、手で足してください。');
    process.exit(1);
  }
}
writeFileSync(path, body);
chmodSync(path, 0o755);
console.error(`入れました: ${path}`);
