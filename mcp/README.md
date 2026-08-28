# Kiriko MCP サーバー — 生成 AI から Kiriko を操作する

Kiriko（ブラウザの動画編集ツール）を、生成 AI から操作するための橋渡しです。
MCP（Model Context Protocol）に対応したツールなら、どれでも同じように繋がります。

```
MCP クライアント ──stdio── mcp/server.js ──WebSocket(127.0.0.1:8910)── ブラウザの Kiriko
```

動画そのものはブラウザから出ません。MCP サーバーは常に**あなたのマシン上**で動き、
ブラウザ側の Kiriko が `ws://127.0.0.1:<ポート>` へ接続しに来る構成です。
ローカルで開いても、公開ページ（https://uraraworks.github.io/Kiriko/）で開いても同じように使えます。

> **このファイルをお使いの生成 AI に示して**
> 「ここに書いてある通りに Kiriko へ MCP 接続できるようにして」と指示すれば、
> 下の手順をそのまま実行してもらえます。

## セットアップ手順（生成 AI はこの節をそのまま実行すればよい）

前提: Node.js 18 以上。

1. リポジトリを取得して、MCP サーバーの依存を入れる（既に手元にあるなら 2. から）:

   ```sh
   git clone https://github.com/uraraworks/Kiriko.git
   cd Kiriko/mcp
   npm install
   ```

2. MCP クライアントに登録する。`<絶対パス>` は 1. のリポジトリの場所に置き換えること:

   ```sh
   claude mcp add kiriko -- node <絶対パス>/mcp/server.js
   ```

   Claude Code 以外のクライアントの場合は、stdio transport で
   `node <絶対パス>/mcp/server.js` を起動する設定を追加する
   （設定ファイルの書き方は各ツールの説明に従う）。

3. ブラウザで Kiriko を開く。どちらでもよい:

   - 公開ページ: `https://uraraworks.github.io/Kiriko/?bridge=1`
   - ローカル: リポジトリ直下で `python3 -m http.server 8901` → `http://localhost:8901/?bridge=1`

   `?bridge=1` を付けると最初から接続しに行く。付けずに開いた場合は、
   ツールバー右の**丸いランプ**をクリックすれば繋がる
   （灰色＝未接続 / 黄色点滅＝サーバー待ち / 緑＝接続中）。

4. 動作確認: MCP クライアントから `kiriko_summary` を呼び、
   編集内容の要約が返れば接続完了。

### 注意事項

- **Safari 非対応（公開ページ利用時）**: https ページから `ws://127.0.0.1` への接続は
  Chrome / Edge / Firefox では localhost 例外で許可されるが、Safari はブロックする。
  公開ページ + MCP の組み合わせは Chrome 系か Firefox を使うこと。
  ローカル（`http://localhost`）で開く場合はどのブラウザでもよい。
- ブリッジのポートは環境変数 `KIRIKO_PORT` で変更できる（既定 `8910`）。
  変更した場合はブラウザ側も `?bridgePort=<ポート番号>` で合わせる。
- ブラウザが未接続の状態でツールを呼ぶと、Kiriko を開くよう案内するエラーが返る。
- 接続は最後に繋いだタブが有効。

## 提供する MCP ツール

| ツール名 | 概要 |
| --- | --- |
| `kiriko_summary` | 編集内容の要約（長さ・クリップ数・テロップ・マーカーなど）。**まずこれを呼ぶ** |
| `kiriko_get_clips` | カットの並びを取得する |
| `kiriko_get_markers` | マーカー一覧を取得する |
| `kiriko_find_silence` | 無音／有音の区間を調べる。カットの下ごしらえの起点 |
| `kiriko_get_audio_levels` | 音量エンベロープを取得する |
| `kiriko_add_markers` | マーカーを一括で立てる（素材の時刻でも渡せる／のりしろ指定可）|
| `kiriko_add_telops` | テロップを一括で追加する |
| `kiriko_get_frame` | 指定時刻のフレームを画像で取得する（映っているものを確かめたい時） |
| `kiriko_get_project` | 編集内容の JSON を丸ごと取得する |
| `kiriko_set_project` | 編集内容の JSON を丸ごと差し替える |
| `kiriko_notes` | 作業メモの読み書き。次のセッションへの申し送りに使う |
| `kiriko_seek` | 再生位置を動かす |
| `kiriko_whisper_models` | 使える音声認識モデルの一覧 |
| `kiriko_transcribe` | **セリフを書き起こしてマーカーにする**（下記） |

使用例（AI への指示イメージ）:
「`kiriko_find_silence` で無音を調べて、3 秒以上の所に切り取り用のマーカーを立てて」

## セリフの書き起こし

ローカルの `whisper.cpp` を使います。音声はこのマシンから出ません。

```sh
brew install whisper-cpp ffmpeg
# モデルを ~/whisper-models/ に置く（環境変数 KIRIKO_WHISPER_MODELS で場所を変えられる）
```

```
このファイルのセリフを書き起こしてマーカーにして
/path/to/動画.mp4
```

**無音には whisper をかけません。** 何も言っていない所に whisper は文章を作ってしまう
（幻聴）ため、Kiriko の音量データで「音がある区間」だけを切り出して渡します。
処理時間も喋っている分だけで済みます。

長い素材は時間が掛かります（M2 で実時間の 1〜1.5 倍）。まず `from` / `to` で
短く試すのがおすすめです。

**書き起こしの最中も編集を続けられます。** 結果は素材の時刻で返し、タイムライン時刻への
変換はマーカーを立てる直前に行うので、その間に人間がカットを進めていても着地位置がずれません
（切られてしまった箇所のマーカーは落ちます）。`pad` でセリフの前後にのりしろを付けられます。

## 方針

- **動画そのものは外に出ない**。やり取りするのは編集内容の JSON と、
  明示的に要求された時のフレーム画像だけ
- 待ち受けは `127.0.0.1` のみ
- 書き込み系は Kiriko の履歴に積むので、**人間が Cmd+Z で戻せる**
- AI は下ごしらえまで。範囲の詰めと最終判断は人間が画面を見て行う

## ブリッジ通信仕様

- ブラウザは接続直後に `{"type":"hello","app":"kiriko"}` を送信する。
- サーバーはコマンドを `{"id":<連番>,"cmd":<string>,"args":<object>}` の形で送信し、
  ブラウザは `{"id":..., "ok":true, "result":...}` または
  `{"id":..., "ok":false, "error":...}` を返す。

ページ内 JS から同じコマンドを直接叩くこともできる（`bme.call(cmd, args)`）。
詳しくは [`docs/AUTOMATION.md`](../docs/AUTOMATION.md) を参照。

## 動作確認（開発者向け）

```sh
node --check server.js
node server.js
```

起動すると stderr に `kiriko MCP: ws://127.0.0.1:8910 で Kiriko を待っています` と出ます。
MCP のログは stdout ではなく stderr に出します（stdout は stdio transport 専用のため）。
