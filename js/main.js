// main.js — UI 全体の組み立て
import { Mp4Source } from './mp4source.js';
import * as P from './project.js';
import { exportProject } from './exporter.js';
import { parseKdenlive, basename } from './kdenlive.js';
import * as T from './telop.js';
import { composeFrame, activeBlur, drawOverlaysAt, overlaysAt } from './compose.js';
import { AudioLibrary, AudioPreview, mixInto } from './audio.js';
import { History } from './history.js';
import { ThumbCache, THUMB_W, THUMB_H } from './thumbs.js';
import { WaveformCache, BINS_PER_SEC, bufferPeaks } from './waveform.js';
import * as B from './boxes.js';
import { ImageLibrary, PLACEMENTS, placementBox, defaultPlacement, createImageClip, drawImageClip, drawnRect } from './images.js';

// ---------------------------------------------------------------- 状態

const S = {
  project: P.createProject(),
  sources: new Map(),      // sourceId -> Mp4Source
  currentSourceId: null,
  markIn: null,
  markOut: null,
  selectedClipId: null,
  mode: 'source',          // 'source' | 'program'
  programTime: 0,          // プログラムモニターの再生位置（出力タイムライン秒）
  programIndex: -1,
  pxPerSec: 8,
  scrollSec: 0,
  shuttle: 0,
  exporting: false,
  pendingKdenlive: null,   // { cuts, files } 素材の読み込み待ち
  videoSourceId: null,     // <video> に現在ロードしている素材
  selectedTelopId: null,
  userFonts: [],           // ユーザーが追加した .ttf/.otf
  installedFonts: null,    // Local Font Access API で列挙した結果
  telopStyle: { ...T.DEFAULT_STYLE }, // 次に追加するテロップの既定スタイル
  selectedBlurId: null,
  selectedAudioId: null,
  zoneIn: null,            // タイムラインの範囲選択（Kdenlive のゾーン相当）
  zoneOut: null,
  selectedImageId: null,
  imageLib: new ImageLibrary(),
  focusArea: 'timeline',   // 'preview' ならカーソルキーで枠を動かす
  binTab: 'media',
  snapLine: null,          // タイムラインで吸着中の位置（秒）
  showThumbs: true,
  showWaves: true,
  inspTab: 'props',
  library: null,           // AudioLibrary（初回の音源読み込み時に作る）
  audioPreview: null,
};

const $ = (id) => document.getElementById(id);

// できたそばから描き直す。連続で来るのでフレームにまとめる
let redrawQueued = false;
const queueTimelineRedraw = () => {
  if (redrawQueued) return;
  redrawQueued = true;
  requestAnimationFrame(() => { redrawQueued = false; renderTimeline(); });
};
const thumbs = new ThumbCache(queueTimelineRedraw);
const waves = new WaveformCache(queueTimelineRedraw);
const bgmPeaks = new Map(); // assetId -> Float32Array（SE / BGM 用。メモリ上なので即時）
const video = $('video');

// ---------------------------------------------------------------- ユーティリティ

