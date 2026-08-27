// バージョン文字列を作る純粋関数。git の実行（副作用）は gen-version.mjs 側に置く。
//
// 方針は WebNP2 と同じ:
//  - ビルド時の壁時計は使わない。git の commit 時刻だけを情報源にする。
//    同じコミットからは何度作っても同じ文字列になること。
//  - JST への変換にホストのタイムゾーン設定を使わない（UTC + 固定オフセット）。

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const pad2 = (n) => String(n).padStart(2, '0');

/**
 * @param {number} commitTsSec commit 時刻（unix 秒）
 * @param {string} shortHash   git rev-parse --short=7 HEAD
 * @param {boolean} dirty      作業ツリーが汚れているか
 */
export function formatVersion(commitTsSec, shortHash, dirty) {
  const jst = new Date(commitTsSec * 1000 + JST_OFFSET_MS);
  const y = jst.getUTCFullYear();
  const mo = pad2(jst.getUTCMonth() + 1);
  const d = pad2(jst.getUTCDate());
  const h = pad2(jst.getUTCHours());
  const mi = pad2(jst.getUTCMinutes());
  const hash = dirty ? `${shortHash}+` : shortHash;
  return {
    footer: `Kiriko ${y}-${mo}-${d} ${h}:${mi} JST (${hash})`,
    buildId: dirty ? `${shortHash}-dirty` : shortHash,
  };
}

/** git を読めなかった時。もっともらしい値で埋めず、分からないと分かる形にする */
export const UNKNOWN_VERSION = {
  footer: 'Kiriko (version unknown)',
  buildId: 'unknown',
};
