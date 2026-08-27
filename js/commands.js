// commands.js
// MCP から呼ばれるコマンドの実装。
// 「AI が下ごしらえ、人間が仕上げ」を想定しているので、
//  - 読み取りは軽い要約を既定にする（プロジェクト全体は明示的に要求された時だけ）
//  - 書き込みは必ず履歴に積んで、人間が Cmd+Z で戻せるようにする

import { BINS_PER_SEC } from './waveform.js';

/**
 * @param {object} ctx { S, P, T, commit, renderAll, status, waves, thumbs, seekProgram, tc }
 */
export function createCommands(ctx) {
  const { S, P, T, commit, renderAll, status } = ctx;
  const proj = () => S.project;

  const clipTimeline = () => {
    let t = 0;
    return proj().clips.map((c) => {
      const src = S.sources.get(c.sourceId);
      const e = { id: c.id, start: +t.toFixed(3), duration: +P.clipDuration(c).toFixed(3),
        source: src?.name ?? c.sourceId, sourceIn: +c.in.toFixed(3), sourceOut: +c.out.toFixed(3) };
      t += P.clipDuration(c);
      return e;
    });
  };

  const cmds = {
    /** ざっくりした状態。まずこれを見てから必要なものを取りに行く想定 */
    async summary() {
      const p = proj();
      return {
        title: p.title,
        notes: p.notes ?? '',
        durationSec: +P.totalDuration(p).toFixed(3),
        output: p.output,
        counts: {
          clips: p.clips.length, markers: p.markers.length, telops: p.telops.length,
          images: p.images.length, blurs: p.blurs.length, audioClips: p.audioClips.length,
        },
        sources: p.sources.map((s) => ({ id: s.id, name: s.name, durationSec: +(s.duration ?? 0).toFixed(3) })),
        loadedSources: [...S.sources.keys()],
        playheadSec: +S.programTime.toFixed(3),
      };
    },

    /** タイムライン上のクリップ並び（どの素材のどこを使っているか） */
    async get_clips() { return clipTimeline(); },

    async get_markers() {
      return proj().markers.map((m) => ({
        id: m.id, time: +m.time.toFixed(3), duration: +(m.duration ?? 0).toFixed(3),
        kind: m.kind ?? 'note', text: m.text ?? '',
      }));
    },

    /** プロジェクト全体（大きいので明示的に呼ぶ用） */
    async get_project() { return proj(); },

    /** プロジェクト全体を差し替える。素材の対応付けは名前で取り直す */
    async set_project({ project }) {
      if (!project || typeof project !== 'object') throw new Error('project が要ります');
      commit('MCP: プロジェクトを差し替え');
      ctx.applyProject(project);
      status('MCP からプロジェクトを受け取りました');
      return { ok: true, durationSec: +P.totalDuration(proj()).toFixed(3) };
    },

    /**
     * マーカーを一括で立てる。
     * kind は keep（ここは残す）/ cut（ここは消す）/ note（メモ）。
     * 「セリフの所に keep」でも「無音の所に cut」でも、同じ流れで消していける。
     * @param {Array<{time:number,duration?:number,text?:string,kind?:string}>} markers
     */
    async add_markers({ markers, replace = false }) {
      if (!Array.isArray(markers)) throw new Error('markers は配列で渡してください');
      const total = P.totalDuration(proj());
      commit(replace ? 'MCP: マーカーを置き換え' : `MCP: マーカーを ${markers.length} 件追加`);
      if (replace) proj().markers = [];
      const added = [];
      for (const m of markers) {
        const time = Math.max(0, Math.min(total, Number(m.time) || 0));
        const dur = Math.max(0, Math.min(total - time, Number(m.duration) || 0));
        const kind = ctx.MARKER_KINDS[m.kind] ? m.kind : (dur > 0 ? 'keep' : 'note');
        proj().markers.push({
          id: P.newId('mk'), time, duration: dur, text: String(m.text ?? ''),
          kind, color: ctx.MARKER_KINDS[kind].color,
        });
        added.push(1);
      }
      proj().markers.sort((a, b) => a.time - b.time);
      renderAll();
      status(`MCP: マーカーを ${added.length} 件立てました`);
      return { added: added.length, total: proj().markers.length };
    },

    /**
     * テロップを一括で追加する。
     * @param {Array<{start:number,end:number,text:string|string[],preset?:string,track?:number}>} telops
     */
    async add_telops({ telops }) {
      if (!Array.isArray(telops)) throw new Error('telops は配列で渡してください');
      const total = P.totalDuration(proj());
      commit(`MCP: テロップを ${telops.length} 件追加`);
      const presets = proj().telopPresets ?? T.DEFAULT_PRESETS;
      const added = [];
      for (const t of telops) {
        const pre = t.preset ? presets.find((x) => x.name === t.preset) : null;
        const style = pre ? { ...pre.style } : { ...S.telopStyle };
        const start = Math.max(0, Math.min(total, Number(t.start) || 0));
        const end = Math.max(start + 0.1, Math.min(total, Number(t.end) || start + 3));
        const rows = Array.isArray(t.text) ? t.text : [String(t.text ?? '')];
        const tel = T.createTelop(start, end, style, rows[0]);
        for (let i = 1; i < rows.length; i++) tel.rows.push(T.createRow(rows[i], style));
        tel.track = Number.isInteger(t.track) ? t.track : 0;
        // 同じ時間に重ならないトラックへ寄せる
        while (proj().telops.some((o) => (o.track ?? 0) === tel.track && start < o.end && end > o.start)) tel.track++;
        tel.z = ctx.nextZ();
        proj().telops.push(tel);
        added.push(tel.id);
      }
      renderAll();
      status(`MCP: テロップを ${added.length} 件追加しました`);
      return { added: added.length, total: proj().telops.length };
    },

    /** 作業メモの読み書き */
    async get_notes() { return { notes: proj().notes ?? '' }; },
    async set_notes({ notes }) {
      commit('MCP: 作業メモを更新');
      proj().notes = String(notes ?? '');
      ctx.syncProjectUI();
      renderAll();
      return { ok: true };
    },

    /**
     * 音量のエンベロープを返す（0〜1）。無音区間を探すのに使う。
     * 素材ではなく「編集後のタイムライン」基準。
     */
    async get_audio_levels({ from = 0, to = null, binsPerSec = 10 }) {
      const total = P.totalDuration(proj());
      const t1 = Math.min(total, to ?? total);
      const levels = await ctx.timelineLevels(from, t1, binsPerSec);
      return { from, to: t1, binsPerSec, levels: levels.map((v) => +v.toFixed(4)) };
    },

    /**
     * 無音（しゃべっていない）区間を探す。
     * threshold は 0〜1。minSec より短い静かさは無視する。
     */
    async find_silence({ threshold = 0.06, minSec = 1.0, from = 0, to = null }) {
      const total = P.totalDuration(proj());
      const t1 = Math.min(total, to ?? total);
      const bps = 20;
      const levels = await ctx.timelineLevels(from, t1, bps);
      const out = [];
      let start = null;
      for (let i = 0; i < levels.length; i++) {
        const quiet = levels[i] < threshold;
        if (quiet && start === null) start = from + i / bps;
        if (!quiet && start !== null) {
          const end = from + i / bps;
          if (end - start >= minSec) out.push({ start: +start.toFixed(2), end: +end.toFixed(2) });
          start = null;
        }
      }
      if (start !== null && t1 - start >= minSec) out.push({ start: +start.toFixed(2), end: +t1.toFixed(2) });
      // 逆に「音がある区間」も返す。セリフ区間マーカーはこちらを使う
      const loud = [];
      let prev = from;
      for (const s of out) {
        if (s.start - prev > 0.05) loud.push({ start: +prev.toFixed(2), end: +s.start.toFixed(2) });
        prev = s.end;
      }
      if (t1 - prev > 0.05) loud.push({ start: +prev.toFixed(2), end: +t1.toFixed(2) });
      return { threshold, minSec, silence: out, sound: loud };
    },

    /** 指定時刻のフレームを PNG（base64）で返す。AI が中身を見るため */
    async get_frame({ time = 0, width = 640 }) {
      const dataUrl = await ctx.frameAt(Number(time) || 0, Math.max(64, Math.min(1920, width)));
      return { time, dataUrl };
    },

    /** 再生位置を動かす（人が見ている画面を合わせたい時に） */
    async seek({ time = 0 }) {
      ctx.seekTo(Number(time) || 0);
      return { playheadSec: +S.programTime.toFixed(3) };
    },
  };

  return cmds;
}

export const BINS = BINS_PER_SEC;
