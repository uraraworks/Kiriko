#!/usr/bin/env node
// Kiriko の MCP サーバー。
//
//   Claude Code ──stdio── ここ ──WebSocket(127.0.0.1)── ブラウザの Kiriko
//
// ブラウザ側から動画そのものは出てこない。やり取りするのは編集内容（JSON）と、
// 明示的に要求された時のフレーム画像だけ。待ち受けは 127.0.0.1 のみ。

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');
const { WebSocketServer } = require('ws');
const path = require('path');
const { findModels, pickModel, transcribePieces } = require('./transcribe.js');

const PORT = Number(process.env.KIRIKO_PORT || 8910);

// ---------------------------------------------------------------- ブラウザとの接続

let client = null;
let seq = 0;
const pending = new Map();

let wsError = null;
const wss = new WebSocketServer({ host: '127.0.0.1', port: PORT });
wss.on('error', (e) => {
  // ポートが使われている＝別の Kiriko サーバーが既に動いている、が典型。
  // ここで落とすと MCP ごと死んでしまうので、状態として抱えてツール側で伝える。
  wsError = e.code === 'EADDRINUSE'
    ? `ポート ${PORT} が既に使われています。別の Kiriko MCP サーバーが動いていないか確認してください`
      + `（環境変数 KIRIKO_PORT で変えられます）`
    : `WebSocket サーバーを開けませんでした: ${e.message}`;
  process.stderr.write(`kiriko MCP: ${wsError}\n`);
});
wss.on('connection', (ws) => {
  client = ws;
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.type !== 'result') return;
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    clearTimeout(p.timer);
    msg.ok ? p.resolve(msg.value) : p.reject(new Error(msg.error || '失敗しました'));
  });
  ws.on('close', () => { if (client === ws) client = null; });
});

/** ブラウザへコマンドを投げて結果を待つ */
function call(cmd, args = {}, timeoutMs = 60000) {
  if (wsError) throw new Error(wsError);
  if (!client || client.readyState !== client.OPEN) {
    throw new Error(
      'Kiriko（ブラウザ）につながっていません。'
      + 'Kiriko を開いて、ツールバー右の丸いランプをクリックして接続してください。'
    );
  }
  const id = ++seq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`応答がありませんでした（${cmd}）`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    client.send(JSON.stringify({ type: 'call', id, cmd, args }));
  });
}

const asText = (v) => ({ content: [{ type: 'text', text: JSON.stringify(v, null, 2) }] });

// ---------------------------------------------------------------- MCP ツール

const server = new McpServer({ name: 'kiriko', version: '0.1.0' });

server.registerTool('kiriko_summary', {
  title: 'Kiriko の状態を見る',
  description: 'いま開いている編集プロジェクトの要約（尺・クリップ数・マーカー数・素材など）。'
    + 'まずこれを呼んでから、必要なものを個別に取りに行くのがよい。',
  inputSchema: {},
}, async () => asText(await call('summary')));

server.registerTool('kiriko_get_clips', {
  title: 'カット一覧',
  description: 'タイムライン上のクリップの並び。どの素材のどこを使っているかが分かる。',
  inputSchema: {},
}, async () => asText(await call('get_clips')));

server.registerTool('kiriko_get_markers', {
  title: 'マーカー一覧',
  description: 'タイムラインのマーカー（メモ）。duration > 0 は「ここは残す」区間。',
  inputSchema: {},
}, async () => asText(await call('get_markers')));

server.registerTool('kiriko_find_silence', {
  title: '無音・有音の区間を調べる',
  description:
    '編集後のタイムラインの音量から、静かな区間と音がある区間を返す。'
    + 'しゃべっている所だけ残す作業の下ごしらえに使う。'
    + 'sound（音がある区間）に kind=keep で立てるか、'
    + 'silence（静かな区間）に kind=cut で立てるか、どちらでもよい。'
    + 'どちらでも Kiriko 側で 1 つずつ確認しながら消していける。',
  inputSchema: {
    threshold: z.number().min(0).max(1).optional().describe('無音とみなす音量（0〜1、既定 0.06）'),
    minSec: z.number().min(0).optional().describe('これより短い静かさは無視（秒、既定 1.0）'),
    from: z.number().min(0).optional(),
    to: z.number().min(0).optional(),
  },
}, async (a) => asText(await call('find_silence', a, 300000)));

