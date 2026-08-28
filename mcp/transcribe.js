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
/**
 * whisper が「何も言っていない所」に作ってしまう文を落とす。
 *
 * 走行中はロードノイズと風が途切れないので、無音として切り出せない。
 * そこに whisper を掛けると、それらしい日本語を作ってしまう。実素材で照合したところ、
 * 幻聴には次の 3 つのはっきりした特徴があり、どれも「人間が残した割合 0%」だった。
 *
 *  1. ちょうど 30 秒（whisper の窓いっぱい）＝ その窓で発話が見つからなかった
 *  2. 学習データ由来の決まり文句（動画の締めの挨拶など）
 *  3. 同じ語の繰り返し（「東京都交通地は、東京都交通地を…」）
 *
 * 落とすと、セリフ区間の外を切る下ごしらえの精度が大きく上がる
 * （実測で、切れる量 2.9 分 → 7.1 分、取りこぼしの誤消しは 0 分のまま）。
 */
const HALLUCINATIONS = [
  'ご視聴ありがとうございました', 'ご視聴ありがとうございます',
  'チャンネル登録', 'おやすみなさい', 'お疲れ様でした', 'おつかれさまでした',
];

function isRepetitive(text) {
  // 同じ 4 文字以上のまとまりが 3 回以上出てきたら、繰り返しとみなす
  for (let n = 4; n <= 8; n++) {
    for (let i = 0; i + n <= text.length; i++) {
      const part = text.slice(i, i + n);
      let count = 0, at = 0;
      while ((at = text.indexOf(part, at)) >= 0) { count++; at += 1; }
      if (count >= 3) return true;
    }
  }
  return false;
}

/** 幻聴らしければ、その理由を返す（本物なら null）*/
function hallucinationReason(seg, windowSec = 30) {
  if (seg.to - seg.from >= windowSec - 0.5) return 'window';
  const t = seg.text;
  if (HALLUCINATIONS.some((h) => t.includes(h))) return 'phrase';
  if (isRepetitive(t)) return 'repeat';
  return null;
}

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
      // -mc 0: 直前の文脈を持ち越さない。持ち越すと、ノイズが続く所で
      // 同じ文を延々と吐き続けるループに落ちる（実素材で確認済み）
      '-mc', '0',
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
 *
 * 返す時刻は **素材の時刻**。タイムライン時刻に直すのは、マーカーを立てる直前に
 * ブラウザ側で行う。書き起こしは長い（実時間の 1〜1.5 倍）ので、その間に人間が
 * カットを進めていても結果がずれた場所に着地しないようにするため。
 *
 * @param {Array<{path:string, srcFrom:number, srcTo:number, tlFrom:number}>} pieces
 * @returns {Promise<Array<{source:string,sourceFrom:number,sourceTo:number,text:string,timeAtStart:number}>>}
 */
async function transcribePieces(pieces, { model, language = 'ja', threads = 8, onProgress = () => {} } = {}) {
  const out = [];
  const dropped = [];
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
      // 何も言っていない所に作られた文は落とす（走行中はノイズが途切れないため出やすい）
      const why = hallucinationReason(s);
      if (why) { dropped.push({ ...s, why }); continue; }
      // 切り出し区間の外にはみ出した分は丸める
      const from = Math.max(0, Math.min(len, s.from));
      const to = Math.max(from, Math.min(len, s.to));
      if (to - from < 0.05) continue;
      out.push({
        source: path.basename(p.path),
        sourceFrom: +(p.srcFrom + from).toFixed(2),
        sourceTo: +(p.srcFrom + to).toFixed(2),
        text: s.text,
        // 参考値。書き起こしを始めた時点のタイムライン時刻（その後の編集で動く）
        timeAtStart: +(p.tlFrom + from).toFixed(2),
      });
    }
  }
  out.sort((a, b) => a.timeAtStart - b.timeAtStart);
  out.dropped = dropped.length;   // 落とした件数（呼び出し側の報告用）
  return out;
}

module.exports = { findModels, pickModel, transcribePieces, hallucinationReason, isRepetitive, MODEL_DIR };
