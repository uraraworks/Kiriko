// findInDir() のフォルダ探索。File System Access API の DirectoryHandle っぽい
// オブジェクト（entries() を持つだけの偽物）を組み立てて、Node 上でも動作を確認する。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findInDir } from '../../js/filestore.js';

// name: entry.kind === 'file' ならファイル名、ディレクトリなら子の entries を渡す
function fakeFile(name) {
  return { kind: 'file', name, async getFile() { return { name }; } };
}

function fakeDir(name, children) {
  return {
    kind: 'directory',
    name,
    async *entries() {
      for (const child of children) {
        if (child.throwOnEnumerate) throw new Error(`enum error: ${name}`);
        yield [child.name, child];
      }
    },
  };
}

// 列挙の途中で例外を投げる「壊れたエントリ」（macOS の .key パッケージ等を模す）
function throwingEntry(name) {
  return { name, get kind() { throw new Error(`broken entry: ${name}`); } };
}

test('findInDir: 途中のエントリが throw しても後続の兄弟フォルダから見つけられる', async () => {
  const target = fakeFile('bgm.mp3');
  const sound = fakeDir('効果音', [target]);
  const broken = throwingEntry('テロップ.key');
  // 列挙順で壊れたエントリの方が先に来るケース
  const root = fakeDir('root', [broken, sound]);

  const hit = await findInDir(root, 'bgm.mp3', 3);
  assert.ok(hit);
  assert.equal(hit.file.name, 'bgm.mp3');
});

test('findInDir: 目的のファイルが depth 内のサブフォルダにある時に見つかる', async () => {
  const target = fakeFile('clip.mp4');
  const deep = fakeDir('深い', [target]);
  const mid = fakeDir('中間', [deep]);
  const root = fakeDir('root', [mid]);

  const hit = await findInDir(root, 'clip.mp4', 2);
  assert.ok(hit);
  assert.equal(hit.file.name, 'clip.mp4');
});

test('findInDir: depth を超えた深さにある時は見つからない', async () => {
  const target = fakeFile('clip.mp4');
  const deep = fakeDir('深い', [target]);
  const mid = fakeDir('中間', [deep]);
  const root = fakeDir('root', [mid]);

  const hit = await findInDir(root, 'clip.mp4', 1);
  assert.equal(hit, null);
});

test('findInDir: 列挙自体が throw する時は null', async () => {
  const root = {
    kind: 'directory',
    name: 'root',
    async *entries() {
      throw new Error('permission denied');
    },
  };

  const hit = await findInDir(root, 'anything', 3);
  assert.equal(hit, null);
});

test('findInDir: サブフォルダの探索が失敗しても別のサブフォルダから見つけられる', async () => {
  const target = fakeFile('found.txt');
  const okDir = fakeDir('ok', [target]);
  const badDir = {
    kind: 'directory',
    name: 'bad',
    async *entries() {
      throw new Error('このフォルダは読めない');
    },
  };
  const root = fakeDir('root', [badDir, okDir]);

  const hit = await findInDir(root, 'found.txt', 2);
  assert.ok(hit);
  assert.equal(hit.file.name, 'found.txt');
});
