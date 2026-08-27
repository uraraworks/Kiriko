// db.js
// ブラウザに残しておくものの置き場（IndexedDB）。
// テロップライブラリとファイルハンドルで同じデータベースを使うので、
// 開き方（バージョンとストアの作成）はここに一本化する。
// 別々のバージョンで開くと VersionError になるため。

const DB_NAME = 'kiriko';
const DB_VERSION = 2;

export const STORE = {
  telopSets: 'telopSets',   // テロップセットのライブラリ
  fileHandles: 'fileHandles', // 一度開いたファイルのハンドル
  dirHandles: 'dirHandles',   // 素材の入っているフォルダ
};

export function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE.telopSets)) db.createObjectStore(STORE.telopSets, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(STORE.fileHandles)) db.createObjectStore(STORE.fileHandles);
      if (!db.objectStoreNames.contains(STORE.dirHandles)) db.createObjectStore(STORE.dirHandles);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** 1 トランザクションを張って結果を返す */
export function withStore(db, store, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => resolve(req?.result);
    t.onerror = () => reject(t.error);
  });
}
