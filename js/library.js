// library.js
// テロップセットのライブラリ。
//
// プロジェクトをまたいで使い回せるよう、ブラウザに保存する（IndexedDB）。
// 背景画像とアイコンも一緒に入れるので、素材の無い別プロジェクトでもそのまま出せる。
// localStorage だと 5MB 前後で画像が入りきらないため IndexedDB を使う。
// データベースの開き方は js/db.js に一本化している。

import { openDB, withStore, STORE } from './db.js';

const open = openDB;
const tx = (db, mode, fn) => withStore(db, STORE.telopSets, mode, fn);

export async function listSets() {
  const db = await open();
  const all = await tx(db, 'readonly', (st) => st.getAll());
  db.close();
  return (all ?? []).sort((a, b) => b.savedAt - a.savedAt);
}

export async function putSet(entry) {
  const db = await open();
  await tx(db, 'readwrite', (st) => st.put(entry));
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
 * ライブラリ全体を 1 つの JSON にまとめる（画像も dataURL で入っているのでこれだけで完結する）。
 * 保存先はブラウザの中（オリジンごと）なので、別のブラウザや公開版へ移す時に使う。
 */
export async function exportAll() {
  const sets = await listSets();
  return JSON.stringify({ kind: 'kiriko.telopLibrary', version: 1, savedAt: Date.now(), sets }, null, 2);
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
    await putSet({
      id: `set_${Date.now().toString(36)}${Math.floor(Math.random() * 46656).toString(36)}${added}`,
      name: String(e.name ?? '無題'),
      savedAt: Number(e.savedAt) || Date.now(),
      telop: e.telop,
      assets: Array.isArray(e.assets) ? e.assets : [],
    });
    added++;
  }
  return { added, skipped };
}

/**
 * 名前でライブラリの中の画像を探す。
 * ライブラリから置いたテロップの画像は、元ファイルが手元に無くてもここから戻せる。
 * @returns {Promise<{name:string, dataUrl:string}|null>}
 */
export async function findAssetByName(name) {
  for (const set of await listSets()) {
    const hit = (set.assets ?? []).find((a) => a.name === name);
    if (hit) return hit;
  }
  return null;
}