function tc(sec, withHours = true) {
  if (!Number.isFinite(sec)) sec = 0;
  sec = Math.max(0, sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const c = Math.floor((sec % 1) * 100);
  const pad = (n) => String(n).padStart(2, '0');
  return (withHours ? pad(h) + ':' : '') + `${pad(m)}:${pad(s)}.${pad(c)}`;
}
const fps = () => S.project.output.fps || 30;
const curSource = () => S.sources.get(S.currentSourceId) || null;

/** クリップとテロップの選択は排他 */
function select(type, id) {
  // 何かを選んだらプロパティが見えている状態にする
  if (id && type !== 'telop') S.inspTab = 'props';
  S.selectedClipId = type === 'clip' ? id : null;
  S.selectedTelopId = type === 'telop' ? id : null;
  S.selectedBlurId = type === 'blur' ? id : null;
  S.selectedAudioId = type === 'audio' ? id : null;
  S.selectedImageId = type === 'image' ? id : null;
}
const selectedTelop = () => S.project.telops.find((t) => t.id === S.selectedTelopId) || null;
const selectedBlur = () => S.project.blurs.find((b) => b.id === S.selectedBlurId) || null;
const selectedAudio = () => S.project.audioClips.find((a) => a.id === S.selectedAudioId) || null;
const selectedImage = () => S.project.images.find((i) => i.id === S.selectedImageId) || null;
const presets = () => S.project.telopPresets ?? T.DEFAULT_PRESETS;

// ---------------------------------------------------------------- 履歴（アンドゥ / リドゥ）

const history = new History(
  () => JSON.stringify(S.project),
  (json) => {
    S.project = JSON.parse(json);
    // 読み込み済みメディアは履歴の対象外。巻き戻しで消えないよう復元する
    for (const [id, src] of S.sources) {
      if (!S.project.sources.some((x) => x.id === id)) {
        S.project.sources.push({ id, name: src.name, size: src.file.size, duration: src.duration });
      }
    }
    if (S.library) {
      for (const [id, buf] of S.library.buffers) {
        if (!S.project.audioAssets.some((x) => x.id === id)) {
          S.project.audioAssets.push({ id, name: id, duration: buf.duration, channels: buf.numberOfChannels });
        }
      }
    }
    for (const [id, bmp] of S.imageLib.bitmaps) {
      if (!S.project.imageAssets.some((x) => x.id === id)) {
        S.project.imageAssets.push({ id, name: id, width: bmp.width, height: bmp.height });
      }
    }
    // 消えた要素を選択したままにしない
    if (!S.project.clips.some((c) => c.id === S.selectedClipId)) S.selectedClipId = null;
    if (!S.project.telops.some((t) => t.id === S.selectedTelopId)) S.selectedTelopId = null;
    if (!S.project.blurs.some((b) => b.id === S.selectedBlurId)) S.selectedBlurId = null;
    if (!S.project.audioClips.some((a) => a.id === S.selectedAudioId)) S.selectedAudioId = null;
    if (!S.project.images.some((i) => i.id === S.selectedImageId)) S.selectedImageId = null;
    normalizeProject();
    S.programTime = Math.min(S.programTime, P.totalDuration(S.project));
    S.programIndex = -1;
    seekProgram(S.programTime, true);
    renderAll();
    renderTelopForm(true);
    renderFxForm(true);
    syncProjectUI();
  },
);

/** 変更を加える直前に呼ぶ */
const commit = (label, key = null) => history.commit(label, key);

/** プロジェクト側の値をフォーム類へ反映する（読み込み・アンドゥ後） */
function syncProjectUI() {
  const p = S.project;
  const set = (id, v) => { const el = $(id); if (el && document.activeElement !== el) el.value = v; };
  set('notes', p.notes ?? '');
  set('mixSe', Math.round((p.mix?.se ?? 1) * 100));
  set('mixBgm', Math.round((p.mix?.bgm ?? 1) * 100));
  $('mixSeLbl').textContent = `${Math.round((p.mix?.se ?? 1) * 100)}%`;
  $('mixBgmLbl').textContent = `${Math.round((p.mix?.bgm ?? 1) * 100)}%`;
  set('optRes', `${p.output.width}x${p.output.height}`);
  set('optFps', String(p.output.fps));
}

function renderHistoryUI() {
  $('btnUndo').disabled = !history.canUndo;
  $('btnRedo').disabled = !history.canRedo;
  $('btnUndo').title = history.canUndo ? `元に戻す：${history.undoLabel}　［ ⌘Z / Ctrl+Z ］` : '元に戻す　［ ⌘Z / Ctrl+Z ］';
  $('btnRedo').title = history.canRedo ? `やり直す：${history.redoLabel}　［ ⇧⌘Z / Ctrl+Y ］` : 'やり直す　［ ⇧⌘Z / Ctrl+Y ］';
}
history.onChange = renderHistoryUI;

function doUndo() {
  const l = history.undo();
  status(l ? `元に戻しました：${l}` : 'これ以上戻せません');
}
function doRedo() {
  const l = history.redo();
  status(l ? `やり直しました：${l}` : 'これ以上進めません');
}

/** 重ね物（画像・テロップ）の z の範囲 */
function zRange() {
  const all = [...S.project.images, ...S.project.telops].map((x) => x.z ?? 0);
  return all.length ? [Math.min(...all), Math.max(...all)] : [0, 0];
}
const bringToFront = (item) => { item.z = zRange()[1] + 1; };
const sendToBack = (item) => { item.z = zRange()[0] - 1; };

/** 旧いプロジェクトを現在の形に揃える */
function normalizeProject() {
  const p = S.project;
  p.telops = (p.telops ?? []).map(T.migrateTelop);
  p.images = p.images ?? [];
  // z 未設定のものを補う。従来の見た目（テロップが画像より前）を保つ
  p.images.forEach((im, i) => { if (typeof im.z !== 'number') im.z = i; });
  p.telops.forEach((tl, i) => { if (typeof tl.z !== 'number') tl.z = 1000 + i; });
  p.imageAssets = p.imageAssets ?? [];
  p.blurs = p.blurs ?? [];
  p.audioClips = p.audioClips ?? [];
  p.audioAssets = p.audioAssets ?? [];
  p.mix = { se: 1, bgm: 1, ...(p.mix ?? {}) };
}

function status(msg, isErr = false) {
  const el = $('status');
  el.textContent = msg;
  el.classList.toggle('err', isErr);
}

// ---------------------------------------------------------------- 素材読み込み

async function openFiles() {
  let files = [];
  if ('showOpenFilePicker' in window) {
    try {
      const handles = await window.showOpenFilePicker({
        multiple: true,
        types: [{
          description: '動画 / 音源 / プロジェクト',
          accept: {
            'video/*': ['.mp4', '.mov', '.m4v'],
            'audio/*': ['.mp3', '.wav', '.m4a', '.ogg'],
            'image/*': ['.png', '.jpg', '.jpeg', '.webp'],
            'application/xml': ['.kdenlive'],
          },
        }],
      });
      files = await Promise.all(handles.map((h) => h.getFile()));
    } catch (e) { if (e.name === 'AbortError') return; throw e; }
  } else {
    $('fileInput').click();
    return;
  }
  await addFiles(files);
}

const AUDIO_RE = /\.(mp3|wav|m4a|aac|ogg|flac)$/i;
const IMAGE_RE = /\.(png|jpe?g|webp|gif|bmp)$/i;

async function addFiles(files) {
  const audio = files.filter((f) => AUDIO_RE.test(f.name));
  if (audio.length) await addAudioAssets(audio);
  const imgs = files.filter((f) => IMAGE_RE.test(f.name));
  if (imgs.length) await addImageAssets(imgs);
  for (const file of files) {
    if (AUDIO_RE.test(file.name) || IMAGE_RE.test(file.name)) continue;
    if (/\.kdenlive$/i.test(file.name)) { await importKdenlive(file); continue; }
    try {
      status(`${file.name} を解析中…`);
      const src = new Mp4Source(file);
      await src.load((m) => status(`${file.name}: ${m}`));
      const id = P.newId('src');
      S.sources.set(id, src);
      S.project.sources.push({ id, name: src.name, size: file.size, duration: src.duration });
      status(`${file.name} 読み込み完了（${tc(src.duration)}）`);
      if (!S.currentSourceId) selectSource(id);
      bindPendingKdenlive();
    } catch (e) {
      console.error(e);
      status(`${file.name}: ${e.message}`, true);
    }
  }
  renderAll();
}

async function importKdenlive(file) {
  try {
    const info = parseKdenlive(await file.text());
    S.pendingKdenlive = info;
    status(`Kdenlive: ${info.cuts.length} カット / 素材 ${info.files.length} 本 を検出。該当の mp4 を読み込むと反映されます`);
    bindPendingKdenlive();
  } catch (e) {
    status(`Kdenlive 読み込み失敗: ${e.message}`, true);
  }
}

/** kdenlive のカット列を、読み込み済み素材にファイル名で突き合わせて取り込む */
function bindPendingKdenlive() {
  const pend = S.pendingKdenlive;
  if (!pend) return;
  const byName = new Map();
  for (const [id, src] of S.sources) byName.set(src.name, id);
  if (!pend.files.every((f) => byName.has(basename(f)))) return;

  commit('Kdenlive からカットを取り込み');
  S.project.clips = pend.cuts.map((c) => ({
    id: P.newId('clip'),
    sourceId: byName.get(basename(c.resource)),
    in: c.in,
    out: c.out,
    volume: 1,
  }));
  S.pendingKdenlive = null;
  zoomFit();
  status(`Kdenlive から ${S.project.clips.length} カットを取り込みました`);
  renderAll();
}

function selectSource(id) {
  const src = S.sources.get(id);
  if (!src) return;
  S.currentSourceId = id;
  S.markIn = null;
  S.markOut = null;
  setMode('source');
  setVideoSource(id);
  video.currentTime = 0;
  $('noMedia').style.display = 'none';
  renderAll();
}

// ---------------------------------------------------------------- モニター

/** <video> に流す素材を切り替える（同じなら何もしない） */
function setVideoSource(id) {
  if (S.videoSourceId === id) return;
  const src = S.sources.get(id);
  if (!src) return;
  S.videoSourceId = id;
  video.src = src.previewUrl;
}

function setMode(mode) {
  S.mode = mode;
  for (const t of document.querySelectorAll('.tab[data-mode]')) t.classList.toggle('active', t.dataset.mode === mode);
  if (mode === 'program') {
    seekProgram(S.programTime, true);
  } else {
    const src = curSource();
    if (src) setVideoSource(S.currentSourceId);
    $('monName').textContent = src ? src.name : '—';
  }
  renderTransport();
}

/** 出力タイムライン秒 → { clip, src, localTime, index } */
function locate(t) {
  let acc = 0;
  const clips = S.project.clips;
  for (let i = 0; i < clips.length; i++) {
    const d = P.clipDuration(clips[i]);
    if (t < acc + d || i === clips.length - 1) {
      return { clip: clips[i], index: i, localTime: Math.min(clips[i].in + Math.max(0, t - acc), clips[i].out) };
    }
    acc += d;
  }
  return null;
}

function clipOffset(index) {
  let acc = 0;
  for (let i = 0; i < index; i++) acc += P.clipDuration(S.project.clips[i]);
  return acc;
}

function seekProgram(t, force = false) {
  S.programTime = Math.max(0, Math.min(t, P.totalDuration(S.project)));
  const loc = locate(S.programTime);
  if (!loc) return;
  const src = S.sources.get(loc.clip.sourceId);
  if (!src) return;
  $('monName').textContent = `${src.name}（クリップ ${loc.index + 1}）`;
  if (force || S.programIndex !== loc.index) {
    S.programIndex = loc.index;
    setVideoSource(loc.clip.sourceId);
  }
  if (Math.abs(video.currentTime - loc.localTime) > 0.05) video.currentTime = loc.localTime;
  video.volume = Math.min(1, Math.max(0, loc.clip.volume ?? 1));
}

/** プログラム再生中のクリップ跨ぎ処理 */
function programTick() {
  if (S.mode !== 'program' || video.paused) return;
  const loc = S.project.clips[S.programIndex];
  if (!loc) return;
  if (video.currentTime >= loc.out - 0.02) {
    const next = S.programIndex + 1;
    if (next >= S.project.clips.length) { video.pause(); return; }
    S.programTime = clipOffset(next);
    seekProgram(S.programTime, true);
    video.play().catch(() => {});
  } else {
    S.programTime = clipOffset(S.programIndex) + (video.currentTime - loc.in);
  }
}

// ---------------------------------------------------------------- クリップ操作

/**
 * イン点はアクティブなモニターに対して打つ（Kdenlive と同じ考え方）。
 *  - ソースモニター … 素材から拾う区間（加算方式）
 *  - プログラムモニター … タイムラインの範囲選択（切り取り用）
 */
function markIn() {
  if (S.mode === 'program') return zoneIn();
  if (!curSource()) return;
  S.markIn = video.currentTime;
  if (S.markOut !== null && S.markOut <= S.markIn) S.markOut = null;
  renderTransport(); renderScrub();
}
function markOut() {
  if (S.mode === 'program') return zoneOut();
  if (!curSource()) return;
  S.markOut = video.currentTime;
  if (S.markIn !== null && S.markIn >= S.markOut) S.markIn = null;
  renderTransport(); renderScrub();
}

function addClip() {
  const src = curSource();
  if (!src) return status('素材が未選択です', true);
  const a = S.markIn ?? 0;
  const b = S.markOut ?? Math.min(src.duration, a + 5);
  if (b - a < 0.05) return status('区間が短すぎます', true);
  commit('クリップ追加');
  const clip = { id: P.newId('clip'), sourceId: S.currentSourceId, in: a, out: b, volume: 1 };
  S.project.clips.push(clip);
  select('clip', clip.id);
  // 次のカットを続けて打てるように、アウト点を新しいイン点にする
  S.markIn = b;
  S.markOut = null;
  status(`クリップ追加 ${tc(a)} → ${tc(b)}（${(b - a).toFixed(2)}秒）`);
  renderAll();
}

// ---------------------------------------------------------------- タイムラインの範囲選択と切り取り

function zoneIn() {
  S.zoneIn = S.programTime;
  // 終了の初期値は開始地点。O を打つまで範囲は 0 のまま（誤って末尾まで消さないように）
  if (S.zoneOut === null || S.zoneOut < S.zoneIn) S.zoneOut = S.zoneIn;
  renderZoneUI();
}

function zoneOut() {
  S.zoneOut = S.programTime;
  if (S.zoneIn === null || S.zoneIn > S.zoneOut) S.zoneIn = S.zoneOut;
  renderZoneUI();
}

function clearZone() {
  S.zoneIn = S.zoneOut = null;
  renderZoneUI();
}

/** 範囲が確定しているか（片方だけならタイムラインの端で補う） */
function zoneRange() {
  if (S.zoneIn === null || S.zoneOut === null) return null;
  return S.zoneOut - S.zoneIn > 0.001 ? [S.zoneIn, S.zoneOut] : null;
}

function renderZoneInfo() {
  const r = zoneRange();
  $('zoneInfo').textContent = r
    ? `範囲 ${tc(r[0], false)} 〜 ${tc(r[1], false)}（${tc(r[1] - r[0], false)}）`
    : S.zoneIn !== null
      ? `範囲 ${tc(S.zoneIn, false)} 〜 —（O で終了を打つ）`
      : '範囲 未選択';
  $('btnExtract').disabled = !r;
  $('btnZoneClear').disabled = !r;
}

function renderZoneUI() {
  renderZoneInfo();
  renderTimeline();
  renderTransport();
}

/** 範囲を切り取って後ろを詰める（Kdenlive の「ゾーンを抽出」相当） */
function extractZone() {
  const r = zoneRange();
  if (!r) return status('先に範囲を選択してください（I / O）', true);
  const [a, b] = r;
  const len = b - a;
  commit(`${tc(len, false)} をカット`);

  const kept = [];
  let t = 0;
  for (const c of S.project.clips) {
    const dur = P.clipDuration(c);
    const s0 = t, e0 = t + dur;
    t = e0;
    if (e0 <= a || s0 >= b) { kept.push(c); continue; }   // 範囲外はそのまま
    if (s0 < a) kept.push({ ...c, out: c.in + (a - s0) }); // 前半を残す
    if (e0 > b) kept.push({ ...c, id: P.newId('clip'), in: c.in + (b - s0) }); // 後半を残す
  }
  S.project.clips = kept;
  rippleAfter(a, b);

  S.selectedClipId = null;
  clearZone();
  seekProgram(a, true);
  renderAll();
  status(`${tc(len, false)} を切り取りました（残り ${tc(P.totalDuration(S.project), false)}）`);
}

/** テロップ・ぼかし・音源を、切り取った分だけ前に詰める */
function rippleAfter(a, b) {
  const len = b - a;
  const shift = (v) => (v >= b ? v - len : v > a ? a : v);
  const alive = (x, y) => y - x > 0.05;

  S.project.telops = S.project.telops
    .map((x) => ({ ...x, start: shift(x.start), end: shift(x.end) }))
    .filter((x) => alive(x.start, x.end));
  S.project.blurs = S.project.blurs
    .map((x) => ({ ...x, start: shift(x.start), end: shift(x.end) }))
    .filter((x) => alive(x.start, x.end));
  S.project.images = S.project.images
    .map((x) => ({ ...x, start: shift(x.start), end: shift(x.end) }))
    .filter((x) => alive(x.start, x.end));
  S.project.audioClips = S.project.audioClips
    .map((x) => {
      const s0 = shift(x.start), e0 = shift(x.start + x.duration);
      // 頭を削られた分だけ素材の頭出しもずらす
      const trimmed = Math.max(0, a - x.start) > 0 && x.start < a ? 0 : Math.max(0, x.start - s0);
      return { ...x, start: s0, duration: e0 - s0, offset: (x.offset ?? 0) + trimmed };
    })
    .filter((x) => x.duration > 0.05);
}

/** 素材まるごとをタイムラインの末尾に置く（範囲を消していく編集の起点） */
function placeWholeSource(sourceId) {
  const src = S.sources.get(sourceId);
  if (!src) return;
  commit('素材をタイムラインに配置');
  const clip = { id: P.newId('clip'), sourceId, in: 0, out: src.duration, volume: 1 };
  S.project.clips.push(clip);
  select('clip', clip.id);
  setMode('program');
  zoomFit();
  renderAll();
  status(`${src.name} 全体（${tc(src.duration, false)}）をタイムラインに配置しました`);
}

function deleteSelected() {
  // プログラムモニターで範囲が選ばれていれば「切り取って詰める」を優先する
  if (S.mode === 'program' && zoneRange()) { extractZone(); return; }
  if (S.selectedBlurId) {
    commit('ぼかしを削除');
    S.project.blurs = S.project.blurs.filter((b) => b.id !== S.selectedBlurId);
    S.selectedBlurId = null; renderAll(); renderFxForm(true); return;
  }
  if (S.selectedImageId) {
    commit('画像を削除');
    S.project.images = S.project.images.filter((i) => i.id !== S.selectedImageId);
    S.selectedImageId = null; renderAll(); renderFxForm(true); return;
  }
  if (S.selectedAudioId) {
    commit('音源を削除');
    S.project.audioClips = S.project.audioClips.filter((a) => a.id !== S.selectedAudioId);
    S.selectedAudioId = null; renderAll(); renderFxForm(true); return;
  }
  if (S.selectedTelopId) {
    commit('テロップを削除');
    S.project.telops = S.project.telops.filter((t) => t.id !== S.selectedTelopId);
    S.selectedTelopId = null;
    renderAll();
    return;
  }
  if (!S.selectedClipId) return;
  const i = S.project.clips.findIndex((c) => c.id === S.selectedClipId);
  if (i < 0) return;
  commit('クリップを削除');
  S.project.clips.splice(i, 1);
  select('clip', S.project.clips[Math.min(i, S.project.clips.length - 1)]?.id ?? null);
  renderAll();
}

// ---------------------------------------------------------------- テロップ

/** いま編集中の「タイムライン時刻」。ソースモニターでも近い位置を返す */
function currentTimelineTime() {
  if (S.mode === 'program') return S.programTime;
  // ソースモニターの位置が採用区間に入っていれば、その出力時刻に読み替える
  let acc = 0;
  for (const c of S.project.clips) {
    if (c.sourceId === S.currentSourceId && video.currentTime >= c.in && video.currentTime < c.out) {
      return acc + (video.currentTime - c.in);
    }
    acc += P.clipDuration(c);
  }
  return S.programTime;
}

function addTelop() {
  const total = P.totalDuration(S.project);
  if (total <= 0) return status('先にクリップを作ってください', true);
  const t0 = Math.min(currentTimelineTime(), Math.max(0, total - 0.5));
  const t1 = Math.min(total, t0 + 3);
  commit('テロップ追加');
  const tel = T.createTelop(t0, t1, S.telopStyle, 'テロップ');
  tel.z = zRange()[1] + 1;
  S.project.telops.push(tel);
  select('telop', tel.id);
  setMode('program');
  seekProgram(t0, true);
  renderAll();
  renderTelopForm(true);
  status(`テロップを追加しました（${tc(t0, false)} 〜 ${tc(t1, false)}）`);
  setTimeout(() => document.getElementById('telText')?.focus(), 0);
}

// ---------------------------------------------------------------- ぼかし / 音源

function addBlur() {
  const total = P.totalDuration(S.project);
  if (total <= 0) return status('先にクリップを作ってください', true);
  const t0 = Math.min(currentTimelineTime(), Math.max(0, total - 0.5));
  commit('ぼかし追加');
  const b = { id: P.newId('blur'), start: t0, end: Math.min(total, t0 + 3), strength: 40 };
  S.project.blurs.push(b);
  select('blur', b.id);
  setMode('program'); seekProgram(t0, true);
  renderAll(); renderFxForm(true);
  status(`ぼかし区間を追加しました（${tc(b.start, false)} 〜 ${tc(b.end, false)}）`);
}

function library() {
  if (!S.library) {
    S.library = new AudioLibrary();
    S.audioPreview = new AudioPreview(S.library);
  }
  return S.library;
}

async function addAudioAssets(files) {
  const lib = library();
  for (const f of files) {
    try {
      const id = P.newId('aud');
      const meta = await lib.add(f, id);
      S.project.audioAssets.push(meta);
      status(`${f.name} を読み込みました（${tc(meta.duration, false)}）`);
    } catch (e) {
      status(`${f.name}: 音源を読み込めませんでした`, true);
    }
  }
  renderAll();
}

/** 素材を再生位置に配置する。BGM は長いので kind を尺で判定する */
function placeAudio(assetId) {
  const asset = S.project.audioAssets.find((a) => a.id === assetId);
  if (!asset) return;
  const total = P.totalDuration(S.project);
  if (total <= 0) return status('先にクリップを作ってください', true);
  const start = Math.min(currentTimelineTime(), Math.max(0, total - 0.2));
  commit(`${asset.name} を配置`);
  const isBgm = asset.duration > 20;
  const ac = {
    id: P.newId('ac'),
    assetId,
    kind: isBgm ? 'bgm' : 'se',
    start,
    offset: 0,
    duration: Math.min(asset.duration, isBgm ? Math.max(1, total - start) : asset.duration),
    volume: isBgm ? 0.35 : 0.9,
    fadeIn: isBgm ? 1.5 : 0,
    fadeOut: isBgm ? 2 : 0,
  };
  S.project.audioClips.push(ac);
  select('audio', ac.id);
  renderAll(); renderFxForm(true);
  status(`${asset.name} を ${tc(start, false)} に配置しました`);
}

// ---------------------------------------------------------------- 画像

async function addImageAssets(files) {
  for (const f of files) {
    try {
      const id = P.newId('img');
      const meta = await S.imageLib.add(f, id);
      S.project.imageAssets.push(meta);
      status(`${f.name} を読み込みました（${meta.width}×${meta.height}）`);
    } catch {
      status(`${f.name}: 画像を読み込めませんでした`, true);
    }
  }
  renderAll();
}

/** 画像を再生位置に配置する */
function placeImage(assetId, placement = null) {
  const asset = S.project.imageAssets.find((a) => a.id === assetId);
  if (!asset) return;
  const total = P.totalDuration(S.project);
  if (total <= 0) return status('先にクリップを作ってください', true);
  const W = S.project.output.width, H = S.project.output.height;
  const place = placement ?? defaultPlacement(asset, W, H);
  const start = Math.min(currentTimelineTime(), Math.max(0, total - 0.5));
  commit(`${asset.name} を配置`);
  const im = createImageClip(assetId, start, Math.min(total, start + 4), placementBox(place, asset, W, H));
  im.z = zRange()[1] + 1;
  S.project.images.push(im);
  select('image', im.id);
  setMode('program');
  seekProgram(start, true);
  S.focusArea = 'preview';
  renderAll(); renderFxForm(true);
  status(`${asset.name} を ${PLACEMENTS.find((x) => x.id === place)?.name ?? place} に配置しました`);
}

// ---------------------------------------------------------------- エフェクト一覧
// 今はぼかしだけ。ここに足せば一覧に並ぶ。

const EFFECTS = [
  {
    id: 'telop',
    name: 'テロップ',
    desc: '文字を重ねる。枠で位置と寄せを決められる。',
    key: 'T',
    add: () => addTelop(),
  },
  {
    id: 'blur',
    name: 'ぼかし',
    desc: '区間を全画面ぼかし。顔や表札などのプライバシー保護に。',
    key: 'B',
    add: () => addBlur(),
  },
];

/** SE/BGM のミックス関数（書き出しとプレビューで共通の定義を使う） */
function audioMixer() {
  const clips = S.project.audioClips;
  if (!clips.length || !S.library) return null;
  const lib = S.library, mix = S.project.mix;
  return (planar, n, absStart, ch, rate) => mixInto(planar, n, absStart, ch, rate, clips, lib, mix);
}

// --- ステージ（<video> ＋ オーバーレイ canvas）---
const stage = $('stage');
const overlay = $('overlay');

function fitStage() {
  const wrap = $('videoWrap');
  const ow = S.project.output.width, oh = S.project.output.height;
  const aw = wrap.clientWidth, ah = wrap.clientHeight;
  if (!aw || !ah) return;
  const scale = Math.min(aw / ow, ah / oh);
  stage.style.width = `${Math.floor(ow * scale)}px`;
  stage.style.height = `${Math.floor(oh * scale)}px`;
  if (overlay.width !== ow) { overlay.width = ow; overlay.height = oh; }
}

/** 出力ピクセル ÷ 表示ピクセル。枠線やハンドルの見た目の太さを一定に保つのに使う */
const stageScale = () => (S.project.output.width || 1920) / Math.max(1, stage.clientWidth);

/** いま編集できる枠（テロップ or 画像）。プレビュー上で選択されているもの */
function activeBox() {
  const tel = selectedTelop();
  if (tel) return { kind: 'telop', item: tel };
  const im = selectedImage();
  if (im) return { kind: 'image', item: im };
  return null;
}

function renderOverlay() {
  fitStage();
  const ctx = overlay.getContext('2d');
  const W = overlay.width, H = overlay.height;
  ctx.clearRect(0, 0, W, H);
  const t = currentTimelineTime();

  // ぼかしは <video> 側に CSS filter で掛ける（表示サイズに合わせて半径を換算）
  const px = S.mode === 'program' ? activeBlur(S.project.blurs, t) : 0;
  const disp = stage.clientWidth / (S.project.output.width || 1920);
  video.style.filter = px > 0 ? `blur(${(px * disp).toFixed(2)}px)` : '';
  video.style.transform = px > 0 ? `scale(${(1 + (px * 4) / Math.min(S.project.output.width, S.project.output.height)).toFixed(4)})` : '';

  const sel = activeBox();
  if (S.mode === 'program') {
    drawOverlaysAt(ctx, S.project, t, S.imageLib);
  } else if (sel) {
    // ソースモニターでは、位置調整しやすいよう選択中のものだけ出す
    if (sel.kind === 'image') drawImageClip(ctx, sel.item, S.imageLib);
    else T.drawTelop(ctx, sel.item);
  }

  // 選択枠とハンドル
  if (sel && (S.mode !== 'program' || (t >= sel.item.start && t < sel.item.end))) {
    const sc = stageScale();
    B.drawBoxChrome(ctx, sel.item.box, sc, { color: sel.kind === 'image' ? '#e0ab74' : '#4c9aff' });
    if (boxDrag?.guides?.length) B.drawGuides(ctx, boxDrag.guides, W, H, sc);
  }
}

/** マウス座標 → 出力ピクセル座標 */
function stagePoint(e) {
  const r = overlay.getBoundingClientRect();
  return {
    x: ((e.clientX - r.left) / r.width) * overlay.width,
    y: ((e.clientY - r.top) / r.height) * overlay.height,
  };
}

/** クリック位置にある枠を拾う（テロップ優先、後ろに描いたものから）*/
function pickBox(p, t) {
  const ctx = overlay.getContext('2d');
  const sel = activeBox();
  const list = S.mode === 'program'
    ? overlaysAt(S.project, t)
    : (sel ? [{ kind: sel.kind, item: sel.item }] : []);
  // 手前（z が大きい方）から拾う
  for (let i = list.length - 1; i >= 0; i--) {
    const { kind, item } = list[i];
    if (B.insideBox(item.box, p.x, p.y)) return { kind, item };
    if (kind === 'telop' && B.insideBox(T.textBounds(ctx, item), p.x, p.y)) return { kind, item };
  }
  return null;
}

let boxDrag = null;

overlay.addEventListener('pointerdown', (e) => {
  const p = stagePoint(e);
  const t = currentTimelineTime();
  S.focusArea = 'preview'; // カーソルキーで枠を動かせるようにする

  // まず選択中の枠のハンドルを見る
  const sel = activeBox();
  const r = 9 * stageScale();
  if (sel) {
    const h = B.hitHandle(sel.item.box, p.x, p.y, r);
    if (h) {
      try { overlay.setPointerCapture(e.pointerId); } catch {}
      boxDrag = {
        ...sel, mode: 'resize', handle: h, startX: p.x, startY: p.y,
        orig: { ...sel.item.box }, guides: [], committed: false,
        label: sel.kind === 'image' ? '画像の大きさを変更' : 'テロップの枠を変更',
      };
      renderOverlay();
      return;
    }
  }

  const hit = pickBox(p, t);
  if (!hit) { renderTimeline(); return; }
  try { overlay.setPointerCapture(e.pointerId); } catch {}
  const changed = hit.item.id !== (sel?.item.id ?? null);
  select(hit.kind, hit.item.id);
  boxDrag = {
    ...hit, mode: 'move', startX: p.x, startY: p.y,
    orig: { ...hit.item.box }, guides: [], committed: false,
    label: hit.kind === 'image' ? '画像の位置を変更' : 'テロップの位置を変更',
  };
  overlay.classList.add('grabbing');
  renderAll();
  if (changed) { renderTelopForm(true); renderFxForm(true); }
});

overlay.addEventListener('pointermove', (e) => {
  const p = stagePoint(e);
  const W = overlay.width, H = overlay.height;

  if (!boxDrag) {
    // カーソル形状（ハンドルの上ではリサイズ、枠の中では move）
    const sel = activeBox();
    let cur = 'default';
    if (sel) {
      const h = B.hitHandle(sel.item.box, p.x, p.y, 9 * stageScale());
      if (h) cur = B.handleCursor(h);
    }
    if (cur === 'default' && pickBox(p, currentTimelineTime())) cur = 'grab';
    overlay.style.cursor = cur;
    return;
  }

  const dx = p.x - boxDrag.startX, dy = p.y - boxDrag.startY;
  const item = boxDrag.item;
  if (!boxDrag.committed) {
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return; // クリックだけでは履歴に積まない
    commit(boxDrag.label, `box:${item.id}`);
    boxDrag.committed = true;
  }
  if (boxDrag.mode === 'resize') {
    const asset = boxDrag.kind === 'image' && e.shiftKey
      ? S.project.imageAssets.find((a) => a.id === item.assetId)
      : null;
    let box = B.resizeBox(boxDrag.orig, boxDrag.handle, dx, dy, {
      min: 40,
      aspect: asset ? asset.width / asset.height : null,
    });
    if (!e.altKey && !asset) {
      // 引いている辺を画面端・中央に吸着させる（Alt で解除。比率固定中は無効）
      const snapped = B.snapResize(box, boxDrag.handle, W, H);
      box = snapped.box;
      boxDrag.guides = snapped.guides;
    } else {
      boxDrag.guides = [];
    }
    item.box = B.clampBox(box, W, H);
  } else {
    let box = { ...boxDrag.orig, x: boxDrag.orig.x + dx, y: boxDrag.orig.y + dy };
    if (!e.altKey) {
      const snapped = B.snapBox(box, W, H);   // 端・中央に吸着（Alt で解除）
      box = snapped.box;
      boxDrag.guides = snapped.guides;
    } else {
      boxDrag.guides = [];
    }
    item.box = B.clampBox(box, W, H);          // 画面外へは出さない
  }
  renderOverlay();
  syncBoxNumbers();
});

overlay.addEventListener('pointerup', () => {
  if (!boxDrag) return;
  boxDrag = null;
  overlay.classList.remove('grabbing');
  renderOverlay();
});

// --- ショートカット一覧（フローティング）---
const helpDlg = $('helpDialog');
function toggleHelp(show) {
  const on = show ?? helpDlg.classList.contains('hidden');
  helpDlg.classList.toggle('hidden', !on);
  if (on && !helpDlg.style.left) {
    // 初期位置は画面中央寄り（インスペクタを覆わない）。ヘッダをつかんで動かせる
    helpDlg.style.left = `${Math.max(8, Math.round(innerWidth / 2 - 180))}px`;
    helpDlg.style.top = '58px';
  }
}
$('btnHelp').onclick = () => toggleHelp();
$('helpDialogClose').onclick = () => toggleHelp(false);
(() => {
  const head = $('helpDialogHead');
  let d = null;
  head.addEventListener('pointerdown', (e) => {
    if (e.target.id === 'helpDialogClose') return;
    const r = helpDlg.getBoundingClientRect();
    d = { dx: e.clientX - r.left, dy: e.clientY - r.top };
    head.classList.add('dragging');
    try { head.setPointerCapture(e.pointerId); } catch {}
  });
  head.addEventListener('pointermove', (e) => {
    if (!d) return;
    helpDlg.style.left = `${Math.max(0, Math.min(innerWidth - 60, e.clientX - d.dx))}px`;
    helpDlg.style.top = `${Math.max(0, Math.min(innerHeight - 40, e.clientY - d.dy))}px`;
  });
  head.addEventListener('pointerup', () => { d = null; head.classList.remove('dragging'); });
})();

// --- 右クリックメニュー ---
// canvas の上ではブラウザ標準のメニュー（「全て選択」など）が出て邪魔なので、
// 抑止して必要な項目だけ自前で出す。
const ctxMenu = $('ctxMenu');

function hideContextMenu() { ctxMenu.classList.add('hidden'); }

function showContextMenu(clientX, clientY, items) {
  ctxMenu.innerHTML = '';
  for (const it of items) {
    const b = document.createElement('button');
    b.innerHTML = `<span>${esc(it.label)}</span>${it.key ? `<span class="k">${esc(it.key)}</span>` : ''}`;
    b.onclick = () => { hideContextMenu(); it.run(); };
    ctxMenu.appendChild(b);
  }
  ctxMenu.classList.remove('hidden');
  // 画面からはみ出さない位置に
  const r = ctxMenu.getBoundingClientRect();
  ctxMenu.style.left = `${Math.min(clientX, innerWidth - r.width - 6)}px`;
  ctxMenu.style.top = `${Math.min(clientY, innerHeight - r.height - 6)}px`;
}

document.addEventListener('pointerdown', (e) => {
  if (!ctxMenu.contains(e.target)) hideContextMenu();
}, true);
window.addEventListener('blur', hideContextMenu);

overlay.addEventListener('contextmenu', (e) => {
  e.preventDefault(); // ブラウザ標準のメニューは出さない
  const hit = pickBox(stagePoint(e), currentTimelineTime());
  if (!hit) { hideContextMenu(); return; }
  select(hit.kind, hit.item.id);
  renderAll(); renderTelopForm(true); renderFxForm(true);
  showContextMenu(e.clientX, e.clientY, [
    { label: hit.kind === 'image' ? '画像を削除' : 'テロップを削除', key: 'Delete', run: () => deleteSelected() },
  ]);
});

/**
 * ダブルクリック。
 *  - つまみの上 … 中身にぴったり合うように枠を詰める
 *  - 画像の上   … 等倍（100%）に戻す。画面からはみ出す場合は収まる大きさまで縮める
 */
overlay.addEventListener('dblclick', (e) => {
  const sel = activeBox();
  if (!sel) return;
  const p = stagePoint(e);
  const W = overlay.width, H = overlay.height;
  const onHandle = B.hitHandle(sel.item.box, p.x, p.y, 9 * stageScale());

  if (onHandle) {
    commit(sel.kind === 'image' ? '枠を画像に合わせる' : '枠を文字に合わせる');
    if (sel.kind === 'image') {
      const bmp = S.imageLib.get(sel.item.assetId);
      if (bmp) sel.item.box = B.clampBox(drawnRect(sel.item, bmp), W, H);
    } else {
      const tb = T.textBounds(overlay.getContext('2d'), sel.item);
      sel.item.box = B.clampBox({ x: tb.x, y: tb.y, w: Math.max(40, tb.w), h: Math.max(40, tb.h) }, W, H);
    }
    status(sel.kind === 'image' ? '枠を画像の大きさに合わせました' : '枠を文字の大きさに合わせました');
  } else if (sel.kind === 'image' && B.insideBox(sel.item.box, p.x, p.y)) {
    const asset = S.project.imageAssets.find((a) => a.id === sel.item.assetId);
    if (!asset) return;
    commit('画像を等倍に戻す');
    const b = sel.item.box;
    const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
    const full = { x: cx - asset.width / 2, y: cy - asset.height / 2, w: asset.width, h: asset.height };
    const fitted = B.fitInto(full, W, H); // 画面より大きければ収まるところまで縮める
    sel.item.box = fitted;
    status(fitted.w < asset.width
      ? `等倍だと画面からはみ出すため ${Math.round((fitted.w / asset.width) * 100)}% にしました`
      : '画像を等倍（100%）に戻しました');
  } else {
    return;
  }
  renderAll();
  renderFxForm(true);
  renderTelopForm(true);
});

/** カーソルキーで 1px（Shift で 10px）動かす */
function nudgeBox(dx, dy) {
  const sel = activeBox();
  if (!sel) return false;
  commit(sel.kind === 'image' ? '画像を移動' : 'テロップを移動', `nudge:${sel.item.id}`);
  const b = sel.item.box;
  sel.item.box = B.clampBox({ ...b, x: b.x + dx, y: b.y + dy }, overlay.width, overlay.height);
  renderOverlay();
  syncBoxNumbers();
  return true;
}

// ---------------------------------------------------------------- 描画：ビン / インスペクタ

/** インスペクタのタブ（プロパティ / 出力 / メモ） */
function renderInspTabs() {
  for (const t of document.querySelectorAll('.insptab')) t.classList.toggle('active', t.dataset.insp === S.inspTab);
  $('inspProps').classList.toggle('hidden', S.inspTab !== 'props');
  $('inspOutput').classList.toggle('hidden', S.inspTab !== 'output');
  $('inspNotes').classList.toggle('hidden', S.inspTab !== 'notes');
}

function renderBin() {
  for (const t of document.querySelectorAll('.bintab')) t.classList.toggle('active', t.dataset.bin === S.binTab);
  $('binMedia').classList.toggle('hidden', S.binTab !== 'media');
  $('binFx').classList.toggle('hidden', S.binTab !== 'fx');

  renderMediaBin();
  renderEffectBin();

  const src = curSource();
  $('srcInfo').innerHTML = src
    ? `映像 <b>${esc(src.video.codec)}</b><br>${src.video.width}×${src.video.height} ／ ${src.video.samples.length} フレーム<br>`
      + (src.audio ? `音声 <b>${esc(src.audio.codec)}</b><br>${src.audio.sampleRate} Hz ／ ${src.audio.channels} ch` : '音声トラックなし')
    : '—';
}

function renderMediaBin() {
  const list = $('binList');
  const empty = !S.project.sources.length && !S.project.audioAssets.length && !S.project.imageAssets.length;
  list.innerHTML = empty ? '<div class="empty">mp4 / mp3 / png をここにドロップしても読み込めます</div>' : '';
  if (empty) return;

  for (const s of S.project.sources) {
    const el = document.createElement('div');
    el.className = 'bin-item' + (s.id === S.currentSourceId ? ' active' : '');
    el.innerHTML = `<div class="row"><div class="n">${esc(s.name)}</div>`
      + `<button class="bin-add" title="この素材をまるごとタイムラインに置く。ここから要らない範囲を切り取っていく">全体を置く</button></div>`
      + `<div class="m">${tc(s.duration)} ／ ${(s.size / 1e9).toFixed(2)} GB</div>`;
    el.querySelector('.bin-add').onclick = (ev) => { ev.stopPropagation(); placeWholeSource(s.id); };
    el.onclick = () => selectSource(s.id);
    list.appendChild(el);
  }

  for (const a of S.project.audioAssets) {
    const el = document.createElement('div');
    el.className = 'bin-item audio';
    el.innerHTML = `<div class="row"><div class="n">♪ ${esc(a.name)}</div>`
      + `<button class="bin-add" title="再生位置に配置">＋</button></div>`
      + `<div class="m">${tc(a.duration, false)} ／ ${a.duration > 20 ? 'BGM' : '効果音'}</div>`;
    el.querySelector('.bin-add').onclick = (e) => { e.stopPropagation(); placeAudio(a.id); };
    el.onclick = () => placeAudio(a.id);
    list.appendChild(el);
  }

  for (const a of S.project.imageAssets) {
    const el = document.createElement('div');
    el.className = 'bin-item image';
    el.innerHTML = `<div class="row"><div class="n">▣ ${esc(a.name)}</div></div>`
      + `<div class="m">${a.width}×${a.height}</div>`
      + `<div class="place-row">${PLACEMENTS.map((pl) => `<button data-p="${pl.id}">${pl.name}</button>`).join('')}</div>`;
    const bmp = S.imageLib.get(a.id);
    if (bmp) {
      const cv = document.createElement('canvas');
      const s2 = Math.min(200 / bmp.width, 54 / bmp.height);
      cv.width = Math.max(1, Math.round(bmp.width * s2));
      cv.height = Math.max(1, Math.round(bmp.height * s2));
      cv.className = 'thumb';
      cv.getContext('2d').drawImage(bmp, 0, 0, cv.width, cv.height);
      el.insertBefore(cv, el.querySelector('.place-row'));
    }
    for (const b of el.querySelectorAll('.place-row button')) {
      b.onclick = (e) => { e.stopPropagation(); placeImage(a.id, b.dataset.p); };
    }
    list.appendChild(el);
  }
}

function renderEffectBin() {
  const list = $('fxList');
  list.innerHTML = '';
  for (const fx of EFFECTS) {
    const el = document.createElement('div');
    el.className = 'fx-item';
    el.innerHTML = `<div class="row"><div class="n">${esc(fx.name)}</div>`
      + (fx.key ? `<kbd>${esc(fx.key)}</kbd>` : '')
      + `<button class="bin-add" title="再生位置に追加${fx.key ? `　［ ${fx.key} ］` : ''}">＋</button></div>`
      + `<div class="d">${esc(fx.desc)}</div>`;
    el.querySelector('.bin-add').onclick = (e) => { e.stopPropagation(); fx.add(); };
    el.onclick = () => fx.add();
    list.appendChild(el);
  }
}

function renderInspector() {
  const form = $('clipForm');
  const tel = selectedTelop(), other = selectedBlur() || selectedAudio() || selectedImage();
  $('selHead').textContent = tel ? '選択テロップ'
    : selectedBlur() ? '選択ぼかし' : selectedAudio() ? '選択音源'
    : selectedImage() ? '選択画像' : '選択クリップ';
  // テロップはフローティングダイアログ側、それ以外は fxForm 側に出る
  form.classList.toggle('hidden', !!other || !!tel);

  const clip = S.project.clips.find((c) => c.id === S.selectedClipId);
  if (!clip) { form.innerHTML = '<div class="empty">未選択</div>'; return; }
  const src = S.sources.get(clip.sourceId);
  form.innerHTML = `
    <div class="m" style="color:var(--dim);font-size:11px">${esc(src?.name ?? clip.sourceId)}</div>
    <label>イン点（秒）<input type="number" id="fIn" step="0.01" value="${clip.in.toFixed(2)}"></label>
    <label>アウト点（秒）<input type="number" id="fOut" step="0.01" value="${clip.out.toFixed(2)}"></label>
    <label>音量 <span id="fVolLbl">${Math.round((clip.volume ?? 1) * 100)}%</span>
      <input type="range" id="fVol" min="0" max="200" value="${Math.round((clip.volume ?? 1) * 100)}"></label>
    <div class="m" style="color:var(--dim);font-size:11px">長さ ${tc(P.clipDuration(clip), false)}</div>`;
  $('fIn').onchange = (e) => { commit('イン点を変更'); clip.in = Math.max(0, +e.target.value); renderAll(); };
  $('fOut').onchange = (e) => { commit('アウト点を変更'); clip.out = Math.max(clip.in + 0.05, +e.target.value); renderAll(); };
  $('fVol').oninput = (e) => {
    commit('クリップ音量を変更', `vol:${clip.id}`);
    clip.volume = +e.target.value / 100; $('fVolLbl').textContent = `${e.target.value}%`;
  };
}

// ---------------------------------------------------------------- テロップ編集パネル

function fontOptions(current) {
  const groups = [
    ['システム', T.SYSTEM_FONTS],
    ['Web フォント', T.WEB_FONTS],
  ];
  if (S.userFonts.length) groups.push(['追加したフォント', S.userFonts.map((f) => ({ css: f, label: f }))]);
  if (S.installedFonts) groups.push(['インストール済み', S.installedFonts.map((f) => ({ css: f, label: f }))]);
  let html = '';
  for (const [label, list] of groups) {
    html += `<optgroup label="${esc(label)}">`;
    for (const f of list) {
      html += `<option value="${esc(f.css)}"${f.css === current ? ' selected' : ''}>${esc(f.label)}</option>`;
    }
    html += '</optgroup>';
  }
  // 一覧に無いフォントが設定されている場合の受け皿
  const all = groups.flatMap(([, l]) => l.map((f) => f.css));
  if (current && !all.includes(current)) html = `<option value="${esc(current)}" selected>${esc(current)}</option>` + html;
  return html;
}

let telopFormId = null;

// --- フローティングダイアログ ---
const telDlg = $('telopDialog');

function openTelopDialog() {
  telDlg.classList.remove('hidden');
  if (!telDlg.style.left) {
    // 初期位置は左端（右パネルまで手を伸ばさずに済み、プレビューも隠さない）。
    // ヘッダをつかんで好きな場所へ移せる。位置は覚える。
    telDlg.style.left = '8px';
    telDlg.style.top = `${$('workspace')?.getBoundingClientRect().top ?? 48}px`;
  }
}
function closeTelopDialog() { telDlg.classList.add('hidden'); }

(() => { // ヘッダをつかんで移動
  const head = $('telopDialogHead');
  let d = null;
  head.addEventListener('pointerdown', (e) => {
    if (e.target.id === 'telopDialogClose') return;
    const r = telDlg.getBoundingClientRect();
    d = { dx: e.clientX - r.left, dy: e.clientY - r.top };
    head.classList.add('dragging');
    try { head.setPointerCapture(e.pointerId); } catch {}
  });
  head.addEventListener('pointermove', (e) => {
    if (!d) return;
    telDlg.style.left = `${Math.max(0, Math.min(innerWidth - 60, e.clientX - d.dx))}px`;
    telDlg.style.top = `${Math.max(0, Math.min(innerHeight - 40, e.clientY - d.dy))}px`;
  });
  head.addEventListener('pointerup', () => { d = null; head.classList.remove('dragging'); });
})();
$('telopDialogClose').onclick = () => { closeTelopDialog(); };

function renderTelopForm(force = false) {
  const form = $('telopForm');
  const tel = selectedTelop();
  if (!tel) { telopFormId = null; closeTelopDialog(); return; }
  openTelopDialog();
  if (!force && telopFormId === tel.id) { syncBoxNumbers(); return; }
  telopFormId = tel.id;

  const AL = { left: '⇤', center: '↔', right: '⇥' };
  const VA = { top: '⤒', middle: '↕', bottom: '⤓' };

  form.innerHTML = `
    <label>テキスト（改行で複数行・枠の幅で折り返し）
      <textarea id="telText" rows="2">${esc(tel.text)}</textarea></label>

    <div class="preset-row">
      <select id="telPreset"><option value="">プリセットを適用…</option>
        ${presets().map((p, i) => `<option value="${i}">${esc(p.name)}</option>`).join('')}
      </select>
      <button class="mini" id="telPresetSave" title="現在のスタイルと枠をプリセットとして保存">＋</button>
    </div>

    <label>フォント<select id="telFont">${fontOptions(tel.font)}</select></label>
    <div class="font-actions">
      <button class="mini" id="telFontFile">.ttf を追加</button>
      <button class="mini" id="telFontLocal">PC のフォント一覧</button>
    </div>

    <div class="grid2">
      <label>サイズ <input class="num" type="number" id="telSize" min="16" max="400" value="${tel.size}"></label>
      <label>縁の太さ <input class="num" type="number" id="telSW" min="0" max="60" value="${tel.strokeWidth}"></label>
    </div>

    <div class="grid2">
      <label>横の寄せ
        <div class="align-grid">${['left', 'center', 'right'].map((a) =>
          `<button data-h="${a}" class="${tel.hAlign === a ? 'on' : ''}" title="${a}">${AL[a]}</button>`).join('')}</div></label>
      <label>縦の寄せ
        <div class="align-grid">${['top', 'middle', 'bottom'].map((a) =>
          `<button data-v="${a}" class="${tel.vAlign === a ? 'on' : ''}" title="${a}">${VA[a]}</button>`).join('')}</div></label>
    </div>
    <label class="chk"><input type="checkbox" id="telWrap" ${tel.wrap ? 'checked' : ''}> 枠の幅で折り返す</label>

    <div class="z-row">
      <button class="mini" id="telZFront" title="他の画像・テロップより手前に出す">最前面へ</button>
      <button class="mini" id="telZBack" title="他の画像・テロップより奥に送る">最背面へ</button>
    </div>

    <div class="grid2">
      <div class="swatch"><input type="color" id="telFill" value="${tel.fill}"><span>文字</span></div>
      <div class="swatch"><input type="color" id="telStroke" value="${tel.stroke}"><span>内縁</span></div>
      <div class="swatch"><input type="color" id="telOuter" value="${tel.outerStroke}"><span>白フチ</span></div>
      <label>白フチ倍率 <input class="num" type="number" id="telOuterScale" step="0.1" min="0" max="5" value="${tel.outerScale}"></label>
    </div>

    <label>影 <span id="telShadowLbl">${Math.round(tel.shadow * 100)}%</span>
      <input type="range" id="telShadow" min="0" max="100" value="${Math.round(tel.shadow * 100)}"></label>

    <div class="grid2">
      <label>開始（秒）<input class="num" type="number" id="telStart" step="0.1" value="${tel.start.toFixed(2)}"></label>
      <label>終了（秒）<input class="num" type="number" id="telEnd" step="0.1" value="${tel.end.toFixed(2)}"></label>
    </div>
    <div class="grid2">
      <label>枠 X <input class="num" type="number" id="boxX" value="${Math.round(tel.box.x)}"></label>
      <label>枠 Y <input class="num" type="number" id="boxY" value="${Math.round(tel.box.y)}"></label>
      <label>枠 幅 <input class="num" type="number" id="boxW" value="${Math.round(tel.box.w)}"></label>
      <label>枠 高さ <input class="num" type="number" id="boxH" value="${Math.round(tel.box.h)}"></label>
    </div>
    <div class="sub-label">プレビュー上で枠をドラッグして移動、四隅・辺で大きさを変更。<br>
      移動もリサイズも端と中央に吸着（Alt で解除）。カーソルキーで 1px（Shift で 10px）。<br>
      つまみをダブルクリックすると枠を文字の大きさに合わせます。</div>`;

  const live = () => { renderOverlay(); renderTimeline(); };
  const bind = (id, fn, ev = 'input') => $(id).addEventListener(ev, (e) => {
    commit('テロップを編集', `tel:${tel.id}:${id}`);
    fn(e.target.value, e); live();
  });

  $('telText').addEventListener('input', (e) => {
    commit('テロップの文字を編集', `telText:${tel.id}`);
    tel.text = e.target.value; live();
  });
  bind('telFont', (v) => { tel.font = v; S.telopStyle.font = v; });
  bind('telSize', (v) => { tel.size = Math.max(8, +v); S.telopStyle.size = tel.size; });
  bind('telSW', (v) => { tel.strokeWidth = Math.max(0, +v); S.telopStyle.strokeWidth = tel.strokeWidth; });
  bind('telFill', (v) => { tel.fill = v; S.telopStyle.fill = v; });
  bind('telStroke', (v) => { tel.stroke = v; S.telopStyle.stroke = v; });
  bind('telOuter', (v) => { tel.outerStroke = v; S.telopStyle.outerStroke = v; });
  bind('telOuterScale', (v) => { tel.outerScale = Math.max(0, +v); S.telopStyle.outerScale = tel.outerScale; });
  bind('telShadow', (v) => { tel.shadow = +v / 100; S.telopStyle.shadow = tel.shadow; $('telShadowLbl').textContent = `${v}%`; });
  bind('telStart', (v) => { tel.start = Math.max(0, +v); });
  bind('telEnd', (v) => { tel.end = Math.max(tel.start + 0.1, +v); });
  bind('boxX', (v) => { tel.box.x = +v; });
  bind('boxY', (v) => { tel.box.y = +v; });
  bind('boxW', (v) => { tel.box.w = Math.max(40, +v); });
  bind('boxH', (v) => { tel.box.h = Math.max(40, +v); });
  $('telWrap').addEventListener('change', (e) => {
    commit('折り返しを切り替え'); tel.wrap = e.target.checked; S.telopStyle.wrap = tel.wrap; live();
  });

  for (const b of form.querySelectorAll('[data-h]')) {
    b.onclick = () => {
      commit('テロップの寄せを変更');
      tel.hAlign = b.dataset.h; S.telopStyle.hAlign = tel.hAlign;
      for (const o of form.querySelectorAll('[data-h]')) o.classList.toggle('on', o === b);
      live();
    };
  }
  for (const b of form.querySelectorAll('[data-v]')) {
    b.onclick = () => {
      commit('テロップの寄せを変更');
      tel.vAlign = b.dataset.v; S.telopStyle.vAlign = tel.vAlign;
      for (const o of form.querySelectorAll('[data-v]')) o.classList.toggle('on', o === b);
      live();
    };
  }

  $('telZFront').onclick = () => { commit('最前面へ'); bringToFront(tel); renderAll(); };
  $('telZBack').onclick = () => { commit('最背面へ'); sendToBack(tel); renderAll(); };

  $('telPreset').onchange = (e) => {
    const p = presets()[+e.target.value];
    if (!p) return;
    commit(`プリセット「${p.name}」を適用`);
    const { box, ...rest } = p.style;
    Object.assign(tel, rest);
    if (box) tel.box = { ...box };
    S.telopStyle = { ...p.style };
    e.target.value = '';
    renderTelopForm(true);
    live();
  };
  $('telPresetSave').onclick = () => {
    const name = prompt('プリセット名', `プリセット ${presets().length + 1}`);
    if (!name) return;
    commit('プリセットを保存');
    const { id, text, start, end, box, ...style } = tel;
    S.project.telopPresets = [...presets(), { name, style: { ...style, box: { ...box } } }];
    renderTelopForm(true);
    status(`プリセット「${name}」を保存しました`);
  };
  $('telFontFile').onclick = () => $('fontInput').click();
  $('telFontLocal').onclick = async () => {
    try {
      S.installedFonts = await T.queryInstalledFonts();
      renderTelopForm(true);
      status(`インストール済みフォント ${S.installedFonts.length} 件を読み込みました`);
    } catch (e) { status(e.message, true); }
  };
}

/** ドラッグ中など、フォームを作り直さずに枠の数値だけ追従させる */
function syncBoxNumbers() {
  const sel = activeBox();
  if (!sel) return;
  const set = (id, v) => { const el = $(id); if (el && document.activeElement !== el) el.value = v; };
  const b = sel.item.box;
  set('boxX', Math.round(b.x)); set('boxY', Math.round(b.y));
  set('boxW', Math.round(b.w)); set('boxH', Math.round(b.h));
}

let fxFormKey = null;

/** ぼかし・音源・画像のプロパティ（インスペクタ側） */
function renderFxForm(force = false) {
  const form = $('fxForm');
  const blur = selectedBlur(), ac = selectedAudio(), im = selectedImage();
  const key = blur ? `b:${blur.id}` : ac ? `a:${ac.id}` : im ? `i:${im.id}` : null;
  form.classList.toggle('hidden', !key);
  if (!key) { fxFormKey = null; return; }
  if (!force && fxFormKey === key) { syncBoxNumbers(); syncFxNumbers(); return; }
  fxFormKey = key;

  const live = () => { renderTimeline(); renderOverlay(); };

  if (blur) {
    form.innerHTML = `
      <div class="sub-label">全画面ぼかし（プライバシー保護用）</div>
      <label>強さ <span id="fxStrLbl">${blur.strength}</span>
        <input type="range" id="fxStr" min="4" max="120" value="${blur.strength}"></label>
      <div class="grid2">
        <label>開始（秒）<input class="num" type="number" id="fxStart" step="0.1" value="${blur.start.toFixed(2)}"></label>
        <label>終了（秒）<input class="num" type="number" id="fxEnd" step="0.1" value="${blur.end.toFixed(2)}"></label>
      </div>
      <div class="sub-label">長さ ${tc(blur.end - blur.start, false)}</div>`;
    const b = (id, fn) => $(id).addEventListener('input', (e) => {
      commit('ぼかしを編集', `blurF:${blur.id}:${id}`); fn(e.target.value); live();
    });
    b('fxStr', (v) => { blur.strength = +v; $('fxStrLbl').textContent = v; });
    b('fxStart', (v) => { blur.start = Math.max(0, +v); });
    b('fxEnd', (v) => { blur.end = Math.max(blur.start + 0.1, +v); });
    return;
  }

  if (im) {
    const a = S.project.imageAssets.find((x) => x.id === im.assetId);
    form.innerHTML = `
      <div class="sub-label">${esc(a?.name ?? im.assetId)}${a ? `（${a.width}×${a.height}）` : ''}</div>
      <div class="place-row">${PLACEMENTS.map((pl) => `<button data-p="${pl.id}">${pl.name}</button>`).join('')}</div>
      <div class="z-row">
        <button class="mini" id="zFront" title="他の画像・テロップより手前に出す">最前面へ</button>
        <button class="mini" id="zBack" title="他の画像・テロップより奥に送る">最背面へ</button>
      </div>
      <label>不透明度 <span id="imOpLbl">${Math.round((im.opacity ?? 1) * 100)}%</span>
        <input type="range" id="imOp" min="0" max="100" value="${Math.round((im.opacity ?? 1) * 100)}"></label>
      <label class="chk"><input type="checkbox" id="imStretch" ${im.fit === 'stretch' ? 'checked' : ''}> 枠いっぱいに引き伸ばす（比率を無視）</label>
      <div class="grid2">
        <label>開始（秒）<input class="num" type="number" id="imStart" step="0.1" value="${im.start.toFixed(2)}"></label>
        <label>終了（秒）<input class="num" type="number" id="imEnd" step="0.1" value="${im.end.toFixed(2)}"></label>
      </div>
      <div class="grid2">
        <label>枠 X <input class="num" type="number" id="boxX" value="${Math.round(im.box.x)}"></label>
        <label>枠 Y <input class="num" type="number" id="boxY" value="${Math.round(im.box.y)}"></label>
        <label>枠 幅 <input class="num" type="number" id="boxW" value="${Math.round(im.box.w)}"></label>
        <label>枠 高さ <input class="num" type="number" id="boxH" value="${Math.round(im.box.h)}"></label>
      </div>
      <div class="sub-label">プレビュー上で枠をドラッグして移動、四隅・辺で拡大縮小。<br>
        移動もリサイズも端と中央に吸着（Alt で解除）。Shift ＋ 角のドラッグで比率を保つ。<br>
        カーソルキーで 1px（Shift で 10px）。<br>
        <b>つまみをダブルクリック</b>＝枠を画像に合わせる／<b>画像をダブルクリック</b>＝等倍に戻す。</div>`;
    const b = (id, fn) => $(id).addEventListener('input', (e) => {
      commit('画像を編集', `imF:${im.id}:${id}`); fn(e.target.value); live();
    });
    b('imOp', (v) => { im.opacity = +v / 100; $('imOpLbl').textContent = `${v}%`; });
    b('imStart', (v) => { im.start = Math.max(0, +v); });
    b('imEnd', (v) => { im.end = Math.max(im.start + 0.1, +v); });
    b('boxX', (v) => { im.box.x = +v; });
    b('boxY', (v) => { im.box.y = +v; });
    b('boxW', (v) => { im.box.w = Math.max(20, +v); });
    b('boxH', (v) => { im.box.h = Math.max(20, +v); });
    $('zFront').onclick = () => { commit('最前面へ'); bringToFront(im); renderAll(); };
    $('zBack').onclick = () => { commit('最背面へ'); sendToBack(im); renderAll(); };
    $('imStretch').addEventListener('change', (e) => {
      commit('画像の伸縮を切り替え'); im.fit = e.target.checked ? 'stretch' : 'contain'; live();
    });
    for (const btn of form.querySelectorAll('.place-row button')) {
      btn.onclick = () => {
        const a2 = S.project.imageAssets.find((x) => x.id === im.assetId);
        if (!a2) return;
        commit('画像の配置を変更');
        im.box = placementBox(btn.dataset.p, a2, S.project.output.width, S.project.output.height);
        renderFxForm(true); live();
      };
    }
    return;
  }

  const asset = S.project.audioAssets.find((a) => a.id === ac.assetId);
  form.innerHTML = `
    <div class="sub-label">${esc(asset?.name ?? ac.assetId)}（${ac.kind === 'bgm' ? 'BGM' : '効果音'}）</div>
    <label>音量 <span id="fxVolLbl">${Math.round(ac.volume * 100)}%</span>
      <input type="range" id="fxVol" min="0" max="200" value="${Math.round(ac.volume * 100)}"></label>
    <div class="grid2">
      <label>フェードイン（秒）<input class="num" type="number" id="fxFi" step="0.1" min="0" value="${ac.fadeIn}"></label>
      <label>フェードアウト（秒）<input class="num" type="number" id="fxFo" step="0.1" min="0" value="${ac.fadeOut}"></label>
    </div>
    <div class="grid2">
      <label>開始（秒）<input class="num" type="number" id="fxStart" step="0.1" value="${ac.start.toFixed(2)}"></label>
      <label>長さ（秒）<input class="num" type="number" id="fxDur" step="0.1" value="${ac.duration.toFixed(2)}"></label>
    </div>
    <label>素材の頭出し（秒）<input class="num" type="number" id="fxOff" step="0.1" min="0" value="${(ac.offset ?? 0).toFixed(2)}"></label>
    <label class="chk"><input type="checkbox" id="fxLoop" ${ac.loop ? 'checked' : ''}> 終了位置まで繰り返す（ループ）</label>
    <div class="sub-label">素材より長い尺にすると頭に戻って繰り返します。<br>
      BGM を重ねて両方にフェードを付ければクロスフェードになります。</div>`;
  const b = (id, fn) => $(id).addEventListener('input', (e) => {
    commit('音源を編集', `acF:${ac.id}:${id}`); fn(e.target.value); live();
  });
  b('fxVol', (v) => { ac.volume = +v / 100; $('fxVolLbl').textContent = `${v}%`; });
  b('fxFi', (v) => { ac.fadeIn = Math.max(0, +v); });
  b('fxFo', (v) => { ac.fadeOut = Math.max(0, +v); });
  b('fxStart', (v) => { ac.start = Math.max(0, +v); });
  b('fxDur', (v) => { ac.duration = Math.max(0.1, +v); });
  b('fxOff', (v) => { ac.offset = Math.max(0, +v); });
  $('fxLoop').addEventListener('change', (e) => {
    commit('ループを切り替え'); ac.loop = e.target.checked; live();
  });
}

function syncFxNumbers() {
  const set = (id, v) => { const el = $(id); if (el && document.activeElement !== el) el.value = v; };
  const blur = selectedBlur(), ac = selectedAudio(), im = selectedImage();
  if (blur) { set('fxStart', blur.start.toFixed(2)); set('fxEnd', blur.end.toFixed(2)); }
  else if (ac) { set('fxStart', ac.start.toFixed(2)); set('fxDur', ac.duration.toFixed(2)); }
  else if (im) { set('imStart', im.start.toFixed(2)); set('imEnd', im.end.toFixed(2)); }
}

function renderTransport() {
  const src = curSource();
  const dur = S.mode === 'program' ? P.totalDuration(S.project) : (src?.duration ?? 0);
  const cur = S.mode === 'program' ? S.programTime : video.currentTime;
  $('tcCur').textContent = tc(cur);
  $('tcDur').textContent = tc(dur);
  $('btnPlay').textContent = video.paused ? '▶' : '❚❚';
  $('rateLabel').textContent = `×${video.playbackRate}`;
  const inV = S.mode === 'program' ? S.zoneIn : S.markIn;
  const outV = S.mode === 'program' ? S.zoneOut : S.markOut;
  $('lblIn').textContent = inV === null ? '--:--' : tc(inV, false);
  $('lblOut').textContent = outV === null ? '--:--' : tc(outV, false);
  $('lblLen').textContent = (inV !== null && outV !== null) ? tc(outV - inV, false) : '--:--';
  $('totalDur').textContent = tc(P.totalDuration(S.project), false);
  $('clipCount').textContent = S.project.clips.length;
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---------------------------------------------------------------- 描画：スクラブバー

function renderScrub() {
  const cv = $('scrubBar');
  const dpr = devicePixelRatio || 1;
  const w = cv.clientWidth, h = 34;
  if (cv.width !== w * dpr) { cv.width = w * dpr; cv.height = h * dpr; }
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const src = curSource();
  const dur = S.mode === 'program' ? P.totalDuration(S.project) : (src?.duration ?? 0);
  ctx.fillStyle = '#2a2e37';
  ctx.fillRect(0, 12, w, 12);
  if (!dur) return;

  if (S.mode === 'source') {
    // 現在素材を使っているクリップを薄く表示
    ctx.fillStyle = '#3f5a8a';
    for (const c of S.project.clips) {
      if (c.sourceId !== S.currentSourceId) continue;
      ctx.fillRect((c.in / dur) * w, 12, Math.max(1, ((c.out - c.in) / dur) * w), 12);
    }
    // イン／アウト
    const a = S.markIn, b = S.markOut;
    if (a !== null || b !== null) {
      const x0 = ((a ?? 0) / dur) * w, x1 = ((b ?? dur) / dur) * w;
      ctx.fillStyle = '#f0c33c33';
      ctx.fillRect(x0, 12, x1 - x0, 12);
      ctx.fillStyle = '#f0c33c';
      if (a !== null) ctx.fillRect(x0 - 1, 8, 3, 20);
      if (b !== null) ctx.fillRect(x1 - 2, 8, 3, 20);
    }
  } else {
    ctx.fillStyle = '#3f5a8a';
    ctx.fillRect(0, 12, w, 12);
    // 選択中の範囲
    const zr = zoneRange();
    if (zr) {
      const x0 = (zr[0] / dur) * w, x1 = (zr[1] / dur) * w;
      ctx.fillStyle = '#f0c33c55';
      ctx.fillRect(x0, 12, x1 - x0, 12);
      ctx.fillStyle = '#f0c33c';
      ctx.fillRect(x0 - 1, 8, 2, 20);
      ctx.fillRect(x1 - 1, 8, 2, 20);
    }
  }

  const cur = S.mode === 'program' ? S.programTime : video.currentTime;
  const px = (cur / dur) * w;
  ctx.fillStyle = '#e8ebf0';
  ctx.fillRect(px - 1, 4, 2, 26);
  ctx.beginPath(); ctx.moveTo(px - 5, 4); ctx.lineTo(px + 5, 4); ctx.lineTo(px, 10); ctx.fill();
}

$('scrubBar').addEventListener('pointerdown', (e) => {
  const cv = e.currentTarget;
  try { cv.setPointerCapture(e.pointerId); } catch {}
  const move = (ev) => {
    const r = cv.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width));
    const dur = S.mode === 'program' ? P.totalDuration(S.project) : (curSource()?.duration ?? 0);
    if (S.mode === 'program') seekProgram(ratio * dur); else video.currentTime = ratio * dur;
    renderScrub(); renderTransport();
  };
  move(e);
  cv.onpointermove = (ev) => { if (ev.buttons) move(ev); };
  cv.onpointerup = () => { cv.onpointermove = null; cv.onpointerup = null; };
});

