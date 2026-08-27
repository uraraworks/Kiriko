# Kiriko を自動操作する

ページ内 JavaScript から Kiriko を操作するための入口です。
AI エージェントからの操作・回帰テスト・下ごしらえの一括処理を想定しています。

MCP サーバー経由で操作する場合は [`../mcp/README.md`](../mcp/README.md) を参照してください。
この文書が扱うのは、その下にある **ページ内 JS の API** です。

## 入口

`window.bme` がページ読み込み時に無条件で公開されます（`?bridge=1` は不要）。

```js
await window.bme.call(cmd, args)   // MCP と同じコマンドを名前で実行する
window.bme.project                 // 編集内容（読み書きどちらも可）
window.bme.state                   // 内部状態（選択・再生位置など）
window.bme.render()                // 直接いじった後の再描画
```

`call()` は MCP 経由とまったく同じ処理を通るので、**ページ内から叩いても
MCP から叩いても挙動がずれません**。

## 2 つの経路

| 経路 | 使う場面 | 必要なもの |
|---|---|---|
| `window.bme.call()` | ブラウザペイン内、DevTools、テストスクリプト | なし |
| MCP（WebSocket） | 別プロセスの生成 AI から | `mcp/server.js` の起動 ＋ 接続 |

MCP は `ws://127.0.0.1:8910` を使う。**https のページ（GitHub Pages 等）からでも繋がる**
（localhost は安全なオリジンとして扱われるため）。ただし **Safari は塞いでいる**ので
Chrome 系か Firefox を使うこと。

`?bridge=1` を付けて開くと最初から接続しに行く。`?bridgePort=9999` でポートも変えられる。
一度つなぐと次回以降も自動で繋ぎに行く（ランプをクリックして切ると解除）。

## コマンド一覧

`call()` と MCP で共通。

| コマンド | 内容 |
|---|---|
| `summary` | 尺・クリップ数・マーカー数・素材などの要約。まずこれ |
| `get_clips` | タイムライン上のクリップの並び（どの素材のどこを使っているか）|
| `get_markers` | マーカー一覧 |
| `get_project` / `set_project` | 編集内容の JSON を丸ごと |
| `add_markers` | マーカーを一括で立てる（`kind`: keep / cut / note）|
| `add_telops` | テロップを一括で追加（プリセット指定・複数行可）|
| `find_silence` | 無音／有音の区間を音量から求める |
| `get_audio_levels` | 音量エンベロープ（0〜1）|
| `get_frame` | 指定時刻の完成フレームを PNG dataURL で |
| `get_notes` / `set_notes` | 作業メモ |
| `seek` | 再生位置を動かす |

```js
// 例: 無音の所に「消す」マーカーを立てる
const { silence } = await bme.call('find_silence', { threshold: 0.08, minSec: 1.0 });
await bme.call('add_markers', {
  markers: silence.map(s => ({ time: s.start, duration: s.end - s.start, kind: 'cut', text: '無音' })),
});
```

## 直接いじる場合

`bme.project` はそのまま書き換えられますが、**履歴には積まれません**。
人間が ⌘Z で戻せるようにしたい時は `call()` 側を使ってください
（書き込み系のコマンドは必ず履歴に積んでいます）。

```js
bme.project.clips.push({ id: 'c1', sourceId, in: 5, out: 11, volume: 1 });
bme.render();
```

## 素材の読み込み

ブラウザはファイルのパスを持てないので、素材は `File` オブジェクトで渡します。

```js
const f = new File([blob], 'PXL_xxx.mp4', { type: 'video/mp4' });
await bme.addFiles([f]);
```

MCP から書き起こし（`kiriko_transcribe`）を使う時だけは、
whisper に渡すために**素材の絶対パス**を別途伝える必要があります。

## 注意

- 時刻はすべて**出力タイムライン基準**（素材の時刻ではない）。`get_clips` で対応が取れる
- 書き出し（`exportProject`）は重い処理なので、自動操作からは呼べるようにしていない
- 動画・音声そのものは MCP に流れない。流れるのは編集内容の JSON と、
  `get_frame` で明示的に要求されたフレーム画像だけ
