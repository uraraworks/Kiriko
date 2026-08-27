// transcribe.js
// ローカルの whisper.cpp でセリフを起こす。
//
// 音声はこのマシンから出ない（ffmpeg で切り出して whisper-cli に渡すだけ）。
//
// 大事な工夫が 2 つある。
//  1) 無音に whisper をかけると幻聴を起こす（何も言っていない所に「おやすみなさい」等が出る）。
//     そこで Kiriko の音量データで「音がある区間」だけを切り出して渡す。
//  2) ついでに処理量が激減する。喋っていない時間が長い素材ほど効く。

const { execFile } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const os = require('os');
const path = require('path');

const run = promisify(execFile);

const MODEL_DIR = process.env.KIRIKO_WHISPER_MODELS
  || path.join(os.homedir(), 'whisper-models');

/** 使えるモデルを探す。壊れているファイルもあるので、大きさで足切りする */
function findModels() {
  try {
    return fs.readdirSync(MODEL_DIR)
      .filter((f) => f.startsWith('ggml-') && f.endsWith('.bin'))
      .map((f) => ({ name: f.replace(/^ggml-|\.bin$/g, ''), path: path.join(MODEL_DIR, f),
        sizeMB: Math.round(fs.statSync(path.join(MODEL_DIR, f)).size / 1e6) }))
      .filter((m) => m.sizeMB > 20 && !m.name.includes('silero'));
  } catch {
    return [];
  }
}

function pickModel(want) {
  const list = findModels();
  if (!list.length) return null;
  if (want) {
    const hit = list.find((m) => m.name === want || m.path === want || m.name.includes(want));
    if (hit) return hit;
  }
  // 既定は「日本語がそこそこ当たって、そこそこ速い」もの
  const order = ['large-v3-turbo-q5_0', 'large-v3-turbo', 'medium', 'small', 'base'];
  for (const o of order) {
    const hit = list.find((m) => m.name === o);
    if (hit) return hit;
  }
  return list.sort((a, b) => b.sizeMB - a.sizeMB)[0];
}

/**
 * 1 区間を書き起こす。
 * @returns {Promise<Array<{from:number,to:number,text:string}>>} 秒（切り出し区間の先頭からの相対）
 */
async function transcribeRange(file, srcFrom, srcTo, model, language, threads) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kiriko-stt-'));
  const wav = path.join(tmp, 'a.wav');
  const out = path.join(tmp, 'r');
  try {
    await run('ffmpeg', [
      '-v', 'error', '-y',
      '-ss', String(srcFrom), '-t', String(Math.max(0.2, srcTo - srcFrom)),
      '-i', file, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav,
    ], { maxBuffer: 1 << 24 });

    await run('whisper-cli', [
      '-m', model.path, '-l', language, '-oj', '-of', out, '-nt',
      '-t', String(threads), wav,
    ], { maxBuffer: 1 << 26 });

    const json = JSON.parse(fs.readFileSync(`${out}.json`, 'utf8'));
    return (json.transcription ?? [])
      .map((s) => ({
        from: (s.offsets?.from ?? 0) / 1000,
        to: (s.offsets?.to ?? 0) / 1000,
        text: String(s.text ?? '').trim(),
      }))
      .filter((s) => s.text);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * タイムライン上の「音がある区間」を書き起こす。
 * @param {Array<{path:string, srcFrom:number, srcTo:number, tlFrom:number}>} pieces
 * @returns {Promise<Array<{time:number,duration:number,text:string}>>} タイムライン秒
 */
async function transcribePieces(pieces, { model, language = 'ja', threads = 8, onProgress = () => {} } = {}) {
  const out = [];
  for (let i = 0; i < pieces.length; i++) {
    const p = pieces[i];
    onProgress(i + 1, pieces.length, p);
    let segs;
    try {
      segs = await transcribeRange(p.path, p.srcFrom, p.srcTo, model, language, threads);
    } catch (e) {
      throw new Error(`書き起こしに失敗しました（${path.basename(p.path)} ${p.srcFrom.toFixed(1)}s〜）: ${e.message}`);
    }
    const len = p.srcTo - p.srcFrom;
    for (const s of segs) {
      // 切り出し区間の外にはみ出した分は丸める
      const from = Math.max(0, Math.min(len, s.from));
      const to = Math.max(from, Math.min(len, s.to));
      if (to - from < 0.05) continue;
      out.push({
        time: +(p.tlFrom + from).toFixed(2),
        duration: +(to - from).toFixed(2),
        text: s.text,
      });
    }
  }
  return out.sort((a, b) => a.time - b.time);
}

module.exports = { findModels, pickModel, transcribePieces, MODEL_DIR };