// ---------------------------------------------------------------- 描画：タイムライン

const tlCanvas = $('tlCanvas');
const RULER_H = 26, FX_H = 22, IMG_H = 30, TELOP_H = 30, TRACK_H = 64, AUD_H = 48;
const Y_FX = RULER_H;
const Y_IMG = Y_FX + FX_H;
const Y_TELOP = Y_IMG + IMG_H;
const Y_V = Y_TELOP + TELOP_H;
const Y_A = Y_V + TRACK_H;
const Y_A2 = Y_A + TRACK_H;

function tlSize() {
  const wrap = $('tlWrap');
  const dpr = devicePixelRatio || 1;
  const w = wrap.clientWidth, h = wrap.clientHeight;
  if (tlCanvas.width !== Math.round(w * dpr) || tlCanvas.height !== Math.round(h * dpr)) {
    tlCanvas.width = Math.round(w * dpr); tlCanvas.height = Math.round(h * dpr);
  }
  return { w, h, dpr };
}
const secToX = (t) => (t - S.scrollSec) * S.pxPerSec;
const xToSec = (x) => x / S.pxPerSec + S.scrollSec;

function zoomFit() {
  // クリップだけでなく、末尾に伸びたテロップ・ぼかし・BGM まで含めて収める
  const total = contentEndSec();
  const w = $('tlWrap').clientWidth || 800;
  S.scrollSec = 0;
  S.pxPerSec = total > 0 ? Math.max(0.5, (w - 20) / total) : 8;
  renderTimeline();
}

