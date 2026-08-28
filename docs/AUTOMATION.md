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
| `add_markers` | マーカーを一括で立てる（`kind`: keep / cut / note、`pad` でのりしろ）|
| `add_telops` | テロップを一括で追加（プリセット指定・複数行可）|
| `find_silence` | 無音／有音の区間を音量から求める |
| `get_audio_levels` | 音量エンベロープ（0〜1）|
| `get_frame` | 指定時刻の完成フレームを PNG dataURL で |
| `cut_range` | 範囲を切り取る（複数まとめて可）。消した分は在庫に残る |
| `list_trims` | 切りすぎた分の在庫。どこで何秒戻せるか |
| `restore_at` | 継ぎ目から秒単位で戻す（`side`: head / tail）|
| `get_notes` / `set_notes` | 作業メモ |
| `seek` | 再生位置を動かす |

### 時間の掛かる処理は「素材の時刻」で持ち回る

書き起こしのように何十分も掛かる処理は、その間に人間がカットを進めます。
開始時点のタイムライン時刻で結果を返すと、**ずれた場所に着地して黙って壊れます**。

そこで `add_markers` は素材の時刻でも受け取れるようにしてある。
タイムライン時刻への変換は**マーカーを立てる直前**に行うので、途中の編集に影響されない。

```js
await bme.call('add_markers', {
  markers: [{ source: 'PXL_0001.mp4', sourceFrom: 50, sourceTo: 54, text: 'セリフ' }],
  pad: 2,   // 前後ののりしろ秒（語頭・語尾の切れ対策）
});
```

素材のその範囲が既に切られていた場合は、変な所に置かず**落として `dropped` で件数を返す**。
`kiriko_transcribe` は既にこの形で結果を渡している。

### カットは非破壊

`cut_range` で消した区間は捨てず、`project.trims` に在庫として残る。
アンドゥは一本道なので、カットの後に別の作業をすると「あの箇所だけ 1 秒返す」ができない。
在庫を持っておけば、**下ごしらえを受け入れた上で、後から必要な所だけ返せる**。

```js
// 無音を全部切ってから、切りすぎた 1 箇所だけ 1 秒返す
await bme.call('cut_range', { ranges: silence.map(s => [s.start, s.end]), label: '無音' });
const { trims } = await bme.call('list_trims');
await bme.call('restore_at', { time: trims[3].atSec, seconds: 1, side: 'head' });
```

戻すと隣のクリップが伸びる（クリップは増えない）。`side: 'head'` は手前のクリップの終端を
延ばす（語尾が切れた時）、`side: 'tail'` は次のクリップの頭を戻す（話し始めが切れた時）。
在庫より多く頼まれた時は、あるだけ返して `restoredSec` で知らせる。

画面では、戻せる分が残っている継ぎ目に印が出る。
<kbd>&lt;</kbd> <kbd>&gt;</kbd> で継ぎ目送り、<kbd>[</kbd> <kbd>]</kbd> で 0.5 秒ずつ復帰、
<kbd>{</kbd> <kbd>}</kbd> で削り直し。

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

- `set_project` で丸ごと差し替えると、渡した JSON に `trims` が無い場合は
  **手元の在庫をそのまま引き継ぐ**（黙って捨てない）。ただし差し替え後のクリップと
  繋がらなくなったものは「戻せないカット」として `list_trims` に出る
- 時刻はすべて**出力タイムライン基準**（素材の時刻ではない）。`get_clips` で対応が取れる
- 書き出し（`exportProject`）は重い処理なので、自動操作からは呼べるようにしていない
- 動画・音声そのものは MCP に流れない。流れるのは編集内容の JSON と、
  `get_frame` で明示的に要求されたフレーム画像だけ
