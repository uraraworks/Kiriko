// trims.js
// カットで消した区間を捨てずに取っておき、後から秒単位で返せるようにする。
//
// なぜ要るか: アンドゥは一本道なので、カットの後に別の作業をすると
// 「あの箇所だけ 1 秒返す」ができない。それだと AI に下ごしらえを任せた時に
// 「全部受け入れるか全部捨てるか」になってしまう。
// 消した区間を在庫として持っておけば、受け入れた上で後から部分的に返せる。
//
// 仕組みの要点:
// - クリップは素材の区間 { sourceId, in, out } を指しているだけなので、
//   消した区間も同じ形で表せる。映像そのものは抱えない
// - 復帰の実体は「隣のクリップを伸ばす」。クリップの挿入は普通は起きない
// - 継ぎ目の位置は前後のクリップ id から毎回引き直す。後から並びが変わっても追随する
//
// DOM も状態も触らないので、そのままテストできる（edit.js と同じ方針）。

import { newId, clipDuration } from './project.js';

/** 秒の比較に使う許容誤差 */
export const EPS = 0.0005;

const near = (a, b) => Math.abs(a - b) < EPS;

/** 区間の合計秒 */
export function segmentsDuration(segments) {
  return (segments ?? []).reduce((a, s) => a + Math.max(0, s.out - s.in), 0);
}

/** クリップ列の開始秒（タイムライン基準）。クリップは隙間なく並ぶ */
function offsetsOf(clips) {
  let t = 0;
  return clips.map((c) => { const o = t; t += clipDuration(c); return o; });
}

function segOf(clip, inSec, outSec) {
  return { sourceId: clip.sourceId, in: inSec, out: outSec, volume: clip.volume ?? 1 };
}

function clipOf(seg) {
  return { id: newId('clip'), sourceId: seg.sourceId, in: seg.in, out: seg.out, volume: seg.volume ?? 1 };
}

/**
 * 区間の列から先頭（または末尾）から sec 秒だけ取り出す。
 * 復帰でも、端のドラッグで伸ばした分の相殺でも使う。
 *
 * @returns {{taken: object[], rest: object[], sec: number}} sec は実際に取れた秒
 */
export function releaseSegments(segments, sec, fromFront = true) {
  const rest = (segments ?? []).map((s) => ({ ...s }));
  const taken = [];
  let need = Math.max(0, sec);
  while (need > EPS && rest.length) {
    const i = fromFront ? 0 : rest.length - 1;
    const s = rest[i];
    const d = s.out - s.in;
    if (d <= need + EPS) {
      rest.splice(i, 1);
      if (fromFront) taken.push(s); else taken.unshift(s);
      need -= d;
    } else if (fromFront) {
      taken.push({ ...s, out: s.in + need });
      rest[i] = { ...s, in: s.in + need };
      need = 0;
    } else {
      taken.unshift({ ...s, in: s.out - need });
      rest[i] = { ...s, out: s.out - need };
      need = 0;
    }
  }
  return { taken, rest, sec: Math.max(0, sec) - need };
}

/**
 * トリムの継ぎ目がタイムラインのどこにあるかを引き直す。
 * 前のクリップの終わり = 継ぎ目。前が消えていたら次のクリップの頭で代用する。
 *
 * @returns {{atSec:number, index:number}|null} index は clips の挿入位置。
 *   両側のクリップを見失っていたら null（戻せない）
 */
export function seamOf(clips, trim) {
  return seamIn(context(clips), trim);
}

/**
 * clips を 1 度だけ走査して、継ぎ目の計算に要るものを揃える。
 * seams() は画面の再描画のたびに呼ばれるので、トリムごとに走査し直さない。
 */
function context(clips) {
  const off = offsetsOf(clips);
  return {
    clips, off,
    index: new Map(clips.map((c, i) => [c.id, i])),
    total: off.length ? off.at(-1) + clipDuration(clips.at(-1)) : 0,
  };
}

function seamIn(ctx, trim) {
  const { clips, off, index, total } = ctx;
  if (!trim.prevClipId) return { atSec: 0, index: 0 };   // 先頭で切った
  const i = index.get(trim.prevClipId);
  if (i !== undefined) return { atSec: off[i] + clipDuration(clips[i]), index: i + 1 };
  if (trim.nextClipId) {
    const j = index.get(trim.nextClipId);
    if (j !== undefined) return { atSec: off[j], index: j };
  } else {
    return { atSec: total, index: clips.length };   // 末尾で切った
  }
  return null;   // 前後とも見失った（丸ごと消された等）
}

/**
 * 継ぎ目の一覧。画面の印と list_trims の両方で使う。
 * atSec が null のものは、アンカーを見失っていて戻せない。
 */