let lastView = '';
function renderTimeline() {
  const { w, h, dpr } = tlSize();
  // 表示範囲が変わったら、まだ手を付けていない生成要求は捨てる（見えない所を作らない）
  const view = `${S.scrollSec.toFixed(2)}:${S.pxPerSec.toFixed(2)}:${w}`;
  if (view !== lastView) { lastView = view; thumbs.clearPending(); waves.clearPending(); }
  const ctx = tlCanvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#191c22';
  ctx.fillRect(0, 0, w, h);

  // --- ルーラー ---
  ctx.fillStyle = '#23262e';
  ctx.fillRect(0, 0, w, RULER_H);
  const step = niceStep(S.pxPerSec);
  ctx.strokeStyle = '#3a404b'; ctx.fillStyle = '#8b93a1';
  ctx.font = '10px ui-monospace, monospace'; ctx.textBaseline = 'middle';
  ctx.beginPath();
  const t0 = Math.floor(S.scrollSec / step) * step;
  for (let t = t0; secToX(t) < w; t += step) {
    const x = Math.round(secToX(t)) + 0.5;
    if (x < 0) continue;
    ctx.moveTo(x, RULER_H - 8); ctx.lineTo(x, RULER_H);
    ctx.fillText(tc(t, t >= 3600), x + 3, RULER_H / 2 - 2);
  }
  ctx.stroke();

  // --- トラック背景 ---
  ctx.fillStyle = '#191f22'; ctx.fillRect(0, Y_FX, w, FX_H);
  ctx.fillStyle = '#241d16'; ctx.fillRect(0, Y_IMG, w, IMG_H);
  ctx.fillStyle = '#1b1d24'; ctx.fillRect(0, Y_TELOP, w, TELOP_H);
  ctx.fillStyle = '#1e2128'; ctx.fillRect(0, Y_V, w, TRACK_H);
  ctx.fillStyle = '#1c1f26'; ctx.fillRect(0, Y_A, w, TRACK_H);
  ctx.fillStyle = '#1d1b26'; ctx.fillRect(0, Y_A2, w, AUD_H);
  ctx.strokeStyle = '#2b303a'; ctx.beginPath();
  for (const y of [Y_IMG, Y_TELOP, Y_V, Y_A, Y_A2, Y_A2 + AUD_H]) { ctx.moveTo(0, y + 0.5); ctx.lineTo(w, y + 0.5); }
  ctx.stroke();

  // --- クリップ ---
  for (const { clip, offset } of P.withTimelineOffsets(S.project)) {
    const x = secToX(offset);
    const cw = P.clipDuration(clip) * S.pxPerSec;
    if (x + cw < -5 || x > w + 5) continue;
    const sel = clip.id === S.selectedClipId;
    drawClip(ctx, x, Y_V + 2, cw, TRACK_H - 6, clip, sel, 'video');
    drawClip(ctx, x, Y_A + 2, cw, TRACK_H - 6, clip, sel, 'audio');
  }

  // --- ぼかし ---
  for (const b of S.project.blurs) {
    const x = secToX(b.start), bw = (b.end - b.start) * S.pxPerSec;
    if (x + bw < -5 || x > w + 5) continue;
    drawFxBlock(ctx, x, Y_FX + 2, Math.max(3, bw), FX_H - 5, `ぼかし ${b.strength}`,
      b.id === S.selectedBlurId, ['#8fd8c4', '#4e9c85'], '#0d2a22');
  }

  // --- SE / BGM ---
  for (const ac of S.project.audioClips) {
    const x = secToX(ac.start), aw = ac.duration * S.pxPerSec;
    if (x + aw < -5 || x > w + 5) continue;
    const asset = S.project.audioAssets.find((a) => a.id === ac.assetId);
    const [ry, rh] = audioRowRect(ac);
    drawAudioClip(ctx, x, ry, Math.max(3, aw), rh, ac, asset, ac.id === S.selectedAudioId);
  }

  // --- 画像 ---
  for (const im of S.project.images) {
    const x = secToX(im.start), iw = (im.end - im.start) * S.pxPerSec;
    if (x + iw < -5 || x > w + 5) continue;
    const a = S.project.imageAssets.find((y) => y.id === im.assetId);
    drawFxBlock(ctx, x, Y_IMG + 2, Math.max(3, iw), IMG_H - 5, `▣ ${a?.name ?? ''}`,
      im.id === S.selectedImageId, ['#e6b482', '#b57a3e'], '#2b1a06');
  }

  // --- テロップ ---
  for (const tel of S.project.telops) {
    const x = secToX(tel.start);
    const tw = (tel.end - tel.start) * S.pxPerSec;
    if (x + tw < -5 || x > w + 5) continue;
    drawTelopBlock(ctx, x, Y_TELOP + 3, Math.max(3, tw), TELOP_H - 7, tel, tel.id === S.selectedTelopId);
  }

  // --- 範囲選択（ゾーン）---
  const zr = zoneRange() ?? (S.zoneIn !== null ? [S.zoneIn, S.zoneIn] : null);
  if (zr) {
    const zx0 = secToX(zr[0]), zx1 = secToX(zr[1]);
    ctx.fillStyle = '#f0c33c18';
    ctx.fillRect(zx0, RULER_H, zx1 - zx0, h - RULER_H);
    ctx.fillStyle = '#f0c33c';
    ctx.fillRect(zx0, 0, Math.max(2, zx1 - zx0), 4);        // ルーラー上の帯
    ctx.fillRect(zx0 - 1, 0, 2, h);
    ctx.fillRect(zx1 - 1, 0, 2, h);
    // 端の三角マーカー
    ctx.beginPath(); ctx.moveTo(zx0, 4); ctx.lineTo(zx0 + 9, 4); ctx.lineTo(zx0, 13); ctx.fill();
    ctx.beginPath(); ctx.moveTo(zx1, 4); ctx.lineTo(zx1 - 9, 4); ctx.lineTo(zx1, 13); ctx.fill();
  }

  // --- 吸着位置の目印 ---
  if (S.snapLine != null) {
    const sx = secToX(S.snapLine);
    if (sx >= 0 && sx <= w) {
      ctx.strokeStyle = '#ff5fa2'; ctx.lineWidth = 1.5;
      ctx.setLineDash([7, 5]);
      ctx.beginPath(); ctx.moveTo(sx + 0.5, RULER_H); ctx.lineTo(sx + 0.5, h); ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  // --- プレイヘッド ---
  const px = secToX(S.programTime);
  if (px >= 0 && px <= w) {
    ctx.strokeStyle = '#e8ebf0'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(px + 0.5, 0); ctx.lineTo(px + 0.5, h); ctx.stroke();
    ctx.fillStyle = '#e8ebf0';
    ctx.beginPath(); ctx.moveTo(px - 6, 0); ctx.lineTo(px + 6, 0); ctx.lineTo(px, 9); ctx.fill();
  }
}

function drawClip(ctx, x, y, w, h, clip, sel, kind) {
  const src = S.sources.get(clip.sourceId);
  const r = 3;
  const base = kind === 'video' ? (sel ? '#6f93e0' : '#4a68a8') : (sel ? '#5fb890' : '#3a7f5f');
  const top = kind === 'video' ? (sel ? '#8fb2ff' : '#5b7fd4') : (sel ? '#7fd8ab' : '#4aa87a');
  ctx.save();
  ctx.beginPath();
  roundRect(ctx, x, y, Math.max(2, w), h, r);
  const g = ctx.createLinearGradient(0, y, 0, y + h);
  g.addColorStop(0, top); g.addColorStop(1, base);
  ctx.fillStyle = g; ctx.fill();
  ctx.strokeStyle = sel ? '#ffffffcc' : '#00000066'; ctx.lineWidth = sel ? 2 : 1; ctx.stroke();
  if (w > 40) {
    ctx.clip();
    if (kind === 'video') drawFilmstrip(ctx, x, y, w, h, clip, src);
    else drawClipWave(ctx, x, y, w, h, clip, src);

    ctx.fillStyle = kind === 'video' ? '#0e131bee' : '#0e131bcc';
    ctx.font = '10px -apple-system, sans-serif'; ctx.textBaseline = 'top';
    const label = kind === 'video'
      ? `${src?.name ?? '?'}  ${tc(clip.in, false)}`
      : `${tc(P.clipDuration(clip), false)}`;
    // サムネイルの上でも読めるよう、ラベルの背に軽く敷く
    const tw = ctx.measureText(label).width;
    ctx.save();
    ctx.fillStyle = '#00000055';
    ctx.fillRect(x + 2, y + 2, tw + 6, 13);
    ctx.restore();
    ctx.fillText(label, x + 5, y + 4);
  }
  ctx.restore();
}

function drawFxBlock(ctx, x, y, w, h, label, sel, colors, textColor) {
  ctx.save();
  ctx.beginPath(); roundRect(ctx, x, y, w, h, 3);
  const g = ctx.createLinearGradient(0, y, 0, y + h);
  g.addColorStop(0, colors[0]); g.addColorStop(1, colors[1]);
  ctx.fillStyle = g; ctx.fill();
  ctx.strokeStyle = sel ? '#ffffffdd' : '#00000066'; ctx.lineWidth = sel ? 2 : 1; ctx.stroke();
  if (w > 40) {
    ctx.clip();
    ctx.fillStyle = textColor; ctx.font = '10px -apple-system, sans-serif'; ctx.textBaseline = 'middle';
    ctx.fillText(label, x + 5, y + h / 2);
  }
  ctx.restore();
}

/** A2 は上段が効果音、下段が BGM。重ならないので掴みやすい */
function audioRowRect(ac) {
  const half = (AUD_H - 6) / 2;
  return ac.kind === 'bgm' ? [Y_A2 + 3 + half + 1, half - 1] : [Y_A2 + 3, half - 1];
}

function drawAudioClip(ctx, x, y, w, h, ac, asset, sel) {
  ctx.save();
  ctx.beginPath(); roundRect(ctx, x, y, w, h, 3);
  const bgm = ac.kind === 'bgm';
  const g = ctx.createLinearGradient(0, y, 0, y + h);
  g.addColorStop(0, sel ? '#b6a9f2' : (bgm ? '#7b6fd0' : '#9a7fd8'));
  g.addColorStop(1, sel ? '#8f80d8' : (bgm ? '#5a4fa4' : '#7358ad'));
  ctx.fillStyle = g; ctx.fill();
  ctx.strokeStyle = sel ? '#ffffffdd' : '#00000066'; ctx.lineWidth = sel ? 2 : 1; ctx.stroke();
  ctx.clip();

  // 波形（AudioBuffer から。メモリ上なので即時に出る）
  if (S.showWaves && S.library?.has(ac.assetId) && w > 6) {
    let wf = bgmPeaks.get(ac.assetId);
    if (!wf) { wf = bufferPeaks(S.library.get(ac.assetId)); bgmPeaks.set(ac.assetId, wf); }
    const peaks = wf.peaks;
    const mid = y + h / 2, amp = h * 0.42 * wf.scale;
    const buf = S.library.get(ac.assetId);
    const loopLen = Math.max(0.001, buf.duration - (ac.offset ?? 0));
    ctx.strokeStyle = '#1a1436aa'; ctx.lineWidth = 1;
    ctx.beginPath();
    for (let px = 0; px < w; px++) {
      let local = px / S.pxPerSec;
      if (ac.loop) local = local % loopLen;
      const b = Math.floor(((ac.offset ?? 0) + local) * BINS_PER_SEC);
      const v = b >= 0 && b < peaks.length ? peaks[b] : 0;
      const a = v * amp;
      ctx.moveTo(x + px + 0.5, mid - a); ctx.lineTo(x + px + 0.5, mid + a);
    }
    ctx.stroke();
  }

  // フェードを台形で見せる
  if ((ac.fadeIn > 0 || ac.fadeOut > 0) && w > 8) {
    ctx.fillStyle = '#00000055';
    const fi = Math.min(w, ac.fadeIn * S.pxPerSec), fo = Math.min(w, ac.fadeOut * S.pxPerSec);
    if (fi > 0) { ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + fi, y); ctx.lineTo(x, y + h); ctx.fill(); }
    if (fo > 0) { ctx.beginPath(); ctx.moveTo(x + w, y); ctx.lineTo(x + w, y + h); ctx.lineTo(x + w - fo, y); ctx.fill(); }
  }
  if (w > 30) {
    ctx.fillStyle = '#14102a'; ctx.font = '10px -apple-system, sans-serif'; ctx.textBaseline = 'middle';
    ctx.fillText(`${bgm ? '♪' : '▸'} ${asset?.name ?? ''}  ${Math.round(ac.volume * 100)}%`, x + 5, y + h / 2);
  }
  ctx.restore();
}

function drawTelopBlock(ctx, x, y, w, h, tel, sel) {
  ctx.save();
  ctx.beginPath(); roundRect(ctx, x, y, w, h, 3);
  const g = ctx.createLinearGradient(0, y, 0, y + h);
  g.addColorStop(0, sel ? '#f2d98a' : '#c9a94e'); g.addColorStop(1, sel ? '#d9b957' : '#a8862f');
  ctx.fillStyle = g; ctx.fill();
  ctx.strokeStyle = sel ? '#ffffffdd' : '#00000066'; ctx.lineWidth = sel ? 2 : 1; ctx.stroke();
  if (w > 24) {
    ctx.clip();
    ctx.fillStyle = '#2a1f00'; ctx.font = '11px -apple-system, sans-serif'; ctx.textBaseline = 'middle';
    ctx.fillText(String(tel.text).replace(/\n/g, ' ') || '（空）', x + 5, y + h / 2);
  }
  ctx.restore();
}

/** クリップの上にサムネイルを並べる。無い分は生成を予約して次の描画で出る */
function drawFilmstrip(ctx, x, y, w, h, clip, src) {
  if (!S.showThumbs || !src) return;
  const th = Math.min(h - 2, THUMB_H);
  const tw = Math.round((th * THUMB_W) / THUMB_H);
  const step = tw + 1;
  // 画面内に入っている部分だけ要求する
  const vw = $('tlWrap').clientWidth || 800;
  const from = Math.max(0, Math.floor((-x) / step));
  const to = Math.min(Math.ceil(w / step), Math.ceil((vw - x) / step));
  for (let i = from; i < to; i++) {
    const px = x + i * step;
    const sec = clip.in + (i * step) / S.pxPerSec;
    if (sec >= clip.out) break;
    const bmp = thumbs.get(src, sec);
    if (bmp) ctx.drawImage(bmp, px, y + (h - th) / 2, tw, th);
  }
}

/** クリップの音声波形。素材から実際にデコードしたピークを使う */
function drawClipWave(ctx, x, y, w, h, clip, src) {
  const mid = y + h / 2;
  if (!S.showWaves || !src?.audio) {
    ctx.strokeStyle = '#0e131b55';
    ctx.beginPath(); ctx.moveTo(x, mid); ctx.lineTo(x + w, mid); ctx.stroke();
    return;
  }
  const t0 = clip.in, t1 = clip.out;
  waves.ensure(src, t0, t1);
  const peaks = waves.peaksFor(src);
  const amp = h * 0.44 * waves.scaleFor(src);
  ctx.strokeStyle = '#0e2a1daa';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let px = 0; px < w; px++) {
    const sec = t0 + px / S.pxPerSec;
    if (sec >= t1) break;
    // 1px に複数ビンが入る場合は最大値を採る
    const b0 = Math.floor(sec * BINS_PER_SEC);
    const b1 = Math.max(b0 + 1, Math.floor((t0 + (px + 1) / S.pxPerSec) * BINS_PER_SEC));
    let v = 0;
    for (let b = b0; b < b1 && b < peaks.length; b++) if (peaks[b] > v) v = peaks[b];
    const a = v * amp;
    ctx.moveTo(x + px + 0.5, mid - a); ctx.lineTo(x + px + 0.5, mid + a);
  }
  ctx.stroke();
}

