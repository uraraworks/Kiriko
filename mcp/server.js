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

server.registerTool('kiriko_seek', {
  title: '再生位置を動かす',
  description: 'Kiriko の再生位置を動かす。人間に見てほしい場所へ合わせる時に。',
  inputSchema: { time: z.number().min(0) },
}, async (a) => asText(await call('seek', a)));

// ---------------------------------------------------------------- 起動

(async () => {
  await server.connect(new StdioServerTransport());
  // stdout は MCP が使うので、ログは stderr へ
  if (!wsError) process.stderr.write(`kiriko MCP: ws://127.0.0.1:${PORT} で Kiriko を待っています\n`);
})();
