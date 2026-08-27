// history.js
// アンドゥ / リドゥ。プロジェクトが JSON なので、丸ごとスナップショットを積む方式にする。
// 200 カット規模でも 1 スナップショット数十 KB 程度なので、差分管理は要らない。
//
// 使い方: **変更を加える直前** に commit() を呼ぶ。その時点の状態が「戻り先」になる。
//   commit('カット')            … 単発の操作
//   commit('トリム', 'trim:c3') … ドラッグ中など連続する操作（同じ key の間は 1 回にまとまる）
//   endGroup()                  … 連続操作の区切り（pointerup / blur などで呼ぶ）

export class History {
  constructor(getState, setState, limit = 100) {
    this.getState = getState;
    this.setState = setState;
    this.limit = limit;
    this.past = [];
    this.future = [];
    this.key = null;
    this.onChange = () => {};
  }

  commit(label, key = null) {
    if (key !== null && this.key === key) return; // 同じ連続操作の途中
    this.key = key;
    this.past.push({ label, json: this.getState() });
    if (this.past.length > this.limit) this.past.shift();
    this.future.length = 0;
    this.onChange();
  }

  /** 連続操作の区切り。次の同じ key の commit を別エントリにする */
  endGroup() {
    if (this.key !== null) { this.key = null; this.onChange(); }
  }

  undo() {
    if (!this.past.length) return null;
    const e = this.past.pop();
    this.future.push({ label: e.label, json: this.getState() });
    this.key = null;
    this.setState(e.json);
    this.onChange();
    return e.label;
  }

  redo() {
    if (!this.future.length) return null;
    const e = this.future.pop();
    this.past.push({ label: e.label, json: this.getState() });
    this.key = null;
    this.setState(e.json);
    this.onChange();
    return e.label;
  }

  clear() {
    this.past.length = 0;
    this.future.length = 0;
    this.key = null;
    this.onChange();
  }

  get canUndo() { return this.past.length > 0; }
  get canRedo() { return this.future.length > 0; }
  get undoLabel() { return this.past.at(-1)?.label ?? null; }
  get redoLabel() { return this.future.at(-1)?.label ?? null; }
}
