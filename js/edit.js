// edit.js
// タイムライン編集の「時刻の計算」だけを切り出したもの。
// DOM も状態も触らないので、そのままテストできる。
// ここが狂うとテロップや音が映像とずれるため、退行を検出しやすくしておく。

/**
 * ドラッグ中のクリップを、どこへ差し込むか決める。
 *
 * **掴んでいるクリップを抜いた並び**で計算するのが要点。
 * 含んだまま計算すると、入れ替わるたびに長さの配置が変わって答えが反転し、
 * 同じマウス位置で行ったり来たりする（終端側で顕著に出た）。
 *
 * @param {number[]} others 掴んでいるものを除いたクリップの長さ（並び順）
 * @param {number} t 差し込みたいタイムライン秒
 * @returns {number} others の何番目の前に入れるか（0〜others.length）
 */
export function dropIndex(others, t) {
  let acc = 0;
  for (let i = 0; i < others.length; i++) {
    if (t < acc + others[i] / 2) return i;   // その枠の前半に居るなら手前へ
    acc += others[i];
  }
  return others.length;   // どれより後ろなら末尾
}

/**
 * [a, b) を切り取って詰めた後の時刻。
 * 範囲の中に居たものは a に潰れる（呼び出し側で長さ 0 のものを捨てる）。
 */
export function rippleTime(v, a, b) {
  if (v >= b) return v - (b - a);
  if (v > a) return a;
  return v;
}

/** 時刻 t に len 秒の隙間を空けた後の時刻 */
export function insertTime(v, t, len) {
  return v >= t ? v + len : v;
}

/**
 * クリップの端をドラッグして長さが変わった時、
 * 後ろのものを動かす境目と量を求める。
 *
 * @param {'in'|'out'} side どちらの端を掴んだか
 * @param {number} startSec そのクリップのタイムライン開始秒
 * @param {number} before 変更前の長さ
 * @param {number} after 変更後の長さ
 * @returns {{edge:number, delta:number}} delta<0 なら詰める、>0 なら空ける
 */
export function trimShift(side, startSec, before, after) {
  const delta = after - before;
  // 頭を削った時はクリップの先頭、後ろを削った時は短い方の終わりが境目
  const edge = side === 'in' ? startSec : startSec + Math.min(before, after);
  return { edge, delta };
}
