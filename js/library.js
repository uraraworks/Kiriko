// library.js
// テロップセットのライブラリ。
//
// プロジェクトをまたいで使い回せるよう、ブラウザに保存する（IndexedDB）。
// 背景画像とアイコンも一緒に入れるので、素材の無い別プロジェクトでもそのまま出せる。
// localStorage だと 5MB 前後で画像が入りきらないため IndexedDB を使う。

const DB_NAME = 'kiriko';
const DB_VERSION = 1;
const STORE = 'telopSets';

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(db, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(req?.result);
    t.onerror = () => reject(t.error);
  });
}

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
