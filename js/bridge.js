// bridge.js
// ローカル MCP サーバーとの橋渡し（WebSocket）。
//
//   Claude Code ──stdio── mcp/server.js ──WebSocket── ここ ── window.bme
//
// 動画も音声もブラウザから出さない。やり取りするのは編集内容（JSON）と、
// 明示的に要求された時のフレーム画像だけ。接続先は localhost 固定。

const DEFAULT_URL = 'ws://127.0.0.1:8910';

export class Bridge {
  /**
   * @param {(cmd:string, args:object)=>Promise<any>} handle コマンドの実処理
   * @param {(state:string, detail?:string)=>void} onState 表示更新用
   */
  constructor(handle, onState = () => {}) {
    this.handle = handle;
    this.onState = onState;
    this.url = DEFAULT_URL;
    this.ws = null;
    this.wanted = false;   // ユーザーが繋ぎたいと思っているか
    this.retry = null;
  }

  get connected() { return this.ws?.readyState === WebSocket.OPEN; }

  connect(url = this.url) {
    this.url = url;
    this.wanted = true;
    // 次に開いた時も繋ぎに行く（切ると解除される）
    try { localStorage.setItem('kiriko.autoBridge', '1'); } catch {}
    this._open();
  }

  disconnect() {
    this.wanted = false;
    try { localStorage.removeItem('kiriko.autoBridge'); } catch {}
    clearTimeout(this.retry);
    this.ws?.close();
    this.ws = null;
    this.onState('off');
  }

  _open() {
    if (this.ws && this.ws.readyState <= WebSocket.OPEN) return;
    this.onState('connecting');
    let ws;
    try {
      ws = new WebSocket(this.url);
    } catch {
      return this._scheduleRetry();
    }
    this.ws = ws;

    ws.onopen = () => {
      this.onState('on');
      ws.send(JSON.stringify({ type: 'hello', app: 'kiriko' }));
    };
    ws.onclose = () => {
      this.ws = null;
      if (this.wanted) this._scheduleRetry();
      else this.onState('off');
    };
    ws.onerror = () => { /* onclose でまとめて扱う */ };

    ws.onmessage = async (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.type !== 'call') return;
      let res;
      try {
        res = { type: 'result', id: msg.id, ok: true, value: await this.handle(msg.cmd, msg.args ?? {}) };
      } catch (e) {
        res = { type: 'result', id: msg.id, ok: false, error: String(e?.message ?? e) };
      }
      try { ws.send(JSON.stringify(res)); } catch {}
    };
  }

  _scheduleRetry() {
    clearTimeout(this.retry);
    this.onState('waiting');
    this.retry = setTimeout(() => { if (this.wanted) this._open(); }, 2000);
  }
}
