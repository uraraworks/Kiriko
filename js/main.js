// main.js — UI 全体の組み立て
import { Mp4Source } from './mp4source.js';
import * as P from './project.js';
import { exportProject } from './exporter.js';
import { parseKdenlive, basename } from './kdenlive.js';
import * as T from './telop.js';
import { composeFrame, activeBlur, drawOverlaysAt, overlaysAt, blurRectAt, activeRectBlurs, drawRectBlur } from './compose.js';
import { AudioLibrary, AudioPreview, mixInto } from './audio.js';
import { History } from './history.js';
import * as Lib from './library.js';
import * as FS from './filestore.js';
import { Bridge } from './bridge.js';
import { createCommands } from './commands.js';
import { ThumbCache, THUMB_W, THUMB_H } from './thumbs.js';
import { WaveformCache, BINS_PER_SEC, bufferPeaks } from './waveform.js';
import * as B from './boxes.js';
import { ImageLibrary, PLACEMENTS, placementBox, defaultPlacement, createImageClip, drawImageClip, drawnRect } from './images.js';

// ---------------------------------------------------------------- 状態

const S = {
  project: P.createProject(),
  sources: new Map(),      // sourceId -> Mp4Source
  mediaFilter: 'all',      // メディア一覧の絞り込み（all / video / audio / image）
  clipboard: null,         // コピーしたテロップ / 音源 / 画像 / ぼかし
  workDir: null,           // 作業フォルダ（FileSystemDirectoryHandle）
  workDirReady: false,     // その許可が生きているか
  libDir: null,            // テロップ用画像の置き場所（FileSystemDirectoryHandle）
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
  selectedMarkerId: null,
  imageLib: new ImageLibrary(),
  focusArea: 'timeline',   // 'preview' ならカーソルキーで枠を動かす
  binTab: 'media',
  libSets: [],             // 保存済みテロップセット（プロジェクトをまたいで使える）
  telopRow: 0,             // テロップのどの行を編集中か
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
  if (type === 'telop' && id !== S.selectedTelopId) S.telopRow = 0;
  S.selectedClipId = type === 'clip' ? id : null;
  S.selectedTelopId = type === 'telop' ? id : null;
  S.selectedBlurId = type === 'blur' ? id : null;
  S.selectedAudioId = type === 'audio' ? id : null;
  S.selectedImageId = type === 'image' ? id : null;
  S.selectedMarkerId = type === 'marker' ? id : null;
}
const selectedTelop = () => S.project.telops.find((t) => t.id === S.selectedTelopId) || null;
const selectedBlur = () => S.project.blurs.find((b) => b.id === S.selectedBlurId) || null;
const selectedAudio = () => S.project.audioClips.find((a) => a.id === S.selectedAudioId) || null;
const selectedImage = () => S.project.images.find((i) => i.id === S.selectedImageId) || null;
const selectedMarker = () => S.project.markers.find((m) => m.id === S.selectedMarkerId) || null;
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
    if (!S.project.markers?.some((m) => m.id === S.selectedMarkerId)) S.selectedMarkerId = null;
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
  p.telops.forEach((t) => { if (typeof t.track !== 'number') t.track = 0; });
  p.images = p.images ?? [];
  // z 未設定のものを補う。従来の見た目（テロップが画像より前）を保つ
  p.images.forEach((im, i) => { if (typeof im.z !== 'number') im.z = i; });
  p.telops.forEach((tl, i) => { if (typeof tl.z !== 'number') tl.z = 1000 + i; });
  p.imageAssets = p.imageAssets ?? [];
  p.blurs = (p.blurs ?? []).map((b) => ({
    shape: 'full', feather: 0.25, round: true, keys: [], ...b,
  }));
  // kind: keep=ここは残す / cut=ここは消す / note=ただのメモ
  p.markers = (p.markers ?? [])
    .map((m) => ({ duration: 0, text: '', kind: (m.duration ?? 0) > 0 ? 'keep' : 'note', ...m }))
    .sort((a, b) => a.time - b.time);
  p.audioClips = p.audioClips ?? [];
  p.audioClips.forEach((a) => { if (typeof a.track !== 'number') a.track = a.kind === 'bgm' ? 1 : 0; });
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
            'application/json': ['.kiriko', '.json'],
          },
        }],
      });
      files = await Promise.all(handles.map((h) => h.getFile()));
      // 次に開いた時そのまま読み直せるよう、ハンドルを覚えておく
      for (const h of handles) await FS.rememberFile(h.name, h);
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
      // 同じ名前で「未接続」の枠があればそこへ繋ぐ（プロジェクトを開いた直後の再接続）
      const slot = S.project.sources.find((x) => x.name === src.name && !S.sources.has(x.id));
      const id = slot?.id ?? P.newId('src');
      S.sources.set(id, src);
      if (slot) Object.assign(slot, { size: file.size, duration: src.duration });
      else S.project.sources.push({ id, name: src.name, size: file.size, duration: src.duration });
      status(`${file.name} 読み込み完了（${tc(src.duration)}）`);
      if (!S.currentSourceId) selectSource(id);
      bindPendingKdenlive();
      // 既にクリップが載っているなら、素材そのものではなく仕上がりを見せる
      if (S.project.clips.length) refreshProgram();
    } catch (e) {
      console.error(e);
      status(`${file.name}: ${e.message}`, true);
    }
  }
  renderAll();
}

async function importKdenlive(file, text = null) {
  try {
    const info = parseKdenlive(text ?? await file.text());
    S.pendingKdenlive = info;
    const total = info.cuts.reduce((a, c) => a + (c.out - c.in), 0);
    const tracks = info.trackCounts.length > 1 ? `（映像 ${info.trackCounts.length} トラックを統合）` : '';
    status(`Kdenlive: ${info.cuts.length} カット${tracks} / 合計 ${tc(total, false)} を検出。`
      + `該当の mp4（${info.files.map(basename).join(', ')}）を読み込むと反映されます`);
    bindPendingKdenlive();
  } catch (e) {
    status(`Kdenlive ファイルを読み込めませんでした（${file.name}）: ${e.message}`, true);
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
  S.programTime = 0;
  refreshProgram();
  const notes = [];
  if (pend.overlaps) notes.push(`${pend.overlaps} 箇所のトランジションは詰めて並べました`);
  if (pend.dropped) notes.push(`重ねて置かれていた ${pend.dropped} 件は取り込めていません`);
  status(`Kdenlive から ${S.project.clips.length} カットを取り込みました`
    + (notes.length ? `（${notes.join(' / ')}）` : ''));
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
  renderAll();
}

// ---------------------------------------------------------------- モニター

/** <video> に流す素材を切り替える（同じなら何もしない） */
/**
 * モニターの「素材が未読み込みです」を出し入れする。
 * 素材の読み込みは選択（selectSource）以外の経路もある（プロジェクトを開いた時など）ので、
 * 状態から毎回決める。
 */
function renderNoMedia() {
  const el = $('noMedia');
  if (el) el.style.display = S.sources.size ? 'none' : '';
}

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

/** クリップの並びが変わった後に、プレビューを今の位置の絵に合わせ直す */
function refreshProgram() {
  if (!P.totalDuration(S.project)) return;
  setMode('program');
  S.programIndex = -1;
  seekProgram(Math.min(S.programTime, P.totalDuration(S.project)), true);
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

/**
 * 範囲まわりの表示。使える時だけ出す。
 * 通常は［開始］だけを置いておき、開始を打ってから終了・切り取り・解除を出す
 * （終了から打つことはまず無いので、並んでいると迷う）。
 */
function renderZoneInfo() {
  const r = zoneRange();
  const started = S.zoneIn !== null;
  const show = (id, on) => $(id).classList.toggle('hidden', !on);

  $('zoneInfo').textContent = r
    ? `範囲 ${tc(r[0], false)} 〜 ${tc(r[1], false)}（${tc(r[1] - r[0], false)}）`
    : started ? `範囲 ${tc(S.zoneIn, false)} 〜 —（O で終了を打つ）` : '';

  show('zoneInfo', started);
  show('btnZoneOut', started);      // 開始を打ってから
  show('btnZoneClear', started);
  show('btnExtract', !!r);          // 範囲になってから
  // コピーは「範囲」か「何か選んでいる時」。貼り付けは持っている時だけ
  show('btnCopy', !!r || !!(S.selectedTelopId || S.selectedAudioId || S.selectedImageId || S.selectedBlurId));
  show('btnPaste', !!S.clipboard?.items?.length);
  $('btnExtract').disabled = !r;
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
  commit(`${tc(b - a, false)} をカット`);
  extractRange(a, b);
  S.selectedClipId = null;
  clearZone();
  seekProgram(a, true);
  renderAll();
  status(`${tc(b - a, false)} を切り取りました（残り ${tc(P.totalDuration(S.project), false)}）`);
}

/** [a, b) を切り取って後ろを詰める（履歴は呼び出し側で積む） */
function extractRange(a, b) {
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
  // マーカーも同じだけ前に詰める。範囲がまるごと消えたものは落とす
  S.project.markers = S.project.markers
    .map((m) => {
      const s0 = shift(m.time), e0 = shift(m.time + (m.duration ?? 0));
      return { ...m, time: s0, duration: Math.max(0, e0 - s0) };
    })
    .filter((m) => (m.duration ?? 0) > 0.02 || (m.time > a && m.time < b ? false : true));
  S.project.audioClips = S.project.audioClips
    .map((x) => {
      const s0 = shift(x.start), e0 = shift(x.start + x.duration);
      // 頭を削られた分だけ素材の頭出しもずらす
      const trimmed = Math.max(0, a - x.start) > 0 && x.start < a ? 0 : Math.max(0, x.start - s0);
      return { ...x, start: s0, duration: e0 - s0, offset: (x.offset ?? 0) + trimmed };
    })
    .filter((x) => x.duration > 0.05);
}

/**
 * 時刻 t に len 秒の隙間を空けて、後ろのものをまとめて後ろへずらす。
 * クリップを伸ばした時に、テロップなどが元の映像と合わなくなるのを防ぐ。
 * t をまたいでいるものは、終わりだけ伸ばして掛かり続けるようにする。
 */
function insertGapAt(t, len) {
  if (len <= 0.0001) return;
  const P0 = S.project;
  const push = (v) => (v >= t ? v + len : v);
  const shiftBlock = (x) => ({ ...x, start: push(x.start), end: push(x.end) });
  P0.telops = P0.telops.map(shiftBlock);
  P0.blurs = P0.blurs.map(shiftBlock);
  P0.images = P0.images.map(shiftBlock);
  P0.markers = P0.markers.map((m) => {
    const s0 = push(m.time), e0 = push(m.time + (m.duration ?? 0));
    return { ...m, time: s0, duration: Math.max(0, e0 - s0) };
  });
  P0.audioClips = P0.audioClips.map((x) => {
    const s0 = push(x.start), e0 = push(x.start + x.duration);
    return { ...x, start: s0, duration: e0 - s0 };
  });
}

/** クリップの開始時刻（タイムライン上）。クリップは隙間なく並ぶ */
function clipStartSec(clip) {
  let t = 0;
  for (const c of S.project.clips) {
    if (c === clip) return t;
    t += P.clipDuration(c);
  }
  return t;
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

/** 使われていないテロップトラックを詰める（T1 が空で T2 だけ残る、を避ける） */
/** 使われていない音源トラックを詰める */
function compactAudioTracks() {
  const used = [...new Set(S.project.audioClips.map((a) => a.track ?? 0))].sort((a, b) => a - b);
  const map = new Map(used.map((v, i) => [v, i]));
  for (const a of S.project.audioClips) a.track = map.get(a.track ?? 0) ?? 0;
}

function compactTelopTracks() {
  const used = [...new Set(S.project.telops.map((t) => t.track ?? 0))].sort((a, b) => a - b);
  const map = new Map(used.map((v, i) => [v, i]));
  for (const t of S.project.telops) t.track = map.get(t.track ?? 0) ?? 0;
}

function deleteSelected() {
  // プログラムモニターで範囲が選ばれていれば「切り取って詰める」を優先する
  if (S.mode === 'program' && zoneRange()) { extractZone(); return; }
  if (S.selectedBlurId) {
    commit('ぼかしを削除');
    S.project.blurs = S.project.blurs.filter((b) => b.id !== S.selectedBlurId);
    S.selectedBlurId = null; renderAll(); renderFxForm(true); return;
  }
  if (S.selectedMarkerId) {
    commit('マーカーを削除');
    S.project.markers = S.project.markers.filter((m) => m.id !== S.selectedMarkerId);
    S.selectedMarkerId = null; renderAll(); renderFxForm(true); return;
  }
  if (S.selectedImageId) {
    commit('画像を削除');
    S.project.images = S.project.images.filter((i) => i.id !== S.selectedImageId);
    S.selectedImageId = null; renderAll(); renderFxForm(true); return;
  }
  if (S.selectedAudioId) {
    commit('音源を削除');
    S.project.audioClips = S.project.audioClips.filter((a) => a.id !== S.selectedAudioId);
    compactAudioTracks();
    S.selectedAudioId = null; renderAll(); renderFxForm(true); return;
  }
  if (S.selectedTelopId) {
    commit('テロップを削除');
    S.project.telops = S.project.telops.filter((t) => t.id !== S.selectedTelopId);
    compactTelopTracks();
    S.selectedTelopId = null;
    renderAll();
    return;
  }
  if (!S.selectedClipId) return;
  const i = S.project.clips.findIndex((c) => c.id === S.selectedClipId);
  if (i < 0) return;
  commit('クリップを削除');
  // 消した分だけ、テロップ・画像・音源・マーカーも前に詰める
  const a = clipStartSec(S.project.clips[i]);
  const b = a + P.clipDuration(S.project.clips[i]);
  S.project.clips.splice(i, 1);
  rippleAfter(a, b);
  select('clip', S.project.clips[Math.min(i, S.project.clips.length - 1)]?.id ?? null);
  renderAll();
}

// ---------------------------------------------------------------- コピー / 貼り付け
//
// 「1 件目 配達完了」のテロップと効果音を 2 件目の所へ持っていって、
// 数字だけ書き換える——という使い方を想定している。
// 中身は JSON なので、丸ごと複製して時刻だけ差し替えればよい。

/**
 * コピーする。
 *  - 範囲（I〜O）が選ばれていれば、そこに掛かっているものを**まとめて**コピーする
 *    （テロップと効果音を組で持っていきたい時はこちら）
 *  - 範囲が無ければ、選択中のもの 1 つ
 * 位置は先頭からの相対で覚えるので、貼り付け先でも間隔が保たれる。
 */
function copySelected() {
  const zone = zoneRange();
  if (zone) return copyRange(zone[0], zone[1]);

  const pick = [
    ['telop', selectedTelop()],
    ['audio', selectedAudio()],
    ['image', selectedImage()],
    ['blur', selectedBlur()],
  ].find(([, v]) => v);
  if (!pick) return status('コピーするものが選ばれていません（範囲を選ぶとまとめてコピーできます）', true);
  const [kind, item] = pick;
  S.clipboard = { base: item.start, items: [{ kind, data: clone(item) }] };
  renderZoneInfo();   // 貼り付けボタンを出す
  status(`${KIND_NAME[kind]}をコピーしました（⌘V で再生位置に貼り付け）`);
}

const clone = (o) => JSON.parse(JSON.stringify(o));

/** 範囲に掛かっているものをまとめてコピーする */
function copyRange(a, b) {
  const P0 = S.project;
  const hit = (s0, e0) => s0 < b && e0 > a;   // 少しでも重なっていれば対象
  const items = [];
  for (const x of P0.telops) if (hit(x.start, x.end)) items.push({ kind: 'telop', data: clone(x) });
  for (const x of P0.images) if (hit(x.start, x.end)) items.push({ kind: 'image', data: clone(x) });
  for (const x of P0.blurs) if (hit(x.start, x.end)) items.push({ kind: 'blur', data: clone(x) });
  for (const x of P0.audioClips) if (hit(x.start, x.start + x.duration)) items.push({ kind: 'audio', data: clone(x) });
  if (!items.length) return status('この範囲にはコピーするものがありません', true);

  // いちばん早いものを基準にする。貼り付けた時、それが再生位置に来て、
  // 残りは同じ間隔で並ぶ（範囲の取り方に結果が左右されない）
  const base = Math.min(...items.map((it) => it.data.start));
  S.clipboard = { base, items };
  const n = {};
  for (const it of items) n[it.kind] = (n[it.kind] ?? 0) + 1;
  const list = Object.entries(n).map(([k, v]) => `${KIND_NAME[k]} ${v}`).join('・');
  renderZoneInfo();   // 貼り付けボタンを出す
  status(`範囲の ${list} をコピーしました（⌘V で再生位置に貼り付け）`);
}

const KIND_NAME = { telop: 'テロップ', audio: '音源', image: '画像', blur: 'ぼかし' };

/** コピーしたものを再生位置に貼り付ける。長さ・書式・間隔はそのまま */
function pasteClipboard() {
  const cb = S.clipboard;
  if (!cb?.items?.length) return status('コピーされていません', true);
  const total = P.totalDuration(S.project);
  if (total <= 0) return status('先にクリップを作ってください', true);

  const t0 = Math.min(currentTimelineTime(), Math.max(0, total - 0.2));
  const only = cb.items.length === 1 ? cb.items[0].kind : null;
  commit(only ? `${KIND_NAME[only]}を貼り付け` : 'まとめて貼り付け');

  let last = null;
  for (const { kind, data: src } of cb.items) {
    const at = t0 + (src.start - cb.base);   // コピー元の間隔を保つ
    if (at >= total) continue;               // 尺の外に出るものは置かない
    if (kind === 'audio') {
      const ac = { ...src, id: P.newId('ac'), start: Math.max(0, at) };
      ac.track = 0;
      while (S.project.audioClips.some((o) => (o.track ?? 0) === ac.track
        && ac.start < o.start + o.duration && ac.start + ac.duration > o.start)) ac.track++;
      S.project.audioClips.push(ac);
      last = ['audio', ac.id];
    } else {
      const len = src.end - src.start;
      const prefix = { telop: 'tel', image: 'img', blur: 'blur' }[kind];
      const item = { ...src, id: P.newId(prefix), start: Math.max(0, at), end: Math.min(total, at + len) };
      if (item.end - item.start < 0.02) continue;
      if (kind !== 'blur') item.z = zRange()[1] + 1;
      if (kind === 'telop') {
        // 同じ時間に既にテロップがあるトラックは避ける
        item.track = 0;
        while (S.project.telops.some((o) =>
          (o.track ?? 0) === item.track && item.start < o.end && item.end > o.start)) item.track++;
      }
      ({ telop: S.project.telops, image: S.project.images, blur: S.project.blurs })[kind].push(item);
      last = [kind, item.id];
    }
  }
  if (!last) return status('貼り付けられませんでした（尺の外です）', true);

  // 範囲は用済み。残っていると Delete が「範囲を切り取る」になって危ない
  S.zoneIn = S.zoneOut = null;
  select(...last);
  setMode('program');
  seekProgram(t0, true);
  renderAll();
  renderTelopForm(true);
  renderFxForm(true);
  // 1 つだけのテロップなら、すぐ文字を直せるように開く
  if (only === 'telop') openTelopEditor();
  status(only
    ? `${KIND_NAME[only]}を ${tc(t0, false)} に貼り付けました`
    : `${cb.items.length} 件を ${tc(t0, false)} から貼り付けました`);
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
  // 同じ時間に既にテロップがあるトラックは避けて、空いている所へ置く
  tel.track = 0;
  while (S.project.telops.some((o) => (o.track ?? 0) === tel.track && t0 < o.end && t1 > o.start)) tel.track++;
  S.project.telops.push(tel);
  select('telop', tel.id);
  setMode('program');
  seekProgram(t0, true);
  renderAll();
  openTelopEditor();
  status(`テロップを追加しました（${tc(t0, false)} 〜 ${tc(t1, false)}）`);
}

// ---------------------------------------------------------------- マーカー

const MARKER_KINDS = {
  keep: { name: '残す', color: '#4bd18a' },
  cut: { name: '消す', color: '#e0574f' },
  note: { name: 'メモ', color: '#e0b84c' },
};

function addMarker(time = null, text = '', duration = 0, kind = null) {
  const total = P.totalDuration(S.project);
  if (total <= 0) return status('先にクリップを作ってください', true);
  const t = Math.max(0, Math.min(total, time ?? currentTimelineTime()));
  commit('マーカーを追加');
  const k = MARKER_KINDS[kind] ? kind : (duration > 0 ? 'keep' : 'note');
  const m = { id: P.newId('mk'), time: t, duration, text, kind: k, color: MARKER_KINDS[k].color };
  S.project.markers.push(m);
  S.project.markers.sort((a, b) => a.time - b.time);
  select('marker', m.id);
  renderAll(); renderFxForm(true);
  status(`マーカーを ${tc(t, false)} に立てました`);
  setTimeout(() => $('mkText')?.focus(), 0);
  return m;
}

/** 前後のマーカーへ飛ぶ */
function jumpMarker(dir) {
  const ms = [...S.project.markers].sort((a, b) => a.time - b.time);
  if (!ms.length) return status('マーカーがありません');
  const t = S.programTime;
  const m = dir > 0 ? ms.find((x) => x.time > t + 0.01) : [...ms].reverse().find((x) => x.time < t - 0.01);
  if (!m) return status(dir > 0 ? '最後のマーカーです' : '最初のマーカーです');
  setMode('program');
  seekProgram(m.time, true);
  select('marker', m.id);
  renderAll(); renderFxForm(true);
  status(`${tc(m.time, false)} ${m.text ? `— ${m.text}` : ''}`);
}

/** 再生位置を挟むマーカーの間を範囲選択する（その区間を切り取る／残す起点） */
function selectBetweenMarkers() {
  const ms = [...S.project.markers].sort((a, b) => a.time - b.time);
  if (ms.length < 1) return status('マーカーがありません', true);
  const t = S.programTime;
  const prev = [...ms].reverse().find((x) => x.time <= t + 0.001);
  const next = ms.find((x) => x.time > t + 0.001);
  const a = prev ? prev.time + (prev.duration || 0) : 0;
  const b = next ? next.time : P.totalDuration(S.project);
  if (b - a < 0.02) return status('この位置には範囲がありません', true);
  setMode('program');
  S.zoneIn = a; S.zoneOut = b;
  renderZoneUI();
  status(`マーカー間を選択しました（${tc(a, false)} 〜 ${tc(b, false)}）`);
}

/** 同じ種別の区間マーカーをまとめる（重なりは統合する） */
function rangesOf(kind) {
  const ranges = S.project.markers
    .filter((m) => (m.duration ?? 0) > 0.02 && (m.kind ?? 'keep') === kind)
    .map((m) => [m.time, m.time + m.duration])
    .sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1] + 0.001) last[1] = Math.max(last[1], r[1]);
    else merged.push([...r]);
  }
  return merged;
}
const keepRanges = () => rangesOf('keep');

