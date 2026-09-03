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

/**
 * 「残す区間」から「切る区間」を求める。
 *
 * 書き起こしでセリフに区間マーカーを立て、その外を切る、という使い方が本命。
 * whisper のマーカーはセリフにぴったり張り付くので、pad を入れないと語頭・語尾が欠ける。
 *
 * @param {Array<[number,number]>} keep 残す区間（順不同・重なっていてよい）
 * @param {number} total 全体の尺
 * @param {number} pad 残す区間の前後に足すのりしろ秒
 * @param {number} minGapSec これより短い隙間は切らない（細切れになるのを防ぐ）
 * @returns {Array<[number,number]>} 切る区間（時刻順）
 */
export function cutRangesFromKeep(keep, total, pad = 0, minGapSec = 0) {
  const merged = [];
  for (const [a0, b0] of [...keep].sort((x, y) => x[0] - y[0])) {
    const a = Math.max(0, a0 - pad), b = Math.min(total, b0 + pad);
    if (b - a <= 0) continue;
    const last = merged[merged.length - 1];
    if (last && a <= last[1] + 0.001) last[1] = Math.max(last[1], b);
    else merged.push([a, b]);
  }
  const gaps = [];
  let prev = 0;
  for (const [a, b] of merged) {
    if (a - prev > 0.02) gaps.push([prev, a]);
    prev = Math.max(prev, b);
  }
  if (total - prev > 0.02) gaps.push([prev, total]);
  return gaps.filter(([a, b]) => b - a >= minGapSec);
}

/**
 * しゃべり出しの点から「残す区間」を組み立てる。
 *
 * 区間マーカー方式と違い、しゃべり出しだけを点で持つ。検出漏れがあっても
 * 「その手前が詰まらないだけ」で済む（区間ごと消えることがない）ので、
 * ノイズの多い素材ではこちらを本命にする。
 *
 * @param {number[]} starts しゃべり出しのタイムライン秒（順不同でよい）
 * @param {Array<{start:number,end:number}>} silence 無音区間（find_silence の silence）
 * @param {number} total 全体の尺
 * @param {number} lead しゃべり出しの手前に残す秒
 * @param {number} tail 発話の終わりに残す余韻秒
 * @returns {Array<[number,number]>} 残す区間（時刻順）
 */
export function keepRangesFromStarts(starts, silence, total, lead = 0.4, tail = 0.6) {
  const uniq = [...new Set(starts)].sort((a, b) => a - b);
  if (!uniq.length) return [];
  const sil = [...silence].sort((a, b) => a.start - b.start);

  const out = [];
  for (let i = 0; i < uniq.length; i++) {
    const s = uniq[i];
    const a = Math.max(0, s - lead);
    let end = total;
    const nextSilence = sil.find((x) => x.start > s);
    if (nextSilence) end = Math.min(total, nextSilence.start + tail);
    const sNext = uniq[i + 1];
    if (sNext !== undefined) {
      const cap = Math.max(s, sNext - lead);
      end = Math.min(end, cap);
    }
    out.push([a, end]);
  }
  return out;
}