export function seams(project) {
  const ctx = context(project.clips ?? []);
  return (project.trims ?? []).map((trim) => {
    const s = seamIn(ctx, trim);
    return {
      id: trim.id,
      atSec: s?.atSec ?? null,
      index: s?.index ?? null,
      remainingSec: segmentsDuration(trim.segments),
      label: trim.label ?? '',
      group: trim.group ?? null,
      trim,
    };
  }).filter((s) => s.remainingSec > EPS)
    .sort((a, b) => (a.atSec ?? Infinity) - (b.atSec ?? Infinity));
}

/** 継ぎ目のうち time にいちばん近いものを返す（tolerance 以内） */
export function seamNear(project, time, tolerance = 0.5) {
  let best = null;
  for (const s of seams(project)) {
    if (s.atSec == null) continue;
    const d = Math.abs(s.atSec - time);
    if (d <= tolerance && (!best || d < Math.abs(best.atSec - time))) best = s;
  }
  return best;
}

/**
 * 同じ継ぎ目に既にトリムがあれば混ぜる。無ければ足す。
 * 継ぎ目ごとに 1 件に保たないと「前を 1 秒」がどれのことか決まらなくなる。
 *
 * @param {boolean} before 新しい区間が既存の区間より素材の時刻で手前なら true
 */
export function mergeTrim(trims, clips, entry, before = false) {
  const out = [...(trims ?? [])];
  const at = seamOf(clips, entry)?.atSec;
  if (at != null) {
    const i = out.findIndex((t) => {
      const s = seamOf(clips, t);
      return s && near(s.atSec, at);
    });
    if (i >= 0) {
      const old = out[i];
      out[i] = {
        ...old,
        prevClipId: entry.prevClipId,
        nextClipId: entry.nextClipId,
        segments: before ? [...entry.segments, ...old.segments] : [...old.segments, ...entry.segments],
        label: old.label || entry.label,   // 最初に付いた名前（「無音」等）を残す
      };
      return out;
    }
  }
  out.push({ id: newId('trim'), ...entry });
  return out;
}

/**
 * [a, b) を切り取る。クリップ列と、消した区間を記録したトリムを返す（元は変更しない）。
 *
 * 切り取る範囲の中に既にある継ぎ目は、そのトリムを取り込んで 1 件にまとめる。
 * そうしないと同じ場所にトリムが 2 つ並んで、どちらを戻すのか決められなくなる。
 */
export function cut(project, a, b, { label = '', group = null, minLen = 0 } = {}) {
  const clips = project.clips ?? [];
  const off = offsetsOf(clips);
  const total = off.length ? off.at(-1) + clipDuration(clips.at(-1)) : 0;
  const lo = Math.max(0, Math.min(a, b));
  const hi = Math.min(total, Math.max(a, b));

  // 範囲に飲み込まれる既存のトリム（継ぎ目が [lo, hi] にあるもの）
  const inner = new Map();   // 継ぎ目の秒 -> トリム
  const swallowed = new Set();
  for (const t of project.trims ?? []) {
    const s = seamOf(clips, t);
    if (!s || s.atSec < lo - EPS || s.atSec > hi + EPS) continue;
    inner.set(s.atSec, t);
    swallowed.add(t.id);
  }
  const takeInner = (atSec, into) => {
    for (const [sec, t] of inner) {
      if (near(sec, atSec)) { into.push(...t.segments); inner.delete(sec); }
    }
  };

  const kept = [];
  const segments = [];
  const splitTail = new Map();   // 分割で後半に新しい id を振った分の対応表
  let insertIndex = 0;
  for (let i = 0; i < clips.length; i++) {
    const c = clips[i];
    const s0 = off[i], e0 = s0 + clipDuration(c);
    takeInner(s0, segments);            // このクリップの手前にある継ぎ目を先に取り込む
    if (e0 <= lo || s0 >= hi) {         // 範囲の外はそのまま
      kept.push(c);
      if (e0 <= lo) insertIndex = kept.length;
      continue;
    }
    // 1 フレームに満たないかけらは残さない。残すと、まったく別の場所の映像が
    // 一瞬だけ挟まって見え、しかも短すぎて画面上で見つけられない
    const headLen = lo - s0, tailLen = e0 - hi;
    const keepHead = s0 < lo && headLen > minLen;
    const keepTail = e0 > hi && tailLen > minLen;
    if (keepHead) {
      kept.push({ ...c, out: c.in + headLen });
      insertIndex = kept.length;
    }
    // 消える部分。残さなかったかけらもここに含めるので、後から戻せる
    const from = keepHead ? c.in + headLen : c.in;
    const to = keepTail ? c.in + Math.min(clipDuration(c), hi - s0) : c.out;
    if (to - from > EPS) segments.push(segOf(c, from, to));
    if (keepTail) {                     // 後半を残す
      const tail = { ...c, id: newId('clip'), in: c.in + (hi - s0) };
      kept.push(tail);
      splitTail.set(c.id, tail.id);
    }
  }
  takeInner(total, segments);           // 末尾の継ぎ目

  // クリップを割ると、id は前半に残る。継ぎ目が後半の終わりにあるトリムは付け替える
  const trims = (project.trims ?? [])
    .filter((t) => !swallowed.has(t.id))
    .map((t) => (splitTail.has(t.prevClipId) ? { ...t, prevClipId: splitTail.get(t.prevClipId) } : t));
  const entry = {
    prevClipId: kept[insertIndex - 1]?.id ?? null,
    nextClipId: kept[insertIndex]?.id ?? null,
    segments,
    label,
    group,
  };
  return {
    clips: kept,
    trims: segments.length ? mergeTrim(trims, kept, entry) : trims,
    removedSec: hi - lo,
    atSec: lo,
  };
}