/**
 * 消す候補。
 *  - 「消す」マーカーがあれば、それ自体が候補
 *  - 無ければ「残す」マーカーの外側が候補
 * どちらの立て方でも同じ流れ（G / F で送って、確認して Delete）で進められる。
 */
function gapRanges() {
  const cut = rangesOf('cut');
  if (cut.length) return cut;
  const keep = keepRanges();
  if (!keep.length) return [];
  const total = P.totalDuration(S.project);
  const gaps = [];
  let prev = 0;
  for (const [a, b] of keep) {
    if (a - prev > 0.02) gaps.push([prev, Math.min(a, total)]);
    prev = Math.max(prev, b);
  }
  if (total - prev > 0.02) gaps.push([prev, total]);
  return gaps;
}

/**
 * 「区間マーカーの外側」を 1 つ範囲選択して、そこへ移動する。
 * 中身を見て、必要なら範囲を詰めてから Delete、を繰り返す使い方を想定している。
 * （まとめて消すより、こちらの方が取りこぼしに気付ける）
 * @param {number} dir +1 で次、-1 で前
 */
function selectGap(dir = 1) {
  const gaps = gapRanges();
  if (!gaps.length) return status('消す候補がありません（区間マーカーを立ててください）', true);
  // いま同じ範囲を選んでいるなら、そこから 1 つ進める（選択後はカーソルが区間の頭に来るので、
  // 再生位置だけを見ると同じ区間を選び続けてしまう）
  const t = S.programTime;
  const cur = gaps.findIndex(([a, b]) =>
    S.zoneIn !== null && S.zoneOut !== null
    && Math.abs(a - S.zoneIn) < 0.02 && Math.abs(b - S.zoneOut) < 0.02);
  let idx;
  if (cur >= 0) {
    idx = Math.max(0, Math.min(gaps.length - 1, cur + dir));
    if (idx === cur) return status(dir > 0 ? '最後の区間外です' : '最初の区間外です');
  } else {
    idx = dir > 0
      ? gaps.findIndex(([, b]) => b > t + 0.05)
      : gaps.map(([a]) => a).reduce((acc, a, i) => (a < t - 0.05 ? i : acc), -1);
    if (idx < 0) idx = dir > 0 ? gaps.length - 1 : 0;
  }
  const g = gaps[idx];
  setMode('program');
  S.zoneIn = g[0]; S.zoneOut = g[1];
  seekProgram(g[0], true);
  renderZoneUI(); renderAll();
  const i = idx + 1;
  status(`区間外 ${i}/${gaps.length} を選択（${tc(g[0], false)} 〜 ${tc(g[1], false)} ／ ${tc(g[1] - g[0], false)}）— 確認して Delete`);
}
const selectNextGap = () => selectGap(1);
const selectPrevGap = () => selectGap(-1);

/** 選択中のマーカーの区間をそのまま範囲選択にする */
function selectMarkerRange() {
  const m = selectedMarker();
  if (!m || (m.duration ?? 0) <= 0.02) return status('区間マーカーを選んでください', true);
  setMode('program');
  S.zoneIn = m.time; S.zoneOut = m.time + m.duration;
  seekProgram(m.time, true);
  renderZoneUI(); renderAll();
  status(`マーカーの区間を選択しました（${tc(m.time, false)} 〜 ${tc(m.time + m.duration, false)}）`);
}

/**
 * 区間マーカー（duration > 0）で示した所だけを残し、あとは全部切り取る。
 * 「セリフのある所に区間マーカーを立てて」→ ここを押す、が本命の使い方。
 */
function keepMarkedRangesOnly() {
  const gaps = gapRanges();
  if (!gaps.length) return status('区間マーカー（長さのあるマーカー）がありません', true);

  const removed = gaps.reduce((acc, g) => acc + (g[1] - g[0]), 0);
  if (!confirm(`区間マーカーの外側 ${gaps.length} 箇所（合計 ${tc(removed, false)}）を切り取ります。よろしいですか？`)) return;

  commit('マーカー区間だけ残す');
  for (const [a, b] of [...gaps].reverse()) extractRange(a, Math.min(b, P.totalDuration(S.project)));
  clearZone();
  seekProgram(0, true);
  renderAll();
  status(`${tc(removed, false)} を切り取りました（残り ${tc(P.totalDuration(S.project), false)}）`);
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
      const slot = S.project.audioAssets.find((x) => x.name === f.name && !lib.has(x.id));
      const id = slot?.id ?? P.newId('aud');
      const meta = await lib.add(f, id);
      if (slot) Object.assign(slot, meta);
      else S.project.audioAssets.push(meta);
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
  ac.track = 0;
  while (S.project.audioClips.some((o) => (o.track ?? 0) === ac.track
    && ac.start < o.start + o.duration && ac.start + ac.duration > o.start)) ac.track++;
  S.project.audioClips.push(ac);
  select('audio', ac.id);
  renderAll(); renderFxForm(true);
  status(`${asset.name} を ${tc(start, false)} に配置しました`);
}

// ---------------------------------------------------------------- 画像

