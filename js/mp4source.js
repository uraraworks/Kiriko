// mp4source.js
// ローカルの mp4/HEVC ファイルを「メモリに載せずに」扱うためのラッパー。
//
//  - moov だけを mp4box.js に食わせてサンプルテーブル（各フレームのファイル内オフセット）を得る
//  - 実データは File.slice() で必要な区間だけ都度読む
//
// 14GB の素材でも、常駐するのはサンプルテーブル + 数MBのリードバッファだけになる。

const MP4Box = globalThis.MP4Box;
const DataStream = globalThis.DataStream; // mp4box.all.js はグローバルに別出しする

/** File.slice() を数MB単位でまとめ読みして使い回す簡易リーダー */
class BlockReader {
  constructor(file, blockSize = 8 << 20) {
    this.file = file;
    this.blockSize = blockSize;
    this.buf = null;
    this.start = 0;
  }
  async bytes(offset, size) {
    const has = this.buf && offset >= this.start && offset + size <= this.start + this.buf.byteLength;
    if (!has) {
      const start = offset;
      const end = Math.min(this.file.size, offset + Math.max(size, this.blockSize));
      this.buf = new Uint8Array(await this.file.slice(start, end).arrayBuffer());
      this.start = start;
    }
    const p = offset - this.start;
    return this.buf.subarray(p, p + size);
  }
  release() {
    this.buf = null;
  }
}

/** stsd から avcC / hvcC を取り出して VideoDecoder の description 用バイト列にする */
function extractVideoDescription(trak) {
  const entries = trak.mdia?.minf?.stbl?.stsd?.entries ?? [];
  for (const entry of entries) {
    const box = entry.avcC || entry.hvcC || entry.vpcC || entry.av1C;
    if (!box) continue;
    const stream = new DataStream(undefined, 0, DataStream.BIG_ENDIAN);
    box.write(stream);
    // 先頭 8 バイトはボックスヘッダ（size + type）なので落とす
    return new Uint8Array(stream.buffer, 8);
  }
  return undefined;
}

/** AAC の AudioSpecificConfig（esds の DecoderSpecificInfo）を取り出す */
function extractAudioDescription(trak) {
  const entries = trak.mdia?.minf?.stbl?.stsd?.entries ?? [];
  for (const entry of entries) {
    const esds = entry.esds;
    if (!esds?.esd) continue;
    // ES_Descriptor -> DecoderConfigDescriptor(tag 4) -> DecoderSpecificInfo(tag 5)
    const find = (descs, tag) => (descs || []).find((d) => d.tag === tag);
    const dcd = find(esds.esd.descs, 4);
    const dsi = dcd && find(dcd.descs, 5);
    if (dsi?.data) return new Uint8Array(dsi.data);
  }
  return undefined;
}

export class Mp4Source {
  constructor(file, name) {
    this.file = file;
    this.name = name ?? file.name;
    this.video = null; // { id, codec, width, height, description, samples, duration }
    this.audio = null; // { id, codec, sampleRate, channels, description, samples, duration }
    this._videoReader = new BlockReader(file);
    this._audioReader = new BlockReader(file, 2 << 20);
    this._objectUrl = null;
  }

  /** <video> プレビュー用の URL（ディスク参照。コピーは発生しない） */
  get previewUrl() {
    if (!this._objectUrl) this._objectUrl = URL.createObjectURL(this.file);
    return this._objectUrl;
  }

  dispose() {
    if (this._objectUrl) URL.revokeObjectURL(this._objectUrl);
    this._objectUrl = null;
    this._videoReader.release();
    this._audioReader.release();
  }

  /**
   * moov を探して解析する。
   * appendBuffer() が返す nextParsePosition を辿るので、mdat（14GB）は読み飛ばされ、
   * moov がファイル末尾にある Pixel 録画でも数回のリードで到達する。
   */
  async load(onProgress = () => {}) {
    const mp4 = MP4Box.createFile();
    let info = null;
    let error = null;
    mp4.onReady = (i) => { info = i; };
    mp4.onError = (e) => { error = e; };

    const CHUNK = 4 << 20;
    let pos = 0;
    let reads = 0;
    while (info === null && pos < this.file.size) {
      const end = Math.min(this.file.size, pos + CHUNK);
      const buf = await this.file.slice(pos, end).arrayBuffer();
      buf.fileStart = pos;
      const next = mp4.appendBuffer(buf);
      reads++;
      onProgress(`moov 探索中… ${(pos / 1e6).toFixed(0)}MB 地点 (${reads} 回目のリード)`);
      if (error) throw new Error(`mp4 解析エラー: ${error}`);
      if (info) break;
      // next が進まない場合は連続読みにフォールバック
      pos = next > pos ? next : end;
    }
    mp4.flush();
    if (!info) throw new Error('moov が見つかりませんでした（mp4 ではない可能性があります）');

    for (const t of info.tracks) {
      const trak = mp4.getTrackById(t.id);
      const samples = mp4.getTrackSamplesInfo(t.id);
      if (!samples || samples.length === 0) continue; // Pixel のメタデータトラックはここで落ちる

      if (t.video && !this.video) {
        this.video = {
          id: t.id,
          codec: t.codec,
          width: t.video.width,
          height: t.video.height,
          description: extractVideoDescription(trak),
          samples: samples.map(toSample),
          duration: t.duration / t.timescale,
        };
      } else if (t.audio && !this.audio) {
        this.audio = {
          id: t.id,
          codec: t.codec,
          sampleRate: t.audio.sample_rate,
          channels: t.audio.channel_count,
          description: extractAudioDescription(trak),
          samples: samples.map(toSample),
          duration: t.duration / t.timescale,
        };
      }
    }
    if (!this.video) throw new Error('映像トラックが見つかりませんでした');

    this.duration = info.duration / info.timescale;
    // 参照を切ってサンプルテーブル以外を解放する
    mp4.stream?.buffers?.splice(0);
    return this;
  }

  /** 指定サンプルの実データをディスクから読む */
  async readSample(sample, kind) {
    const reader = kind === 'audio' ? this._audioReader : this._videoReader;
    return reader.bytes(sample.offset, sample.size);
  }

  /** t 秒以下で最も後ろのキーフレーム（同期サンプル）の index */
  static syncIndexBefore(samples, t) {
    let lo = 0, hi = samples.length - 1, idx = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (samples[mid].time <= t) { idx = mid; lo = mid + 1; } else { hi = mid - 1; }
    }
    for (let i = idx; i >= 0; i--) if (samples[i].sync) return i;
    return 0;
  }

  /** t 秒以下で最も後ろのサンプル index */
  static indexBefore(samples, t) {
    let lo = 0, hi = samples.length - 1, idx = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (samples[mid].time <= t) { idx = mid; lo = mid + 1; } else { hi = mid - 1; }
    }
    return idx;
  }
}

function toSample(s) {
  return {
    offset: s.offset,
    size: s.size,
    time: s.cts / s.timescale,          // 秒
    dts: s.dts / s.timescale,
    duration: s.duration / s.timescale,
    sync: !!s.is_sync,
  };
}