server.registerTool('kiriko_get_audio_levels', {
  title: '音量の波形を取る',
  description: '編集後のタイムラインの音量エンベロープ（0〜1）。細かく見たい時に。',
  inputSchema: {
    from: z.number().min(0).optional(),
    to: z.number().min(0).optional(),
    binsPerSec: z.number().min(1).max(50).optional().describe('1 秒あたりの点数（既定 10）'),
  },
}, async (a) => asText(await call('get_audio_levels', a, 300000)));

server.registerTool('kiriko_add_markers', {
  title: 'マーカーを立てる',
  description:
    'マーカーをまとめて立てる。duration を付けると区間マーカーになる。\n'
    + 'kind は keep（ここは残す）/ cut（ここは消す）/ note（ただのメモ）。\n'
    + '「セリフの所に keep」でも「無音の所に cut」でも、Kiriko 側では同じ流れ'
    + '（G / F で消す候補を送りながら確認して Delete）で進められる。\n'
    + 'text にセリフや理由を入れておくと、人間が判断しやすい。'
    + '範囲はあとから人間が調整できるので、多少ずれていても構わない。',
  inputSchema: {
    markers: z.array(z.object({
      time: z.number().min(0).describe('タイムライン上の秒'),
      duration: z.number().min(0).optional().describe('区間の長さ（秒）。省略すると点マーカー'),
      text: z.string().optional().describe('メモ（セリフなど）'),
      kind: z.enum(['keep', 'cut', 'note']).optional().describe('keep=残す / cut=消す / note=メモ'),
    })).describe('立てるマーカー'),
    replace: z.boolean().optional().describe('true なら既存のマーカーを消してから入れる'),
  },
}, async (a) => asText(await call('add_markers', a)));

server.registerTool('kiriko_add_telops', {
  title: 'テロップを追加する',
  description:
    'テロップをまとめて追加する。text に配列を渡すと複数行になる。'
    + 'preset にプリセット名（例「実況（下段中央）」）を指定すると、その書式と位置で入る。',
  inputSchema: {
    telops: z.array(z.object({
      start: z.number().min(0),
      end: z.number().min(0),
      text: z.union([z.string(), z.array(z.string())]),
      preset: z.string().optional(),
      track: z.number().int().min(0).optional(),
    })),
  },
}, async (a) => asText(await call('add_telops', a)));

server.registerTool('kiriko_get_subtitles', {
  title: '字幕一覧を見る',
  description:
    '字幕（SRT）を全件取得する。各エントリに checkLimits の警告（長すぎ・速すぎ）が付くので、'
    + 'まずこれを呼んで直す所を見つけるのに使う。warnings が空なら問題なし。',
  inputSchema: {},
}, async () => asText(await call('get_subtitles')));

server.registerTool('kiriko_set_subtitles', {
  title: '字幕を入れる・更新する',
  description:
    '字幕（SRT）をまとめて入れる。**字幕は動画に焼き込まれない**。'
    + 'SRT ファイルとして書き出して YouTube 等に添付するためのものなので、映像は変わらない。\n\n'
    + '1 エントリに日本語（ja）と英語（en）を同居させる。**英訳だけを流し込みたい時は '
    + 'id を指定して en だけ渡す**（ja / start / end は省略すれば保持される）。\n\n'
    + '目安は日本語 16 文字 × 2 行・6 文字毎秒、英語 42 文字 × 2 行・17 文字毎秒'
    + '（kiriko_get_subtitles の warnings で分かる）。**逐語訳である必要はなく、'
    + '収まらなければ短く言い直すのが正しい。** 特に英語は日本語より文字数を食うので直訳しないこと。\n\n'
    + 'mode は replace（総入れ替え）/ merge（既定、id があれば更新・無ければ新規追加）。'
    + 'id 指定なのに見つからない分はエラーにせず skipped で返る。\n\n'
    + 'kiriko_transcribe の結果（{start,end,text}）をそのまま入れる時は autoSplit: true '
    + '（長い発話を読みやすい長さに自動分割する。新規追加にのみ効き、id 指定の更新には効かない）。\n\n'
    + '字幕は 1 トラックで**重ならない**。重なった分は start 昇順に詰められ、'
    + '詰めた結果 0.3 秒未満になったものは落ちる（dropped で件数が分かる）。',
  inputSchema: {
    subtitles: z.array(z.object({
      id: z.string().optional().describe('既存エントリの更新なら指定する。省略すると新規追加'),
      start: z.number().min(0).optional().describe('タイムライン上の開始秒'),
      end: z.number().min(0).optional().describe('タイムライン上の終了秒'),
      ja: z.string().optional(),
      en: z.string().optional(),
    })).describe('入れる字幕'),
    mode: z.enum(['replace', 'merge']).optional().describe("既定 'merge'"),
    autoSplit: z.boolean().optional().describe('true なら新規追加分を読みやすい長さに自動分割する'),
  },
}, async (a) => asText(await call('set_subtitles', a)));

