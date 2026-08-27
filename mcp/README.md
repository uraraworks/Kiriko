# Kiriko MCP サーバー

Claude Code から Kiriko（ブラウザの動画編集ツール）を操作するための橋渡し。

```
Claude Code ──stdio── mcp/server.js ──WebSocket(127.0.0.1:8910)── ブラウザの Kiriko
```

## 使い方

1. Claude Code に登録する

```bash
claude mcp add kiriko -- node /Users/haruurara/MyProject/_WebService/BrowserMovieEditor/mcp/server.js
```

2. Kiriko を開き、ツールバー右の**丸いランプ**をクリックして接続する
   （灰色＝未接続 / 黄色点滅＝サーバー待ち / 緑＝接続中）

3. Claude Code から話しかける

```
セリフが取れそうな所を調べて、区間マーカーを立てて
```

## できること

| ツール | 用途 |
|---|---|
| `kiriko_summary` | 状態の要約。まずこれ |
| `kiriko_get_clips` | カットの並び |
| `kiriko_get_markers` | マーカー一覧 |
| `kiriko_find_silence` | 無音／有音の区間を調べる（下ごしらえの起点） |
| `kiriko_get_audio_levels` | 音量エンベロープ |
| `kiriko_add_markers` | マーカーを一括で立てる |
| `kiriko_add_telops` | テロップを一括で追加 |
| `kiriko_get_frame` | 指定時刻のフレームを画像で見る |
| `kiriko_get_project` / `kiriko_set_project` | 編集内容の JSON を丸ごと |
| `kiriko_notes` | 作業メモの読み書き |
| `kiriko_seek` | 再生位置を動かす |

## 方針

- **動画そのものは外に出ない**。やり取りするのは編集内容の JSON と、明示的に要求された時のフレーム画像だけ
- 待ち受けは `127.0.0.1` のみ
- 書き込み系は Kiriko の履歴に積むので、**人間が Cmd+Z で戻せる**
- AI は下ごしらえまで。範囲の詰めと最終判断は人間が画面を見て行う

ポートは環境変数 `KIRIKO_PORT` で変えられる（既定 8910）。
