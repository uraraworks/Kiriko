// commands.js
// MCP から呼ばれるコマンドの実装。
// 「AI が下ごしらえ、人間が仕上げ」を想定しているので、
//  - 読み取りは軽い要約を既定にする（プロジェクト全体は明示的に要求された時だけ）
//  - 書き込みは必ず履歴に積んで、人間が Cmd+Z で戻せるようにする

import { BINS_PER_SEC } from './waveform.js';
import { cutRangesFromKeep, keepRangesFromStarts } from './edit.js';
import * as SUB from './subtitles.js';

/**
 * @param {object} ctx { S, P, T, commit, renderAll, status, waves, thumbs, seekProgram, tc }
 */
export function createCommands(ctx) {
  const { S, P, T, commit, renderAll, status } = ctx;
  const proj = () => S.project;

  /**
   * 素材の時刻 [from, to) が、いまのタイムラインのどこに当たるかを返す。
   *
   * MCP 側の重い処理（書き起こし等）は素材の時刻で結果を返し、変換はここで、
   * マーカーを立てる直前に行う。そうすれば処理中に人間がタイムラインを
   * 編集していても、結果がずれた場所に着地しない。
   * 同じ素材を 2 度使っていれば複数に、切られていれば 0 個になる。
   */
  const sourceToTimeline = (sourceId, from, to) => {
    const out = [];
    let t = 0;
    for (const c of proj().clips) {
      const dur = P.clipDuration(c);
      if (c.sourceId === sourceId) {
        const a = Math.max(from, c.in), b = Math.min(to, c.out);
        if (b - a > 0.02) out.push([t + (a - c.in), t + (b - c.in)]);
      }
      t += dur;
    }
    return out;
  };

  /** 字幕 1 件の警告文を作る（長すぎ・速すぎ）。無ければ空配列 */
  const subtitleWarnings = (sub) => {
    const warnings = [];
    for (const lang of ['ja', 'en']) {
      const r = SUB.checkLimits(sub, lang);
      const lim = SUB.LIMITS[lang];
      if (r.long) warnings.push(`${lang}:1行が長すぎます（${r.maxLine}/${lim.chars}文字）`);
      if (r.fast) {
        const cps = Number.isFinite(r.cps) ? r.cps.toFixed(1) : '∞';
        warnings.push(`${lang}:速すぎます（${cps}/${lim.cps} 文字毎秒）`);
      }
    }
    return warnings;
  };

  /** 素材を名前でも id でも引けるようにする（MCP 側は名前しか知らないことがある） */
  const findSource = (key) => {
    if (!key) return null;
    const list = proj().sources;
    return list.find((s) => s.id === key) ?? list.find((s) => s.name === key) ?? null;
  };

  /** サムネの元画像を MCP へ返す形に揃える（get_thumbnail / set_thumbnail_base で共通） */
  const thumbBaseView = (base, p) => {
    if (!base) return null;
    if (base.kind === 'frame') return { kind: 'frame', time: +base.time.toFixed(3) };
    return { kind: 'asset', assetId: base.assetId, name: p.imageAssets.find((a) => a.id === base.assetId)?.name ?? null };
  };

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
    /**
     * マーカーを一括で立てる。
     *
     * 時刻は 2 通りで渡せる:
     *  - `time` / `duration` … タイムライン時刻。渡した時点の並びが前提
     *  - `source` + `sourceFrom` / `sourceTo` … 素材の時刻。**立てる直前に変換する**ので、
     *    書き起こしのような長い処理の最中に人間が編集していてもずれない。
     *    素材が切られていればそのマーカーは落ちる（dropped で件数を返す）
     */
    async add_markers({ markers, replace = false, pad = 0 }) {
      if (!Array.isArray(markers)) throw new Error('markers は配列で渡してください');
      const total = P.totalDuration(proj());
      const padSec = Math.max(0, Number(pad) || 0);

      // 先に置き場所を決める。1 件も置けない時に履歴を汚さないため
      const places = [];
      let dropped = 0;
      for (const m of markers) {
        const text = String(m.text ?? '');
        const kind = m.kind;
        if (m.source !== undefined && m.source !== null) {
          const src = findSource(m.source);
          if (!src) { dropped++; continue; }
          const from = Number(m.sourceFrom) || 0;
          const to = Number(m.sourceTo ?? m.sourceFrom) || from;
          const spans = sourceToTimeline(src.id, from - padSec, to + padSec);
          if (!spans.length) { dropped++; continue; }
          for (const [a, b] of spans) places.push({ time: a, dur: b - a, text, kind });
          continue;
        }
        const time = Math.max(0, Math.min(total, (Number(m.time) || 0) - padSec));
        const dur = Math.max(0, Math.min(total - time, (Number(m.duration) || 0) + padSec * 2));
        places.push({ time, dur, text, kind });
      }
      if (!places.length && !replace) {
        return { added: 0, dropped, total: proj().markers.length,
          note: dropped ? '素材のその範囲は、いまタイムラインに残っていません' : undefined };
      }

      commit(replace ? 'MCP: マーカーを置き換え' : `MCP: マーカーを ${places.length} 件追加`);
      if (replace) proj().markers = [];
      for (const p of places) {
        const kind = ctx.MARKER_KINDS[p.kind] ? p.kind : (p.dur > 0 ? 'keep' : 'note');
        proj().markers.push({
          id: P.newId('mk'), time: +p.time.toFixed(3), duration: +p.dur.toFixed(3),
          text: p.text, kind, color: ctx.MARKER_KINDS[kind].color,
        });
      }
      proj().markers.sort((a, b) => a.time - b.time);
      renderAll();
      status(`MCP: マーカーを ${places.length} 件立てました`);
      return { added: places.length, dropped, total: proj().markers.length };
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

    /** 字幕を一覧する。各エントリに checkLimits から作った警告だけを添える */
    async get_subtitles() {
      const total = P.totalDuration(proj());
      const list = proj().subtitles.slice().sort((a, b) => a.start - b.start);
      let warned = 0;
      const subtitles = list.map((s) => {
        const warnings = subtitleWarnings(s);
        if (warnings.length) warned++;
        return {
          id: s.id, start: +s.start.toFixed(3), end: +s.end.toFixed(3),
          ja: s.ja ?? '', en: s.en ?? '', warnings,
        };
      });
      return { subtitles, total: subtitles.length, warned, durationSec: +total.toFixed(3) };
    },

    /**
     * 字幕を入れる。mode='replace' は総入れ替え、mode='merge'（既定）は
     * id 指定なら既存のフィールドだけ更新（渡されなかったフィールドは保持）、
     * id 無しなら新規追加。id が見つからない更新はエラーにせず skipped で数える。
     *
     * autoSplit は新規追加分だけに効く。fromSegments に通してから足すので、
     * whisper の書き起こしをそのまま流し込める（英訳は付かないので落ちる）。
     *
     * 入れ終わったら start 昇順に並べ替え、重なりを詰め、
     * 詰めた結果 0.3 秒未満になったものは落とす（normalizeOverlaps）。
     * タイムライン全体の長さを超える分は clamp する。
     */
    async set_subtitles({ subtitles, mode = 'merge', autoSplit = false }) {
      if (!Array.isArray(subtitles)) throw new Error('subtitles は配列で渡してください');
      const total = P.totalDuration(proj());
      commit(mode === 'replace' ? 'MCP: 字幕を置き換え' : 'MCP: 字幕を反映');

      let list = mode === 'replace' ? [] : proj().subtitles.slice();
      let updated = 0, skipped = 0;

      const withId = subtitles.filter((s) => s.id !== undefined && s.id !== null);
      const withoutId = subtitles.filter((s) => s.id === undefined || s.id === null);

      for (const s of withId) {
        const idx = list.findIndex((x) => x.id === s.id);
        if (idx < 0) { skipped++; continue; }
        const next = { ...list[idx] };
        if (s.ja !== undefined) next.ja = String(s.ja);
        if (s.en !== undefined) next.en = String(s.en);
        if (s.start !== undefined) next.start = Number(s.start) || 0;
        if (s.end !== undefined) next.end = Number(s.end) || 0;
        list[idx] = next;
        updated++;
      }

      let newEntries;
      if (autoSplit) {
        // {start,end,ja} で来るので、fromSegments が読む text に橋渡しする。
        // 分割されると入力エントリとの 1:1 対応が崩れるため、en はここでは付けない。
        const segs = withoutId.map((s) => ({
          start: Number(s.start) || 0, end: Number(s.end) || 0, text: s.ja ?? '',
        }));
        newEntries = SUB.fromSegments(segs);
      } else {
        newEntries = withoutId.map((s) => SUB.createSubtitle(
          Number(s.start) || 0, Number(s.end) || 0, String(s.ja ?? ''), String(s.en ?? ''),
        ));
      }
      const added = newEntries.length;
      list.push(...newEntries);

      // タイムライン全体の長さを超える分は clamp する
      list = list.map((s) => ({
        ...s,
        start: Math.max(0, Math.min(total, s.start)),
        end: Math.max(0, Math.min(total, s.end)),
      }));

      const { subtitles: normalized, dropped } = SUB.normalizeOverlaps(list, 0.3);
      proj().subtitles = normalized;
      renderAll();

      const warned = normalized.filter((s) => subtitleWarnings(s).length).length;
      status(`MCP: 字幕を反映しました（追加 ${added} / 更新 ${updated} / 総数 ${normalized.length}）`);
      return { added, updated, skipped, dropped, total: normalized.length, warned };
    },

    /**
     * 範囲を切り取る。消した分は在庫（trims）に残るので、後から秒単位で戻せる。
     * 無音カットのように何箇所もある時は ranges でまとめて渡す。
     */
    async cut_range({ ranges, from, to, label = '', group = null }) {
      const list = Array.isArray(ranges) && ranges.length
        ? ranges.map((r) => (Array.isArray(r) ? r : [r.from ?? r.start, r.to ?? r.end]))
        : [[from, to]];
      const clean = list
        .map(([a, b]) => [Math.max(0, Number(a) || 0), Number(b) || 0])
        .filter(([a, b]) => b - a > 0.001);
      if (!clean.length) throw new Error('切り取る範囲がありません');
      const r = ctx.cutRanges(clean, String(label ?? ''), group ? String(group) : null);
      ctx.status(`MCP: ${clean.length} 箇所（${r.removedSec.toFixed(1)} 秒）を切り取りました`);
      return { cut: clean.length, ...r, hint: '戻したい所は restore_at で秒単位に返せます' };
    },

    /**
     * 区間マーカーの外を切り取る。書き起こし → マーカー → 外を切る、の最後の一歩。
     *
     * pad でセリフの前後にのりしろを残す（whisper のマーカーはぴったり張り付くので、
     * 入れないと語頭・語尾が欠ける）。minGapSec より短い隙間は切らずに残す（細切れ防止）。
     * dryRun なら切らずに、何箇所・何秒切ることになるかだけ返す。
     */
    async cut_outside_markers({ pad = 0, minGapSec = 0, kind = 'keep', dryRun = false }) {
      const total = P.totalDuration(proj());
      const keep = proj().markers
        .filter((m) => (m.duration ?? 0) > 0.02 && (m.kind ?? 'keep') === kind)
        .map((m) => [m.time, m.time + m.duration]);
      if (!keep.length) throw new Error(`長さのある ${kind} マーカーがありません`);

      const ranges = cutRangesFromKeep(keep, total, Math.max(0, Number(pad) || 0),
        Math.max(0, Number(minGapSec) || 0));
      const removedSec = ranges.reduce((a, [x, y]) => a + (y - x), 0);
      const plan = {
        cut: ranges.length,
        removedSec: +removedSec.toFixed(3),
        beforeSec: +total.toFixed(3),
        durationSec: +(total - removedSec).toFixed(3),
        keepMarkers: keep.length,
      };
      if (dryRun) return { ...plan, dryRun: true, ranges: ranges.map(([x, y]) => [+x.toFixed(2), +y.toFixed(2)]) };
      if (!ranges.length) return { ...plan, note: '切る所がありませんでした' };

      const r = ctx.cutRanges(ranges, 'マーカー区間の外', 'outside-markers');
      status(`MCP: マーカー区間の外 ${ranges.length} 箇所（${removedSec.toFixed(1)} 秒）を切り取りました`);
      return { ...plan, ...r, hint: '切りすぎた所は restore_at で秒単位に戻せます' };
    },

    /**
     * しゃべり出しの点マーカーの手前の無音だけを詰める。
     *
     * cut_outside_markers と違い、しゃべり出しさえ検出できていれば、
     * しゃべり終わりは無音区間から自動で決まる。検出漏れがあっても
     * 「その手前が詰まらないだけ」で済むので、ノイズの多い素材で安全に振れる。
     *
     * lead はしゃべり出しの手前に残す秒（子音は音量が小さく、音量の立ち上がりは
     * 実際のしゃべり出しより遅れるので、0 にすると語頭が欠ける）。
     * tail は発話の終わりに残す余韻秒。dryRun なら切らずに見積もりだけ返す。
     */
    async cut_before_markers({ lead = 0.4, tail = 0.6, kind = 'start', minGapSec = 0,
                                threshold = 0.06, minSec = 1.0, dryRun = false }) {
      const total = P.totalDuration(proj());
      const starts = proj().markers
        .filter((m) => (m.kind ?? 'note') === kind)
        .map((m) => m.time);
      if (!starts.length) throw new Error(`${kind} マーカーがありません`);

      const { silence } = await cmds.find_silence({ threshold, minSec });
      const keep = keepRangesFromStarts(starts, silence, total, Math.max(0, Number(lead) || 0),
        Math.max(0, Number(tail) || 0));
      const ranges = cutRangesFromKeep(keep, total, 0, Math.max(0, Number(minGapSec) || 0));
      const removedSec = ranges.reduce((a, [x, y]) => a + (y - x), 0);
      const plan = {
        cut: ranges.length,
        removedSec: +removedSec.toFixed(3),
        beforeSec: +total.toFixed(3),
        durationSec: +(total - removedSec).toFixed(3),
        startMarkers: starts.length,
      };
      if (dryRun) return { ...plan, dryRun: true, ranges: ranges.map(([x, y]) => [+x.toFixed(2), +y.toFixed(2)]) };
      if (!ranges.length) return { ...plan, note: '切る所がありませんでした' };

      const r = ctx.cutRanges(ranges, 'しゃべり出しの手前', 'before-markers');
      status(`MCP: しゃべり出しの手前 ${ranges.length} 箇所（${removedSec.toFixed(1)} 秒）を切り取りました`);
      return { ...plan, ...r, hint: '切りすぎた所は restore_at で秒単位に戻せます' };
    },

    /** カットで消した区間の在庫。どこで何秒戻せるかを見るためのもの */
    async list_trims() {
      return {
        trims: ctx.TR.seams(proj()).map((s) => ({
          id: s.id,
          atSec: s.atSec === null ? null : +s.atSec.toFixed(3),
          remainingSec: +s.remainingSec.toFixed(3),
          label: s.label,
          group: s.group,
          restorable: s.atSec !== null,
        })),
        note: 'atSec が null のものは前後のクリップを見失っていて戻せません',
      };
    },

    /**
     * 継ぎ目から seconds 秒だけ戻す。
     * side='head' は手前のクリップを伸ばす（語尾が切れた時）、
     * side='tail' は次のクリップの頭を戻す（話し始めが切れた時）。
     */
    async restore_at({ time, seconds = 0.5, side = 'head', tolerance = 0.5 }) {
      const r = ctx.restoreAt({
        time: time === undefined || time === null ? undefined : Number(time),
        seconds: Number(seconds) || 0,
        side: side === 'tail' ? 'tail' : 'head',
        tolerance: Number(tolerance) || 0.5,
      });
      ctx.status(`MCP: ${r.side === 'head' ? '前' : '後ろ'}を ${r.restoredSec.toFixed(1)} 秒戻しました`);
      return {
        atSec: +r.atSec.toFixed(3),
        restoredSec: +r.restoredSec.toFixed(3),
        requestedSec: r.requestedSec,
        remainingSec: +r.remainingSec.toFixed(3),
        side: r.side,
        durationSec: +P.totalDuration(proj()).toFixed(3),
      };
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

    /**
     * サムネの中身を軽く見る。kiriko_get_project は重いので、これはサムネだけ。
     * レイアウト（座標・大きさ・書式・重ね順）は返すだけで、MCP からは変えられない。
     */
    async get_thumbnail() {
      const p = proj();
      const th = p.thumbnail;
      return {
        output: { width: p.output.width, height: p.output.height },
        base: thumbBaseView(th.base, p),
        telops: th.telops.map((t) => ({ id: t.id, z: t.z ?? 0, rows: t.rows.map((r) => r.text) })),
        images: th.images.map((im) => ({
          id: im.id, z: im.z ?? 0, assetId: im.assetId,
          name: p.imageAssets.find((a) => a.id === im.assetId)?.name ?? null,
          box: { x: +im.box.x.toFixed(1), y: +im.box.y.toFixed(1), w: +im.box.w.toFixed(1), h: +im.box.h.toFixed(1) },
        })),
      };
    },

    /**
     * 既にあるサムネのテロップの文字だけを差し替える。位置・大きさ・書式・重ね順は触らない
     * （行ごとに書式が違うので、行数を勝手に増減させると書式が決まらない。1件でもおかしければ何も書き換えない）
     */
    async set_thumbnail_text({ texts }) {
      if (!Array.isArray(texts)) throw new Error('texts は配列で渡してください');
      const th = proj().thumbnail;
      const plans = [];
      for (const t of texts) {
        if (t.id === undefined || t.id === null) throw new Error('id が要ります');
        const tel = th.telops.find((x) => x.id === t.id);
        if (!tel) throw new Error(`テロップ ${t.id} が見つかりません`);
        if ((t.text === undefined) === (t.rows === undefined)) {
          throw new Error(`テロップ ${t.id} は text か rows のどちらか一方が要ります`);
        }
        if (t.rows !== undefined && !Array.isArray(t.rows)) {
          throw new Error(`テロップ ${t.id} の rows は文字列の配列で渡してください`);
        }
        const rows = t.rows !== undefined ? t.rows.map(String) : String(t.text).split('\n');
        if (rows.length !== tel.rows.length) {
          throw new Error(`テロップ ${t.id} は ${tel.rows.length} 行です（${rows.length} 行が渡されました）`);
        }
        plans.push({ tel, rows });
      }

      commit('MCP: サムネの文字を差し替え');
      for (const { tel, rows } of plans) {
        rows.forEach((text, i) => { tel.rows[i].text = text; });
      }
      ctx.renderAll();
      status('MCP からサムネの文字を受け取りました');
      return {
        updated: plans.length,
        telops: plans.map(({ tel }) => ({ id: tel.id, rows: tel.rows.map((r) => r.text) })),
      };
    },

    /** サムネの元画像を決める（何を写すかだけ。位置や大きさは Kiriko 側でドラッグして決める） */
    async set_thumbnail_base({ time, assetName, clear }) {
      const given = [time !== undefined, assetName !== undefined, clear !== undefined].filter(Boolean).length;
      if (given !== 1) throw new Error('time / assetName / clear のうち、どれか 1 つだけ渡してください');

      let base;
      let label;
      if (clear !== undefined) {
        if (!clear) throw new Error('clear は true で渡してください');
        base = null;
        label = '元画像を外しました';
      } else if (time !== undefined) {
        const t = Number(time) || 0;
        const total = P.totalDuration(proj());
        if (t < 0 || t > total) throw new Error(`time はタイムラインの範囲内（0〜${total.toFixed(3)}）で渡してください`);
        base = { kind: 'frame', time: t };
        label = `${ctx.tc(t, false)} の場面を元画像にしました`;
      } else {
        const want = String(assetName).normalize('NFC');
        const asset = proj().imageAssets.find((a) => (a.name ?? '').normalize('NFC') === want);
        if (!asset) {
          const names = proj().imageAssets.map((a) => a.name).join('、');
          throw new Error(`画像素材 ${assetName} が見つかりません（持っている素材: ${names || 'なし'}）`);
        }
        base = { kind: 'asset', assetId: asset.id };
        label = `${asset.name} を元画像にしました`;
      }

      ctx.setThumbBase(base, label);
      return thumbBaseView(base, proj());
    },
  };

  return cmds;
}

export const BINS = BINS_PER_SEC;