server.registerTool('kiriko_cut_range', {
  title: '範囲を切り取る',
  description:
    '範囲を切り取って後ろを詰める。無音カットのように何箇所もある時は ranges でまとめて渡す。\n\n'
    + '**カットは非破壊**。消した分は在庫として残るので、'
    + 'kiriko_list_trims で確認し、kiriko_restore_at で秒単位に戻せる。\n'
    + '迷ったら少し多めに切って「気になる所は戻してください」と伝えるとよい。',
  inputSchema: {
    ranges: z.array(z.object({
      from: z.number().min(0).describe('開始秒（タイムライン）'),
      to: z.number().min(0).describe('終了秒（タイムライン）'),
    })).optional().describe('切り取る範囲。複数まとめて渡せる'),
    from: z.number().min(0).optional().describe('1 箇所だけの時の開始秒'),
    to: z.number().min(0).optional().describe('1 箇所だけの時の終了秒'),
    label: z.string().optional().describe("在庫に付ける名前（例 '無音'）。後で見分けが付く"),
    group: z.string().optional().describe('まとめて戻したい時の目印'),
  },
}, async (a) => asText(await call('cut_range', a, 300000)));

server.registerTool('kiriko_cut_outside_markers', {
  title: '区間マーカーの外を切り取る',
  description:
    '「残す」区間マーカーの外を全部切り取る。'
    + 'kiriko_transcribe でセリフにマーカーを立ててから、これを呼ぶのが本命の流れ。\n\n'
    + '**pad は 3 秒を既定と考えてよい。** 実素材（配達動画 95 分のうち 30 分）で'
    + '人間の編集と照合した結果:\n'
    + '  pad 0 秒 … 正しさ 97.1% / カット作業の 79.0% を肩代わり / 誤って消す 30分あたり36秒\n'
    + '  pad 3 秒 … 正しさ 99.4% / 68.2% / 6 秒\n'
    + '  pad 5 秒 … 正しさ 100%  / 60.8% / 0 秒\n'
    + '0 のままだと語頭・語尾が欠ける。誤って消した分は kiriko_restore_at で戻せるので、'
    + '3 秒あたりが釣り合う。\n'
    + 'minGapSec より短い隙間は切らずに残す（細切れになるのを防ぐ）。\n'
    + 'dryRun: true で、切らずに何箇所・何秒切ることになるかだけ確認できる。',
  inputSchema: {
    pad: z.number().min(0).max(30).optional().describe('マーカーの前後に残すのりしろ秒（既定 0）'),
    minGapSec: z.number().min(0).optional().describe('これより短い隙間は切らない（既定 0）'),
    kind: z.enum(['keep', 'cut', 'note']).optional().describe("対象のマーカー種別（既定 'keep'）"),
    dryRun: z.boolean().optional().describe('true なら切らずに結果の見積もりだけ返す'),
  },
}, async (a) => asText(await call('cut_outside_markers', a, 300000)));

