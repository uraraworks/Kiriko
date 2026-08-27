// filestore.js
// 一度開いたファイル／フォルダの「ハンドル」を覚えておく置き場（IndexedDB）。
//
// ブラウザはファイルのパスを持てないが、File System Access API のハンドルは
// IndexedDB に保存できる。次に開いた時は、そのハンドルから読み直せる。
//
//  - ファイルハンドル … 名前で引く。一度開いた素材はそのまま復帰できる
//  - フォルダハンドル … 中を名前で探す。フォルダを 1 回選べば、その中の素材は全部読める
//
// 読み取りの許可はブラウザが管理する。許可が切れている時は requestPermission が要り、
// これは「ユーザーの操作の直後」でないと通らないので、ボタンから呼ぶこと。

import { openDB, withStore, STORE } from './db.js';

const open = openDB;
const FILES = STORE.fileHandles;
const DIRS = STORE.dirHandles;
const tx = (db, store, mode, fn) => withStore(db, store, mode, fn);

/** 開いたファイルのハンドルを覚える（名前で引く） */
export async function rememberFile(name, handle) {
  if (!handle) return;
  const db = await open();
  await tx(db, FILES, 'readwrite', (st) => st.put(handle, name));
  db.close();
}

/** 素材の入っているフォルダを覚える */
export async function rememberDir(handle) {
  if (!handle) return;
  const db = await open();
  await tx(db, DIRS, 'readwrite', (st) => st.put(handle, handle.name));
  db.close();
}

export async function listDirs() {
  const db = await open();
  const all = await tx(db, DIRS, 'readonly', (st) => st.getAll());
  db.close();
  return all ?? [];
}

async function getFileHandle(name) {
  const db = await open();
  const h = await tx(db, FILES, 'readonly', (st) => st.get(name));
  db.close();
  return h ?? null;
}

const can = async (h, mode = 'read') => (await h.queryPermission?.({ mode })) === 'granted';

/**
 * 名前からファイルを取り戻す。
 * @param {string} name
 * @param {boolean} ask 許可が無い時に尋ねてよいか（ユーザー操作の直後だけ true にする）
 * @returns {Promise<File|null>}
 */
export async function resolveFile(name, ask = false) {
  // ① 直接そのファイルのハンドルを覚えている
  const h = await getFileHandle(name);
  if (h) {
    const f = await useHandle(h, ask);
    if (f) return f;
  }
  // ② 覚えているフォルダの中から探す（直下 → 1 階層下）
  for (const dir of await listDirs()) {
    if (!(await can(dir)) && !(ask && await request(dir))) continue;
    const f = await findInDir(dir, name, 1);
    if (f) {
      await rememberFile(name, f.handle);
      return f.file;
    }
  }
  return null;
}

async function useHandle(h, ask) {
  try {
    if (!(await can(h)) && !(ask && await request(h))) return null;
    return await h.getFile();
  } catch {
    return null;   // 移動・削除された等
  }
}

async function request(h) {
  try { return (await h.requestPermission?.({ mode: 'read' })) === 'granted'; } catch { return false; }
}

async function findInDir(dir, name, depth) {
  try {
    for await (const [key, entry] of dir.entries()) {
      if (entry.kind === 'file' && key === name) return { file: await entry.getFile(), handle: entry };
    }
    if (depth > 0) {
      for await (const [, entry] of dir.entries()) {
        if (entry.kind !== 'directory') continue;
        const hit = await findInDir(entry, name, depth - 1);
        if (hit) return hit;
      }
    }
  } catch { /* 許可が無い等 */ }
  return null;
}

/** 覚えているものを全部忘れる */
export async function forgetAll() {
  const db = await open();
  await tx(db, FILES, 'readwrite', (st) => st.clear());
  await tx(db, DIRS, 'readwrite', (st) => st.clear());
  db.close();
}

export const isSupported = () => 'showOpenFilePicker' in window;