function roundRect(ctx, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function niceStep(pxPerSec) {
  const targets = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];
  for (const t of targets) if (t * pxPerSec >= 70) return t;
  return 3600;
}

// --- タイムラインの吸着 ---
// テロップ・画像・SE はカットの切り替わりに合わせて置くことが多いので、
// クリップの境目（と再生位置）に吸わせる。Alt で解除。

function snapTargets() {
  const list = [0];
  let t = 0;
  for (const c of S.project.clips) { t += P.clipDuration(c); list.push(t); }
  list.push(S.programTime);
  return list;
}

/** 1 点を吸着させる。tol は画面上の距離なので、拡大率に関わらず同じ感覚になる */
function snapOne(value, targets, tolPx = 10) {
  const tol = tolPx / S.pxPerSec;
  let best = null, bd = Infinity;
  for (const t of targets) {
    const d = Math.abs(value - t);
    if (d <= tol && d < bd) { bd = d; best = t; }
  }
  return best;
}

/** ブロック全体の移動。始点・終点のうち近い方を吸着させる */
function snapBlockMove(start, len, alt) {
  S.snapLine = null;
  if (alt) return start;
  const tg = snapTargets();
  const a = snapOne(start, tg), b = snapOne(start + len, tg);
  const da = a === null ? Infinity : Math.abs(start - a);
  const db = b === null ? Infinity : Math.abs(start + len - b);
  if (da === Infinity && db === Infinity) return start;
  if (da <= db) { S.snapLine = a; return a; }
  S.snapLine = b; return b - len;
}

