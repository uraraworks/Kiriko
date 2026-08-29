// ファイル名の採番ロジック。IndexedDB / File System Access API 無しでテストできるよう、
// nextFreeName() は exists を関数で受け取る形にしてある。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextFreeName } from '../../js/filestore.js';

test('nextFreeName: 空いていればそのまま', async () => {
  const name = await nextFreeName('foo.kiriko', () => false);
  assert.equal(name, 'foo.kiriko');
});

test('nextFreeName: ふさがっていれば -2 から探す', async () => {
  const taken = new Set(['foo.kiriko']);
  const name = await nextFreeName('foo.kiriko', (n) => taken.has(n));
  assert.equal(name, 'foo-2.kiriko');
});

test('nextFreeName: -2 もふさがっていれば -3 へ', async () => {
  const taken = new Set(['foo.kiriko', 'foo-2.kiriko']);
  const name = await nextFreeName('foo.kiriko', (n) => taken.has(n));
  assert.equal(name, 'foo-3.kiriko');
});

test('nextFreeName: exists が Promise を返しても動く', async () => {
  const taken = new Set(['foo.kiriko', 'foo-2.kiriko']);
  const name = await nextFreeName('foo.kiriko', async (n) => taken.has(n));
  assert.equal(name, 'foo-3.kiriko');
});

test('nextFreeName: 拡張子が無い名前でも動く', async () => {
  const taken = new Set(['foo']);
  const name = await nextFreeName('foo', (n) => taken.has(n));
  assert.equal(name, 'foo-2');
});
