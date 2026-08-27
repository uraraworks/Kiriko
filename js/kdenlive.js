// kdenlive.js
// Kdenlive (MLT XML) プロジェクトから「カット区間リスト」を取り出す。
// テロップやエフェクトは読まない。in/out だけを拾う。
//
// 気をつける所:
//  - 1 つのトラックは tractor の中に playlist を 2 本持つ（同一トラック内の
//    トランジション用）。片方だけ読むと取りこぼす
//  - 映像トラックが複数あることがある。実素材では V1 の隙間を V2 のクリップが
//    埋めている作りだった（重なりゼロ）。トラックを 1 本だけ選ぶと 12 クリップ落ちる。
//    なので全部の映像トラックを位置順に統合する
//  - <blank> は隙間。タイムライン位置の計算に要る（並び順がこれで決まる）
//  - MLT の out は「最後のフレーム」なので、長さは out - in + 1 フレーム
//  - <track hide="audio"> が映像トラック（音声を隠している側）

/** "00:00:04.967" / "123"（フレーム）→ 秒 */
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
  const frame = 1 / fps;

  // producer / chain の id → リソースパス
  const resources = new Map();
  for (const el of doc.querySelectorAll('producer, chain')) {
    const id = el.getAttribute('id');
    const res = [...el.querySelectorAll('property')]
      .find((p) => p.getAttribute('name') === 'resource')?.textContent?.trim();
    if (id && res) resources.set(id, res);
  }

  // playlist の中身を、タイムライン位置つきで読む
  const playlists = new Map();
  for (const pl of doc.querySelectorAll('playlist')) {
    const id = pl.getAttribute('id');
    if (!id || id === 'main_bin') continue;
    const items = [];
    let pos = 0;
    for (const c of pl.children) {
      if (c.tagName === 'blank') {
        pos += toSeconds(c.getAttribute('length'), fps);
      } else if (c.tagName === 'entry') {
        const from = toSeconds(c.getAttribute('in'), fps);
        const to = toSeconds(c.getAttribute('out'), fps) + frame;
        items.push({ pos, in: from, out: to, resource: resources.get(c.getAttribute('producer')) });
        pos += to - from;
      }
    }
    playlists.set(id, items);
  }

  // tractor から映像トラック（hide="audio" 側）を拾う
  const isVideoFile = (p) => /\.(mp4|mov|m4v|mkv|avi|webm)$/i.test(p || '');
  const tracks = [];
  for (const tr of doc.querySelectorAll('tractor')) {
    const tks = [...tr.querySelectorAll(':scope > track')];
    if (!tks.length || !tks.every((t) => t.getAttribute('hide') === 'audio')) continue;
    const items = tks
      .flatMap((t) => (playlists.get(t.getAttribute('producer')) ?? []).map((c) => ({ ...c, track: tr.getAttribute('id') })))
      .filter((c) => isVideoFile(c.resource) && c.out - c.in > 0.001);
    if (items.length) tracks.push({ id: tr.getAttribute('id'), entries: items });
  }
  if (!tracks.length) throw new Error('動画クリップが見つかりませんでした');

  // 全トラックを位置順に統合する。重なっている物は上に載せる演出（PinP 等）なので、
  // Kiriko の 1 本の V1 では表現できない。落とした数は呼び出し側に伝える。
  const all = tracks.flatMap((t) => t.entries).sort((a, b) => a.pos - b.pos);
  const cuts = [];
  let overlaps = 0, dropped = 0;
  let endOfLast = -Infinity;
  for (const c of all) {
    const len = c.out - c.in;
    if (c.pos < endOfLast - 0.05) {
      // 手前のクリップに大きくかぶっている
      if (c.pos + len <= endOfLast + 0.05) { dropped++; continue; } // 完全に隠れている＝重ね物
      overlaps++;                                                    // 端が重なるだけ＝トランジション
    }
    cuts.push(c);
    endOfLast = c.pos + len;
  }

  const files = [...new Set(cuts.map((e) => e.resource))];
  return {
    fps, cuts, files, overlaps, dropped,
    trackIds: tracks.map((t) => t.id),
    trackCounts: tracks.map((t) => t.entries.length),
  };
}

export function basename(path) {
  return String(path).split(/[\\/]/).pop();
}