/** 端のトリム。引いている側だけ吸着させる */
function snapEdge(value, alt) {
  S.snapLine = null;
  if (alt) return value;
  const hit = snapOne(value, snapTargets());
  if (hit === null) return value;
  S.snapLine = hit;
  return hit;
}

// --- タイムライン操作 ---
function hitBlurBlock(x, y) {
  if (y < Y_FX || y >= Y_TELOP) return null;
  for (let i = S.project.blurs.length - 1; i >= 0; i--) {
    const b = S.project.blurs[i];
    const cx = secToX(b.start), cw = (b.end - b.start) * S.pxPerSec;
    if (x >= cx && x <= cx + cw) return { blur: b, cx, cw };
  }
  return null;
}

function hitAudioClip(x, y) {
  if (y < Y_A2 || y >= Y_A2 + AUD_H) return null;
  for (let i = S.project.audioClips.length - 1; i >= 0; i--) {
    const ac = S.project.audioClips[i];
    const cx = secToX(ac.start), cw = ac.duration * S.pxPerSec;
    const [ry, rh] = audioRowRect(ac);
    if (x >= cx && x <= cx + cw && y >= ry && y <= ry + rh) return { ac, cx, cw };
  }
  return null;
}

function hitImageBlock(x, y) {
  if (y < Y_IMG || y >= Y_TELOP) return null;
  for (let i = S.project.images.length - 1; i >= 0; i--) {
    const im = S.project.images[i];
    const cx = secToX(im.start), cw = (im.end - im.start) * S.pxPerSec;
    if (x >= cx && x <= cx + cw) return { im, cx, cw };
  }
  return null;
}