/**
 * 継ぎ目から seconds 秒だけ戻す。
 *
 * side='head' なら手前のクリップを伸ばす（語尾が切れた時）。
 * side='tail' なら次のクリップの頭を戻す（話し始めが切れた時）。
 * どちらも継ぎ目に seconds 秒ぶん映像が戻ってくるので、
 * 呼び出し側は atSec に restoredSec の隙間を空けること（insertGapAt）。
 *
 * 在庫より多く頼まれた時は、あるだけ返して restoredSec で知らせる（エラーにはしない）。
 */
export function restore(project, { time, seconds = 0.5, side = 'head', tolerance = 0.5 } = {}) {
  const seam = seamNear(project, time, tolerance);
  if (!seam) throw new Error('その位置にカットの継ぎ目がありません');

  const head = side !== 'tail';
  const { taken, rest, sec } = releaseSegments(seam.trim.segments, seconds, head);
  if (sec <= EPS) throw new Error('戻せる分がもうありません');

  const clips = (project.clips ?? []).map((c) => ({ ...c }));
  let at = seam.index;
  if (head) {
    // 手前のクリップに継ぎ足せるならそうする（クリップを増やさない）
    for (const p of taken) {
      const prev = clips[at - 1];
      if (prev && prev.sourceId === p.sourceId && near(prev.out, p.in)) clips[at - 1] = { ...prev, out: p.out };
      else { clips.splice(at, 0, clipOf(p)); at++; }
    }
  } else {
    // 次のクリップの頭を戻す。後ろから順に、継ぎ目の位置へ積んでいく
    for (let i = taken.length - 1; i >= 0; i--) {
      const p = taken[i];
      const next = clips[at];
      if (next && next.sourceId === p.sourceId && near(next.in, p.out)) clips[at] = { ...next, in: p.in };
      else clips.splice(at, 0, clipOf(p));
    }
  }

  let trims = (project.trims ?? [])
    .map((t) => (t.id === seam.trim.id ? { ...t, segments: rest } : t))
    .filter((t) => segmentsDuration(t.segments) > EPS);

  // 在庫を使い切って元通り繋がったなら、切れ目を残さず 1 本に戻す
  ({ trims } = coalesceAt(clips, trims, at));

  return {
    clips, trims,
    atSec: seam.atSec,
    restoredSec: sec,
    requestedSec: seconds,
    remainingSec: segmentsDuration(rest),
    side: head ? 'head' : 'tail',
    trimId: seam.trim.id,
    label: seam.label,
  };
}

/**
 * 隣り合う 2 つのクリップが素材の上で地続きなら 1 本にまとめる（clips は破壊的に変更）。
 * 消えるクリップを指していたトリムのアンカーは、残る方へ付け替える。
 */
function coalesceAt(clips, trims, index) {
  const a = clips[index - 1], b = clips[index];
  if (!a || !b || a.sourceId !== b.sourceId || !near(a.out, b.in)) return { clips, trims };
  clips[index - 1] = { ...a, out: b.out };
  clips.splice(index, 1);
  return {
    clips,
    trims: trims.map((t) => ({
      ...t,
      prevClipId: t.prevClipId === b.id ? a.id : t.prevClipId,
      nextClipId: t.nextClipId === b.id ? a.id : t.nextClipId,
    })),
  };
}

/**
 * クリップの端をドラッグして伸ばした分を、在庫から差し引く。
 * これをしないと、同じ映像がタイムラインと在庫の両方にあることになり、
 * 後で戻した時に二重に出てしまう。
 *
 * @param {string} clipId 伸ばしたクリップ
 * @param {'in'|'out'} side どちらの端を伸ばしたか
 */
export function consumeAt(project, clipId, side, sec) {
  const trims = project.trims ?? [];
  const i = trims.findIndex((t) => (side === 'out' ? t.prevClipId === clipId : t.nextClipId === clipId));
  if (i < 0 || sec <= EPS) return trims;
  const { rest } = releaseSegments(trims[i].segments, sec, side === 'out');
  return trims
    .map((t, j) => (j === i ? { ...t, segments: rest } : t))
    .filter((t) => segmentsDuration(t.segments) > EPS);
}
