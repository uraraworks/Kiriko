// kdenlive.js
// Kdenlive (MLT XML) プロジェクトから「カット区間リスト」を取り出す。
// Phase 4 の移行機能の先出し。テロップ/エフェクトは読まず、in/out だけを拾う。

/** "00:00:04.967" / "123" (フレーム) → 秒 */
function toSeconds(v, fps) {
  if (v == null) return 0;
  const s = String(v).trim();
  if (s.includes(':')) {
    const p = s.split(':').map(Number);
    while (p.length < 3) p.unshift(0);
    return p[0] * 3600 + p[1] * 60 + p[2];
  }
  const n = Number(s);
  return Number.isFinite(n) ? n / fps : 0;
}

export function parseKdenlive(xmlText) {
  const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('kdenlive ファイルを解析できませんでした');

  const profile = doc.querySelector('profile');
  const fps = profile
    ? (Number(profile.getAttribute('frame_rate_num')) || 30) / (Number(profile.getAttribute('frame_rate_den')) || 1)
    : 30;

  // producer / chain の id → リソースパス
  const resources = new Map();
  for (const el of doc.querySelectorAll('producer, chain')) {
    const id = el.getAttribute('id');
    const res = [...el.querySelectorAll('property')]
      .find((p) => p.getAttribute('name') === 'resource')?.textContent?.trim();
    if (id && res) resources.set(id, res);
  }

  const isVideoFile = (p) => /\.(mp4|mov|m4v|mkv|avi|webm)$/i.test(p || '');

  // playlist ごとにエントリを集め、動画素材を一番多く含むものを V1 とみなす
  const playlists = [];
  for (const pl of doc.querySelectorAll('playlist')) {
    if (pl.getAttribute('id') === 'main_bin') continue;
    const entries = [];
    for (const e of pl.querySelectorAll('entry')) {
      const res = resources.get(e.getAttribute('producer'));
      if (!isVideoFile(res)) continue;
      const inSec = toSeconds(e.getAttribute('in'), fps);
      const outSec = toSeconds(e.getAttribute('out'), fps) + 1 / fps; // MLT の out は最終フレーム
      if (outSec > inSec) entries.push({ resource: res, in: inSec, out: outSec });
    }
    if (entries.length) playlists.push({ id: pl.getAttribute('id'), entries });
  }
  if (!playlists.length) throw new Error('動画クリップが見つかりませんでした');

  // Kdenlive は AV クリップを映像用/音声用のプレイリストに分けて持つ。
  // tractor の <track hide="audio"> が映像トラックなので、そちらを優先する。
  const videoTracks = new Set(
    [...doc.querySelectorAll('tractor > track')]
      .filter((t) => t.getAttribute('hide') === 'audio')
      .map((t) => t.getAttribute('producer'))
  );
  playlists.sort((a, b) =>
    (videoTracks.has(b.id) - videoTracks.has(a.id)) || (b.entries.length - a.entries.length));
  const best = playlists[0];

  const files = [...new Set(best.entries.map((e) => e.resource))];
  return { fps, cuts: best.entries, files, trackId: best.id };
}

export function basename(path) {
  return String(path).split(/[\\/]/).pop();
}