function hitTelopBlock(x, y) {
  if (y < Y_TELOP || y >= Y_V) return null;
  for (let i = S.project.telops.length - 1; i >= 0; i--) {
    const tel = S.project.telops[i];
    const cx = secToX(tel.start), cw = (tel.end - tel.start) * S.pxPerSec;
    if (x >= cx && x <= cx + cw) return { tel, cx, cw };
  }
  return null;
}

function hitClip(x, y) {
  if (y < Y_V || y >= Y_A2) return null;
  for (const { clip, offset } of P.withTimelineOffsets(S.project)) {
    const cx = secToX(offset), cw = P.clipDuration(clip) * S.pxPerSec;
    if (x >= cx && x <= cx + cw) return { clip, offset, cx, cw };
  }
  return null;
}

tlCanvas.addEventListener('pointermove', (e) => {
  if (drag) return;
  const r = tlCanvas.getBoundingClientRect();
  const x = e.clientX - r.left, y = e.clientY - r.top;
  const hit = hitBlurBlock(x, y) || hitImageBlock(x, y) || hitTelopBlock(x, y) || hitAudioClip(x, y) || hitClip(x, y);
  tlCanvas.style.cursor = !hit ? 'default'
    : (Math.abs(x - hit.cx) < 6 || Math.abs(x - (hit.cx + hit.cw)) < 6) ? 'ew-resize' : 'grab';
});

let drag = null;
tlCanvas.addEventListener('pointerdown', (e) => {
  const r = tlCanvas.getBoundingClientRect();
  const x = e.clientX - r.left, y = e.clientY - r.top;
  S.focusArea = 'timeline'; // カーソルキーはコマ送りに戻す
  try { tlCanvas.setPointerCapture(e.pointerId); } catch {}

  // ぼかしトラック
  const bh = hitBlurBlock(x, y);
  if (bh) {
    select('blur', bh.blur.id);
    commit('ぼかしを編集', `blur:${bh.blur.id}`);
    const eL = Math.abs(x - bh.cx) < 6, eR = Math.abs(x - (bh.cx + bh.cw)) < 6;
    drag = eL || eR
      ? { type: 'blurTrim', blur: bh.blur, side: eL ? 'start' : 'end', startX: x, orig: { ...bh.blur } }
      : { type: 'blurMove', blur: bh.blur, startX: x, orig: { ...bh.blur } };
    renderAll(); renderFxForm(true); return;
  }
  if (y >= Y_FX && y < Y_IMG) { select('clip', null); renderAll(); renderFxForm(true); renderTelopForm(true); return; }

  // 画像トラック
  const ih = hitImageBlock(x, y);
  if (ih) {
    select('image', ih.im.id);
    const eL = Math.abs(x - ih.cx) < 6, eR = Math.abs(x - (ih.cx + ih.cw)) < 6;
    drag = eL || eR
      ? { type: 'imageTrim', im: ih.im, side: eL ? 'start' : 'end', startX: x, orig: { ...ih.im } }
      : { type: 'imageMove', im: ih.im, startX: x, orig: { ...ih.im } };
    renderAll(); renderFxForm(true); renderTelopForm(true);
    return;
  }
  if (y >= Y_IMG && y < Y_TELOP) { select('clip', null); renderAll(); renderFxForm(true); renderTelopForm(true); return; }

  // SE / BGM トラック
  const ah = hitAudioClip(x, y);
  if (ah) {
    select('audio', ah.ac.id);
    commit('音源を編集', `audio:${ah.ac.id}`);
    const eL = Math.abs(x - ah.cx) < 6, eR = Math.abs(x - (ah.cx + ah.cw)) < 6;
    drag = eL || eR
      ? { type: 'audioTrim', ac: ah.ac, side: eL ? 'start' : 'end', startX: x, orig: { ...ah.ac } }
      : { type: 'audioMove', ac: ah.ac, startX: x, orig: { ...ah.ac } };
    renderAll(); renderFxForm(true); return;
  }
  if (y >= Y_A2) { select('clip', null); renderAll(); renderFxForm(true); renderTelopForm(true); return; }

  // テロップトラック
  const th = hitTelopBlock(x, y);
  if (th) {
    const rebuild = th.tel.id !== S.selectedTelopId;
    select('telop', th.tel.id);
    commit('テロップの時間を変更', `telopTime:${th.tel.id}`);
    const edgeL = Math.abs(x - th.cx) < 6, edgeR = Math.abs(x - (th.cx + th.cw)) < 6;
    drag = edgeL || edgeR
      ? { type: 'telopTrim', tel: th.tel, side: edgeL ? 'start' : 'end', startX: x, orig: { start: th.tel.start, end: th.tel.end } }
      : { type: 'telopMove', tel: th.tel, startX: x, orig: { start: th.tel.start, end: th.tel.end } };
    renderAll(); renderFxForm(true);
    if (rebuild) renderTelopForm(true);
    return;
  }
  if (y >= Y_TELOP && y < Y_V) { // テロップトラックの空き
    select('clip', null);
    renderAll(); renderTelopForm(true); renderFxForm(true);
    return;
  }

  const hit = hitClip(x, y);
  if (!hit || y < RULER_H) {
    setMode('program');
    seekProgram(Math.max(0, xToSec(x)), true);
    renderAll();
    drag = { type: 'scrub' };
    return;
  }
  const rebuildTel = !!S.selectedTelopId, rebuildFx = !!(S.selectedBlurId || S.selectedAudioId);
  select('clip', hit.clip.id);
  commit('クリップを編集', `clip:${hit.clip.id}`);
  if (rebuildTel) renderTelopForm(true);
  if (rebuildFx) renderFxForm(true);
  const edgeL = Math.abs(x - hit.cx) < 6, edgeR = Math.abs(x - (hit.cx + hit.cw)) < 6;
  if (edgeL || edgeR) {
    drag = { type: 'trim', clip: hit.clip, side: edgeL ? 'in' : 'out', startX: x, orig: { in: hit.clip.in, out: hit.clip.out } };
  } else {
    drag = { type: 'move', clip: hit.clip, startX: x, moved: false };
  }
  renderAll();
});

tlCanvas.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const r = tlCanvas.getBoundingClientRect();
  const x = e.clientX - r.left;
  if (drag.type === 'scrub') {
    seekProgram(Math.max(0, xToSec(x)), false);
    renderTimeline(); renderTransport(); renderScrub(); renderOverlay();
  } else if (drag.type === 'trim') {
    const d = (x - drag.startX) / S.pxPerSec;
    const src = S.sources.get(drag.clip.sourceId);
    if (drag.side === 'in') {
      drag.clip.in = Math.max(0, Math.min(drag.orig.out - 0.1, drag.orig.in + d));
    } else {
      drag.clip.out = Math.max(drag.orig.in + 0.1, Math.min(src?.duration ?? Infinity, drag.orig.out + d));
    }
    renderTimeline(); renderInspector(); renderTransport();
  } else if (drag.type === 'blurMove') {
    const d = (x - drag.startX) / S.pxPerSec;
    const len = drag.orig.end - drag.orig.start;
    drag.blur.start = Math.max(0, snapBlockMove(drag.orig.start + d, len, e.altKey));
    drag.blur.end = drag.blur.start + len;
    renderTimeline(); renderOverlay(); syncFxNumbers();
  } else if (drag.type === 'blurTrim') {
    const d = (x - drag.startX) / S.pxPerSec;
    if (drag.side === 'start') drag.blur.start = Math.max(0, Math.min(drag.orig.end - 0.1, snapEdge(drag.orig.start + d, e.altKey)));
    else drag.blur.end = Math.max(drag.orig.start + 0.1, snapEdge(drag.orig.end + d, e.altKey));
    renderTimeline(); renderOverlay(); syncFxNumbers();
  } else if (drag.type === 'audioMove') {
    const d = (x - drag.startX) / S.pxPerSec;
    drag.ac.start = Math.max(0, snapBlockMove(drag.orig.start + d, drag.orig.duration, e.altKey));
    renderTimeline(); syncFxNumbers();
  } else if (drag.type === 'audioTrim') {
    const d = (x - drag.startX) / S.pxPerSec;
    const asset = S.project.audioAssets.find((a) => a.id === drag.ac.assetId);
    const maxLen = asset ? asset.duration : Infinity;
    if (drag.side === 'start') {
      // 頭を詰めると素材の頭出し位置もずれる
      const ns = Math.max(0, Math.min(drag.orig.start + drag.orig.duration - 0.1, snapEdge(drag.orig.start + d, e.altKey)));
      const shift = ns - drag.orig.start;
      drag.ac.start = ns;
      drag.ac.offset = Math.max(0, (drag.orig.offset ?? 0) + shift);
      drag.ac.duration = Math.max(0.1, drag.orig.duration - shift);
    } else {
      const cap = drag.ac.loop ? Infinity : maxLen - (drag.ac.offset ?? 0);
      const ne = snapEdge(drag.orig.start + drag.orig.duration + d, e.altKey);
      drag.ac.duration = Math.max(0.1, Math.min(cap, ne - drag.ac.start));
    }
    renderTimeline(); syncFxNumbers();
  } else if (drag.type === 'imageMove') {
    const d = (x - drag.startX) / S.pxPerSec;
    const len = drag.orig.end - drag.orig.start;
    drag.im.start = Math.max(0, snapBlockMove(drag.orig.start + d, len, e.altKey));
    drag.im.end = drag.im.start + len;
    renderTimeline(); renderOverlay(); syncFxNumbers();
  } else if (drag.type === 'imageTrim') {
    const d = (x - drag.startX) / S.pxPerSec;
    if (drag.side === 'start') drag.im.start = Math.max(0, Math.min(drag.orig.end - 0.1, snapEdge(drag.orig.start + d, e.altKey)));
    else drag.im.end = Math.max(drag.orig.start + 0.1, snapEdge(drag.orig.end + d, e.altKey));
    renderTimeline(); renderOverlay(); syncFxNumbers();
  } else if (drag.type === 'telopMove') {
    const d = (x - drag.startX) / S.pxPerSec;
    const len = drag.orig.end - drag.orig.start;
    drag.tel.start = Math.max(0, snapBlockMove(drag.orig.start + d, len, e.altKey));
    drag.tel.end = drag.tel.start + len;
    renderTimeline(); renderOverlay(); syncBoxNumbers();
  } else if (drag.type === 'telopTrim') {
    const d = (x - drag.startX) / S.pxPerSec;
    if (drag.side === 'start') drag.tel.start = Math.max(0, Math.min(drag.orig.end - 0.1, snapEdge(drag.orig.start + d, e.altKey)));
    else drag.tel.end = Math.max(drag.orig.start + 0.1, snapEdge(drag.orig.end + d, e.altKey));
    renderTimeline(); renderOverlay(); syncBoxNumbers();
  } else if (drag.type === 'move') {
    if (Math.abs(x - drag.startX) > 4) drag.moved = true;
    const clips = S.project.clips;
    const from = clips.indexOf(drag.clip);
    const t = xToSec(x);
    let acc = 0, to = clips.length - 1;
    for (let i = 0; i < clips.length; i++) {
      const d = P.clipDuration(clips[i]);
      if (t < acc + d / 2) { to = i; break; }
      acc += d;
    }
    if (to !== from && to >= 0) {
      clips.splice(to, 0, clips.splice(from, 1)[0]);
      renderTimeline();
    }
  }
});

document.addEventListener('pointerup', () => history.endGroup());
document.addEventListener('focusin', () => history.endGroup());

tlCanvas.addEventListener('pointerup', () => {
  S.snapLine = null;
  if (drag && drag.type === 'move' && !drag.moved) {
    // クリック扱い：選択のみ
  }
  drag = null;
  renderAll();
});

tlCanvas.addEventListener('dblclick', (e) => {
  const r = tlCanvas.getBoundingClientRect();
  const y = e.clientY - r.top;
  if (y < Y_V || y >= Y_A2) return;
  const hit = hitClip(e.clientX - r.left, y);
  if (!hit) return;
  selectSource(hit.clip.sourceId);
  S.markIn = hit.clip.in; S.markOut = hit.clip.out;
  video.currentTime = hit.clip.in;
  renderAll();
});

/** タイムラインの中身が終わる秒（クリップ・テロップ・ぼかし・音源すべての末尾） */
function contentEndSec() {
  let end = P.totalDuration(S.project);
  for (const t of S.project.telops) end = Math.max(end, t.end);
  for (const b of S.project.blurs) end = Math.max(end, b.end);
  for (const i of S.project.images) end = Math.max(end, i.end);
  for (const a of S.project.audioClips) end = Math.max(end, a.start + a.duration);
  return end;
}

function clampScroll(sec) {
  const visible = ($('tlWrap').clientWidth || 800) / S.pxPerSec;
  // 全体が収まっているならスクロールさせない。
  // 収まらない時は、末尾で編集しやすいよう少しだけ先まで送れるようにする。
  const end = contentEndSec();
  const margin = Math.min(visible * 0.3, 10);
  const max = end <= visible ? 0 : end - visible + margin;
  return Math.max(0, Math.min(max, sec));
}

$('tlWrap').addEventListener('wheel', (e) => {
  e.preventDefault();
  const r = tlCanvas.getBoundingClientRect();
  if (e.ctrlKey || e.metaKey) {
    // ⌘ / Ctrl ＋ ホイールで拡大縮小（カーソル位置を固定したまま）。
    // Mac のトラックパッドのピンチも ctrlKey 付きの wheel として届くのでそのまま効く。
    const px = e.clientX - r.left;
    const anchorSec = xToSec(px);
    const f = Math.exp(-e.deltaY * 0.002);
    S.pxPerSec = Math.max(0.2, Math.min(400, S.pxPerSec * f));
    S.scrollSec = Math.max(0, anchorSec - px / S.pxPerSec);
  } else {
    // ホイールは横スクロール。トラックパッドの横スワイプ（deltaX）も拾う。
    const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    S.scrollSec = clampScroll(S.scrollSec + d / S.pxPerSec);
  }
  renderTimeline();
}, { passive: false });

// ---------------------------------------------------------------- プロジェクト保存 / 読込

