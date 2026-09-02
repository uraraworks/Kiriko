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

// 作業フォルダ（VSCode でいう「開いているフォルダ」）。
// プロジェクトも素材もここに置く前提にすると、許可 1 回で全部つながる。
const WORK = '__work__';

/** 作業フォルダを覚える */
export async function setWorkDir(handle) {
  if (!handle) return;
  const db = await open();
  await tx(db, DIRS, 'readwrite', (st) => st.put(handle, WORK));
  db.close();
}

// テロップライブラリの画像を置くフォルダ。
// IndexedDB に画像を丸ごと（dataURL で）抱えると重くなるので、
// 実ファイルはここに置いて、ライブラリからは名前で参照する。
const LIB = '__lib__';

/** ライブラリフォルダを覚える */
export async function setLibDir(handle) {
  if (!handle) return;
  const db = await open();
  await tx(db, DIRS, 'readwrite', (st) => st.put(handle, LIB));
  db.close();
}

/** 覚えているライブラリフォルダ（無ければ null） */
export async function getLibDir() {
  const db = await open();
  const h = await tx(db, DIRS, 'readonly', (st) => st.get(LIB));
  db.close();
  return h ?? null;
}

/** ライブラリフォルダから 1 ファイル読む */
export async function readFile(dir, name) {
  try { return await (await dir.getFileHandle(name)).getFile(); } catch { return null; }
}

/**
 * 作業フォルダだけを忘れる（`__work__` キーだけ消す）。
 * useWorkFolder() は setWorkDir() と rememberDir() の両方を呼ぶので、同じフォルダの
 * ハンドルが `__work__` と「フォルダ名」の 2 つのキーで DIRS に入っている。
 * ここで消すのは `__work__` だけで、フォルダ名の方はあえて残す。素材の探し先
 * （listDirs / resolveFile）としては生きていてほしいので、道連れにしない。
 */
export async function forgetWorkDir() {
  const db = await open();
  await tx(db, DIRS, 'readwrite', (st) => st.delete(WORK));
  db.close();
}

/** 覚えている作業フォルダ（無ければ null） */
export async function getWorkDir() {
  const db = await open();
  const h = await tx(db, DIRS, 'readonly', (st) => st.get(WORK));
  db.close();
  return h ?? null;
}

/** 作業フォルダを先頭にした、素材を探すフォルダの一覧 */
export async function listDirs() {
  const db = await open();
  const all = (await tx(db, DIRS, 'readonly', (st) => st.getAll())) ?? [];
  const work = await tx(db, DIRS, 'readonly', (st) => st.get(WORK));
  db.close();
  // 作業フォルダを最優先で探す（同じ名前の素材が複数あっても、手元のものが勝つ）
  if (!work) return all;
  return [work, ...all.filter((d) => d !== work)];
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
  // ② 覚えているフォルダの中から探す（直下 → 3 階層下まで）。
  // 素材フォルダの下にさらにサブフォルダを掘って整理しているケースがあるため、
  // 1 階層下だけでは届かないことがある
  for (const dir of await listDirs()) {
    if (!(await can(dir)) && !(ask && await request(dir))) continue;
    const f = await findInDir(dir, name, 3);
    if (f) {
      await rememberFile(name, f.handle);
      return f.file;
    }
  }
  return null;
}

/**
 * 必要な素材の許可を、ユーザー操作の直後に 1 回でまとめて取っておく。
 *
 * requestPermission は「transient user activation」（クリックなどの直後）が無いと
 * 通らない仕様で、動画のデコードなどに時間がかかった後でこっそり呼ぶと、
 * ダイアログすら出ずに黙って拒否される。なので resolveFile を1件ずつ呼ぶ前に、
 * ボタンが押された直後のこの関数でまとめて await しておく。
 * @param {string[]} names 読み直したいファイル名
 */
export async function ensureAccess(names = []) {
  // フォルダを先に処理する（フォルダを 1 つ許可すれば、中の素材は全部読めるようになるため）
  for (const dir of await listDirs()) {
    if (!(await can(dir))) await request(dir);
  }
  // 直接ファイルハンドルを覚えているものは、フォルダの許可だけではカバーできないので個別に
  for (const name of names) {
    const h = await getFileHandle(name);
    if (h && !(await can(h))) await request(h);
  }
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

// ---------------------------------------------------------------- 書き込み

/**
 * 書き込みできるフォルダを返す（覚えているものの中から）。
 * ライブラリの画像をプロジェクトのフォルダへ置くのに使う。
 */
export async function writableDir() {
  const work = await getWorkDir();
  if (work && (await work.queryPermission?.({ mode: 'readwrite' })) === 'granted') return work;
  for (const dir of await listDirs()) {
    if ((await dir.queryPermission?.({ mode: 'readwrite' })) === 'granted') return dir;
  }
  return null;
}

/** そのフォルダに同じ名前のファイルがあるか */
export async function hasFile(dir, name) {
  try { await dir.getFileHandle(name); return true; } catch { return false; }
}

/**
 * 同名のファイルが無い名前を探す（"foo.kiriko" → "foo-2.kiriko" → "foo-3.kiriko" …）。
 * `exists(name)` を差し替えれば IndexedDB / File System Access API 無しでもテストできる。
 * @param {string} name
 * @param {(name: string) => boolean | Promise<boolean>} exists
 * @returns {Promise<string>}
 */
export async function nextFreeName(name, exists) {
  if (!(await exists(name))) return name;
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let i = 2; ; i++) {
    const cand = `${base}-${i}${ext}`;
    if (!(await exists(cand))) return cand;
  }
}

/**
 * フォルダにファイルを書く。書けたらハンドルも覚える。
 * @returns {Promise<boolean>} 書けたか
 */
export async function writeFile(dir, name, blob) {
  try {
    const h = await dir.getFileHandle(name, { create: true });
    const w = await h.createWritable();
    await w.write(blob);
    await w.close();
    await rememberFile(name, h);
    return true;
  } catch {
    return false;
  }
}