async function addImageAssets(files) {
  for (const f of files) {
    try {
      const slot = S.project.imageAssets.find((x) => x.name === f.name && !S.imageLib.get(x.id));
      const id = slot?.id ?? P.newId('img');
      const meta = await S.imageLib.add(f, id);
      if (slot) Object.assign(slot, meta);
      else S.project.imageAssets.push(meta);
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
/**
 * 矩形ぼかしを枠として扱うための包み。
 * 位置はキーフレームで持つので、box への書き込みは「今の時刻のキー」に反映する。
 */
function blurBoxProxy(b, t) {
  return {
    id: b.id, start: b.start, end: b.end, _blur: b,
    get box() { return blurRectAt(b, t); },
    set box(v) { setBlurRectAt(b, t, v); },
  };
}

/** 時刻 t のキーを更新（無ければ作る）。キーが無い状態なら rect を直接書き換える */
function setBlurRectAt(b, t, rect) {
  const r = { x: rect.x, y: rect.y, w: rect.w, h: rect.h };
  if (!b.keys?.length) { b.rect = r; return; }
  const i = b.keys.findIndex((k) => Math.abs(k.t - t) < 0.02);
  if (i >= 0) Object.assign(b.keys[i], r);
  else { b.keys.push({ t, ...r }); b.keys.sort((x, y) => x.t - y.t); }
}

function activeBox() {
  const tel = selectedTelop();
  if (tel) return { kind: 'telop', item: tel };
  const im = selectedImage();
  if (im) return { kind: 'image', item: im };
  const bl = selectedBlur();
  if (bl?.shape === 'rect') return { kind: 'blur', item: blurBoxProxy(bl, currentTimelineTime()) };
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
    // 部分ぼかしは <video> の CSS filter では表現できないので、
    // その区間だけ映像をキャンバスに描き直して重ねる
    if (video.readyState >= 2) {
      for (const b of activeRectBlurs(S.project.blurs, t)) drawRectBlur(ctx, video, W, H, b, t);
    }
    drawOverlaysAt(ctx, S.project, t, S.imageLib);
  } else if (sel) {
    // ソースモニターでは、位置調整しやすいよう選択中のものだけ出す
    if (sel.kind === 'image') drawImageClip(ctx, sel.item, S.imageLib);
    else T.drawTelop(ctx, sel.item, S.imageLib);
  }

  // 選択枠とハンドル
  if (sel && (S.mode !== 'program' || (t >= sel.item.start && t < sel.item.end))) {
    const sc = stageScale();
    B.drawBoxChrome(ctx, sel.item.box, sc, { color: sel.kind === 'image' ? '#e0ab74' : sel.kind === 'blur' ? '#7fd8c4' : '#4c9aff' });
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
  // 部分ぼかしは一番奥に置く（テロップ・画像が重なっていればそちらを優先して掴む）
  const list = S.mode === 'program'
    ? [
        ...activeRectBlurs(S.project.blurs, t).map((b) => ({ kind: 'blur', item: blurBoxProxy(b, t) })),
        ...overlaysAt(S.project, t),
      ]
    : (sel ? [{ kind: sel.kind, item: sel.item }] : []);
  // 手前（z が大きい方）から拾う
  for (let i = list.length - 1; i >= 0; i--) {
    const { kind, item } = list[i];
    if (B.insideBox(item.box, p.x, p.y)) return { kind, item };
    if (kind === 'telop' && B.insideBox(T.textBounds(ctx, item, S.imageLib), p.x, p.y)) return { kind, item };
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
        label: sel.kind === 'image' ? '画像の大きさを変更' : sel.kind === 'blur' ? 'ぼかし範囲を変更' : 'テロップの枠を変更',
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
  if (hit.kind === 'blur') S.inspTab = 'props';
  boxDrag = {
    ...hit, mode: 'move', startX: p.x, startY: p.y,
    orig: { ...hit.item.box }, guides: [], committed: false,
    label: hit.kind === 'image' ? '画像の位置を変更' : hit.kind === 'blur' ? 'ぼかし範囲を移動' : 'テロップの位置を変更',
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

  // 右下のつまみで大きさを変える。設定が増えて縦に長くなるので、
  // 広げたい人は広げられるように（大きさは覚える）
  const grip = $('telopGrip');
  const MIN_W = 280, MIN_H = 220;
  let z = null;
  grip.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const r = telDlg.getBoundingClientRect();
    z = { x: e.clientX, y: e.clientY, w: r.width, h: r.height, left: r.left, top: r.top };
    try { grip.setPointerCapture(e.pointerId); } catch {}
  });
  grip.addEventListener('pointermove', (e) => {
    if (!z) return;
    setTelopDialogSize(z.w + (e.clientX - z.x), z.h + (e.clientY - z.y));
  });
  grip.addEventListener('pointerup', () => {
    if (!z) return;
    z = null;
    try {
      localStorage.setItem('kiriko.telopDlg',
        JSON.stringify({ w: parseFloat(telDlg.style.width), h: parseFloat(telDlg.style.height) }));
    } catch { /* プライベートモード等 */ }
  });

  function setTelopDialogSize(w, h) {
    const r = telDlg.getBoundingClientRect();
    // 画面からはみ出さない範囲で
    telDlg.style.width = `${Math.max(MIN_W, Math.min(w, innerWidth - r.left - 8))}px`;
    telDlg.style.height = `${Math.max(MIN_H, Math.min(h, innerHeight - r.top - 8))}px`;
    telDlg.style.maxHeight = 'none';
  }

  // 前回の大きさを復元する
  try {
    const saved = JSON.parse(localStorage.getItem('kiriko.telopDlg') || 'null');
    if (saved?.w && saved?.h) {
      telDlg.style.width = `${saved.w}px`;
      telDlg.style.height = `${saved.h}px`;
      telDlg.style.maxHeight = 'none';
    }
  } catch { /* 壊れていたら既定の大きさで */ }
})();

// --- ツールチップ ---
// ブラウザ標準の title は出るまでが 1〜2 秒あり、その時間は変えられない。
// 出てほしいのは 0.5 秒くらいなので、title を横取りして自前で出す。
const TIP_DELAY = 500;
(() => {
  const tip = $('tip');
  let timer = null, current = null;

  const hide = () => {
    clearTimeout(timer);
    current = null;
    tip.classList.remove('show');
    tip.classList.add('hidden');
  };

  const show = (el, text) => {
    tip.textContent = text;
    tip.classList.remove('hidden');
    const r = el.getBoundingClientRect();
    const t = tip.getBoundingClientRect();
    let x = r.left + r.width / 2 - t.width / 2;
    let y = r.bottom + 7;
    if (y + t.height > innerHeight - 4) y = r.top - t.height - 7;  // 下に入らなければ上へ
    tip.style.left = `${Math.max(4, Math.min(innerWidth - t.width - 4, x))}px`;
    tip.style.top = `${Math.max(4, y)}px`;
    requestAnimationFrame(() => tip.classList.add('show'));
  };

  document.addEventListener('pointerover', (e) => {
    if (!(e.target instanceof Element)) return;
    const el = e.target.closest('[title], [data-tip]');
    if (!el) { if (current) hide(); return; }
    if (el === current) return;
    hide();
    // 標準のツールチップが出ないよう title は退避する（読み上げ用に aria-label を残す）
    if (el.hasAttribute('title')) {
      const t = el.getAttribute('title');
      el.setAttribute('data-tip', t);
      if (!el.hasAttribute('aria-label')) el.setAttribute('aria-label', t);
      el.removeAttribute('title');
    }
    const text = el.getAttribute('data-tip');
    if (!text) return;
    current = el;
    timer = setTimeout(() => show(el, text), TIP_DELAY);
  });

  document.addEventListener('pointerout', (e) => {
    if (current && e.target instanceof Element && e.target.closest('[data-tip]') === current) hide();
  });
  document.addEventListener('pointerdown', hide, true);
  window.addEventListener('wheel', hide, true);
  window.addEventListener('blur', hide);
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

// 文字入力欄以外ではブラウザ標準のメニュー（「コピー」「全てを選択」など）を出さない。
// 入力欄ではコピー & ペーストが要るのでそのまま通す。
document.addEventListener('contextmenu', (e) => {
  const t = e.target;
  const editable = t instanceof Element
    && (t.matches('input, textarea, [contenteditable=""], [contenteditable="true"]') || t.closest('[contenteditable="true"]'));
  if (!editable) e.preventDefault();
});

overlay.addEventListener('contextmenu', (e) => {
  e.preventDefault(); // ブラウザ標準のメニューは出さない
  const hit = pickBox(stagePoint(e), currentTimelineTime());
  if (!hit) { hideContextMenu(); return; }
  select(hit.kind, hit.item.id);
  renderAll(); renderTelopForm(true); renderFxForm(true);
  const items = [
    { label: hit.kind === 'image' ? '画像を削除' : 'テロップを削除', key: 'Delete', run: () => deleteSelected() },
  ];
  items.push({ label: 'コピー', key: '⌘C', run: () => copySelected() });
  if (hit.kind === 'telop') {
    items.push({ label: 'テロップを編集…', run: () => openTelopDialog() });
    items.push({ label: '★ ライブラリに保存…', run: () => saveTelopToLibrary() });
  }
  showContextMenu(e.clientX, e.clientY, items);
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
      const tb = T.textBounds(overlay.getContext('2d'), sel.item, S.imageLib);
      sel.item.box = B.clampBox({ x: tb.x, y: tb.y, w: Math.max(40, tb.w), h: Math.max(40, tb.h) }, W, H);
    }
    status(sel.kind === 'image' ? '枠を画像の大きさに合わせました' : '枠を文字の大きさに合わせました');
  } else if (sel.kind === 'telop' && B.insideBox(sel.item.box, p.x, p.y)) {
    openTelopEditor();
    return;
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
  commit(sel.kind === 'image' ? '画像を移動' : sel.kind === 'blur' ? 'ぼかし範囲を移動' : 'テロップを移動', `nudge:${sel.item.id}`);
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
  $('binLib').classList.toggle('hidden', S.binTab !== 'lib');

  renderMediaBin();
  renderEffectBin();
  renderLibraryBin();

  const src = curSource();
  $('srcInfo').innerHTML = src
    ? `映像 <b>${esc(src.video.codec)}</b><br>${src.video.width}×${src.video.height} ／ ${src.video.samples.length} フレーム<br>`
      + (src.audio ? `音声 <b>${esc(src.audio.codec)}</b><br>${src.audio.sampleRate} Hz ／ ${src.audio.channels} ch` : '音声トラックなし')
    : '—';
}

function renderMediaBin() {
  const list = $('binList');
  const f = S.mediaFilter ?? 'all';
  const show = (kind) => f === 'all' || f === kind;
  const nAll = S.project.sources.length + S.project.audioAssets.length + S.project.imageAssets.length;
  const n = (show('video') ? S.project.sources.length : 0)
    + (show('audio') ? S.project.audioAssets.length : 0)
    + (show('image') ? S.project.imageAssets.length : 0);

  list.innerHTML = '';
  if (!n) {
    list.innerHTML = nAll
      ? '<div class="empty">この種類の素材はまだありません</div>'
      : '<div class="empty">mp4 / mp3 / png をここにドロップしても読み込めます</div>';
    return;
  }

  for (const s of show('video') ? S.project.sources : []) {
    const loaded = S.sources.has(s.id);
    const el = document.createElement('div');
    el.className = 'bin-item' + (s.id === S.currentSourceId ? ' active' : '') + (loaded ? '' : ' missing');
    el.innerHTML = `<div class="row"><div class="n">${esc(s.name)}</div>`
      + (loaded ? `<button class="bin-add" title="この素材をまるごとタイムラインに置く。ここから要らない範囲を切り取っていく">全体を置く</button>` : '')
      + `</div>`
      + (loaded
        ? `<div class="m">${tc(s.duration)} ／ ${(s.size / 1e9).toFixed(2)} GB</div>`
        : `<div class="m warnline">未接続 — このファイルをドロップするとつながります</div>`);
    el.querySelector('.row').appendChild(assetDelButton('video', s.id, s.name));
    if (loaded) {
      el.querySelector('.bin-add').onclick = (ev) => { ev.stopPropagation(); placeWholeSource(s.id); };
      el.onclick = () => selectSource(s.id);
    } else {
      el.onclick = () => status(`${s.name} を開くと、このプロジェクトのクリップがつながります`);
    }
    list.appendChild(el);
  }

  for (const a of show('audio') ? S.project.audioAssets : []) {
    const ok = !!S.library?.has(a.id);
    const el = document.createElement('div');
    el.className = 'bin-item audio' + (ok ? '' : ' missing');
    el.innerHTML = `<div class="row"><div class="n">♪ ${esc(a.name)}</div>`
      + (ok ? `<button class="bin-add" title="再生位置に配置">＋</button>` : '') + `</div>`
      + (ok ? `<div class="m">${tc(a.duration, false)} ／ ${a.duration > 20 ? 'BGM' : '効果音'}</div>`
            : `<div class="m warnline">未接続 — このファイルをドロップするとつながります</div>`);
    el.querySelector('.row').appendChild(assetDelButton('audio', a.id, a.name));
    if (ok) {
      el.querySelector('.bin-add').onclick = (e) => { e.stopPropagation(); placeAudio(a.id); };
      el.onclick = () => placeAudio(a.id);
    }
    list.appendChild(el);
  }

  for (const a of show('image') ? S.project.imageAssets : []) {
    const ok = !!S.imageLib.get(a.id);
    const el = document.createElement('div');
    el.className = 'bin-item image' + (ok ? '' : ' missing');
    el.innerHTML = `<div class="row"><div class="n">▣ ${esc(a.name)}</div></div>`
      + (ok ? `<div class="m">${a.width}×${a.height}</div>`
            : `<div class="m warnline">未接続 — このファイルをドロップするとつながります</div>`)
      + (ok ? `<div class="place-row">${PLACEMENTS.map((pl) => `<button data-p="${pl.id}">${pl.name}</button>`).join('')}</div>` : '');
    el.querySelector('.row').appendChild(assetDelButton('image', a.id, a.name));
    const bmp = S.imageLib.get(a.id);
    if (bmp && el.querySelector('.place-row')) {
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
    if (!ok) el.onclick = () => status(`${a.name} を開くと、この画像がつながります`);
    list.appendChild(el);
  }
}

/**
 * 素材をプロジェクトから外す。
 * 使っている物があれば、何がいくつ消えるかを伝えてから確認する。
 * 履歴に積むので Cmd+Z で戻せる。
 */
function removeAsset(kind, id, name) {
  const P0 = S.project;
  const used = [];
  if (kind === 'video') {
    const n = P0.clips.filter((c) => c.sourceId === id).length;
    if (n) used.push(`クリップ ${n} 個`);
  } else if (kind === 'audio') {
    const n = P0.audioClips.filter((c) => c.assetId === id).length;
    if (n) used.push(`音源 ${n} 個`);
  } else {
    const n = P0.images.filter((im) => im.assetId === id).length;
    if (n) used.push(`画像 ${n} 個`);
    const t = P0.telops.filter((tl) => tl.bgAssetId === id || tl.icon?.assetId === id).length;
    if (t) used.push(`テロップ ${t} 個`);
  }
  const msg = used.length
    ? `「${name}」はタイムラインで使われています（${used.join('・')}）。\n\n`
      + '一緒に削除しますか？（⌘Z で戻せます）'
    : `「${name}」をプロジェクトから外しますか？`;
  if (!confirm(msg)) return;

  commit('素材を削除');
  // 読み込み済みの中身（デコーダ・画像・音）は捨てない。
  // 履歴は project の JSON しか戻さないので、捨てると ⌘Z で戻した時に
  // 「未接続」になってしまう。次にページを開くまで持っておく
  if (kind === 'video') {
    P0.clips = P0.clips.filter((c) => c.sourceId !== id);
    P0.sources = P0.sources.filter((x) => x.id !== id);
    if (S.currentSourceId === id) {
      S.currentSourceId = P0.sources[0]?.id ?? null;
      if (S.currentSourceId) setVideoSource(S.currentSourceId);
      $('monName').textContent = curSource()?.name ?? '—';
    }
  } else if (kind === 'audio') {
    P0.audioClips = P0.audioClips.filter((c) => c.assetId !== id);
    P0.audioAssets = P0.audioAssets.filter((x) => x.id !== id);
  } else {
    P0.images = P0.images.filter((im) => im.assetId !== id);
    for (const tl of P0.telops) {
      if (tl.bgAssetId === id) tl.bgAssetId = null;
      if (tl.icon?.assetId === id) tl.icon.assetId = null;
    }
    P0.imageAssets = P0.imageAssets.filter((x) => x.id !== id);
  }
  select(null, null);
  refreshProgram();
  renderAll();
  renderTelopForm(true);
  status(`「${name}」を外しました`);
}

/** 素材の行に付ける × ボタン */
function assetDelButton(kind, id, name) {
  const b = document.createElement('button');
  b.className = 'bin-del';
  b.title = 'プロジェクトから外す';
  b.textContent = '×';
  b.onclick = (ev) => { ev.stopPropagation(); removeAsset(kind, id, name); };
  return b;
}

// ---------------------------------------------------------------- テロップセットのライブラリ

async function reloadLibrary() {
  try {
    S.libSets = await Lib.listSets();
  } catch (e) {
    S.libSets = [];
    status(`ライブラリを読めませんでした: ${e.message}`, true);
  }
  renderLibraryBin();
}

/**
 * 画像を含むセットを保存する前に、ライブラリフォルダを確かめる。
 * 未設定・許可切れのまま保存すると画像がブラウザの中に溜まり、
 * 閲覧データを消したときに一緒に消えてしまう。
 * @returns {Promise<boolean>} 保存を続けてよいか
 */
async function ensureLibDir() {
  if (S.libDir) {
    // 許可はブラウザ再起動などで切れる。ここはボタンの直後なので尋ねられる
    if ((await S.libDir.queryPermission?.({ mode: 'readwrite' })) === 'granted') return true;
    try {
      if ((await S.libDir.requestPermission({ mode: 'readwrite' })) === 'granted') return true;
    } catch { /* もう無い等 */ }
  }
  if (!('showDirectoryPicker' in window)) return true;   // 選べないブラウザはそのまま

  const first = !S.libDir;
  const ok = confirm(
    (first ? 'ライブラリフォルダがまだ決まっていません。' : `ライブラリフォルダ「${S.libDir.name}」を使えません。`)
    + '\n\nこのまま保存すると、画像はブラウザの中に取り込まれます。'
    + '\n閲覧データを消したときに一緒に消えてしまいます。'
    + '\n\n［OK］フォルダを決める（おすすめ）'
    + '\n［キャンセル］このまま保存する');
  if (!ok) return true;

  try {
    const dir = await window.showDirectoryPicker({ mode: 'readwrite' });
    S.libDir = dir;
    await FS.setLibDir(dir);
    renderLibDir();
    return true;
  } catch (e) {
    if (e.name === 'AbortError') return false;           // 選ぶのをやめた＝保存も取りやめ
    status(e.message, true);
    return false;
  }
}

/** 選択中のテロップを、画像ごとライブラリに保存する */
async function saveTelopToLibrary() {
  const tel = selectedTelop();
  if (!tel) return;
  // 画像を使っているセットだけ、置き場所を先に確かめる
  const usesImages = [tel.bgAssetId, tel.icon?.assetId].some(Boolean);
  if (usesImages && !(await ensureLibDir())) return;
  const name = prompt('セット名', Lib.setLabel({ telop: tel }).slice(0, 30));
  if (!name) return;

  // 使っている画像も一緒に保存する（別プロジェクトでもそのまま出せるように）。
  // ライブラリフォルダを決めてあれば実ファイルとして置き、ライブラリには名前だけ持たせる。
  // 決まっていない時は dataURL で抱える（従来どおり。IndexedDB は膨らむ）
  const assets = [];
  let stashed = 0;
  for (const id of [tel.bgAssetId, tel.icon?.assetId].filter(Boolean)) {
    const bmp = S.imageLib.get(id);
    const meta = S.project.imageAssets.find((a) => a.id === id);
    if (!bmp) continue;
    const iname = meta?.name ?? `${id}.png`;
    if (await Lib.stashAsset(iname, await Lib.bitmapToBlob(bmp))) {
      assets.push({ id, name: iname, file: true });
      stashed++;
    } else {
      assets.push({ id, name: iname, dataUrl: await Lib.bitmapToDataURL(bmp) });
    }
  }
  const { id, start, end, track, z, ...body } = tel;
  try {
    await Lib.putSet({ id: P.newId('set'), name, savedAt: Date.now(), telop: body, assets });
    await reloadLibrary();
    const inBrowser = assets.length - stashed;
    status(`「${name}」をライブラリに保存しました`
      + (stashed ? `（画像 ${stashed} 件は ${S.libDir?.name ?? 'ライブラリフォルダ'} に置きました）` : '')
      + (inBrowser ? `（画像 ${inBrowser} 件はブラウザの中に取り込みました）` : ''));
  } catch (e) {
    status(`保存できませんでした: ${e.message}`, true);
  }
}

/** ライブラリのセットを現在の再生位置に置く。同梱画像はビンに読み込み直す */
async function placeLibrarySet(entry) {
  const total = P.totalDuration(S.project);
  if (total <= 0) return status('先にクリップを作ってください', true);

  // 同梱画像を（まだ無ければ）読み込んで、新しい assetId に差し替える。
  // 素材フォルダに書き込めるなら、そこへ実ファイルとしても残す。
  // ライブラリのコピーはセットを消すと無くなるので、原本を手元に作っておく。
  const remap = new Map();
  const dir = await FS.writableDir().catch(() => null);
  let copied = 0;
  for (const a of entry.assets ?? []) {
    const existing = S.project.imageAssets.find((x) => x.name === a.name);
    if (existing) { remap.set(a.id, existing.id); continue; }
    const file = await Lib.assetToFile(a);
    if (!file) { status(`${a.name} が見つかりません（ライブラリフォルダを確認してください）`, true); continue; }
    const id = P.newId('img');
    const meta = await S.imageLib.add(file, id);
    S.project.imageAssets.push(meta);
    remap.set(a.id, id);
    if (dir && !(await FS.hasFile(dir, a.name)) && await FS.writeFile(dir, a.name, file)) copied++;
  }

  const t0 = Math.min(currentTimelineTime(), Math.max(0, total - 0.5));
  const len = Math.max(1, (entry.telop.end ?? 3) - (entry.telop.start ?? 0)) || 3;
  commit(`「${entry.name}」を配置`);
  const tel = JSON.parse(JSON.stringify(entry.telop));
  tel.id = P.newId('tel');
  tel.start = t0;
  tel.end = Math.min(total, t0 + 3);
  if (tel.bgAssetId) tel.bgAssetId = remap.get(tel.bgAssetId) ?? null;
  if (tel.icon?.assetId) tel.icon.assetId = remap.get(tel.icon.assetId) ?? null;
  tel.z = zRange()[1] + 1;
  tel.track = 0;
  while (S.project.telops.some((o) => (o.track ?? 0) === tel.track && tel.start < o.end && tel.end > o.start)) tel.track++;
  S.project.telops.push(tel);
  select('telop', tel.id);
  S.telopRow = 0;
  setMode('program');
  renderAll(); renderTelopForm(true);
  status(`「${entry.name}」を ${tc(t0, false)} に置きました`
    + (copied ? `（画像 ${copied} 件を ${dir.name} に保存しました）` : ''));
}

function renderLibraryBin() {
  const list = $('libList');
  if (!S.libSets.length) {
    list.innerHTML = '<div class="empty">テロップ編集ダイアログの下にある「★ ライブラリに保存」で、'
      + 'ここに貯まります。別のプロジェクトでもそのまま使えます。'
      + '<br><br>先に<b>ライブラリフォルダ</b>を決めておくと、テロップ用の画像が'
      + 'そこに実ファイルで残るので、ブラウザのデータを消しても無くなりません。</div>';
    return;
  }
  list.innerHTML = '';
  for (const e of S.libSets) {
    const el = document.createElement('div');
    el.className = 'bin-item lib';
    el.innerHTML = `<div class="row"><div class="n">${esc(e.name)}</div>`
      + `<button class="bin-add" title="再生位置に置く">＋</button>`
      + `<button class="bin-del" title="ライブラリから削除">×</button></div>`
      + `<div class="m">${esc(Lib.setLabel(e).slice(0, 40))}</div>`;
    el.querySelector('.bin-add').onclick = (ev) => { ev.stopPropagation(); placeLibrarySet(e); };
    el.querySelector('.bin-del').onclick = async (ev) => {
      ev.stopPropagation();
      if (!confirm(`「${e.name}」をライブラリから削除しますか？`)) return;
      await Lib.deleteSet(e.id);
      await reloadLibrary();
    };
    el.onclick = () => placeLibrarySet(e);
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
  const tel = selectedTelop(), other = selectedBlur() || selectedAudio() || selectedImage() || selectedMarker();
  $('selHead').textContent = tel ? '選択テロップ'
    : selectedBlur() ? '選択ぼかし' : selectedAudio() ? '選択音源'
    : selectedImage() ? '選択画像' : selectedMarker() ? '選択マーカー' : '選択クリップ';
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

/** 編集ダイアログを開く（ダブルクリック / 新規追加のときだけ） */
function openTelopEditor() {
  if (!selectedTelop()) return;
  openTelopDialog();
  renderTelopForm(true);
  setTimeout(() => $('telText')?.focus(), 0);
}

function renderTelopForm(force = false) {
  const form = $('telopForm');
  const tel = selectedTelop();
  if (!tel) { telopFormId = null; closeTelopDialog(); return; }
  // 選んだだけでは開かない。開いている時だけ中身を選択に追従させる
  if (telDlg.classList.contains('hidden')) { telopFormId = null; return; }
  const key = `${tel.id}:${tel.rows.length}:${S.telopRow}`;
  if (!force && telopFormId === key) { syncBoxNumbers(); return; }
  telopFormId = key;

  if (S.telopRow >= tel.rows.length) S.telopRow = tel.rows.length - 1;
  const row = tel.rows[S.telopRow] ?? tel.rows[0];
  const AL = { left: '⇤', center: '↔', right: '⇥' };
  const VA = { top: '⤒', middle: '↕', bottom: '⤓' };
  const imgs = S.project.imageAssets;

  form.innerHTML = `
    <div class="row-tabs" id="rowTabs">
      ${tel.rows.map((r, i) =>
        `<button class="row-tab${i === S.telopRow ? ' on' : ''}" data-row="${i}" title="${esc(r.text || '（空）')}">${i + 1}</button>`).join('')}
      <button class="row-tab add" id="rowAdd" title="行を追加">＋</button>
      ${tel.rows.length > 1 ? '<button class="row-tab del" id="rowDel" title="この行を削除">－</button>' : ''}
      ${tel.rows.length > 1 && S.telopRow > 0 ? '<button class="row-tab" id="rowUp" title="上へ">↑</button>' : ''}
      ${tel.rows.length > 1 && S.telopRow < tel.rows.length - 1 ? '<button class="row-tab" id="rowDown" title="下へ">↓</button>' : ''}
    </div>

    <label>${tel.rows.length > 1 ? `${S.telopRow + 1} 行目の` : ''}テキスト
      <textarea id="telText" rows="2">${esc(row.text)}</textarea></label>

    <div class="preset-row">
      <select id="telPreset"><option value="">プリセットを適用…</option>
        ${presets().map((p, i) => `<option value="${i}">${esc(p.name)}</option>`).join('')}
      </select>
      <button class="mini" id="telPresetSave" title="この行の書式と枠をプリセットとして保存">＋</button>
    </div>

    <label>フォント<select id="telFont">${fontOptions(row.font)}</select></label>
    <div class="font-actions">
      <button class="mini" id="telFontFile">.ttf を追加</button>
      <button class="mini" id="telFontLocal">PC のフォント一覧</button>
    </div>

    <div class="grid2">
      <label>サイズ <input class="num" type="number" id="telSize" min="16" max="400" value="${row.size}"></label>
      <label>縁の太さ <input class="num" type="number" id="telSW" min="0" max="60" value="${row.strokeWidth}"></label>
    </div>

    <div class="grid2">
      <div class="swatch"><input type="color" id="telFill" value="${row.fill}"><span>文字</span></div>
      <div class="swatch"><input type="color" id="telStroke" value="${row.stroke}"><span>内縁</span></div>
      <div class="swatch"><input type="color" id="telOuter" value="${row.outerStroke}"><span>白フチ</span></div>
      <label>白フチ倍率 <input class="num" type="number" id="telOuterScale" step="0.1" min="0" max="5" value="${row.outerScale}"></label>
    </div>

    <label>影 <span id="telShadowLbl">${Math.round(row.shadow * 100)}%</span>
      <input type="range" id="telShadow" min="0" max="100" value="${Math.round(row.shadow * 100)}"></label>

    <label>この行の横の寄せ
      <div class="align-grid">${['left', 'center', 'right'].map((a) =>
        `<button data-h="${a}" class="${row.hAlign === a ? 'on' : ''}" title="${a}">${AL[a]}</button>`).join('')}</div></label>

    <div class="panel-head sub inline">セット全体</div>

    <label>背景画像
      <select id="telBg">
        <option value="">なし</option>
        ${imgs.map((a) => `<option value="${a.id}"${a.id === tel.bgAssetId ? ' selected' : ''}>${esc(a.name)}</option>`).join('')}
      </select></label>
    ${tel.bgAssetId ? `
    <div class="grid2">
      <label>不透明度 <input class="num" type="number" id="telBgOp" min="0" max="100" value="${Math.round((tel.bgOpacity ?? 1) * 100)}"></label>
      <label class="chk" style="align-self:end"><input type="checkbox" id="telBgStretch" ${tel.bgFit === 'stretch' ? 'checked' : ''}> 引き伸ばす</label>
    </div>` : ''}

    <label>アイコン画像
      <select id="telIcon">
        <option value="">なし</option>
        ${imgs.map((a) => `<option value="${a.id}"${a.id === tel.icon?.assetId ? ' selected' : ''}>${esc(a.name)}</option>`).join('')}
      </select></label>
    ${tel.icon?.assetId ? `
    <div class="grid2">
      <label>位置
        <div class="align-grid four">${[['left', '左'], ['right', '右'], ['top', '上'], ['bottom', '下']].map(([v, n]) =>
          `<button data-icside="${v}" class="${tel.icon.side === v ? 'on' : ''}">${n}</button>`).join('')}</div></label>
      <label>大きさ <input class="num" type="number" id="telIconSize" min="8" max="600" value="${Math.round(tel.icon.size)}"></label>
      <label>文字との間隔 <input class="num" type="number" id="telIconGap" min="0" max="200" value="${Math.round(tel.icon.gap)}"></label>
      <label class="chk" style="align-self:end"><input type="checkbox" id="telIconTrim" ${tel.icon.trim !== false ? 'checked' : ''}> 余白を切り詰める</label>
      <label>縦位置（左右のとき）
        <div class="align-grid">${[['top', '⤒'], ['middle', '↕'], ['bottom', '⤓']].map(([v, n]) =>
          `<button data-icv="${v}" class="${tel.icon.valign === v ? 'on' : ''}">${n}</button>`).join('')}</div></label>
    </div>` : ''}

    <div class="grid2">
      <label>縦の寄せ
        <div class="align-grid">${['top', 'middle', 'bottom'].map((a) =>
          `<button data-v="${a}" class="${tel.vAlign === a ? 'on' : ''}" title="${a}">${VA[a]}</button>`).join('')}</div></label>
      <label>行間 <input class="num" type="number" id="telRowGap" step="2" value="${Math.round(tel.rowGap ?? 0)}"></label>
    </div>
    <label class="chk"><input type="checkbox" id="telWrap" ${tel.wrap ? 'checked' : ''}> 枠の幅で折り返す</label>

    <div class="z-row">
      <button class="mini" id="telZFront" title="他の画像・テロップより手前に出す">最前面へ</button>
      <button class="mini" id="telZBack" title="他の画像・テロップより奥に送る">最背面へ</button>
    </div>
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
      つまみをダブルクリックすると枠を中身の大きさに合わせます。</div>`;

  const live = () => { renderOverlay(); renderTimeline(); };
  const bind = (id, fn, ev = 'input') => $(id)?.addEventListener(ev, (e) => {
    commit('テロップを編集', `tel:${tel.id}:${id}`);
    fn(e.target.value, e); live();
  });

  // --- 行の切り替え・増減 ---
  for (const b of form.querySelectorAll('.row-tab[data-row]')) {
    b.onclick = () => { S.telopRow = +b.dataset.row; renderTelopForm(true); live(); };
  }
  $('rowAdd').onclick = () => {
    commit('行を追加');
    tel.rows.splice(S.telopRow + 1, 0, T.createRow('', tel.rows[S.telopRow]));
    S.telopRow++;
    renderTelopForm(true); live();
  };
  if ($('rowDel')) $('rowDel').onclick = () => {
    commit('行を削除');
    tel.rows.splice(S.telopRow, 1);
    S.telopRow = Math.max(0, S.telopRow - 1);
    renderTelopForm(true); live();
  };
  if ($('rowUp')) $('rowUp').onclick = () => {
    commit('行を上へ');
    tel.rows.splice(S.telopRow - 1, 0, tel.rows.splice(S.telopRow, 1)[0]);
    S.telopRow--; renderTelopForm(true); live();
  };
  if ($('rowDown')) $('rowDown').onclick = () => {
    commit('行を下へ');
    tel.rows.splice(S.telopRow + 1, 0, tel.rows.splice(S.telopRow, 1)[0]);
    S.telopRow++; renderTelopForm(true); live();
  };

  // --- 行の書式 ---
  $('telText').addEventListener('input', (e) => {
    commit('テロップの文字を編集', `telText:${tel.id}:${S.telopRow}`);
    row.text = e.target.value; live();
  });
  bind('telFont', (v) => { row.font = v; S.telopStyle.font = v; });
  bind('telSize', (v) => { row.size = Math.max(8, +v); S.telopStyle.size = row.size; });
  bind('telSW', (v) => { row.strokeWidth = Math.max(0, +v); S.telopStyle.strokeWidth = row.strokeWidth; });
  bind('telFill', (v) => { row.fill = v; S.telopStyle.fill = v; });
  bind('telStroke', (v) => { row.stroke = v; S.telopStyle.stroke = v; });
  bind('telOuter', (v) => { row.outerStroke = v; S.telopStyle.outerStroke = v; });
  bind('telOuterScale', (v) => { row.outerScale = Math.max(0, +v); S.telopStyle.outerScale = row.outerScale; });
  bind('telShadow', (v) => { row.shadow = +v / 100; S.telopStyle.shadow = row.shadow; $('telShadowLbl').textContent = `${v}%`; });
  for (const b of form.querySelectorAll('[data-h]')) {
    b.onclick = () => {
      commit('横の寄せを変更');
      row.hAlign = b.dataset.h; S.telopStyle.hAlign = row.hAlign;
      for (const o of form.querySelectorAll('[data-h]')) o.classList.toggle('on', o === b);
      live();
    };
  }

  // --- セット全体 ---
  bind('telBg', (v) => { tel.bgAssetId = v || null; renderTelopForm(true); });
  bind('telBgOp', (v) => { tel.bgOpacity = Math.max(0, Math.min(1, +v / 100)); });
  $('telBgStretch')?.addEventListener('change', (e) => {
    commit('背景の伸縮を切り替え'); tel.bgFit = e.target.checked ? 'stretch' : 'contain'; live();
  });
  bind('telRowGap', (v) => { tel.rowGap = +v; });
  bind('telIcon', (v) => { tel.icon = { ...tel.icon, assetId: v || null }; renderTelopForm(true); });
  bind('telIconSize', (v) => { tel.icon.size = Math.max(8, +v); });
  bind('telIconGap', (v) => { tel.icon.gap = Math.max(0, +v); });
  $('telIconTrim')?.addEventListener('change', (e) => {
    commit('アイコンの余白設定を変更'); tel.icon.trim = e.target.checked; live();
  });
  for (const b of form.querySelectorAll('[data-icside]')) {
    b.onclick = () => {
      commit('アイコンの位置を変更'); tel.icon.side = b.dataset.icside;
      for (const o of form.querySelectorAll('[data-icside]')) o.classList.toggle('on', o === b);
      live();
    };
  }
  for (const b of form.querySelectorAll('[data-icv]')) {
    b.onclick = () => {
      commit('アイコンの縦位置を変更'); tel.icon.valign = b.dataset.icv;
      for (const o of form.querySelectorAll('[data-icv]')) o.classList.toggle('on', o === b);
      live();
    };
  }
  for (const b of form.querySelectorAll('[data-v]')) {
    b.onclick = () => {
      commit('縦の寄せを変更');
      tel.vAlign = b.dataset.v; S.telopStyle.vAlign = tel.vAlign;
      for (const o of form.querySelectorAll('[data-v]')) o.classList.toggle('on', o === b);
      live();
    };
  }
  $('telWrap').addEventListener('change', (e) => {
    commit('折り返しを切り替え'); tel.wrap = e.target.checked; S.telopStyle.wrap = tel.wrap; live();
  });
  bind('telStart', (v) => { tel.start = Math.max(0, +v); });
  bind('telEnd', (v) => { tel.end = Math.max(tel.start + 0.1, +v); });
  bind('boxX', (v) => { tel.box.x = +v; });
  bind('boxY', (v) => { tel.box.y = +v; });
  bind('boxW', (v) => { tel.box.w = Math.max(40, +v); });
  bind('boxH', (v) => { tel.box.h = Math.max(40, +v); });

  $('telZFront').onclick = () => { commit('最前面へ'); bringToFront(tel); renderAll(); };
  $('telZBack').onclick = () => { commit('最背面へ'); sendToBack(tel); renderAll(); };

  $('telPreset').onchange = (e) => {
    const p = presets()[+e.target.value];
    if (!p) return;
    commit(`プリセット「${p.name}」を適用`);
    const { box, vAlign, wrap, ...rowStyle } = p.style;
    Object.assign(row, rowStyle);
    if (box) tel.box = { ...box };
    if (vAlign) tel.vAlign = vAlign;
    S.telopStyle = { ...p.style };
    e.target.value = '';
    renderTelopForm(true); live();
  };
  $('telPresetSave').onclick = () => {
    const name = prompt('プリセット名', `プリセット ${presets().length + 1}`);
    if (!name) return;
    commit('プリセットを保存');
    const { id, text, ...style } = row;
    S.project.telopPresets = [...presets(), {
      name, style: { ...style, box: { ...tel.box }, vAlign: tel.vAlign, wrap: tel.wrap },
    }];
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
  const blur = selectedBlur(), ac = selectedAudio(), im = selectedImage(), mk = selectedMarker();
  const key = mk ? `m:${mk.id}` : blur ? `b:${blur.id}` : ac ? `a:${ac.id}` : im ? `i:${im.id}` : null;
  form.classList.toggle('hidden', !key);
  if (!key) { fxFormKey = null; return; }
  if (!force && fxFormKey === key) { syncBoxNumbers(); syncFxNumbers(); return; }
  fxFormKey = key;

  const live = () => { renderTimeline(); renderOverlay(); };

  if (mk) {
    form.innerHTML = `
      <label>種別
        <div class="align-grid">${Object.entries(MARKER_KINDS).map(([k, v]) =>
          `<button data-mkind="${k}" class="${(mk.kind ?? 'note') === k ? 'on' : ''}">${v.name}</button>`).join('')}</div></label>
      <label>メモ<textarea id="mkText" rows="3">${esc(mk.text ?? '')}</textarea></label>
      <div class="grid2">
        <label>位置（秒）<input class="num" type="number" id="mkTime" step="0.1" value="${mk.time.toFixed(2)}"></label>
        <label>長さ（秒）<input class="num" type="number" id="mkDur" step="0.1" min="0" value="${(mk.duration ?? 0).toFixed(2)}"></label>
      </div>
      <div class="sub-label">長さ 0 なら点、0 より大きければ区間。端をドラッグでも伸縮できます。<br>
        <b>残す</b>を立てるとその外側が、<b>消す</b>を立てるとそこ自体が、
        G / F で送る「消す候補」になります。</div>`;
    const b = (id, fn) => $(id).addEventListener('input', (e) => {
      commit('マーカーを編集', `mk:${mk.id}:${id}`); fn(e.target.value); live();
    });
    b('mkText', (v) => { mk.text = v; });
    b('mkTime', (v) => { mk.time = Math.max(0, +v); });
    b('mkDur', (v) => { mk.duration = Math.max(0, +v); });
    for (const btn of form.querySelectorAll('[data-mkind]')) {
      btn.onclick = () => {
        commit('マーカーの種別を変更');
        mk.kind = btn.dataset.mkind;
        mk.color = MARKER_KINDS[mk.kind].color;
        for (const o of form.querySelectorAll('[data-mkind]')) o.classList.toggle('on', o === btn);
        live();
      };
    }
    return;
  }

  if (blur) {
    const isRect = blur.shape === 'rect';
    const r = isRect ? blurRectAt(blur, currentTimelineTime()) : null;
    const keys = blur.keys ?? [];
    form.innerHTML = `
      <label>かける範囲
        <div class="align-grid">
          <button data-shape="full" class="${!isRect ? 'on' : ''}">全画面</button>
          <button data-shape="rect" class="${isRect ? 'on' : ''}">部分（顔など）</button>
        </div></label>
      <label>強さ <span id="fxStrLbl">${blur.strength}</span>
        <input type="range" id="fxStr" min="4" max="120" value="${blur.strength}"></label>
      ${isRect ? `
      <label>縁のぼかし <span id="fxFeaLbl">${Math.round((blur.feather ?? 0.25) * 100)}%</span>
        <input type="range" id="fxFea" min="0" max="90" value="${Math.round((blur.feather ?? 0.25) * 100)}"></label>
      <label class="chk"><input type="checkbox" id="fxRound" ${blur.round !== false ? 'checked' : ''}> 楕円にする（顔向き）</label>
      <div class="grid2">
        <label>X <input class="num" type="number" id="boxX" value="${Math.round(r.x)}"></label>
        <label>Y <input class="num" type="number" id="boxY" value="${Math.round(r.y)}"></label>
        <label>幅 <input class="num" type="number" id="boxW" value="${Math.round(r.w)}"></label>
        <label>高さ <input class="num" type="number" id="boxH" value="${Math.round(r.h)}"></label>
      </div>

      <div class="panel-head sub inline">追従（キーフレーム）</div>
      <div class="sub-label">動く顔に合わせるには、要所で位置を打つと間を自動で補間します。</div>
      <div class="z-row">
        <button class="mini" id="fxKeyAdd">＋ ここに打つ</button>
        <button class="mini" id="fxKeyDel" ${keys.length ? '' : 'disabled'}>この位置を削除</button>
      </div>
      ${keys.length ? `<div class="key-list">${keys.map((k, i) =>
        `<button class="key-chip" data-key="${i}" title="${tc(k.t, false)} へ移動">${tc(k.t, false)}</button>`).join('')}</div>`
        : '<div class="sub-label">キーなし（位置は固定）</div>'}
      ` : ''}
      <div class="grid2">
        <label>開始（秒）<input class="num" type="number" id="fxStart" step="0.1" value="${blur.start.toFixed(2)}"></label>
        <label>終了（秒）<input class="num" type="number" id="fxEnd" step="0.1" value="${blur.end.toFixed(2)}"></label>
      </div>
      <div class="sub-label">長さ ${tc(blur.end - blur.start, false)}${isRect ? '<br>プレビュー上で枠をドラッグして位置と大きさを決められます。' : ''}</div>`;

    const b = (id, fn) => $(id)?.addEventListener('input', (e) => {
      commit('ぼかしを編集', `blurF:${blur.id}:${id}`); fn(e.target.value); live();
    });
    b('fxStr', (v) => { blur.strength = +v; $('fxStrLbl').textContent = v; });
    b('fxFea', (v) => { blur.feather = +v / 100; $('fxFeaLbl').textContent = `${v}%`; });
    b('fxStart', (v) => { blur.start = Math.max(0, +v); });
    b('fxEnd', (v) => { blur.end = Math.max(blur.start + 0.1, +v); });
    const setRect = (fn) => {
      const cur = blurRectAt(blur, currentTimelineTime());
      fn(cur);
      setBlurRectAt(blur, currentTimelineTime(), cur);
    };
    b('boxX', (v) => setRect((c) => { c.x = +v; }));
    b('boxY', (v) => setRect((c) => { c.y = +v; }));
    b('boxW', (v) => setRect((c) => { c.w = Math.max(20, +v); }));
    b('boxH', (v) => setRect((c) => { c.h = Math.max(20, +v); }));
    $('fxRound')?.addEventListener('change', (e) => {
      commit('ぼかしの形を変更'); blur.round = e.target.checked; live();
    });
    for (const btn of form.querySelectorAll('[data-shape]')) {
      btn.onclick = () => {
        commit('ぼかしの範囲を変更');
        blur.shape = btn.dataset.shape;
        if (blur.shape === 'rect' && !blur.rect && !blur.keys?.length) {
          const W = S.project.output.width, H = S.project.output.height;
          blur.rect = { x: W / 2 - 200, y: H / 2 - 160, w: 400, h: 320 };
        }
        renderFxForm(true); live();
      };
    }
    $('fxKeyAdd')?.addEventListener('click', () => {
      commit('キーを打つ');
      const t = currentTimelineTime();
      const cur = blurRectAt(blur, t);
      blur.keys = blur.keys ?? [];
      const i = blur.keys.findIndex((k) => Math.abs(k.t - t) < 0.02);
      if (i >= 0) Object.assign(blur.keys[i], cur);
      else blur.keys.push({ t, ...cur });
      blur.keys.sort((a2, b2) => a2.t - b2.t);
      renderFxForm(true); live();
      status(`${tc(t, false)} にキーを打ちました（${blur.keys.length} 個）`);
    });
    $('fxKeyDel')?.addEventListener('click', () => {
      const t = currentTimelineTime();
      const i = (blur.keys ?? []).findIndex((k) => Math.abs(k.t - t) < 0.05);
      if (i < 0) return status('この位置にキーがありません', true);
      commit('キーを削除');
      blur.keys.splice(i, 1);
      renderFxForm(true); live();
    });
    for (const chip of form.querySelectorAll('[data-key]')) {
      chip.onclick = () => {
        setMode('program');
        seekProgram(blur.keys[+chip.dataset.key].t, true);
        renderAll(); renderFxForm(true);
      };
    }
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
  const blur = selectedBlur(), ac = selectedAudio(), im = selectedImage(), mk = selectedMarker();
  if (mk) { set('mkTime', mk.time.toFixed(2)); set('mkDur', (mk.duration ?? 0).toFixed(2)); }
  else if (blur) { set('fxStart', blur.start.toFixed(2)); set('fxEnd', blur.end.toFixed(2)); }
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
  $('totalDur').textContent = tc(P.totalDuration(S.project));   // 1 時間超えがあるので時間から出す
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
    // タイムラインの表示範囲も合わせる（拡大したまま遠くへ飛ぶと見失うため）
    if (S.mode === 'program' && revealPlayhead()) renderTimeline();
    renderScrub(); renderTransport();
  };
  move(e);
  cv.onpointermove = (ev) => { if (ev.buttons) move(ev); };
  cv.onpointerup = () => { cv.onpointermove = null; cv.onpointerup = null; };
});

// ---------------------------------------------------------------- 描画：タイムライン

const tlCanvas = $('tlCanvas');
const RULER_H = 26, MARK_H = 24, FX_H = 22, IMG_H = 30, TELOP_H = 30, TRACK_H = 60, AUD_H = 42;

/** テロップのトラック数。いつでも 1 本空きがあるようにして、そこへドラッグで移せる */
function telopTrackCount() {
  const max = S.project.telops.reduce((m, t) => Math.max(m, t.track ?? 0), -1);
  return Math.max(2, max + 2);
}

/** SE / BGM のトラック数。A1 は素材音なので、こちらは A2 から始まる */
function audioTrackCount() {
  const max = S.project.audioClips.reduce((m, a) => Math.max(m, a.track ?? 0), -1);
  return Math.max(2, max + 2);
}

/**
 * トラックの並びと高さ。テロップは可変本数なのでここで組み立てる。
 * @returns {Array<{kind,index,label,y,h}>}
 */
// トラックの見出しは 2 文字なので、何の行なのか説明を添える（初見で分からないため）
const TRACK_TIPS = {
  marker: 'マーカー：目印や覚え書きを置く行です。区間マーカーは「ここは残す／消す」の印になります　［ M で追加 ］',
  fx: 'エフェクト：ぼかしを掛ける区間を置く行です',
  image: '画像：差し込んだ画像を置く行です',
  telop: (i) => `テロップ ${i + 1}：文字を置く行です（重ねたい時は別の行へ）`,
  video: '映像：カットしたクリップが並ぶ行です',
  audio: '元の音：動画にもともと入っている音です（クリップと一緒に動きます）',
  music: (i) => `効果音 / BGM ${i + 1}：追加した音源を置く行です`,
};

function trackLayout() {
  const rows = [];
  let y = RULER_H;
  const push = (kind, index, label, h) => {
    const t = TRACK_TIPS[kind];
    rows.push({ kind, index, label, y, h, tip: typeof t === 'function' ? t(index) : t });
    y += h;
  };
  push('marker', 0, 'MK', MARK_H);
  push('fx', 0, 'FX', FX_H);
  push('image', 0, 'IM', IMG_H);
  for (let i = 0; i < telopTrackCount(); i++) push('telop', i, `T${i + 1}`, TELOP_H);
  push('video', 0, 'V1', TRACK_H);
  push('audio', 0, 'A1', TRACK_H);
  for (let i = 0; i < audioTrackCount(); i++) push('music', i, `A${i + 2}`, AUD_H);
  return rows;
}

/** 種類（と番号）から縦位置を引く */
function trackRow(kind, index = 0) {
  return trackLayout().find((r) => r.kind === kind && r.index === index) ?? null;
}
const trackTop = (kind, i = 0) => trackRow(kind, i)?.y ?? RULER_H;
const trackH = (kind, i = 0) => trackRow(kind, i)?.h ?? 0;

/** y 座標がどのトラックか */
function trackAt(y) {
  return trackLayout().find((r) => y >= r.y && y < r.y + r.h) ?? null;
}
function tracksBottom() {
  const l = trackLayout();
  const last = l[l.length - 1];
  return last.y + last.h;
}

function tlSize() {
  const wrap = $('tlWrap');
  const dpr = devicePixelRatio || 1;
  const w = wrap.clientWidth;
  const h = tracksBottom();           // 全トラック分。足りない分は .tl-body が縦スクロールする
  if (tlCanvas.width !== Math.round(w * dpr) || tlCanvas.height !== Math.round(h * dpr)) {
    tlCanvas.width = Math.round(w * dpr); tlCanvas.height = Math.round(h * dpr);
  }
  tlCanvas.style.width = `${w}px`;
  tlCanvas.style.height = `${h}px`;
  return { w, h, dpr };
}

/**
 * スクロール位置はここだけで書き換える。
 * 実際のスクロールバーは spacer の幅で作るので、S.scrollSec と scrollLeft を常に同期させる。
 */
function setScroll(sec) {
  S.scrollSec = clampScroll(sec);
  const bar = $('tlHScroll');
  const want = Math.round(S.scrollSec * S.pxPerSec);
  if (Math.abs(bar.scrollLeft - want) > 0.5) bar.scrollLeft = want;
}

/**
 * 再生位置がタイムラインの見えている範囲から外れていたら、そこまで寄せる。
 * 拡大率は変えない（プレビューのシークで飛んだ時に、タイムラインを追従させる）。
 * @returns {boolean} 動かしたか
 */
function revealPlayhead(t = S.programTime) {
  const visible = $('tlWrap').clientWidth / S.pxPerSec;
  if (!visible) return false;
  const pad = Math.min(visible * 0.15, 3);   // 端ぴったりだと見づらいので少し余裕を持たせる
  const before = S.scrollSec;
  if (t < S.scrollSec + pad) setScroll(t - pad);
  else if (t > S.scrollSec + visible - pad) setScroll(t - visible + pad);
  else return false;
  return S.scrollSec !== before;
}

/** spacer の幅＝スクロールできる全長。これでネイティブのスクロールバーが出る */
function updateScrollRange() {
  const wrap = $('tlWrap');
  const visible = wrap.clientWidth / S.pxPerSec;
  const end = contentEndSec();
  const margin = Math.min(visible * 0.3, 10);
  const total = end <= visible ? visible : end + margin;
  $('tlSpacer').style.width = `${Math.max(wrap.clientWidth, Math.round(total * S.pxPerSec))}px`;
}

$('tlHScroll').addEventListener('scroll', () => {
  // 自分で scrollLeft を書き換えた分は無視する（フラグではなく値で判定する方が取りこぼさない）
  const sec = $('tlHScroll').scrollLeft / S.pxPerSec;
  if (Math.abs(sec - S.scrollSec) < 0.002) return;
  S.scrollSec = sec;
  renderTimeline();
});

// --- 上下を分けるスプリットバー ---
(() => {
  const split = $('tlSplit');
  const KEY = 'kiriko.timelineHeight';
  const setHeight = (px) => {
    const h = Math.max(140, Math.min(innerHeight - 260, px));
    document.documentElement.style.setProperty('--tl-h', `${Math.round(h)}px`);
  };
  const apply = (px) => { setHeight(px); renderTimeline(); };
  // 起動時は高さを入れるだけ。描画は後段の renderAll() に任せる（この時点ではまだ初期化前）
  try { const saved = Number(localStorage.getItem(KEY)); if (saved) setHeight(saved); } catch {}

  let dragging = false;
  split.addEventListener('pointerdown', (e) => {
    dragging = true;
    split.classList.add('dragging');
    try { split.setPointerCapture(e.pointerId); } catch {}
  });
  split.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    apply(innerHeight - e.clientY - 26); // ステータスバーのぶんを引く
  });
  const end = () => {
    if (!dragging) return;
    dragging = false;
    split.classList.remove('dragging');
    try { localStorage.setItem(KEY, parseInt(getComputedStyle(document.documentElement).getPropertyValue('--tl-h'))); } catch {}
  };
  split.addEventListener('pointerup', end);
  split.addEventListener('pointercancel', end);
})();
const secToX = (t) => (t - S.scrollSec) * S.pxPerSec;
const xToSec = (x) => x / S.pxPerSec + S.scrollSec;

function zoomFit() {
  // クリップだけでなく、末尾に伸びたテロップ・ぼかし・BGM まで含めて収める
  const total = contentEndSec();
  const w = $('tlWrap').clientWidth || 800;
  S.pxPerSec = total > 0 ? Math.max(0.5, (w - 20) / total) : 8;
  updateScrollRange();
  setScroll(0);
  renderTimeline();
}

/** トラック見出しは本数が変わるので動的に組む。高さもここで内容に合わせる */
function renderTrackHeads() {
  const el = $('tlHeads');
  const layout = trackLayout();
  const sig = layout.map((r) => `${r.label}:${r.h}`).join('|');
  if (el.dataset.sig === sig) return;
  el.dataset.sig = sig;
  el.innerHTML = `<div class="tl-head ruler-head" style="height:${RULER_H}px"></div>`
    + layout.map((r) =>
      `<div class="tl-head ${r.kind}" style="height:${r.h}px" title="${esc(r.tip ?? r.label)}">${r.label}</div>`).join('');
  // トラックが増えても収まるよう、タイムラインの高さを中身に合わせる
  $('tlWrap').style.height = `${tracksBottom()}px`;
}

let lastView = '';
function renderTimeline() {
  renderTrackHeads();
  const { w, h, dpr } = tlSize();
  // 表示範囲が変わったら、まだ手を付けていない生成要求は捨てる（見えない所を作らない）
  const view = `${S.scrollSec.toFixed(2)}:${S.pxPerSec.toFixed(2)}:${w}`;
  if (view !== lastView) { lastView = view; thumbs.clearPending(); waves.clearPending(); }
  updateScrollRange();
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
  const BG = { marker: '#1f1c26', fx: '#191f22', image: '#241d16', telop: '#1b1d24', video: '#1e2128', audio: '#1c1f26', music: '#1d1b26' };
  const layout = trackLayout();
  for (const r of layout) {
    ctx.fillStyle = BG[r.kind] ?? '#1b1d24';
    ctx.fillRect(0, r.y, w, r.h);
  }
  ctx.strokeStyle = '#2b303a'; ctx.beginPath();
  for (const r of layout) { ctx.moveTo(0, r.y + 0.5); ctx.lineTo(w, r.y + 0.5); }
  ctx.moveTo(0, tracksBottom() + 0.5); ctx.lineTo(w, tracksBottom() + 0.5);
  ctx.stroke();

  // --- クリップ ---
  for (const { clip, offset } of P.withTimelineOffsets(S.project)) {
    const x = secToX(offset);
    const cw = P.clipDuration(clip) * S.pxPerSec;
    if (x + cw < -5 || x > w + 5) continue;
    const sel = clip.id === S.selectedClipId;
    drawClip(ctx, x, trackTop('video') + 2, cw, TRACK_H - 6, clip, sel, 'video');
    drawClip(ctx, x, trackTop('audio') + 2, cw, TRACK_H - 6, clip, sel, 'audio');
  }

  // --- マーカー ---
  const mkY = trackTop('marker');
  for (const m of S.project.markers) {
    const x = secToX(m.time);
    const mw = (m.duration ?? 0) * S.pxPerSec;
    if (x + Math.max(mw, 160) < -5 || x > w + 5) continue;
    const sel = m.id === S.selectedMarkerId;
    ctx.save();
    if (mw > 1) {
      // 区間マーカー（ここは残す、の印）
      ctx.fillStyle = sel ? '#ffffff' : (MARKER_KINDS[m.kind]?.color ?? '#e0b84c');
      ctx.beginPath(); roundRect(ctx, x, mkY + 3, Math.max(3, mw), MARK_H - 7, 3); ctx.fill();
      ctx.strokeStyle = sel ? '#ffffffdd' : '#00000055'; ctx.lineWidth = sel ? 2 : 1; ctx.stroke();
    } else {
      // 点マーカー（旗）
      ctx.fillStyle = sel ? '#ffffff' : (MARKER_KINDS[m.kind]?.color ?? '#e0b84c');
      ctx.beginPath();
      ctx.moveTo(x, mkY + 3); ctx.lineTo(x + 11, mkY + 7); ctx.lineTo(x, mkY + 11);
      ctx.closePath(); ctx.fill();
      ctx.fillRect(x - 1, mkY + 3, 2, MARK_H - 7);
    }
    // 選択中は下のトラックまで線を引く
    if (sel) {
      ctx.strokeStyle = '#f0d68a99'; ctx.lineWidth = 1; ctx.setLineDash([4, 4]);
      ctx.beginPath(); ctx.moveTo(x + 0.5, mkY); ctx.lineTo(x + 0.5, h); ctx.stroke();
      ctx.setLineDash([]);
    }
    if (m.text) {
      ctx.fillStyle = mw > 40 ? '#101a14' : (MARKER_KINDS[m.kind]?.color ?? '#d9c07a');
      ctx.font = '10.5px -apple-system, sans-serif'; ctx.textBaseline = 'middle';
      const tx = mw > 40 ? x + 5 : x + 14;
      ctx.save();
      ctx.beginPath(); ctx.rect(tx, mkY, w - tx, MARK_H); ctx.clip();
      ctx.fillText(m.text.replace(/\n/g, ' '), tx, mkY + MARK_H / 2);
      ctx.restore();
    }
    ctx.restore();
  }

  // --- ぼかし ---
  for (const b of S.project.blurs) {
    const x = secToX(b.start), bw = (b.end - b.start) * S.pxPerSec;
    if (x + bw < -5 || x > w + 5) continue;
    drawFxBlock(ctx, x, trackTop('fx') + 2, Math.max(3, bw), FX_H - 5, `ぼかし ${b.strength}`,
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
    drawFxBlock(ctx, x, trackTop('image') + 2, Math.max(3, iw), IMG_H - 5, `▣ ${a?.name ?? ''}`,
      im.id === S.selectedImageId, ['#e6b482', '#b57a3e'], '#2b1a06');
  }

  // --- テロップ ---
  for (const tel of S.project.telops) {
    const x = secToX(tel.start);
    const tw = (tel.end - tel.start) * S.pxPerSec;
    if (x + tw < -5 || x > w + 5) continue;
    drawTelopBlock(ctx, x, trackTop('telop', tel.track ?? 0) + 3, Math.max(3, tw), TELOP_H - 7, tel, tel.id === S.selectedTelopId);
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

/** 音源クリップの縦位置。トラックごとに 1 本ずつ置く */
function audioRowRect(ac) {
  return [trackTop('music', ac.track ?? 0) + 3, AUD_H - 7];
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
    const label = (tel.rows ?? []).map((r) => r.text).filter(Boolean).join(' / ').replace(/\n/g, ' ');
    ctx.fillText((tel.bgAssetId ? '▣ ' : '') + (label || '（空）'), x + 5, y + h / 2);
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

/** 吸着先：カットの境目・マーカー（区間なら両端）・再生位置 */
function snapTargets(includePlayhead = true) {
  const list = [0];
  let t = 0;
  for (const c of S.project.clips) { t += P.clipDuration(c); list.push(t); }
  for (const m of S.project.markers) {
    list.push(m.time);
    if ((m.duration ?? 0) > 0) list.push(m.time + m.duration);
  }
  if (includePlayhead) list.push(S.programTime);
  return list;
}

/**
 * 再生位置のドラッグも区切りに吸着させる。
 * 画像やテロップをカットの頭に合わせたい時、まずカーソルをそこへ置くので効いてくる。
 */
function snapPlayhead(sec, alt) {
  S.snapLine = null;
  if (alt) return sec;
  const targets = snapTargets(false);
  if (S.zoneIn !== null) targets.push(S.zoneIn);
  if (S.zoneOut !== null) targets.push(S.zoneOut);
  const hit = snapOne(sec, targets);
  if (hit === null) return sec;
  S.snapLine = hit;
  return hit;
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
function hitMarker(x, y) {
  if (trackAt(y)?.kind !== 'marker') return null;
  for (let i = S.project.markers.length - 1; i >= 0; i--) {
    const m = S.project.markers[i];
    const cx = secToX(m.time);
    const cw = (m.duration ?? 0) > 0 ? (m.duration * S.pxPerSec) : 10;
    if (x >= cx - 5 && x <= cx + cw + 5) return { m, cx, cw };
  }
  return null;
}

function hitBlurBlock(x, y) {
  if (trackAt(y)?.kind !== 'fx') return null;
  for (let i = S.project.blurs.length - 1; i >= 0; i--) {
    const b = S.project.blurs[i];
    const cx = secToX(b.start), cw = (b.end - b.start) * S.pxPerSec;
    if (x >= cx && x <= cx + cw) return { blur: b, cx, cw };
  }
  return null;
}

function hitAudioClip(x, y) {
  const tr = trackAt(y);
  if (tr?.kind !== 'music') return null;
  for (let i = S.project.audioClips.length - 1; i >= 0; i--) {
    const ac = S.project.audioClips[i];
    if ((ac.track ?? 0) !== tr.index) continue;
    const cx = secToX(ac.start), cw = ac.duration * S.pxPerSec;
    if (x >= cx && x <= cx + cw) return { ac, cx, cw };
  }
  return null;
}

function hitImageBlock(x, y) {
  if (trackAt(y)?.kind !== 'image') return null;
  for (let i = S.project.images.length - 1; i >= 0; i--) {
    const im = S.project.images[i];
    const cx = secToX(im.start), cw = (im.end - im.start) * S.pxPerSec;
    if (x >= cx && x <= cx + cw) return { im, cx, cw };
  }
  return null;
}

function hitTelopBlock(x, y) {
  const tr = trackAt(y);
  if (tr?.kind !== 'telop') return null;
  for (let i = S.project.telops.length - 1; i >= 0; i--) {
    const tel = S.project.telops[i];
    if ((tel.track ?? 0) !== tr.index) continue;
    const cx = secToX(tel.start), cw = (tel.end - tel.start) * S.pxPerSec;
    if (x >= cx && x <= cx + cw) return { tel, cx, cw };
  }
  return null;
}

function hitClip(x, y) {
  const k = trackAt(y)?.kind;
  if (k !== 'video' && k !== 'audio') return null;
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
  const hit = hitMarker(x, y) || hitBlurBlock(x, y) || hitImageBlock(x, y) || hitTelopBlock(x, y) || hitAudioClip(x, y) || hitClip(x, y);
  tlCanvas.style.cursor = !hit ? 'default'
    : (Math.abs(x - hit.cx) < 6 || Math.abs(x - (hit.cx + hit.cw)) < 6) ? 'ew-resize' : 'grab';
});

let drag = null;
tlCanvas.addEventListener('pointerdown', (e) => {
  const r = tlCanvas.getBoundingClientRect();
  const x = e.clientX - r.left, y = e.clientY - r.top;
  S.focusArea = 'timeline'; // カーソルキーはコマ送りに戻す
  try { tlCanvas.setPointerCapture(e.pointerId); } catch {}

  // マーカートラック
  const mh = hitMarker(x, y);
  if (mh) {
    select('marker', mh.m.id);
    const hasRange = (mh.m.duration ?? 0) > 0;
    const eL = hasRange && Math.abs(x - mh.cx) < 6;
    const eR = hasRange && Math.abs(x - (mh.cx + mh.cw)) < 6;
    drag = (eL || eR)
      ? { type: 'markerTrim', m: mh.m, side: eL ? 'start' : 'end', startX: x, orig: { ...mh.m } }
      : { type: 'markerMove', m: mh.m, startX: x, orig: { ...mh.m } };
    renderAll(); renderFxForm(true); renderTelopForm(true);
    return;
  }
  if (trackAt(y)?.kind === 'marker') { select('clip', null); renderAll(); renderFxForm(true); renderTelopForm(true); return; }

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
  if (trackAt(y)?.kind === 'fx') { select('clip', null); renderAll(); renderFxForm(true); renderTelopForm(true); return; }

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
  if (trackAt(y)?.kind === 'image') { select('clip', null); renderAll(); renderFxForm(true); renderTelopForm(true); return; }

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
  if (trackAt(y)?.kind === 'music') { select('clip', null); renderAll(); renderFxForm(true); renderTelopForm(true); return; }

  // テロップトラック
  const th = hitTelopBlock(x, y);
  if (th) {
    const rebuild = th.tel.id !== S.selectedTelopId;
    select('telop', th.tel.id);
    commit('テロップの時間を変更', `telopTime:${th.tel.id}`);
    const edgeL = Math.abs(x - th.cx) < 6, edgeR = Math.abs(x - (th.cx + th.cw)) < 6;
    drag = edgeL || edgeR
      ? { type: 'telopTrim', tel: th.tel, side: edgeL ? 'start' : 'end', startX: x, orig: { start: th.tel.start, end: th.tel.end } }
      : { type: 'telopMove', tel: th.tel, startX: x, orig: { start: th.tel.start, end: th.tel.end, track: th.tel.track ?? 0 } };
    renderAll(); renderFxForm(true);
    if (rebuild) renderTelopForm(true);
    return;
  }
  if (trackAt(y)?.kind === 'telop') { // テロップトラックの空き
    select('clip', null);
    renderAll(); renderTelopForm(true); renderFxForm(true);
    return;
  }

  const hit = hitClip(x, y);
  if (!hit || y < RULER_H) {
    setMode('program');
    seekProgram(Math.max(0, snapPlayhead(xToSec(x), e.altKey)), true);
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
    drag = {
      type: 'trim', clip: hit.clip, side: edgeL ? 'in' : 'out', startX: x,
      orig: { in: hit.clip.in, out: hit.clip.out },
      startSec: clipStartSec(hit.clip),   // 詰める／空ける位置の基準
    };
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
    seekProgram(Math.max(0, snapPlayhead(xToSec(x), e.altKey)), false);
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
  } else if (drag.type === 'markerMove') {
    const d = (x - drag.startX) / S.pxPerSec;
    drag.m.time = Math.max(0, snapBlockMove(drag.orig.time + d, drag.orig.duration ?? 0, e.altKey));
    renderTimeline(); syncFxNumbers();
  } else if (drag.type === 'markerTrim') {
    const d = (x - drag.startX) / S.pxPerSec;
    if (drag.side === 'start') {
      const endAt = drag.orig.time + drag.orig.duration;
      const ns = Math.max(0, Math.min(endAt - 0.05, snapEdge(drag.orig.time + d, e.altKey)));
      drag.m.time = ns;
      drag.m.duration = endAt - ns;
    } else {
      const end = snapEdge(drag.orig.time + drag.orig.duration + d, e.altKey);
      drag.m.duration = Math.max(0.05, end - drag.m.time);
    }
    renderTimeline(); syncFxNumbers();
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
    const tr = trackAt(e.clientY - tlCanvas.getBoundingClientRect().top);
    if (tr?.kind === 'music') drag.ac.track = tr.index;
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
    // 縦にドラッグすると T1 / T2 … を移れる
    const tr = trackAt(e.clientY - tlCanvas.getBoundingClientRect().top);
    if (tr?.kind === 'telop') drag.tel.track = tr.index;
    renderTimeline(); renderOverlay(); syncBoxNumbers();
  } else if (drag.type === 'telopTrim') {
    const d = (x - drag.startX) / S.pxPerSec;
    if (drag.side === 'start') drag.tel.start = Math.max(0, Math.min(drag.orig.end - 0.1, snapEdge(drag.orig.start + d, e.altKey)));
    else drag.tel.end = Math.max(drag.orig.start + 0.1, snapEdge(drag.orig.end + d, e.altKey));
    renderTimeline(); renderOverlay(); syncBoxNumbers();
  } else if (drag.type === 'move') {
    if (Math.abs(x - drag.startX) > 4) drag.moved = true;
    const clips = S.project.clips;
    const t = xToSec(x);
    // 差し込み位置は「掴んでいるクリップを抜いた並び」で決める。
    // 掴んだままの並びで計算すると、入れ替わるたびに長さの配置が変わって
    // 答えが変わり、同じ位置で行ったり来たりする（終端側で顕著だった）
    const others = clips.filter((c) => c !== drag.clip);
    let acc = 0, to = others.length;
    for (let i = 0; i < others.length; i++) {
      const d = P.clipDuration(others[i]);
      if (t < acc + d / 2) { to = i; break; }
      acc += d;
    }
    others.splice(to, 0, drag.clip);
    if (others.some((c, i) => c !== clips[i])) {
      if (!drag.reordered) { commit('クリップを並べ替え'); drag.reordered = true; }
      S.project.clips = others;
      renderTimeline();
    }
  }
});

document.addEventListener('pointerup', () => history.endGroup());
document.addEventListener('focusin', () => history.endGroup());

tlCanvas.addEventListener('pointerup', () => {
  S.snapLine = null;
  // 端をドラッグして長さが変わった分、後ろのものをまとめて動かす
  if (drag?.type === 'trim') {
    const before = drag.orig.out - drag.orig.in;
    const after = P.clipDuration(drag.clip);
    const d = after - before;
    if (Math.abs(d) > 0.0005) {
      // 頭を削った時はクリップの先頭、後ろを削った時はクリップの終わりが境目
      const edge = drag.side === 'in' ? drag.startSec : drag.startSec + Math.min(before, after);
      if (d < 0) rippleAfter(edge, edge - d);
      else insertGapAt(edge, d);
    }
  }
  if (drag && drag.type === 'move' && !drag.moved) {
    // クリック扱い：選択のみ
  }
  drag = null;
  renderAll();
});

tlCanvas.addEventListener('dblclick', (e) => {
  const r = tlCanvas.getBoundingClientRect();
  const y = e.clientY - r.top;
  const dk = trackAt(y)?.kind;
  if (dk === 'telop') {
    const th = hitTelopBlock(e.clientX - r.left, y);
    if (th) { select('telop', th.tel.id); S.telopRow = 0; renderAll(); openTelopEditor(); }
    return;
  }
  if (dk === 'marker') {
    const mh = hitMarker(e.clientX - r.left, y);
    if (mh) { select('marker', mh.m.id); renderAll(); renderFxForm(true); setTimeout(() => $('mkText')?.focus(), 0); }
    return;
  }
  if (dk !== 'video' && dk !== 'audio') return;
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

// タイムラインの右クリック
tlCanvas.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  const r = tlCanvas.getBoundingClientRect();
  const x = e.clientX - r.left, y = e.clientY - r.top;
  const hit = hitBlurBlock(x, y) || hitImageBlock(x, y) || hitTelopBlock(x, y) || hitAudioClip(x, y) || hitClip(x, y);
  const items = [];

  if (hit) {
    if (hit.m) {
      select('marker', hit.m.id);
      items.push({ label: 'マーカーを削除', key: 'Delete' });
      if ((hit.m.duration ?? 0) > 0.02) {
        items.push({ label: 'この区間を範囲選択', run: () => { select('marker', hit.m.id); selectMarkerRange(); } });
      }
      items.push({ label: '次の区間外を範囲選択', key: 'G', run: () => { seekProgram(hit.m.time, true); selectNextGap(); } });
      items.push({ label: '前の区間外を範囲選択', key: 'F', run: () => { seekProgram(hit.m.time, true); selectPrevGap(); } });
      items.push({ label: '区間マーカーの外を全部切り取る…', run: () => keepMarkedRangesOnly() });
    }
    else if (hit.blur) { select('blur', hit.blur.id); items.push({ label: 'ぼかしを削除', key: 'Delete' }); }
    else if (hit.im) {
      select('image', hit.im.id);
      items.push({ label: '画像を削除', key: 'Delete' });
      items.push({ label: 'コピー', key: '⌘C', run: () => copySelected() });
    }
    else if (hit.tel) {
      select('telop', hit.tel.id);
      items.push({ label: 'テロップを削除', key: 'Delete' });
      items.push({ label: 'コピー', key: '⌘C', run: () => copySelected() });
      items.push({ label: 'テロップを編集…', run: () => openTelopDialog() });
      items.push({ label: '★ ライブラリに保存…', run: () => saveTelopToLibrary() });
    }
    else if (hit.ac) {
      select('audio', hit.ac.id);
      items.push({ label: '音源を削除', key: 'Delete' });
      items.push({ label: 'コピー', key: '⌘C', run: () => copySelected() });
    }
    else if (hit.clip) { select('clip', hit.clip.id); items.push({ label: 'クリップを削除' }); }
    if (!items[0].run) items[0].run = () => deleteSelected();
    renderAll(); renderTelopForm(true); renderFxForm(true);
  }
  if (zoneRange()) {
    items.push({ label: '範囲を切り取って詰める', key: 'Delete', run: () => extractZone() });
    items.push({ label: '範囲のテロップ・音源などをまとめてコピー', key: '⌘C', run: () => copySelected() });
  }
  if (S.clipboard) {
    items.push({ label: S.clipboard.items.length === 1
      ? `ここに${KIND_NAME[S.clipboard.items[0].kind]}を貼り付け`
      : `ここに ${S.clipboard.items.length} 件を貼り付け`, key: '⌘V',
      run: () => { seekProgram(xToSec(x), true); pasteClipboard(); } });
  }
  if (!hit && trackAt(y)?.kind === 'marker') {
    items.push({ label: 'ここにマーカーを立てる', key: 'M', run: () => addMarker(xToSec(x)) });
    if (keepRanges().length) items.push({ label: '区間マーカーの外を全部切り取る…', run: () => keepMarkedRangesOnly() });
  }
  if (!items.length) { hideContextMenu(); return; }
  showContextMenu(e.clientX, e.clientY, items);
});

/**
 * ホイール / トラックパッド。
 *   横（deltaX）        … 時間軸を左右に
 *   縦（deltaY）        … タイムラインのペインを上下に（トラックが入りきらない時）
 *   Shift + 縦          … 時間軸を左右に（Windows の慣習）
 *   ⌘ / Ctrl + 縦       … 拡大縮小（カーソル位置を固定）
 * Mac のマジックマウス／トラックパッドは縦横そのまま、普通のホイールは Shift で横。
 * トラックが縦に収まっていて動かせない時は、素のホイールも横スクロールに回す。
 */
$('tlWrap').addEventListener('wheel', (e) => {
  const r = tlCanvas.getBoundingClientRect();

  if (e.ctrlKey || e.metaKey) {
    // Mac のトラックパッドのピンチも ctrlKey 付きの wheel として届くのでそのまま効く
    e.preventDefault();
    const px = e.clientX - r.left;
    const anchorSec = xToSec(px);
    const f = Math.exp(-e.deltaY * 0.002);
    S.pxPerSec = Math.max(0.2, Math.min(400, S.pxPerSec * f));
    updateScrollRange();
    setScroll(anchorSec - px / S.pxPerSec);
    renderTimeline();
    return;
  }

  const scrollTime = (d) => {
    e.preventDefault();
    setScroll(S.scrollSec + d / S.pxPerSec);
    renderTimeline();
  };

  if (e.shiftKey) return scrollTime(e.deltaY || e.deltaX);
  if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return scrollTime(e.deltaX);

  const body = $('tlBody');
  if (body.scrollHeight <= body.clientHeight + 1) return scrollTime(e.deltaY);
  // 縦に動かせるならブラウザに任せる（.tl-body がそのままスクロールする）
}, { passive: false });

// ---------------------------------------------------------------- プロジェクト保存 / 読込

async function saveProject() {
  S.project.title = S.project.title || '無題プロジェクト';
  const text = P.serialize(S.project);
  const name = `${S.project.title || '無題プロジェクト'}.kiriko`;
  // 作業フォルダを開いていれば、そこへそのまま保存する（毎回選ばなくてよい）
  const dir = await FS.writableDir().catch(() => null);
  if (dir && await FS.writeFile(dir, name, new Blob([text], { type: 'application/json' }))) {
    status(`${dir.name} / ${name} に保存しました`);
    return;
  }
  if ('showSaveFilePicker' in window) {
    try {
      const h = await window.showSaveFilePicker({
        suggestedName: name,
        types: [{ description: 'Kiriko プロジェクト', accept: { 'application/json': ['.kiriko', '.json'] } }],
      });
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
  const text = await file.text();
  // 「開く」から .kdenlive を選んだ時は、そのまま取り込みに回す
  // （JSON として読もうとして落ちていた）
  if (/\.kdenlive$/i.test(file.name) || text.trimStart().startsWith('<')) {
    await importKdenlive(file, text);
    return;
  }
  try {
    const p = P.deserialize(text);
    // ファイルの実体はブラウザに保持できないので、名前で突き合わせる。
    // 保存されていた素材の一覧は捨てずに残す（どのファイルが要るか分かるように）。
    // 既に開いている素材があれば、そちらの id に寄せる。
    const loaded = new Map();
    for (const [id, src] of S.sources) loaded.set(src.name, id);
    const remap = new Map();
    const sources = [];
    for (const s of p.sources ?? []) {
      const hit = loaded.get(s.name);
      if (hit) { remap.set(s.id, hit); sources.push({ ...s, id: hit }); loaded.delete(s.name); }
      else sources.push({ ...s });
    }
    // 読み込む前から開いていて、プロジェクトに載っていない素材も残す
    for (const [name, id] of loaded) {
      const src = S.sources.get(id);
      sources.push({ id, name, size: src.file.size, duration: src.duration });
    }
    p.sources = sources;
    p.clips = (p.clips ?? []).map((c) => ({ ...c, sourceId: remap.get(c.sourceId) ?? c.sourceId }));
    commit('プロジェクトを読み込み');
    S.project = p;
    normalizeProject();
    syncProjectUI();
    select(null, null);
    zoomFit();
    refreshProgram();
    renderAll();
    status('プロジェクトを読み込みました。素材を探しています…');
    await reloadMissingAssets();
  } catch (e) {
    status(`プロジェクトを読み込めませんでした（${file.name}）: ${e.message}`, true);
  }
}

// ---------------------------------------------------------------- 作業フォルダ
//
// ブラウザはファイルの「パス」を扱えないので、プロジェクトファイルを渡されても
// 「その隣にある動画」へは辿り着けない。VSCode と同じくフォルダごと開いてもらい、
// その中でプロジェクトと素材を突き合わせる。

/** フォルダを開く仕組みが使えるブラウザか */
const canUseWorkDir = () => 'showDirectoryPicker' in window;

/** 作業フォルダの表示と、ボタンの有効・無効を更新する */
function renderWorkDir() {
  const el = $('workDirName');
  const ready = !canUseWorkDir() || !!(S.workDir && S.workDirReady);
  if (el) {
    el.textContent = S.workDir && S.workDirReady ? S.workDir.name : '';
    el.classList.toggle('hidden', !(S.workDir && S.workDirReady));
    el.title = S.workDir ? `作業フォルダ: ${S.workDir.name}` : '';
  }
  // フォルダが無いうちは、保存先も素材の在り処も決まらない。
  // 中途半端に触れるより、開いてもらうまで止めておく（VSCode と同じ考え方）
  document.body.classList.toggle('no-workdir', !ready);
  const wc = $('welcome');
  if (wc) wc.classList.toggle('hidden', ready);
  // 前回のフォルダがあれば、開き直すボタンを出す
  const re = $('wcReopen');
  if (re) {
    const show = !ready && !!S.workDir;
    re.classList.toggle('hidden', !show);
    if (show) re.textContent = `「${S.workDir.name}」を開き直す`;
    const op = $('wcOpen');
    if (op) op.className = show ? 'tb wc-alt' : 'tb export';
  }
}

/** フォルダ直下の .kiriko を新しい順に返す */
async function listProjectsIn(dir) {
  const out = [];
  for await (const [name, entry] of dir.entries()) {
    if (entry.kind !== 'file' || !/\.kiriko$/i.test(name)) continue;
    const f = await entry.getFile();
    out.push({ name, handle: entry, mtime: f.lastModified });
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

/** 作業フォルダを選んでもらい、中のプロジェクトを開く */
async function openWorkFolder() {
  if (!('showDirectoryPicker' in window)) return status('このブラウザはフォルダを開けません', true);
  let dir;
  try {
    dir = await window.showDirectoryPicker({ mode: 'readwrite' });
  } catch (e) { if (e.name !== 'AbortError') status(e.message, true); return; }
  await useWorkFolder(dir);
}

async function useWorkFolder(dir) {
  S.workDir = dir;
  S.workDirReady = true;
  await FS.setWorkDir(dir);
  await FS.rememberDir(dir);
  renderWorkDir();

  const projs = await listProjectsIn(dir).catch(() => []);
  if (!projs.length) {
    status(`${dir.name} を作業フォルダにしました（プロジェクトはまだありません）`);
    await reloadMissingAssets(true);
    return;
  }
  if (projs.length === 1) { await openFromWorkDir(projs[0]); return; }
  showProjectPicker(projs);
}

async function openFromWorkDir(p) {
  await FS.rememberFile(p.name, p.handle);
  await loadProject(await p.handle.getFile());
}

/** フォルダにプロジェクトが複数ある時に選んでもらう */
function showProjectPicker(projs) {
  const dlg = $('projPick');
  const list = $('projPickList');
  list.innerHTML = '';
  for (const p of projs) {
    const b = document.createElement('button');
    b.className = 'pick-row';
    b.innerHTML = `<span class="pick-name"></span><span class="pick-time"></span>`;
    b.querySelector('.pick-name').textContent = p.name;
    b.querySelector('.pick-time').textContent = new Date(p.mtime).toLocaleString();
    b.onclick = async () => { dlg.classList.add('hidden'); await openFromWorkDir(p); };
    list.appendChild(b);
  }
  dlg.classList.remove('hidden');
}

/** 前回の作業フォルダを覚えていれば、使える状態か確かめる */
async function restoreWorkDir() {
  S.workDir = await FS.getWorkDir().catch(() => null);
  // 許可はブラウザ再起動などで切れる。尋ね直すにはユーザーの操作が要るので、
  // ここでは確かめるだけにして、案内画面のボタンから requestPermission する
  S.workDirReady = S.workDir
    ? (await S.workDir.queryPermission?.({ mode: 'readwrite' })) === 'granted'
    : false;
  renderWorkDir();
  if (S.workDirReady) await useWorkFolder(S.workDir);
}

/** 前回のフォルダを開き直す（ボタンから＝ユーザー操作の直後） */
async function reopenWorkDir() {
  if (!S.workDir) return openWorkFolder();
  let ok = false;
  try {
    ok = (await S.workDir.requestPermission({ mode: 'readwrite' })) === 'granted';
  } catch { ok = false; }
  if (!ok) return openWorkFolder();   // 断られた・もう無い時は選び直してもらう
  await useWorkFolder(S.workDir);
}

/** プロジェクトが要求していて、まだ開けていない素材の一覧 */
function missingAssets() {
  const out = [];
  for (const x of S.project.sources) if (!S.sources.has(x.id)) out.push({ kind: 'video', ...x });
  for (const x of S.project.audioAssets) if (!S.library?.has(x.id)) out.push({ kind: 'audio', ...x });
  for (const x of S.project.imageAssets) if (!S.imageLib.get(x.id)) out.push({ kind: 'image', ...x });
  return out;
}

/**
 * 覚えているファイル／フォルダから、足りない素材を読み直す。
 * @param {boolean} ask 許可を尋ねてよいか（ボタンから呼ぶ時だけ true）
 */
async function reloadMissingAssets(ask = false) {
  const want = missingAssets();
  if (!want.length) { renderMissingBar(); return { loaded: 0, missing: [] }; }

  let loaded = 0, fromLib = 0;
  for (const a of want) {
    let file = await FS.resolveFile(a.name, ask);
    // 画像だけは、テロップライブラリに同じ名前で入っていればそこから戻せる
    // （ライブラリから置いたテロップの画像は、元ファイルが手元に無いことがある）
    if (!file && a.kind === 'image') {
      const asset = await Lib.findAssetByName(a.name).catch(() => null);
      if (asset) {
        file = await Lib.assetToFile(asset).catch(() => null);
        if (file) fromLib++;
      }
    }
    if (!file) continue;
    status(`${a.name} を読み込んでいます…`);
    try {
      if (a.kind === 'video') {
        const src = new Mp4Source(file);
        await src.load(() => {});
        S.sources.set(a.id, src);
        Object.assign(a, { size: file.size, duration: src.duration });
        const slot = S.project.sources.find((x) => x.id === a.id);
        if (slot) Object.assign(slot, { size: file.size, duration: src.duration });
        if (!S.currentSourceId) S.currentSourceId = a.id;
      } else if (a.kind === 'audio') {
        const meta = await library().add(file, a.id);
        Object.assign(S.project.audioAssets.find((x) => x.id === a.id) ?? {}, meta);
      } else {
        const meta = await S.imageLib.add(file, a.id);
        Object.assign(S.project.imageAssets.find((x) => x.id === a.id) ?? {}, meta);
      }
      loaded++;
    } catch (e) {
      console.error(e);
    }
  }

  // 読み直した素材をモニターにも載せる（開いただけでは selectSource を通らない）
  if (S.currentSourceId && !S.videoSourceId) {
    setVideoSource(S.currentSourceId);
    $('monName').textContent = curSource()?.name ?? '—';
  }
  const missing = missingAssets();
  refreshProgram();
  renderAll();
  renderMissingBar();
  if (loaded) {
    const via = fromLib ? `（うち ${fromLib} 件はテロップライブラリから）` : '';
    status(missing.length
      ? `素材 ${loaded} 件を読み直しました${via}。${missing.length} 件は見つかりませんでした`
      : `素材 ${loaded} 件を読み直しました${via}`);
  } else if (missing.length) {
    status(`${missing.length} 件の素材が見つかりません。［素材を探す］から選んでください`, true);
  }
  return { loaded, missing };
}

/** 足りない素材があることを知らせる帯 */
function renderMissingBar() {
  const bar = $('missingBar');
  const want = missingAssets();
  bar.classList.toggle('hidden', !want.length);
  if (!want.length) return;
  bar.querySelector('.mb-text').textContent =
    `${want.length} 件の素材が見つかりません（${want.map((x) => x.name).join('、')}）`
    + ' — 素材の入ったフォルダを開くと、次回から自動でつながります';
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
  setExporting(true);
  const ac = new AbortController();
  $('btnCancel').onclick = () => ac.abort();
  $('exportDialog').classList.remove('hidden');
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
        status(`書き出し中… ${(r * 100).toFixed(1)}%（残り約 ${tc(eta, false)}）`);
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
    setExporting(false);
    $('exportDialog').classList.add('hidden');
    $('progBar').style.width = '0';
  }
}

/**
 * 書き出し中の見た目を切り替える。
 * 画面はオーバーレイで覆われるが、ボタン自体も止めておく（連打・二重起動の防止）。
 * 長時間かかるので、うっかりタブを閉じた時にも聞き返す。
 */
function setExporting(on) {
  const btn = $('btnExport');
  btn.disabled = on;
  btn.classList.toggle('busy', on);
  btn.title = on ? '書き出し中です' : 'mp4 で書き出す';
  document.body.classList.toggle('exporting', on);
  if (on) addEventListener('beforeunload', warnExporting);
  else removeEventListener('beforeunload', warnExporting);
}
function warnExporting(e) { e.preventDefault(); e.returnValue = ''; }

// ---------------------------------------------------------------- イベント配線

$('btnSaveProj').onclick = saveProject;
$('btnUndo').onclick = doUndo;
$('btnRedo').onclick = doRedo;
$('btnWorkDir').onclick = openWorkFolder;
$('wcOpen').onclick = openWorkFolder;
$('wcReopen').onclick = reopenWorkDir;
$('projPickClose').onclick = () => $('projPick').classList.add('hidden');
$('btnLoadProj').onclick = async () => {
  if (!('showOpenFilePicker' in window)) return $('projInput').click();
  try {
    const [h] = await window.showOpenFilePicker({
      types: [{ description: 'Kiriko / Kdenlive のプロジェクト',
        accept: { 'application/json': ['.kiriko', '.json'], 'application/xml': ['.kdenlive'] } }],
    });
    await FS.rememberFile(h.name, h);
    await loadProject(await h.getFile());
  } catch (e) { if (e.name !== 'AbortError') status(e.message, true); }
};
$('btnAddClip').onclick = addClip;
$('btnDelete').onclick = deleteSelected;
// 素材の追加は 1 つにまとめている（種類は拡張子で判別する）
$('binAdd').onclick = () => openFiles().catch((e) => status(e.message, true));
for (const b of document.querySelectorAll('#binFilter button')) {
  b.onclick = () => {
    S.mediaFilter = b.dataset.f;
    for (const x of document.querySelectorAll('#binFilter button')) x.classList.toggle('on', x === b);
    renderMediaBin();
  };
}
$('imageInput').onchange = (e) => { addImageAssets([...e.target.files]); e.target.value = ''; };
// 足りない素材を探す
$('mbFind').onclick = async () => {
  // まず覚えているものから（ここはユーザー操作の直後なので許可を尋ねられる）
  const r = await reloadMissingAssets(true);
  if (!r.missing.length) return;
  // それでも見つからない分は選んでもらう
  if (!('showOpenFilePicker' in window)) { $('fileInput').click(); return; }
  try {
    const handles = await window.showOpenFilePicker({
      multiple: true,
      types: [{ description: '素材', accept: {
        'video/*': ['.mp4', '.mov', '.m4v'],
        'audio/*': ['.mp3', '.wav', '.m4a', '.ogg'],
        'image/*': ['.png', '.jpg', '.jpeg', '.webp'],
      } }],
    });
    for (const h of handles) await FS.rememberFile(h.name, h);
    await addFiles(await Promise.all(handles.map((h) => h.getFile())));
    await reloadMissingAssets(true);
  } catch (e) { if (e.name !== 'AbortError') status(e.message, true); }
};

$('mbFolder').onclick = async () => {
  if (!('showDirectoryPicker' in window)) return status('このブラウザはフォルダ選択に対応していません', true);
  try {
    // 書き込みも許してもらう。作業フォルダとして保存先にもするため
    // （断られても読み取りだけで動く）
    const dir = await window.showDirectoryPicker({ mode: 'readwrite' });
    S.workDir = dir;
    S.workDirReady = true;
    await FS.setWorkDir(dir);
    await FS.rememberDir(dir);
    renderWorkDir();
    status(`${dir.name} を作業フォルダにしました。素材を探しています…`);
    await reloadMissingAssets(true);
  } catch (e) { if (e.name !== 'AbortError') status(e.message, true); }
};

for (const t of document.querySelectorAll('.bintab')) {
  t.onclick = () => { S.binTab = t.dataset.bin; renderBin(); };
}
$('libRefresh').onclick = () => reloadLibrary();

// ライブラリフォルダ（テロップ用画像の置き場所）
$('libDirPick').onclick = async () => {
  if (!('showDirectoryPicker' in window)) return status('このブラウザはフォルダを選べません', true);
  try {
    const dir = await window.showDirectoryPicker({ mode: 'readwrite' });
    S.libDir = dir;
    await FS.setLibDir(dir);
    renderLibDir();
    status(`ライブラリフォルダを ${dir.name} にしました`);
  } catch (e) { if (e.name !== 'AbortError') status(e.message, true); }
};

/** ライブラリフォルダの表示を更新する */
function renderLibDir() {
  const el = $('libDirName');
  if (!el) return;
  el.textContent = S.libDir ? S.libDir.name : '未設定';
  el.classList.toggle('unset', !S.libDir);
  el.title = S.libDir ? `ライブラリフォルダ: ${S.libDir.name}` : 'まだ決めていません（画像はブラウザの中に抱えます）';
}

/** 覚えているライブラリフォルダを読み戻す */
async function restoreLibDir() {
  S.libDir = await FS.getLibDir().catch(() => null);
  renderLibDir();
}

$('libExport').onclick = async () => {
  try {
    const n = S.libSets.length;
    if (!n) return status('ライブラリが空です', true);
    // ライブラリフォルダに実ファイルで置いてある画像は、既定では名前だけ書き出す。
    // 別の PC へ持っていくなら埋め込んでおかないと画像が付いてこない
    const hasFiles = S.libSets.some((e) => (e.assets ?? []).some((a) => a.file));
    const embed = hasFiles
      && confirm('画像もファイルに埋め込みますか？\n\n'
        + '［OK］別の PC へ移せます（サイズは大きくなります）\n'
        + '［キャンセル］名前だけ書き出します（ライブラリフォルダと一緒に使ってください）');
    const text = await Lib.exportAll(embed);
    const name = 'テロップライブラリ.kirikolib';
    if ('showSaveFilePicker' in window) {
      try {
        const h = await window.showSaveFilePicker({
          suggestedName: name,
          types: [{ description: 'Kiriko テロップライブラリ', accept: { 'application/json': ['.kirikolib', '.json'] } }],
        });
        const w = await h.createWritable();
        await w.write(text); await w.close();
        return status(`テロップセット ${n} 件を書き出しました`);
      } catch (e) { if (e.name === 'AbortError') return; }
    }
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    const a = document.createElement('a'); a.href = url; a.download = name; a.click();
    URL.revokeObjectURL(url);
    status(`テロップセット ${n} 件を書き出しました`);
  } catch (e) { status(`書き出せませんでした: ${e.message}`, true); }
};

$('libImport').onclick = () => $('libInput').click();
$('libInput').onchange = async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const r = await Lib.importAll(await file.text(), false);
    await reloadLibrary();
    S.binTab = 'lib'; renderBin();
    status(r.added
      ? `テロップセット ${r.added} 件を読み込みました` + (r.skipped ? `（${r.skipped} 件は既にあるので飛ばしました）` : '')
      : '新しく追加するものはありませんでした');
  } catch (err) { status(`読み込めませんでした: ${err.message}`, true); }
};
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
  updateScrollRange();
  setScroll(centerSec - nv / 2);
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
$('btnAddMarker').onclick = () => addMarker();
$('btnPrevGap').onclick = selectPrevGap;
$('btnNextGap').onclick = selectNextGap;
$('btnAddTelop').onclick = addTelop;
$('btnCopy').onclick = copySelected;
$('btnPaste').onclick = pasteClipboard;
$('telSaveLib').onclick = () => saveTelopToLibrary();
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
  // dataTransfer はイベントを抜けると無効になるので、await より先に全部取り出す
  const files = [...e.dataTransfer.files];
  const pending = [...e.dataTransfer.items]
    .map((it) => { try { return it.getAsFileSystemHandle?.() ?? null; } catch { return null; } })
    .filter(Boolean);

  if (files.length) addFiles(files);

  // ハンドルが取れたものは覚えておく（次に開いた時そのまま読み直せる）
  (async () => {
    for (const p of pending) {
      const h = await p.catch(() => null);
      if (!h) continue;
      if (h.kind === 'file') await FS.rememberFile(h.name, h);
      else if (h.kind === 'directory') await FS.rememberDir(h);
    }
  })();
});

// --- キーボード ---
document.addEventListener('keydown', (e) => {
  if (e.target instanceof Element && e.target.matches('input, select, textarea')) return;
  const k = e.key.toLowerCase();
  // 作業フォルダを開くまでは編集操作を受け付けない（ヘルプだけ通す）
  if (document.body.classList.contains('no-workdir') && k !== '?' && k !== 'escape') return;
  if (e.ctrlKey || e.metaKey) {
    if (k === 's') { e.preventDefault(); saveProject(); return; }
    if (k === 'z') { e.preventDefault(); e.shiftKey ? doRedo() : doUndo(); return; }
    if (k === 'y') { e.preventDefault(); doRedo(); return; }   // Windows 流
    if (k === 'c') { e.preventDefault(); copySelected(); return; }
    if (k === 'v') { e.preventDefault(); pasteClipboard(); return; }
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
    case 'm': addMarker(); break;
    case ',': jumpMarker(-1); break;
    case '.': jumpMarker(1); break;
    case 'g': selectNextGap(); break;
    case 'f': selectPrevGap(); break;
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
  renderNoMedia();
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
// 版の表示。js/version.js は scripts/gen-version.mjs が作る（git 管理外）ので、
// 生成されていない時は「開発中」と出す。
(async () => {
  const el = $('version');
  try {
    const m = await import('./version.js');
    el.textContent = m.VERSION_FOOTER;
  } catch {
    el.textContent = 'Kiriko（開発中）';
  }
})();

renderHistoryUI();
renderAll();
reloadLibrary();
restoreWorkDir();
restoreLibDir();
status('準備完了 — 作業フォルダを開くか、mp4 をここへドロップしてください');

// ---------------------------------------------------------------- MCP 連携

/** プロジェクトを丸ごと差し替える（素材は名前で取り直す） */
function applyProject(p) {
  const byName = new Map();
  for (const [id, src] of S.sources) byName.set(src.name, id);
  const remap = new Map();
  for (const s of p.sources ?? []) {
    const hit = byName.get(s.name);
    if (hit) remap.set(s.id, hit);
  }
  p.clips = (p.clips ?? []).map((c) => ({ ...c, sourceId: remap.get(c.sourceId) ?? c.sourceId }));
  p.sources = S.project.sources;
  S.project = p;
  normalizeProject();
  select(null, null);
  syncProjectUI();
  zoomFit();
  renderAll();
}

/** タイムライン上の音量エンベロープ。素材の波形をクリップの並びに沿って読み出す */
async function timelineLevels(from, to, binsPerSec) {
  const n = Math.max(1, Math.ceil((to - from) * binsPerSec));
  const out = new Float32Array(n);
  const entries = P.withTimelineOffsets(S.project);

  // 必要な範囲の波形を用意する（未デコードなら取りに行く）
  for (const { clip, offset } of entries) {
    const dur = P.clipDuration(clip);
    if (offset + dur < from || offset > to) continue;
    const src = S.sources.get(clip.sourceId);
    if (!src?.audio) continue;
    waves.ensure(src, clip.in, clip.out);
  }
  // 取り終わるまで待つ（見えている所だけの遅延生成なので、ここでは明示的に待つ）
  for (let i = 0; i < 600 && (waves.busy || waves.queue.length); i++) {
    await new Promise((r) => setTimeout(r, 50));
  }

  for (const { clip, offset } of entries) {
    const dur = P.clipDuration(clip);
    if (offset + dur < from || offset > to) continue;
    const src = S.sources.get(clip.sourceId);
    if (!src?.audio) continue;
    const peaks = waves.peaksFor(src);
    const scale = waves.scaleFor(src);
    const gain = clip.volume ?? 1;
    for (let i = 0; i < n; i++) {
      const t = from + i / binsPerSec;          // タイムライン時刻
      if (t < offset || t >= offset + dur) continue;
      const srcT = clip.in + (t - offset);      // 素材の時刻
      const b0 = Math.floor(srcT * BINS_PER_SEC);
      const b1 = Math.max(b0 + 1, Math.floor((srcT + 1 / binsPerSec) * BINS_PER_SEC));
      let v = 0;
      for (let b = b0; b < b1 && b < peaks.length; b++) if (peaks[b] > v) v = peaks[b];
      out[i] = Math.max(out[i], Math.min(1, v * scale * gain));
    }
  }
  return [...out];
}

/** 指定時刻の完成フレームを PNG dataURL で返す（テロップ・ぼかしも入った状態） */
async function frameAt(time, width) {
  const total = P.totalDuration(S.project);
  const t = Math.max(0, Math.min(total, time));
  const loc = locate(t);
  if (!loc) throw new Error('クリップがありません');
  const src = S.sources.get(loc.clip.sourceId);
  if (!src) throw new Error('素材が読み込まれていません');

  const W = S.project.output.width, H = S.project.output.height;
  const v = document.createElement('video');
  v.muted = true; v.preload = 'auto'; v.src = src.previewUrl;
  await new Promise((res, rej) => {
    v.addEventListener('loadeddata', res, { once: true });
    v.addEventListener('error', () => rej(new Error('素材を開けませんでした')), { once: true });
  });
  await new Promise((res, rej) => {
    const to = setTimeout(() => rej(new Error('シークできませんでした')), 5000);
    v.addEventListener('seeked', () => { clearTimeout(to); res(); }, { once: true });
    v.currentTime = loc.localTime;
  });

  const cv = new OffscreenCanvas(W, H);
  const ctx = cv.getContext('2d');
  composeFrame(ctx, v, t, W, H, S.project, S.imageLib);

  const h = Math.round((width * H) / W);
  const small = new OffscreenCanvas(width, h);
  small.getContext('2d').drawImage(cv, 0, 0, width, h);
  const blob = await small.convertToBlob({ type: 'image/png' });
  return await new Promise((res) => {
    const fr = new FileReader();
    fr.onload = () => res(fr.result);
    fr.readAsDataURL(blob);
  });
}

const mcpCommands = createCommands({
  S, P, T, MARKER_KINDS,
  commit, renderAll, status,
  applyProject, timelineLevels, frameAt, syncProjectUI,
  nextZ: () => zRange()[1] + 1,
  seekTo: (t) => { setMode('program'); seekProgram(t, true); renderAll(); },
});

const bridge = new Bridge(
  async (cmd, args) => {
    const fn = mcpCommands[cmd];
    if (!fn) throw new Error(`知らないコマンドです: ${cmd}`);
    return await fn(args ?? {});
  },
  (state) => {
    const el = $('mcpDot');
    if (!el) return;
    // 繋がった時だけ知らせる。待っている間はランプの色で足りるので、
    // ステータス行を占領しない（サーバーを立てていない人には出っぱなしになる）
    if (state === 'on' && el.classList.contains('mcp-dot') && !el.classList.contains('on')) {
      status('MCP つながりました');
    }
    el.className = `mcp-dot ${state}`;
    el.title = {
      on: 'MCP つながっています（クリックで切断）',
      connecting: 'MCP 接続中…',
      waiting: 'MCP サーバーを待っています（mcp/server.js を起動してください）',
      off: 'MCP 未接続（クリックで接続）',
    }[state];
  },
);

$('mcpDot').onclick = () => {
  if (bridge.wanted) { bridge.disconnect(); status('MCP 連携を切りました'); }
  else { bridge.connect(); status('MCP サーバーに接続します…'); }
};

// ?bridge=1 で最初から繋ぎに行く。?bridgePort= でポートも変えられる。
// https のページ（GitHub Pages 等）からでも ws://127.0.0.1 へは繋がる
// （localhost は安全なオリジンとして扱われるため）。Safari だけは塞いでいる。
(() => {
  const q = new URLSearchParams(location.search);
  const port = q.get('bridgePort');
  if (port) bridge.url = `ws://127.0.0.1:${port}`;
  // 自動接続はランプの色だけで知らせる（繋がったらステータスに出る）
  if (q.get('bridge') === '1' || localStorage.getItem('kiriko.autoBridge') === '1') bridge.connect();
})();

// Phase 4（AI 連携 / MCP）に向けた操作フック。
// プロジェクト JSON をそのまま差し替えられるようにしておく。
window.bme = {
  state: S,
  get project() { return S.project; },
  set project(p) { S.project = p; select(null, null); zoomFit(); renderAll(); },
  addFiles,
  addTelop,
  addBlur,
  addMarker,
  keepMarkedRangesOnly,
  MARKER_KINDS,
  jumpMarker,
  selectNextGap,
  selectPrevGap,
  selectMarkerRange,
  gapRanges,
  addImageAssets,
  placeImage,
  addAudioAssets,
  placeAudio,
  telop: T,
  loadProjectJSON(text) { S.project = P.deserialize(text); zoomFit(); renderAll(); },
  exportProjectJSON() { return P.serialize(S.project); },
  render: renderAll,
  bridge,
  commands: mcpCommands,
  /**
   * MCP と同じコマンドを名前で実行する。
   * ブラウザペインなど、WebSocket を通さずに直接操作したい時はこちら。
   * MCP 経由とまったく同じ処理を通るので、挙動がずれない。
   */
  call: async (cmd, args = {}) => {
    const fn = mcpCommands[cmd];
    if (!fn) throw new Error(`知らないコマンドです: ${cmd}（使えるもの: ${Object.keys(mcpCommands).join(', ')}）`);
    return await fn(args);
  },
  timelineLevels,
  frameAt,
};