async function saveProject() {
  S.project.title = S.project.title || '無題プロジェクト';
  const text = P.serialize(S.project);
  const name = `${S.project.title}.bme.json`;
  if ('showSaveFilePicker' in window) {
    try {
      const h = await window.showSaveFilePicker({ suggestedName: name, types: [{ description: 'BME プロジェクト', accept: { 'application/json': ['.json'] } }] });
      const w = await h.createWritable();
      await w.write(text); await w.close();
      status('プロジェクトを保存しました');
      return;
    } catch (e) { if (e.name === 'AbortError') return; }
  }
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = document.createElement('a'); a.href = url; a.download = name; a.click();
  URL.revokeObjectURL(url);
  status('プロジェクトを保存しました');
}

async function loadProject(file) {
  try {
    const p = P.deserialize(await file.text());
    // 素材は名前で突き合わせる（ファイル参照はブラウザ側に保持できないため）
    const byName = new Map();
    for (const [id, src] of S.sources) byName.set(src.name, id);
    const remap = new Map();
    for (const s of p.sources) {
      const existing = byName.get(s.name);
      if (existing) remap.set(s.id, existing);
    }
    p.clips = p.clips.map((c) => ({ ...c, sourceId: remap.get(c.sourceId) ?? c.sourceId }));
    p.sources = S.project.sources;
    commit('プロジェクトを読み込み');
    S.project = p;
    normalizeProject();
    syncProjectUI();
    select(null, null);
    const missing = p.clips.filter((c) => !S.sources.has(c.sourceId)).length;
    zoomFit();
    renderAll();
    status(missing ? `読み込みました（素材未接続のクリップ ${missing} 件。該当 mp4 を開いてください）` : 'プロジェクトを読み込みました');
  } catch (e) {
    status(`プロジェクト読み込み失敗: ${e.message}`, true);
  }
}

// ---------------------------------------------------------------- 書き出し

async function doExport() {
  if (S.exporting) return;
  const clips = S.project.clips.filter((c) => P.clipDuration(c) > 0.001);
  if (!clips.length) return status('書き出すクリップがありません', true);
  for (const c of clips) if (!S.sources.has(c.sourceId)) return status('素材が未接続のクリップがあります', true);

  // 出力設定を反映
  const [w, h] = $('optRes').value.split('x').map(Number);
  S.project.output = {
    width: w, height: h,
    fps: +$('optFps').value,
    videoBitrate: +$('optVbr').value,
    audioBitrate: +$('optAbr').value,
  };

  let fileHandle = null;
  if ('showSaveFilePicker' in window) {
    try {
      fileHandle = await window.showSaveFilePicker({
        suggestedName: `${S.project.title || 'export'}.mp4`,
        types: [{ description: 'MP4 動画', accept: { 'video/mp4': ['.mp4'] } }],
      });
    } catch (e) { if (e.name === 'AbortError') return; throw e; }
  }

  video.pause();
  // フォントが未ロードだと別書体で焼き込まれてしまう
  await T.ensureFontsLoaded(S.project.telops);
  S.exporting = true;
  const ac = new AbortController();
  $('btnCancel').onclick = () => ac.abort();
  $('overlay').classList.remove('hidden');
  $('ovLog').textContent = '';
  const t0 = performance.now();

  try {
    const proj = S.project;
    const buf = await exportProject(proj, S.sources, {
      fileHandle,
      signal: ac.signal,
      composeFrame: (ctx, frame, t, w, h) => composeFrame(ctx, frame, t, w, h, proj, S.imageLib),
      audioMix: audioMixer(),
      onProgress: (r, text) => {
        $('ovProg').style.width = `${Math.min(100, r * 100).toFixed(1)}%`;
        $('progBar').style.width = `${Math.min(100, r * 100).toFixed(1)}%`;
        const el = performance.now() - t0;
        const eta = r > 0.01 ? (el / r - el) / 1000 : 0;
        $('ovText').textContent = `${(r * 100).toFixed(1)}%  ${text}  残り約 ${tc(eta, false)}`;
      },
      onLog: (t) => { $('ovLog').textContent += t + '\n'; $('ovLog').scrollTop = 1e9; },
    });
    if (buf) {
      const url = URL.createObjectURL(new Blob([buf], { type: 'video/mp4' }));
      const a = document.createElement('a'); a.href = url; a.download = `${S.project.title || 'export'}.mp4`; a.click();
      URL.revokeObjectURL(url);
    }
    status(`書き出し完了（${((performance.now() - t0) / 1000).toFixed(1)} 秒）`);
  } catch (e) {
    console.error(e);
    status(`書き出し失敗: ${e.message}`, true);
    $('ovLog').textContent += `エラー: ${e.message}\n`;
    await new Promise((r) => setTimeout(r, 1500));
  } finally {
    S.exporting = false;
    $('overlay').classList.add('hidden');
    $('progBar').style.width = '0';
  }
}

// ---------------------------------------------------------------- イベント配線

$('btnSaveProj').onclick = saveProject;
$('btnUndo').onclick = doUndo;
$('btnRedo').onclick = doRedo;
$('btnLoadProj').onclick = () => $('projInput').click();
$('btnAddClip').onclick = addClip;
$('btnDelete').onclick = deleteSelected;
$('binAddVideo').onclick = () => openFiles().catch((e) => status(e.message, true));
$('binAddAudio').onclick = () => $('audioInput').click();
$('binAddImage').onclick = () => $('imageInput').click();
$('imageInput').onchange = (e) => { addImageAssets([...e.target.files]); e.target.value = ''; };
for (const t of document.querySelectorAll('.bintab')) {
  t.onclick = () => { S.binTab = t.dataset.bin; renderBin(); };
}
for (const t of document.querySelectorAll('.insptab')) {
  t.onclick = () => { S.inspTab = t.dataset.insp; renderInspTabs(); };
}
$('mixSe').oninput = (e) => {
  commit('効果音の全体音量', 'mixSe');
  S.project.mix.se = +e.target.value / 100; $('mixSeLbl').textContent = `${e.target.value}%`;
};
$('mixBgm').oninput = (e) => {
  commit('BGM の全体音量', 'mixBgm');
  S.project.mix.bgm = +e.target.value / 100; $('mixBgmLbl').textContent = `${e.target.value}%`;
};
$('notes').addEventListener('input', (e) => {
  commit('作業メモを編集', 'notes');
  S.project.notes = e.target.value;
});
$('audioInput').onchange = (e) => { addAudioAssets([...e.target.files]); e.target.value = ''; };
$('fontInput').onchange = async (e) => {
  for (const f of e.target.files) {
    try {
      const name = await T.loadFontFile(f);
      if (!S.userFonts.includes(name)) S.userFonts.push(name);
      const tel = selectedTelop();
      if (tel) { tel.font = name; S.telopStyle.font = name; }
      status(`フォント「${name}」を追加しました`);
    } catch (err) { status(`フォント読み込み失敗: ${f.name}`, true); }
  }
  e.target.value = '';
  renderTelopForm(true);
  renderOverlay();
};
$('btnExport').onclick = () => doExport().catch((e) => status(e.message, true));
function zoomBy(f) {
  // 画面中央を固定したまま拡大縮小する
  const visible = ($('tlWrap').clientWidth || 800) / S.pxPerSec;
  const centerSec = S.scrollSec + visible / 2;
  S.pxPerSec = Math.max(0.2, Math.min(400, S.pxPerSec * f));
  const nv = ($('tlWrap').clientWidth || 800) / S.pxPerSec;
  S.scrollSec = clampScroll(centerSec - nv / 2);
  renderTimeline();
}
$('btnZoomIn').onclick = () => zoomBy(1.5);
$('btnZoomOut').onclick = () => zoomBy(1 / 1.5);
$('btnZoomFit').onclick = zoomFit;
$('btnThumbs').onclick = () => {
  S.showThumbs = !S.showThumbs;
  thumbs.setEnabled(S.showThumbs);
  $('btnThumbs').classList.toggle('on', S.showThumbs);
  renderTimeline();
};
$('btnWaves').onclick = () => {
  S.showWaves = !S.showWaves;
  waves.setEnabled(S.showWaves);
  $('btnWaves').classList.toggle('on', S.showWaves);
  renderTimeline();
};
$('btnZoneIn').onclick = () => { setMode('program'); zoneIn(); };
$('btnZoneOut').onclick = () => { setMode('program'); zoneOut(); };
$('btnExtract').onclick = extractZone;
$('btnZoneClear').onclick = clearZone;
$('optRes').onchange = (e) => {
  commit('出力解像度を変更');
  const [w, h] = e.target.value.split('x').map(Number);
  S.project.output.width = w; S.project.output.height = h;
  renderOverlay();
};

$('fileInput').onchange = (e) => { addFiles([...e.target.files]); e.target.value = ''; };
$('projInput').onchange = (e) => { if (e.target.files[0]) loadProject(e.target.files[0]); e.target.value = ''; };

for (const t of document.querySelectorAll('.tab[data-mode]')) t.onclick = () => { setMode(t.dataset.mode); renderAll(); };

$('btnPlay').onclick = togglePlay;
$('btnHome').onclick = () => { if (S.mode === 'program') seekProgram(0, true); else video.currentTime = 0; renderAll(); };
$('btnEnd').onclick = () => {
  if (S.mode === 'program') seekProgram(P.totalDuration(S.project) - 0.1, true);
  else video.currentTime = Math.max(0, (curSource()?.duration ?? 0) - 0.1);
  renderAll();
};
$('btnBack1').onclick = () => step(-1 / fps());
$('btnFwd1').onclick = () => step(1 / fps());

function togglePlay() {
  if (!video.src) return;
  if (video.paused) { video.playbackRate = 1; video.play().catch(() => {}); } else video.pause();
  renderTransport();
}

/** SE / BGM をプログラム再生に追従させる */
function syncAudioPreview() {
  if (!S.audioPreview) return;
  if (S.mode !== 'program' || video.paused || video.playbackRate !== 1) {
    S.audioPreview.stop();
    return;
  }
  // クリップ跨ぎのシークでは鳴らし直さない（BGM が切れてしまうため）。
  // ずれが大きくなった時だけスケジュールし直す。
  const pos = S.audioPreview.positionNow();
  if (pos !== null && Math.abs(pos - S.programTime) < 0.25) return;
  S.audioPreview.start(S.project.audioClips, S.programTime, S.project.mix);
}
function step(d) {
  video.pause();
  if (S.mode === 'program') seekProgram(S.programTime + d, false);
  else video.currentTime = Math.max(0, video.currentTime + d);
  renderTransport(); renderScrub(); renderTimeline(); renderOverlay();
}

video.addEventListener('timeupdate', () => { programTick(); renderTransport(); renderScrub(); if (S.mode === 'program') { renderTimeline(); syncAudioPreview(); } renderOverlay(); });
video.addEventListener('seeked', () => { renderTransport(); renderScrub(); syncAudioPreview(); });
video.addEventListener('play', () => { renderTransport(); syncAudioPreview(); });
video.addEventListener('pause', () => { renderTransport(); S.audioPreview?.stop(); });
video.addEventListener('loadedmetadata', () => { renderTransport(); renderScrub(); });

// requestVideoFrameCallback があればクリップ跨ぎの精度が上がる
if ('requestVideoFrameCallback' in HTMLVideoElement.prototype) {
  const cb = () => { programTick(); if (!video.paused) renderOverlay(); video.requestVideoFrameCallback(cb); };
  video.requestVideoFrameCallback(cb);
}

// --- ドラッグ＆ドロップ ---
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => {
  e.preventDefault();
  const files = [...e.dataTransfer.files];
  if (files.length) addFiles(files);
});

// --- キーボード ---
document.addEventListener('keydown', (e) => {
  if (e.target instanceof Element && e.target.matches('input, select, textarea')) return;
  const k = e.key.toLowerCase();
  if (e.ctrlKey || e.metaKey) {
    if (k === 's') { e.preventDefault(); saveProject(); return; }
    if (k === 'z') { e.preventDefault(); e.shiftKey ? doRedo() : doUndo(); return; }
    if (k === 'y') { e.preventDefault(); doRedo(); return; }   // Windows 流
  }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  switch (k) {
    case ' ': e.preventDefault(); togglePlay(); break;
    case 'i':
      if (e.shiftKey && S.mode === 'program' && S.zoneIn !== null) { seekProgram(S.zoneIn, true); renderAll(); }
      else markIn();
      break;
    case 'o':
      if (e.shiftKey && S.mode === 'program' && S.zoneOut !== null) { seekProgram(S.zoneOut, true); renderAll(); }
      else markOut();
      break;
    case '?': case '/': toggleHelp(); break;
    case 'escape':
      if (!ctxMenu.classList.contains('hidden')) hideContextMenu();
      else if (!helpDlg.classList.contains('hidden')) toggleHelp(false);
      else if (!$('telopDialog').classList.contains('hidden')) closeTelopDialog();
      else clearZone();
      break;
    case 'enter': addClip(); break;
    case 't': addTelop(); break;
    case 'b': addBlur(); break;
    case 'j':
      video.playbackRate = video.paused || video.playbackRate > 0 ? 1 : video.playbackRate;
      step(-10 / fps()); break;
    case 'k': video.pause(); renderTransport(); break;
    case 'l':
      video.playbackRate = Math.min(8, video.paused ? 2 : video.playbackRate * 2);
      video.play().catch(() => {}); renderTransport(); break;
    // プレビューで枠を選んでいる間は、カーソルキーで 1px ずつ動かす
    case 'arrowleft': case 'arrowright': case 'arrowup': case 'arrowdown': {
      e.preventDefault();
      const d = e.shiftKey ? 10 : 1;
      if (S.focusArea === 'preview' && activeBox()) {
        if (k === 'arrowleft') nudgeBox(-d, 0);
        else if (k === 'arrowright') nudgeBox(d, 0);
        else if (k === 'arrowup') nudgeBox(0, -d);
        else nudgeBox(0, d);
        break;
      }
      if (k === 'arrowleft') step(e.shiftKey ? -1 : -1 / fps());
      else if (k === 'arrowright') step(e.shiftKey ? 1 : 1 / fps());
      break;
    }
    case 'home': $('btnHome').click(); break;
    case 'end': $('btnEnd').click(); break;
    case 'delete': case 'backspace': e.preventDefault(); deleteSelected(); break;
  }
});

new ResizeObserver(() => { renderTimeline(); renderScrub(); renderOverlay(); }).observe(document.body);

// ---------------------------------------------------------------- 起動

function renderAll() {
  renderBin();
  renderInspTabs();
  renderInspector();
  renderTelopForm();
  renderFxForm();
  renderTransport();
  renderScrub();
  renderZoneInfo();
  renderTimeline();
  renderOverlay();
}

if (!('VideoEncoder' in window)) {
  status('このブラウザは WebCodecs 非対応です（Chrome / Edge をお使いください）', true);
}
normalizeProject();
syncProjectUI();
renderHistoryUI();
renderAll();
status('準備完了 — メディアタブから素材を読み込むか、mp4 をここへドロップしてください');

// Phase 4（AI 連携 / MCP）に向けた操作フック。
// プロジェクト JSON をそのまま差し替えられるようにしておく。
window.bme = {
  state: S,
  get project() { return S.project; },
  set project(p) { S.project = p; select(null, null); zoomFit(); renderAll(); },
  addFiles,
  addTelop,
  addBlur,
  addImageAssets,
  placeImage,
  addAudioAssets,
  placeAudio,
  telop: T,
  loadProjectJSON(text) { S.project = P.deserialize(text); zoomFit(); renderAll(); },
  exportProjectJSON() { return P.serialize(S.project); },
  render: renderAll,
};