server.registerTool('kiriko_cut_before_markers', {
  title: 'しゃべり出しマーカーの手前を詰める',
  description:
    'しゃべり出しの点マーカーの手前にある無音だけを詰める。'
    + "kiriko_transcribe（markerStyle: 'onset'、既定）でしゃべり出しマーカーを立ててから、"
    + 'これを呼ぶのが本命の流れ。\n\n'
    + 'しゃべり終わりは音量から自動で判定するので、指定しなくてよい'
    + '（次のしゃべり出しの手前で打ち切られる）。\n\n'
    + 'lead は 0.4 秒が既定。子音は音量が小さく、音量の立ち上がりは'
    + '実際のしゃべり出しより遅れるので、0 にすると語頭が欠ける。\n\n'
    + '**cut_outside_markers と違い、検出漏れは「その手前が詰まらないだけ」で済む**'
    + '（区間ごと消えることがない）ので、ノイズの多い素材ではこちらの方が安全に振れる。\n\n'
    + 'minGapSec より短い隙間は切らずに残す（細切れになるのを防ぐ）。\n'
    + 'dryRun: true で、切らずに何箇所・何秒切ることになるかだけ確認できる。\n\n'
    + 'kiriko_transcribe を from / to で一部だけ流した時は、ここにも同じ範囲を渡すこと。'
    + '渡さないと、マーカーが無い残りの区間が丸ごとカット対象になる。',
  inputSchema: {
    lead: z.number().min(0).max(10).optional().describe('しゃべり出しの手前に残す秒（既定 0.4）'),
    tail: z.number().min(0).max(10).optional().describe('発話の終わりに残す余韻秒（既定 0.6）'),
    kind: z.enum(['start', 'keep', 'cut', 'note']).optional().describe("対象のマーカー種別（既定 'start'）"),
    minGapSec: z.number().min(0).optional().describe('これより短い隙間は切らない（既定 0）'),
    threshold: z.number().min(0).max(1).optional().describe('音があるとみなす音量（既定 0.06）'),
    minSec: z.number().min(0).optional().describe('これより短い静かさは区切りにしない（既定 1.0）'),
    from: z.number().min(0).optional().describe('タイムライン上の開始秒（既定 0）'),
    to: z.number().min(0).optional().describe('タイムライン上の終了秒（既定は最後まで）'),
    dryRun: z.boolean().optional().describe('true なら切らずに結果の見積もりだけ返す'),
  },
}, async (a) => asText(await call('cut_before_markers', a, 300000)));

server.registerTool('kiriko_list_trims', {
  title: 'カットで消した分の在庫',
  description:
    'どこで何秒戻せるかの一覧。atSec が継ぎ目のタイムライン位置。\n'
    + '人間に「ここを切りました、気になる所は戻せます」と伝える時にも使える。',
  inputSchema: {},
}, async () => asText(await call('list_trims')));

server.registerTool('kiriko_restore_at', {
  title: 'カットした分を継ぎ目から戻す',
  description:
    '継ぎ目から seconds 秒だけ映像を戻す。切りすぎた所の手当てに使う。\n\n'
    + "side='head' は手前のクリップを伸ばす（語尾が切れた時）、"
    + "side='tail' は次のクリップの頭を戻す（話し始めが切れた時）。\n"
    + 'time を省略すると、いまの再生位置の継ぎ目が対象になる。\n'
    + '在庫より多く頼まれた時は、あるだけ返して restoredSec で知らせる。',
  inputSchema: {
    time: z.number().min(0).optional().describe('継ぎ目のタイムライン秒（省略で再生位置）'),
    seconds: z.number().min(0).optional().describe('戻す秒数（既定 0.5）'),
    side: z.enum(['head', 'tail']).optional().describe("head=手前を伸ばす / tail=次の頭を戻す（既定 head）"),
    tolerance: z.number().min(0).optional().describe('継ぎ目とみなす許容秒（既定 0.5）'),
  },
}, async (a) => asText(await call('restore_at', a)));

server.registerTool('kiriko_get_frame', {
  title: 'フレームを見る',
  description: '指定した時刻の映像を PNG で返す（テロップやぼかしも入った状態）。中身を確認したい時に。',
  inputSchema: {
    time: z.number().min(0).describe('タイムライン上の秒'),
    width: z.number().min(64).max(1920).optional().describe('返す幅（既定 640）'),
  },
}, async (a) => {
  const r = await call('get_frame', a, 120000);
  const base64 = String(r.dataUrl).split(',')[1] ?? '';
  return { content: [{ type: 'image', data: base64, mimeType: 'image/png' }] };
});

