// library.js
// テロップセットのライブラリ。
//
// プロジェクトをまたいで使い回せるよう、ブラウザに保存する（IndexedDB）。
// 背景画像とアイコンも一緒に入れるので、素材の無い別プロジェクトでもそのまま出せる。
// localStorage だと 5MB 前後で画像が入りきらないため IndexedDB を使う。
// データベースの開き方は js/db.js に一本化している。

import { openDB, withStore, STORE } from './db.js';
import * as FS from './filestore.js';

const open = openDB;
const tx = (db, mode, fn) => withStore(db, STORE.telopSets, mode, fn);

/**
 * 一覧の並び。
 * 手で並べ替えた順（order）を優先し、まだ並べ替えていないものは保存日時の新しい順。
 * order を持つものと持たないものが混ざるのは、並べ替える前に保存したセットがあるため。
 */
export function sortSets(sets) {
  return [...(sets ?? [])].sort((a, b) => {
    const ao = a.order ?? null, bo = b.order ?? null;
    if (ao !== null && bo !== null) return ao - bo;
    if (ao !== null) return -1;     // 並べ替え済みのものが先
    if (bo !== null) return 1;
    return b.savedAt - a.savedAt;
  });
}

/** 新しく保存するセットを先頭に置くための order */
export function headOrder(sets) {
  const min = Math.min(...(sets ?? []).map((e) => e.order ?? 0), 0);
  return min - 1;
}

export async function listSets() {
  const db = await open();
  const all = await tx(db, 'readonly', (st) => st.getAll());
  db.close();
  return sortSets(all);
}

export async function putSet(entry) {
  const db = await open();
  await tx(db, 'readwrite', (st) => st.put(entry));
  db.close();
}

/** 1 件だけ書き換える（名前の変更など）。見つからなければ何もしない */
export async function updateSet(id, patch) {
  const db = await open();
  const cur = await tx(db, 'readonly', (st) => st.get(id));
  if (cur) await tx(db, 'readwrite', (st) => st.put({ ...cur, ...patch, id }));
  db.close();
  return !!cur;
}

/** 渡された id の並びで order を振り直す。一覧に出ていないものは触らない */
export async function reorderSets(ids) {
  const db = await open();
  const all = await tx(db, 'readonly', (st) => st.getAll());
  const rank = new Map(ids.map((id, i) => [id, i]));
  for (const e of all ?? []) {
    const i = rank.get(e.id);
    if (i !== undefined && e.order !== i) await tx(db, 'readwrite', (st) => st.put({ ...e, order: i }));
  }
  db.close();
}

export async function deleteSet(id) {
  const db = await open();
  await tx(db, 'readwrite', (st) => st.delete(id));
  db.close();
}

/** ImageBitmap を PNG の dataURL にする（保存用） */
export async function bitmapToDataURL(bmp) {
  const cv = new OffscreenCanvas(bmp.width, bmp.height);
  cv.getContext('2d').drawImage(bmp, 0, 0);
  const blob = await cv.convertToBlob({ type: 'image/png' });
  return await new Promise((res) => {
    const fr = new FileReader();
    fr.onload = () => res(fr.result);
    fr.readAsDataURL(blob);
  });
}

/**
 * セットの画像 1 件をファイルとして取り出す。
 *  - ライブラリフォルダに実ファイルがあればそれを読む（IndexedDB を軽くできる）
 *  - 昔のセットや、フォルダ未設定のときに保存したものは dataURL から戻す
 * @returns {Promise<File|null>}
 */
export async function assetToFile(a) {
  if (!a) return null;
  if (a.file) {
    const dir = await FS.getLibDir().catch(() => null);
    if (dir) {
      const f = await FS.readFile(dir, a.name);
      if (f) return f;
    }
  }
  if (a.dataUrl) return await dataURLToFile(a.dataUrl, a.name);
  return null;
}

/**
 * 画像をライブラリフォルダに置く。置けたら true。
 * 同じ名前のものがあればそのまま使う（同じ画像とみなす）。
 */
export async function stashAsset(name, blob) {
  const dir = await FS.getLibDir().catch(() => null);
  if (!dir) return false;
  if (await FS.hasFile(dir, name)) return true;
  return await FS.writeFile(dir, name, blob);
}

/** ImageBitmap を PNG の Blob にする */
export async function bitmapToBlob(bmp) {
  const cv = new OffscreenCanvas(bmp.width, bmp.height);
  cv.getContext('2d').drawImage(bmp, 0, 0);
  return await cv.convertToBlob({ type: 'image/png' });
}

