# 同梱しているもの

| ライブラリ | 用途 | ライセンス |
|---|---|---|
| [mp4box.js](https://github.com/gpac/mp4box.js) | mp4 の解析（moov からサンプル表を取る） | BSD-3-Clause |
| [mp4-muxer](https://github.com/Vanilagy/mp4-muxer) | 書き出し時の mp4 組み立て | MIT |

`vendor/` に置いてあります。

Web フォント（M PLUS Rounded 1c / RocknRoll One / Dela Gothic One / Yusei Magic /
Kiwi Maru）は Google Fonts から読み込んでいます（SIL Open Font License）。

MCP サーバー（`mcp/`）は
[@modelcontextprotocol/sdk](https://github.com/modelcontextprotocol/typescript-sdk)（MIT）と
[ws](https://github.com/websockets/ws)（MIT）を使います。
セリフの書き起こしは、別途インストールした
[whisper.cpp](https://github.com/ggerganov/whisper.cpp)（MIT）と ffmpeg を呼び出します。
