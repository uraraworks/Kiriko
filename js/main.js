// main.js — UI 全体の組み立て
import { Mp4Source } from './mp4source.js';
import * as P from './project.js';
import { exportProject } from './exporter.js';
import { parseKdenlive, basename } from './kdenlive.js';

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
};

const $ = (id) => document.getElementById(id);
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
        types: [{ description: '動画 / プロジェクト', accept: { 'video/*': ['.mp4', '.mov', '.m4v'], 'application/xml': ['.kdenlive'] } }],
      });
      files = await Promise.all(handles.map((h) => h.getFile()));
    } catch (e) { if (e.name === 'AbortError') return; throw e; }
  } else {
    $('fileInput').click();
    return;
  }
  await addFiles(files);
}

async function addFiles(files) {
  for (const file of files) {
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
  for (const t of document.querySelectorAll('.tab')) t.classList.toggle('active', t.dataset.mode === mode);
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

function markIn() {
  if (S.mode !== 'source' || !curSource()) return;
  S.markIn = video.currentTime;
  if (S.markOut !== null && S.markOut <= S.markIn) S.markOut = null;
  renderTransport(); renderScrub();
}
function markOut() {
  if (S.mode !== 'source' || !curSource()) return;
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
  const clip = { id: P.newId('clip'), sourceId: S.currentSourceId, in: a, out: b, volume: 1 };
  S.project.clips.push(clip);
  S.selectedClipId = clip.id;
  // 次のカットを続けて打てるように、アウト点を新しいイン点にする
  S.markIn = b;
  S.markOut = null;
  status(`クリップ追加 ${tc(a)} → ${tc(b)}（${(b - a).toFixed(2)}秒）`);
  renderAll();
}

function deleteSelected() {
  if (!S.selectedClipId) return;
  const i = S.project.clips.findIndex((c) => c.id === S.selectedClipId);
  if (i < 0) return;
  S.project.clips.splice(i, 1);
  S.selectedClipId = S.project.clips[Math.min(i, S.project.clips.length - 1)]?.id ?? null;
  renderAll();
}

// ---------------------------------------------------------------- 描画：ビン / インスペクタ

function renderBin() {
  const list = $('binList');
  if (!S.project.sources.length) {
    list.innerHTML = '<div class="empty">「素材を開く」で mp4 を読み込みます</div>';
  } else {
    list.innerHTML = '';
    for (const s of S.project.sources) {
      const el = document.createElement('div');
      el.className = 'bin-item' + (s.id === S.currentSourceId ? ' active' : '');
      el.innerHTML = `<div class="n">${esc(s.name)}</div><div class="m">${tc(s.duration)} ／ ${(s.size / 1e9).toFixed(2)} GB</div>`;
      el.onclick = () => selectSource(s.id);
      list.appendChild(el);
    }
  }
  const src = curSource();
  $('srcInfo').innerHTML = src
    ? `映像 <b>${esc(src.video.codec)}</b><br>${src.video.width}×${src.video.height} ／ ${src.video.samples.length} フレーム<br>`
      + (src.audio ? `音声 <b>${esc(src.audio.codec)}</b><br>${src.audio.sampleRate} Hz ／ ${src.audio.channels} ch` : '音声トラックなし')
    : '—';
}

function renderInspector() {
  const form = $('clipForm');
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
  $('fIn').onchange = (e) => { clip.in = Math.max(0, +e.target.value); renderAll(); };
  $('fOut').onchange = (e) => { clip.out = Math.max(clip.in + 0.05, +e.target.value); renderAll(); };
  $('fVol').oninput = (e) => { clip.volume = +e.target.value / 100; $('fVolLbl').textContent = `${e.target.value}%`; };
}

function renderTransport() {
  const src = curSource();
  const dur = S.mode === 'program' ? P.totalDuration(S.project) : (src?.duration ?? 0);
  const cur = S.mode === 'program' ? S.programTime : video.currentTime;
  $('tcCur').textContent = tc(cur);
  $('tcDur').textContent = tc(dur);
  $('btnPlay').textContent = video.paused ? '▶' : '❚❚';
  $('rateLabel').textContent = `×${video.playbackRate}`;
  $('lblIn').textContent = S.markIn === null ? '--:--' : tc(S.markIn, false);
  $('lblOut').textContent = S.markOut === null ? '--:--' : tc(S.markOut, false);
  $('lblLen').textContent = (S.markIn !== null && S.markOut !== null) ? tc(S.markOut - S.markIn, false) : '--:--';
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
  }

  const cur = S.mode === 'program' ? S.programTime : video.currentTime;
  const px = (cur / dur) * w;
  ctx.fillStyle = '#e8ebf0';
  ctx.fillRect(px - 1, 4, 2, 26);
  ctx.beginPath(); ctx.moveTo(px - 5, 4); ctx.lineTo(px + 5, 4); ctx.lineTo(px, 10); ctx.fill();
}

$('scrubBar').addEventListener('pointerdown', (e) => {
  const cv = e.currentTarget;
  cv.setPointerCapture(e.pointerId);
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
const RULER_H = 26, TRACK_H = 62;

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
  const total = P.totalDuration(S.project);
  const w = $('tlWrap').clientWidth || 800;
  S.scrollSec = 0;
  S.pxPerSec = total > 0 ? Math.max(0.5, (w - 20) / total) : 8;
  renderTimeline();
}

function renderTimeline() {
  const { w, h, dpr } = tlSize();
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
  for (let i = 0; i < 2; i++) {
    ctx.fillStyle = i % 2 ? '#1c1f26' : '#1e2128';
    ctx.fillRect(0, RULER_H + i * TRACK_H, w, TRACK_H);
    ctx.strokeStyle = '#2b303a'; ctx.beginPath();
    ctx.moveTo(0, RULER_H + (i + 1) * TRACK_H + 0.5); ctx.lineTo(w, RULER_H + (i + 1) * TRACK_H + 0.5); ctx.stroke();
  }

  // --- クリップ ---
  for (const { clip, offset } of P.withTimelineOffsets(S.project)) {
    const x = secToX(offset);
    const cw = P.clipDuration(clip) * S.pxPerSec;
    if (x + cw < -5 || x > w + 5) continue;
    const sel = clip.id === S.selectedClipId;
    drawClip(ctx, x, RULER_H + 2, cw, TRACK_H - 6, clip, sel, 'video');
    drawClip(ctx, x, RULER_H + TRACK_H + 2, cw, TRACK_H - 6, clip, sel, 'audio');
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
    ctx.fillStyle = '#0e131bcc';
    ctx.font = '10px -apple-system, sans-serif'; ctx.textBaseline = 'top';
    const label = kind === 'video'
      ? `${src?.name ?? '?'}  ${tc(clip.in, false)}`
      : `${tc(P.clipDuration(clip), false)}`;
    ctx.fillText(label, x + 5, y + 4);
    if (kind === 'audio') drawFakeWave(ctx, x, y, w, h);
  }
  ctx.restore();
}

function drawFakeWave(ctx, x, y, w, h) {
  // Phase 0 では波形解析まではしない。存在感だけ出しておく。
  ctx.strokeStyle = '#0e131b55'; ctx.beginPath();
  const mid = y + h * 0.62;
  for (let i = 0; i < w; i += 3) {
    const a = (Math.sin(i * 0.35) * 0.5 + Math.sin(i * 0.11) * 0.5) * h * 0.16;
    ctx.moveTo(x + i, mid - a); ctx.lineTo(x + i, mid + a);
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

// --- タイムライン操作 ---
function hitClip(x, y) {
  if (y < RULER_H) return null;
  for (const { clip, offset } of P.withTimelineOffsets(S.project)) {
    const cx = secToX(offset), cw = P.clipDuration(clip) * S.pxPerSec;
    if (x >= cx && x <= cx + cw) return { clip, offset, cx, cw };
  }
  return null;
}

tlCanvas.addEventListener('pointermove', (e) => {
  if (drag) return;
  const r = tlCanvas.getBoundingClientRect();
  const hit = hitClip(e.clientX - r.left, e.clientY - r.top);
  const x = e.clientX - r.left;
  tlCanvas.style.cursor = !hit ? 'default'
    : (Math.abs(x - hit.cx) < 6 || Math.abs(x - (hit.cx + hit.cw)) < 6) ? 'ew-resize' : 'grab';
});

let drag = null;
tlCanvas.addEventListener('pointerdown', (e) => {
  const r = tlCanvas.getBoundingClientRect();
  const x = e.clientX - r.left, y = e.clientY - r.top;
  tlCanvas.setPointerCapture(e.pointerId);

  const hit = hitClip(x, y);
  if (!hit || y < RULER_H) {
    setMode('program');
    seekProgram(Math.max(0, xToSec(x)), true);
    renderAll();
    drag = { type: 'scrub' };
    return;
  }
  S.selectedClipId = hit.clip.id;
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
    renderTimeline(); renderTransport(); renderScrub();
  } else if (drag.type === 'trim') {
    const d = (x - drag.startX) / S.pxPerSec;
    const src = S.sources.get(drag.clip.sourceId);
    if (drag.side === 'in') {
      drag.clip.in = Math.max(0, Math.min(drag.orig.out - 0.1, drag.orig.in + d));
    } else {
      drag.clip.out = Math.max(drag.orig.in + 0.1, Math.min(src?.duration ?? Infinity, drag.orig.out + d));
    }
    renderTimeline(); renderInspector(); renderTransport();
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

tlCanvas.addEventListener('pointerup', () => {
  if (drag && drag.type === 'move' && !drag.moved) {
    // クリック扱い：選択のみ
  }
  drag = null;
  renderAll();
});

tlCanvas.addEventListener('dblclick', (e) => {
  const r = tlCanvas.getBoundingClientRect();
  const hit = hitClip(e.clientX - r.left, e.clientY - r.top);
  if (!hit) return;
  selectSource(hit.clip.sourceId);
  S.markIn = hit.clip.in; S.markOut = hit.clip.out;
  video.currentTime = hit.clip.in;
  renderAll();
});

$('tlWrap').addEventListener('wheel', (e) => {
  e.preventDefault();
  const r = tlCanvas.getBoundingClientRect();
  const anchorSec = xToSec(e.clientX - r.left);
  if (e.ctrlKey || e.metaKey || !e.shiftKey) {
    const f = Math.exp(-e.deltaY * 0.002);
    S.pxPerSec = Math.max(0.2, Math.min(400, S.pxPerSec * f));
    S.scrollSec = Math.max(0, anchorSec - (e.clientX - r.left) / S.pxPerSec);
  } else {
    S.scrollSec = Math.max(0, S.scrollSec + e.deltaY / S.pxPerSec);
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
    S.project = p;
    S.selectedClipId = null;
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
  S.exporting = true;
  const ac = new AbortController();
  $('btnCancel').onclick = () => ac.abort();
  $('overlay').classList.remove('hidden');
  $('ovLog').textContent = '';
  const t0 = performance.now();

  try {
    const buf = await exportProject(S.project, S.sources, {
      fileHandle,
      signal: ac.signal,
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

$('btnOpen').onclick = () => openFiles().catch((e) => status(e.message, true));
$('btnSaveProj').onclick = saveProject;
$('btnLoadProj').onclick = () => $('projInput').click();
$('btnMarkIn').onclick = markIn;
$('btnMarkOut').onclick = markOut;
$('btnAddClip').onclick = addClip;
$('btnDelete').onclick = deleteSelected;
$('btnExport').onclick = () => doExport().catch((e) => status(e.message, true));
$('btnZoomIn').onclick = () => { S.pxPerSec = Math.min(400, S.pxPerSec * 1.5); renderTimeline(); };
$('btnZoomOut').onclick = () => { S.pxPerSec = Math.max(0.2, S.pxPerSec / 1.5); renderTimeline(); };
$('btnZoomFit').onclick = zoomFit;

$('fileInput').onchange = (e) => { addFiles([...e.target.files]); e.target.value = ''; };
$('projInput').onchange = (e) => { if (e.target.files[0]) loadProject(e.target.files[0]); e.target.value = ''; };

for (const t of document.querySelectorAll('.tab')) t.onclick = () => { setMode(t.dataset.mode); renderAll(); };

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
function step(d) {
  video.pause();
  if (S.mode === 'program') seekProgram(S.programTime + d, false);
  else video.currentTime = Math.max(0, video.currentTime + d);
  renderTransport(); renderScrub(); renderTimeline();
}

video.addEventListener('timeupdate', () => { programTick(); renderTransport(); renderScrub(); if (S.mode === 'program') renderTimeline(); });
video.addEventListener('seeked', () => { renderTransport(); renderScrub(); });
video.addEventListener('play', renderTransport);
video.addEventListener('pause', renderTransport);
video.addEventListener('loadedmetadata', () => { renderTransport(); renderScrub(); });

// requestVideoFrameCallback があればクリップ跨ぎの精度が上がる
if ('requestVideoFrameCallback' in HTMLVideoElement.prototype) {
  const cb = () => { programTick(); video.requestVideoFrameCallback(cb); };
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
  if (e.target.matches('input, select, textarea')) return;
  const k = e.key.toLowerCase();
  if ((e.ctrlKey || e.metaKey) && k === 's') { e.preventDefault(); saveProject(); return; }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  switch (k) {
    case ' ': e.preventDefault(); togglePlay(); break;
    case 'i': markIn(); break;
    case 'o': markOut(); break;
    case 'enter': addClip(); break;
    case 'j':
      video.playbackRate = video.paused || video.playbackRate > 0 ? 1 : video.playbackRate;
      step(-10 / fps()); break;
    case 'k': video.pause(); renderTransport(); break;
    case 'l':
      video.playbackRate = Math.min(8, video.paused ? 2 : video.playbackRate * 2);
      video.play().catch(() => {}); renderTransport(); break;
    case 'arrowleft': e.preventDefault(); step(e.shiftKey ? -1 : -1 / fps()); break;
    case 'arrowright': e.preventDefault(); step(e.shiftKey ? 1 : 1 / fps()); break;
    case 'home': $('btnHome').click(); break;
    case 'end': $('btnEnd').click(); break;
    case 'delete': case 'backspace': e.preventDefault(); deleteSelected(); break;
  }
});

new ResizeObserver(() => { renderTimeline(); renderScrub(); }).observe(document.body);

// ---------------------------------------------------------------- 起動

function renderAll() {
  renderBin();
  renderInspector();
  renderTransport();
  renderScrub();
  renderTimeline();
}

if (!('VideoEncoder' in window)) {
  status('このブラウザは WebCodecs 非対応です（Chrome / Edge をお使いください）', true);
}
renderAll();
status('準備完了 — 「素材を開く」または mp4 をドロップしてください');

// Phase 4（AI 連携 / MCP）に向けた操作フック。
// プロジェクト JSON をそのまま差し替えられるようにしておく。
window.bme = {
  state: S,
  get project() { return S.project; },
  set project(p) { S.project = p; S.selectedClipId = null; zoomFit(); renderAll(); },
  addFiles,
  loadProjectJSON(text) { S.project = P.deserialize(text); zoomFit(); renderAll(); },
  exportProjectJSON() { return P.serialize(S.project); },
  render: renderAll,
};