server.registerTool('kiriko_get_project', {
  title: 'プロジェクト全体を取る',
  description: '編集内容の JSON をまるごと。大きいので、要約で足りる時は kiriko_summary を使うこと。',
  inputSchema: {},
}, async () => asText(await call('get_project', {}, 120000)));

server.registerTool('kiriko_set_project', {
  title: 'プロジェクト全体を差し替える',
  description:
    '編集内容の JSON をまるごと差し替える。素材はファイル名で対応付け直す。'
    + '取り消しは Kiriko 側の Cmd+Z でできる。大きく変える時だけ使うこと。',
  inputSchema: { project: z.record(z.any()).describe('kiriko_get_project で取れる形の JSON') },
}, async (a) => asText(await call('set_project', a, 120000)));

server.registerTool('kiriko_notes', {
  title: '作業メモの読み書き',
  description: 'プロジェクトの作業メモ。notes を渡すと書き込み、省略すると読み取り。',
  inputSchema: { notes: z.string().optional() },
}, async (a) => asText(
  a.notes === undefined ? await call('get_notes') : await call('set_notes', a)
));

server.registerTool('kiriko_get_thumbnail', {
  title: 'サムネの中身を見る',
  description:
    'YouTube 用サムネイル（1 枚絵）の中身。kiriko_get_project は重いので、サムネだけ軽く見る用。\n\n'
    + 'レイアウト（座標・大きさ・書式・重ね順）は人がドラッグで作るもので、ここには書式は含まれない'
    + '（文字と id だけ）。位置や大きさを変える API は無い。',
  inputSchema: {},
}, async () => asText(await call('get_thumbnail')));

server.registerTool('kiriko_set_thumbnail_text', {
  title: 'サムネの文字を差し替える',
  description:
    '既にあるサムネのテロップの文字だけを入れ替える。**位置・大きさ・書式・重ね順は一切触らない**'
    + '（レイアウトは Kiriko 側でドラッグして決めるもの）。\n\n'
    + 'id は kiriko_get_thumbnail が返したテロップの id。text（改行区切り）か rows（配列）の'
    + 'どちらかを渡す。今の行数と渡した行数が違うとエラーになる（行ごとに書式が違うため）。\n\n'
    + '1 件でもおかしければ何も書き換えずにエラーを返す。',
  inputSchema: {
    texts: z.array(z.object({
      id: z.string().describe('kiriko_get_thumbnail が返したテロップの id'),
      text: z.string().optional().describe('改行で行を分ける'),
      rows: z.array(z.string()).optional().describe('行ごとに渡す。text と排他'),
    })).describe('差し替える文字'),
  },
}, async (a) => asText(await call('set_thumbnail_text', a)));

server.registerTool('kiriko_set_thumbnail_base', {
  title: 'サムネの元画像を決める',
  description:
    'サムネに敷く元画像を決める。**位置や大きさは変えられない**（Kiriko 側でドラッグして決める）。\n\n'
    + 'time / assetName / clear のうち、どれか 1 つだけを渡す。\n'
    + '  time … タイムラインのその秒の場面を元画像にする\n'
    + '  assetName … 画像素材から名前で探す\n'
    + '  clear … 元画像を外す',
  inputSchema: {
    time: z.number().min(0).optional().describe('タイムライン上の秒'),
    assetName: z.string().optional().describe('画像素材の名前'),
    clear: z.boolean().optional().describe('true で元画像を外す'),
  },
}, async (a) => asText(await call('set_thumbnail_base', a)));

server.registerTool('kiriko_seek', {
  title: '再生位置を動かす',
  description: 'Kiriko の再生位置を動かす。人間に見てほしい場所へ合わせる時に。',
  inputSchema: { time: z.number().min(0) },
}, async (a) => asText(await call('seek', a)));

server.registerTool('kiriko_whisper_models', {
  title: '使える音声認識モデルを見る',
  description: 'このマシンに入っている whisper.cpp のモデル一覧。kiriko_transcribe の model に名前を渡せる。',
  inputSchema: {},
}, async () => asText({ models: findModels(), default: pickModel()?.name ?? null }));

