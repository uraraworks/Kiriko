// subtitles.js
// SRT 字幕（日本語・英語の 2 言語）を扱う純粋関数だけのモジュール。
//
// なぜテロップと別に持つか: テロップは画面焼き込みの演出要素だが、
// 字幕は配信プラットフォームに渡す SRT ファイルそのもの。1 エントリに
// ja / en を同居させておくと、翻訳や校正を突き合わせながら進めやすい。
// 書き出しは言語ごとに分けるので、片方が空のエントリはその言語の SRT からは除く。
//
// DOM も状態も触らないので、そのままテストできる（trims.js と同じ方針）。

import { newId } from './project.js';

/** 読みやすさの目安値。UI や自動生成の警告判定に使う */
export const LIMITS = {
  ja: { chars: 16, lines: 2, cps: 6 },
  en: { chars: 42, lines: 2, cps: 17 },
};

/** 字幕エントリを 1 つ作る */
export function createSubtitle(start, end, ja = '', en = '') {
  return { id: newId('sub'), start, end, ja, en };
}

/** 秒 → SRT のタイムコード '00:01:23,456' */
export function formatTime(sec) {
  const total = Math.max(0, sec);
  const ms = Math.round(total * 1000);
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const msRest = ms % 1000;
  const pad = (v, n) => String(v).padStart(n, '0');
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)},${pad(msRest, 3)}`;
}

/** 字幕列を SRT 文字列にする。空テキストのエントリはその言語からは除く */
export function toSrt(subtitles, lang) {
  const rows = (subtitles ?? [])
    .filter((s) => (s[lang] ?? '').trim() !== '')
    .slice()
    .sort((a, b) => a.start - b.start);
  return rows
    .map((s, i) => `${i + 1}\n${formatTime(s.start)} --> ${formatTime(s.end)}\n${s[lang]}\n\n`)
    .join('');
}

/** 1 行の折り返し・表示速度をチェックする */
export function checkLimits(sub, lang, limits = LIMITS) {
  const text = sub?.[lang] ?? '';
  const lim = limits[lang];
  if (text.trim() === '') return { long: false, fast: false, lines: 0, maxLine: 0, cps: 0 };
  const lineArr = text.split('\n');
  const lines = lineArr.length;
  const maxLine = Math.max(...lineArr.map((l) => l.length));
  const long = maxLine > lim.chars || lines > lim.lines;
  const durationSec = (sub.end ?? 0) - (sub.start ?? 0);
  const totalChars = lineArr.join('').length;
  const cps = durationSec > 0 ? totalChars / durationSec : Infinity;
  const fast = durationSec <= 0 ? true : cps > lim.cps;
  return { long, fast, lines, maxLine, cps };
}

/** id のエントリを時刻 t で 2 つに割る。テキストは前半に残し、後半は空にする */
export function splitAt(subtitles, id, t) {
  const list = subtitles ?? [];
  const i = list.findIndex((s) => s.id === id);
  if (i < 0) return list;
  const sub = list[i];
  if (!(t > sub.start && t < sub.end)) return list;
  const head = { ...sub, end: t };
  const tail = { id: newId('sub'), start: t, end: sub.end, ja: '', en: '' };
  const out = list.slice();
  out.splice(i, 1, head, tail);
  return out;
}

/** 隣り合う 2 つを 1 つにまとめる（並び順で隣接していなければ何もしない） */
export function mergeAdjacent(subtitles, idA, idB) {
  const list = (subtitles ?? []).slice().sort((a, b) => a.start - b.start);
  const iA = list.findIndex((s) => s.id === idA);
  const iB = list.findIndex((s) => s.id === idB);
  if (iA < 0 || iB < 0 || Math.abs(iA - iB) !== 1) return subtitles ?? [];
  const [first, second] = iA < iB ? [list[iA], list[iB]] : [list[iB], list[iA]];
  const join = (a, b) => [a, b].filter((x) => (x ?? '').trim() !== '').join('\n');
  const merged = {
    id: first.id,
    start: first.start,
    end: second.end,
    ja: join(first.ja, second.ja),
    en: join(first.en, second.en),
  };
  const out = (subtitles ?? []).filter((s) => s.id !== idA && s.id !== idB);
  out.push(merged);
  return out;
}

/** 表示用に chars で折り返す。手動改行（\n）は尊重する */
export function wrapForDisplay(text, chars) {
  return (text ?? '')
    .split('\n')
    .map((line) => {
      if (line.length <= chars) return line;
      const out = [];
      let rest = line;
      while (rest.length > chars) {
        out.push(rest.slice(0, chars));
        rest = rest.slice(chars);
      }
      out.push(rest);
      return out.join('\n');
    })
    .join('\n');
}

/**
 * start 昇順に並べ替え、重なりを解消する（前の end が次の start を超えていたら前を詰める）。
 * 詰めた結果 minSec 未満になったものは落とす。
 * DOM も状態も触らない純粋関数なので、MCP コマンド（set_subtitles）からもテストからも呼べる。
 */
export function normalizeOverlaps(subtitles, minSec = 0.3) {
  const sorted = (subtitles ?? []).slice().sort((a, b) => a.start - b.start);
  for (let i = 0; i < sorted.length - 1; i++) {
    const cur = sorted[i], next = sorted[i + 1];
    if (cur.end > next.start) cur.end = next.start;
  }
  const kept = [];
  let dropped = 0;
  for (const s of sorted) {
    if (s.end - s.start < minSec) dropped++;
    else kept.push(s);
  }
  return { subtitles: kept, dropped };
}

const SENTENCE_END = /[。！？!?]/;
const CLAUSE_END = /[、,]/;

/** 1 エントリを LIMITS.ja に収まるまで再帰的に分割する（文字位置の配列を返す） */
function splitPositions(text, maxChars) {
  if (text.length <= maxChars) return [text];
  // 候補範囲内（先頭から maxChars 分より前）で一番後ろの句点・読点を探す
  const window = text.slice(0, maxChars + 1);
  const findLast = (re) => {
    let idx = -1;
    for (let i = 0; i < window.length; i++) if (re.test(window[i])) idx = i;
    return idx;
  };
  let cut = findLast(SENTENCE_END);
  if (cut < 0) cut = findLast(CLAUSE_END);
  if (cut < 0) cut = maxChars - 1; // 機械的に切る
  const head = text.slice(0, cut + 1);
  const rest = text.slice(cut + 1);
  if (!rest) return [head];
  return [head, ...splitPositions(rest, maxChars)];
}

/**
 * whisper の書き起こしから字幕の下書きを作る。
 * 長い発話は句読点で分割し、時刻は文字数比で按分する。
 * 短すぎる表示は最短秒まで伸ばし、隣とは重ならないようにする。
 */
export function fromSegments(segments, opts = {}) {
  const minDur = opts.minDur ?? 1.2;
  const maxChars = LIMITS.ja.chars * LIMITS.ja.lines;
  const draft = [];
  for (const seg of segments ?? []) {
    const text = (seg.text ?? '').trim();
    const dur = Math.max(0, seg.end - seg.start);
    if (!text) continue;
    const parts = splitPositions(text, maxChars).filter((p) => p.length);
    const totalLen = parts.reduce((a, p) => a + p.length, 0) || 1;
    let t = seg.start;
    for (const part of parts) {
      const share = dur * (part.length / totalLen);
      const start = t;
      const end = start + share;
      draft.push(createSubtitle(start, end, part));
      t = end;
    }
    if (draft.length) draft[draft.length - 1].end = seg.end; // 端数の誤差を吸収
  }

  // 最短表示秒まで伸ばす（次の開始は侵さない）
  for (let i = 0; i < draft.length; i++) {
    const cur = draft[i];
    const next = draft[i + 1];
    const limit = next ? next.start : Infinity;
    if (cur.end - cur.start < minDur) {
      cur.end = Math.min(limit, cur.start + minDur);
    }
  }

  // 重なりを詰める（前の end が次の start を超えていたら前を詰める）
  for (let i = 0; i < draft.length - 1; i++) {
    const cur = draft[i];
    const next = draft[i + 1];
    if (cur.end > next.start) cur.end = next.start;
  }

  return draft;
}