export async function dataURLToFile(dataUrl, name) {
  const blob = await (await fetch(dataUrl)).blob();
  return new File([blob], name, { type: blob.type || 'image/png' });
}

/** 一覧に出す見出し（先頭の行のテキスト） */
export function setLabel(entry) {
  const rows = entry.telop?.rows ?? [];
  const t = rows.map((r) => r.text).filter(Boolean).join(' / ').replace(/\n/g, ' ');
  return t || '（文字なし）';
}

/**
 * ライブラリ全体を 1 つの JSON にまとめる。
 * 保存先はブラウザの中（オリジンごと）なので、別のブラウザや公開版へ移す時に使う。
 *
 * @param {boolean} embed 画像を dataURL で埋め込むか。
 *   false（既定）… ライブラリフォルダに実ファイルがある画像は名前だけ書く。ファイルは小さいが、
 *                   別の PC へ移す時はライブラリフォルダも一緒に持っていく必要がある
 *   true          … 画像も全部埋め込む。これ 1 つで完結するが大きくなる
 */
export async function exportAll(embed = false) {
  const sets = await listSets();
  if (!embed) {
    return JSON.stringify({ kind: 'kiriko.telopLibrary', version: 1, savedAt: Date.now(), sets }, null, 2);
  }
  const full = [];
  for (const set of sets) {
    const assets = [];
    for (const a of set.assets ?? []) {
      if (a.dataUrl) { assets.push(a); continue; }
      const f = await assetToFile(a);
      assets.push(f ? { ...a, dataUrl: await blobToDataURL(f) } : a);
    }
    full.push({ ...set, assets });
  }
  return JSON.stringify({ kind: 'kiriko.telopLibrary', version: 1, savedAt: Date.now(), sets: full }, null, 2);
}

function blobToDataURL(blob) {
  return new Promise((res) => {
    const fr = new FileReader();
    fr.onload = () => res(fr.result);
    fr.readAsDataURL(blob);
  });
}

/**
 * 書き出した JSON を取り込む。
 * @param {string} text
 * @param {boolean} replace true なら今あるものを消してから入れる
 * @returns {Promise<{added:number, skipped:number}>}
 */
export async function importAll(text, replace = false) {
  let data;
  try { data = JSON.parse(text); } catch { throw new Error('ファイルの形式が違います'); }
  const sets = Array.isArray(data) ? data : data.sets;
  if (!Array.isArray(sets)) throw new Error('テロップライブラリのファイルではないようです');

  const current = await listSets();
  if (replace) for (const e of current) await deleteSet(e.id);

  const have = new Set(replace ? [] : current.map((e) => `${e.name}:${setLabel(e)}`));
  let added = 0, skipped = 0;
  for (const e of sets) {
    if (!e?.telop?.rows) { skipped++; continue; }
    const key = `${e.name}:${setLabel(e)}`;
    if (have.has(key)) { skipped++; continue; }   // 同じ名前・同じ中身は入れ直さない
    have.add(key);
    // 画像が埋め込まれていて、ライブラリフォルダがあるなら実ファイルに移す
    // （IndexedDB を膨らませない）
    const assets = [];
    for (const a of Array.isArray(e.assets) ? e.assets : []) {
      if (a?.dataUrl && await stashAsset(a.name, await (await fetch(a.dataUrl)).blob())) {
        const { dataUrl, ...rest } = a;
        assets.push({ ...rest, file: true });
      } else if (a) {
        assets.push(a);
      }
    }
    await putSet({
      id: `set_${Date.now().toString(36)}${Math.floor(Math.random() * 46656).toString(36)}${added}`,
      name: String(e.name ?? '無題'),
      savedAt: Number(e.savedAt) || Date.now(),
      telop: e.telop,
      assets,
    });
    added++;
  }
  return { added, skipped };
}

/**
 * 名前でライブラリの中の画像を探す。
 * ライブラリから置いたテロップの画像は、元ファイルが手元に無くてもここから戻せる。
 * 中身の取り出しは assetToFile に渡すこと。
 * @returns {Promise<{name:string, dataUrl?:string, file?:boolean}|null>}
 */
export async function findAssetByName(name) {
  for (const set of await listSets()) {
    const hit = (set.assets ?? []).find((a) => a.name === name);
    if (hit) return hit;
  }
  return null;
}
