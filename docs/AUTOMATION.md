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

### 人間の操作を邪魔しない

書き込み系のコマンドは、**人間がドラッグしている間は待ちます**（`bme.busy()` が false に
なるまで）。操作の途中で履歴のスナップショットが撮られると、⌘Z の戻り先がおかしくなるため。
待ちすぎないよう 15 秒で諦めて進みます。

カットや復帰でタイムラインが伸び縮みしても、**再生位置は同じ映像を指したまま**にします。
選択も、そのクリップが残っていれば保ちます。書き起こしのような長い処理を任せている間、
人間は別の場所で編集を続けられます。

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
| `get_subtitles` | 字幕（SRT）一覧。長すぎ・速すぎの警告付き |
| `set_subtitles` | 字幕（SRT）をまとめて入れる・更新する（`mode`: replace / merge、`autoSplit`）|
| `find_silence` | 無音／有音の区間を音量から求める |
| `get_audio_levels` | 音量エンベロープ（0〜1）|
| `get_frame` | 指定時刻の完成フレームを PNG dataURL で |
| `cut_range` | 範囲を切り取る（複数まとめて可）。消した分は在庫に残る |
| `cut_outside_markers` | 「残す」区間マーカーの外を切る（`pad` / `minGapSec` / `dryRun`）|
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

本命の流れはこれ。書き起こし → マーカー → 外を切る → 切りすぎを戻す。

```js
// セリフに「残す」マーカーを立てて、その外を切る
const plan = await bme.call('cut_outside_markers', { pad: 3, minGapSec: 5, dryRun: true });
if (plan.removedSec < 60 * 60) await bme.call('cut_outside_markers', { pad: 3, minGapSec: 5 });
```

`pad` は必ず検討すること。whisper のマーカーはセリフにぴったり張り付くので、
0 のままだと語頭・語尾が欠ける。`minGapSec` より短い隙間は切らずに残す（細切れ防止）。

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

### 字幕（SRT）の下ごしらえ

字幕は**動画に焼き込まれない**。SRT ファイルとして書き出して YouTube 等に添付するもの。
1 エントリに日本語（ja）と英語（en）を同居させる。想定している流れ:

1. 人間が `kiriko_transcribe` で書き起こす
2. AI が `set_subtitles({ subtitles: segments, autoSplit: true })` で日本語の下書きを流し込む
   （長すぎる発話は読みやすい長さに自動分割される）
3. AI が `get_subtitles` を呼び、`warnings`（長すぎ・速すぎ）が付いたエントリを見つけて `ja` を書き直す
4. AI が **英訳だけを `id` 指定で流し込む**（`set_subtitles({ subtitles: [{ id, en }] })`）。
   逐語訳である必要はなく、収まらなければ短く言い直すのが正しい
5. 人間が UI で仕上げて SRT を書き出す

```js
// 2. 書き起こしをそのまま日本語字幕の下書きにする
await bme.call('set_subtitles', { subtitles: segments, autoSplit: true });

// 3. 警告が付いたものだけ拾う
const { subtitles } = await bme.call('get_subtitles');
const needsFix = subtitles.filter((s) => s.warnings.length);

// 4. 英訳を id 指定で流し込む（ja / start / end は省略すれば保持される）
await bme.call('set_subtitles', { subtitles: [{ id: needsFix[0].id, en: 'Short translation' }] });
```

字幕は 1 トラックで**重ならない**。`set_subtitles` は入れ終わると start 昇順に並べ替えて
重なりを詰め、詰めた結果 0.3 秒未満になったものは落とす（返り値の `dropped`）。

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
