# Browser Movie Editor

ブラウザだけで完結する動画編集ツール（自分用）。
企画書: `_claude_work/hisho-san/docs/ブラウザ動画編集ツール/企画書_20260827.md`

## 現状：Phase 0（最小パイプライン）

実素材の読み込み → シーク再生 → in/out でカット → 連結して mp4 書き出し、まで通っている。

- **処理は 100% クライアント完結**。動画はアップロードせず、ローカルファイルを直接読む
- 14GB の素材でもメモリに載せない（moov だけ解析し、実データは `File.slice()` で都度読む）
- 書き出しは「デコード → Canvas 合成 → エンコード」の流水処理

## 検証結果（2026-08-27 / M2 Mac・Chromium系）

実素材 `PXL_20251001_021741207.ACTIVE.TS.mp4`（HEVC 1080p / 14GB）の先頭 90 秒を切り出して検証。

| 項目 | 結果 |
|---|---|
| moov 解析 | 2 回のリード（mdat 14GB を読み飛ばし）／17ms |
| デコード | `hvc1.1.6.L123` OK、AAC は esds から ASC 抽出で OK |
| 書き出し | 12 クリップ・60 秒を **9.2 秒（実時間比 6.5 倍）** |
| 出力 | H.264 avc1 1920×1080 / AAC 48kHz ステレオ |
| CFR 精度 | 1800 フレーム丁度・フレーム間隔 33.33ms が全継ぎ目で乱れなし |
| 映像内容 | in 点のフレームが元素材と一致 |
| 音声 | max_volume が元素材と一致（-5.9 dB） |

15 分の完成尺なら書き出しはおよそ 2〜3 分の見込み。

※ 音声は AAC エンコーダのプライミング分だけ映像より 70ms ほど長く出る（頭は揃っている）。

## 使い方

```bash
python3 -m http.server 8901
```

`http://localhost:8901/` を Chrome / Edge で開く（`file://` だと WebCodecs 系 API が見えない）。

1. **素材を開く**（または mp4 をドロップ）
2. ソースモニターで <kbd>I</kbd> / <kbd>O</kbd> を打って <kbd>Enter</kbd> でクリップ追加
3. タイムラインで並べ替え・トリム
4. **書き出し** で mp4 保存

`.kdenlive` を開くと既存プロジェクトのカット列（in/out）を取り込む。
該当する mp4 を読み込むと自動でクリップに反映される。

### ショートカット

| キー | 動作 |
|---|---|
| <kbd>Space</kbd> | 再生／停止 |
| <kbd>I</kbd> / <kbd>O</kbd> | イン点／アウト点 |
| <kbd>Enter</kbd> | クリップ追加（アウト点が次のイン点になる） |
| <kbd>J</kbd> <kbd>K</kbd> <kbd>L</kbd> | 逆送り／停止／早送り |
| <kbd>←</kbd> <kbd>→</kbd> | 1 フレーム（<kbd>Shift</kbd> で 1 秒） |
| <kbd>Delete</kbd> | 選択クリップ削除 |
| <kbd>Ctrl</kbd>+<kbd>S</kbd> | プロジェクト保存 |

## ファイル構成

| ファイル | 役割 |
|---|---|
| `js/mp4source.js` | mp4box.js で moov だけ解析し、サンプル単位でディスクから読む |
| `js/exporter.js` | decode → Canvas → encode → mux の書き出しパイプライン |
| `js/project.js` | JSON プロジェクトのデータモデル |
| `js/kdenlive.js` | Kdenlive (MLT XML) からカット列を取り込む |
| `js/main.js` | NLE 風 UI（ビン／モニター／タイムライン） |
| `vendor/` | mp4box.js, mp4-muxer |
| `test.html` | パイプライン単体の検証ページ（`testdata/` に素材を置いて開く） |

## プロジェクト JSON

AI が直接読み書きできることを狙った素直な構造。`telops` / `audioClips` / `blurs` は
Phase 2・3 用に枠だけ用意してある。

```json
{
  "version": 1,
  "output": { "width": 1920, "height": 1080, "fps": 30, "videoBitrate": 12000000 },
  "sources": [{ "id": "src_x", "name": "PXL_....mp4", "duration": 5400.0 }],
  "clips":   [{ "id": "clip_x", "sourceId": "src_x", "in": 12.5, "out": 18.2, "volume": 1 }]
}
```

素材ファイルそのものはブラウザ側に保持できないため、プロジェクトを読み込んだ後に
同名の mp4 を開くと自動で再接続される。

## AI 連携フック

`window.bme` からプロジェクトを直接読み書きできる。Phase 4 の MCP 連携はここに繋ぐ。

```js
bme.exportProjectJSON()      // 現在の編集内容を JSON 文字列で取得
bme.loadProjectJSON(text)    // JSON を流し込んで UI に反映
bme.project.clips            // カット列を直接いじる → bme.render()
```

## 次のフェーズ

- Phase 1: 高速 in/out 打ちの詰め、サムネイル、波形
- Phase 2: テロップ（テキスト直接編集・二重縁取り・プリセット）
- Phase 3: SE / BGM / ぼかし / 音量
- Phase 4: AI 連携（JSON 下ごしらえ）、MCP