server.registerTool('kiriko_transcribe', {
  title: 'セリフを書き起こしてマーカーにする',
  description:
    'ローカルの whisper.cpp でセリフを書き起こし、タイムライン時刻に直して返す。\n'
    + '音声はこのマシンから出ない。\n\n'
    + '**音がある区間だけを渡す**ので、無音での幻聴（何も言っていない所に文が出る）を避けられ、'
    + '処理時間も喋っていない分だけ減る。\n\n'
    + 'sourcePaths に素材の絶対パスを渡すこと（ブラウザ側はファイルの場所を知らないため）。\n'
    + "addMarkers: true にすると、そのまま結果をマーカーにする。markerStyle は既定が 'onset'"
    + '（しゃべり出しの点マーカー。次は kiriko_cut_before_markers を呼ぶのが本命の流れ）で、'
    + "'block' を渡すと従来通り「残す」区間マーカーになる（次は kiriko_cut_outside_markers）。\n\n"
    + '**結果は素材の時刻で返す**ので、書き起こしの最中に人間がカットを進めていても、'
    + 'マーカーはずれた場所に着地しない（タイムライン時刻への変換は立てる直前に行う）。'
    + '素材が切られてしまった箇所のマーカーは落ちる。\n\n'
    + 'pad を渡すと、セリフの前後にのりしろを付けた区間マーカーになる（語頭・語尾の切れ対策）。'
    + '**3 秒を既定と考えてよい**（実素材での照合結果は kiriko_cut_outside_markers の説明にある）。\n\n'
    + '**走行中など、ノイズが途切れない素材では幻聴が出る。** '
    + '「ちょうど 30 秒の区間」「決まり文句」「同じ語の繰り返し」は自動で落としていて、'
    + 'その件数を droppedAsNoise で返す。落とさないと、後段のカットがほとんど効かなくなる'
    + '（実測で肩代わりが 17.5% → 68.2%）。\n\n'
    + '**長い素材は時間が掛かる**（M2 で実時間の 1〜1.5 倍）。'
    + 'まず from / to で短く試してから範囲を広げるとよい。',
  inputSchema: {
    sourcePaths: z.array(z.string()).describe('素材ファイルの絶対パス'),
    from: z.number().min(0).optional().describe('タイムライン上の開始秒（既定 0）'),
    to: z.number().min(0).optional().describe('タイムライン上の終了秒（既定は最後まで）'),
    language: z.string().optional().describe("言語（既定 'ja'）"),
    model: z.string().optional().describe('モデル名。kiriko_whisper_models で確認できる'),
    threshold: z.number().min(0).max(1).optional().describe('音があるとみなす音量（既定 0.06）'),
    minSec: z.number().min(0).optional().describe('これより短い静かさは区切りにしない（既定 0.6）'),
    addMarkers: z.boolean().optional().describe('true なら結果をそのままマーカーにする'),
    markerStyle: z.enum(['onset', 'block']).optional().describe(
      "マーカーの形。'onset'（既定）はしゃべり出しの点、'block' は従来の区間マーカー"),
    pad: z.number().min(0).max(30).optional().describe(
      "マーカーの前後に付けるのりしろ秒（既定 0。markerStyle: 'block' の時だけ使う）"),
    markerKind: z.enum(['start', 'keep', 'cut', 'note']).optional().describe(
      "マーカーの種別（既定は markerStyle に合わせて 'start' か 'keep'）"),
  },
}, async (a) => {
  const model = pickModel(a.model);
  if (!model) {
    throw new Error(
      'whisper.cpp のモデルが見つかりません。~/whisper-models に ggml-*.bin を置くか、'
      + '環境変数 KIRIKO_WHISPER_MODELS で場所を指定してください'
    );
  }

  // 1) 音がある区間を Kiriko に聞く（無音を渡さないため）
  const sil = await call('find_silence', {
    threshold: a.threshold ?? 0.06, minSec: a.minSec ?? 0.6, from: a.from ?? 0, to: a.to ?? null,
  }, 300000);
  if (!sil.sound.length) return asText({ model: model.name, segments: [], note: '音がある区間が見つかりませんでした' });

  // 2) タイムラインの区間を「素材のどこか」に読み替える
  const clips = await call('get_clips');
  const byName = new Map(a.sourcePaths.map((p2) => [path.basename(p2), p2]));
  const pieces = [];
  for (const s of sil.sound) {
    for (const c of clips) {
      const cs = c.start, ce = c.start + c.duration;
      const from = Math.max(s.start, cs), to = Math.min(s.end, ce);
      if (to - from < 0.15) continue;
      const file = byName.get(c.source);
      if (!file) continue;  // パスをもらっていない素材は飛ばす
      pieces.push({
        path: file,
        srcFrom: c.sourceIn + (from - cs),
        srcTo: c.sourceIn + (to - cs),
        tlFrom: from,
      });
    }
  }
  if (!pieces.length) {
    throw new Error(
      '素材のパスが合いません。sourcePaths にタイムラインで使っているファイルの絶対パスを渡してください'
      + `（使用中: ${[...new Set(clips.map((c) => c.source))].join(', ')}）`
    );
  }

  const total = pieces.reduce((acc, p2) => acc + (p2.srcTo - p2.srcFrom), 0);
  process.stderr.write(`kiriko MCP: 書き起こし開始 ${pieces.length} 区間 / 合計 ${total.toFixed(1)} 秒（${model.name}）\n`);

  const segments = await transcribePieces(pieces, {
    model,
    language: a.language ?? 'ja',
    onProgress: (i, n, p2) => process.stderr.write(
      `kiriko MCP: ${i}/${n} ${p2.srcFrom.toFixed(1)}–${p2.srcTo.toFixed(1)}s\n`
    ),
  });

  const markerStyle = a.markerStyle ?? 'onset';
  let markers = null;
  let skippedRegions = 0;
  if (a.addMarkers && segments.length) {
    if (markerStyle === 'onset') {
      // しゃべり出しの点マーカー。位置は sil.sound[] の各区間の start（タイムライン時刻）を使う。
      // whisper の segment はどこに重なるか（text を拾うため）だけに使う。
      // 幻聴として落とした区間・そもそも何も聞き取れなかった区間にはマーカーを立てない。
      // 立ててしまうと走行ノイズだけの所が残って、後段のカットが効かなくなる。
      const sorted = [...segments].sort((x, y) => x.timeAtStart - y.timeAtStart);
      const onsets = [];
      for (const region of sil.sound) {
        const hit = sorted.find((s) => s.timeAtStart >= region.start && s.timeAtStart < region.end);
        if (!hit || !hit.text.trim()) continue;   // 声と認められなかった区間は飛ばす
        onsets.push({
          time: region.start, duration: 0,
          text: hit.text.slice(0, 20),
          kind: a.markerKind ?? 'start',
        });
      }
      skippedRegions = sil.sound.length - onsets.length;
      markers = onsets.length ? await call('add_markers', { markers: onsets }) : { added: 0 };
    } else {
      // 素材の時刻のまま渡す。タイムライン時刻への変換はブラウザ側が今の並びで行う
      markers = await call('add_markers', {
        markers: segments.map((s) => ({
          source: s.source, sourceFrom: s.sourceFrom, sourceTo: s.sourceTo,
          text: s.text, kind: a.markerKind ?? 'keep',
        })),
        pad: a.pad ?? 0,
      });
    }
  }

  return asText({
    model: model.name,
    transcribedSec: +total.toFixed(1),
    droppedAsNoise: segments.dropped ?? 0,
    segments,
    markers,
    skippedRegions,
    note: 'sourceFrom / sourceTo は素材の時刻。timeAtStart は書き起こし開始時点の'
      + 'タイムライン時刻で、その後の編集で動くので当てにしないこと。'
      + "skippedRegions は markerStyle: 'onset' で、音はあるが声と認められず"
      + 'マーカーを立てなかった区間の数（走行ノイズなど）',
  });
});

// ---------------------------------------------------------------- 起動

(async () => {
  await server.connect(new StdioServerTransport());
  // stdout は MCP が使うので、ログは stderr へ
  if (!wsError) process.stderr.write(`kiriko MCP: ws://127.0.0.1:${PORT} で Kiriko を待っています\n`);
})();
