// fontname.js
// フォントファイル（sfnt）の name テーブルから、書体名を取り出す。
//
// Local Font Access API が返すのは英語名だけなので、日本語名は自分で読むしかない。
// Keynote などが「ヒラギノ角ゴシック」と出せるのは、フォント自身が日本語名を
// 持っているため（name テーブルの言語別レコード）。
//
// ファイル全体は読まない。ヘッダを少し読んで name テーブルの位置を求め、
// そこだけ切り出して読む（フォントは 1 つ数 MB あり、数百個あるため）。

const U16 = (v, o) => v.getUint16(o);
const U32 = (v, o) => v.getUint32(o);

/** ヘッダを読むのに要るバイト数（テーブル数が分かるまでは仮）*/
export const HEADER_PROBE = 12;

/**
 * sfnt ヘッダから、テーブル一覧を読むのに必要な長さを返す。
 * TrueType Collection (ttcf) は先頭のフォントを見る。
 * @returns {{ start:number, need:number }|null} start = そのフォントの先頭位置
 */
export function headerPlan(probe) {
  const v = new DataView(probe);
  if (v.byteLength < 12) return null;
  const tag = U32(v, 0);
  if (tag === 0x74746366) {          // 'ttcf'
    // 先頭フォントの位置は 12 バイト目から。もう少し読む必要がある
    return { start: -1, need: 16 };
  }
  const numTables = U16(v, 4);
  return { start: 0, need: 12 + numTables * 16 };
}

/** ttcf の先頭フォントの位置 */
export function firstFontOffset(probe16) {
  const v = new DataView(probe16);
  return U32(v, 12);
}

/**
 * テーブル一覧から name テーブルの位置を探す。
 *
 * 返す offset は**ファイル先頭からの絶対位置**。
 * TrueType Collection でも、テーブル一覧に入っている値は絶対位置なので、
 * フォントの開始位置を足してはいけない（足すと読み先がずれて名前が取れない）。
 *
 * @param {ArrayBuffer} header そのフォントの先頭から 12 + 16*numTables バイト
 */
export function findNameTable(header) {
  const v = new DataView(header);
  const numTables = U16(v, 4);
  for (let i = 0; i < numTables; i++) {
    const o = 12 + i * 16;
    if (o + 16 > v.byteLength) break;
    if (U32(v, o) === 0x6e616d65) {   // 'name'
      return { offset: U32(v, o + 8), length: U32(v, o + 12) };
    }
  }
  return null;
}

const decode = (bytes, platformID, encodingID) => {
  try {
    if (platformID === 3 || platformID === 0) return new TextDecoder('utf-16be').decode(bytes);
    if (platformID === 1 && encodingID === 1) return new TextDecoder('shift_jis').decode(bytes);
    return new TextDecoder('macintosh').decode(bytes);
  } catch {
    return new TextDecoder().decode(bytes);
  }
};

const isJa = (platformID, languageID) =>
  (platformID === 3 && languageID === 0x0411) || (platformID === 1 && languageID === 11);

/**
 * name テーブルから書体名を取り出す。
 * nameID 16（推奨ファミリ名）を 1（ファミリ名）より優先する。
 * @param {ArrayBuffer} table name テーブルそのもの
 * @returns {{ ja: string|null, en: string|null }}
 */
export function readFamilyNames(table) {
  const v = new DataView(table);
  if (v.byteLength < 6) return { ja: null, en: null };
  const count = U16(v, 2);
  const stringOffset = U16(v, 4);
  const best = { ja: null, en: null };
  const rank = { ja: -1, en: -1 };

  for (let i = 0; i < count; i++) {
    const o = 6 + i * 12;
    if (o + 12 > v.byteLength) break;
    const platformID = U16(v, o), encodingID = U16(v, o + 2);
    const languageID = U16(v, o + 4), nameID = U16(v, o + 6);
    if (nameID !== 1 && nameID !== 16) continue;
    const len = U16(v, o + 8), off = stringOffset + U16(v, o + 10);
    if (off + len > v.byteLength) continue;

    const key = isJa(platformID, languageID) ? 'ja' : 'en';
    const score = nameID === 16 ? 2 : 1;      // 推奨ファミリ名の方が良い
    if (score <= rank[key]) continue;
    const name = decode(new Uint8Array(table, off, len), platformID, encodingID).replace(/\0/g, '').trim();
    if (!name) continue;
    best[key] = name;
    rank[key] = score;
  }
  return best;
}
