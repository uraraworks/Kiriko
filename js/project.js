// project.js
// 編集内容を表す JSON プロジェクトファイル。
// 「AI が下ごしらえ → 人間が仕上げ」を狙って、素直に読み書きできる形にしてある。
// Phase 0 で使うのは sources / clips だけだが、以降のフェーズで足す枠は先に切ってある。

export const PROJECT_VERSION = 1;

export function createProject() {
  return {
    version: PROJECT_VERSION,
    title: '無題プロジェクト',
    output: { width: 1920, height: 1080, fps: 30, videoBitrate: 12_000_000, audioBitrate: 192_000 },
    sources: [],   // { id, name, size, duration }
    clips: [],     // { id, sourceId, in, out, volume }
    telops: [],    // { id, text, start, end, x, y, ...style } 時刻は出力タイムライン秒
    telopPresets: null, // null なら telop.js の既定プリセットを使う
    audioClips: [],// Phase 3 (SE / BGM)
    blurs: [],     // Phase 3
  };
}

let seq = 0;
export function newId(prefix) {
  return `${prefix}_${Date.now().toString(36)}${(seq++).toString(36)}`;
}

export function clipDuration(clip) {
  return Math.max(0, clip.out - clip.in);
}

export function totalDuration(project) {
  return project.clips.reduce((a, c) => a + clipDuration(c), 0);
}

/** クリップ列の中で「出力タイムライン上の開始秒」を積算して返す */
export function withTimelineOffsets(project) {
  let t = 0;
  return project.clips.map((clip) => {
    const entry = { clip, offset: t };
    t += clipDuration(clip);
    return entry;
  });
}

export function serialize(project) {
  return JSON.stringify(project, null, 2);
}

export function deserialize(text) {
  const p = JSON.parse(text);
  if (p.version !== PROJECT_VERSION) {
    console.warn(`プロジェクトのバージョンが違います (${p.version} != ${PROJECT_VERSION})`);
  }
  return { ...createProject(), ...p };
}
