// sparse-audio.mjs — MP4/MOV「只讀音軌」解析器原型
// 讀檔案的 sample table（moov 目錄），算出每個聲音封包的確切位置，跳過影片資料只讀聲音。
// 白名單策略：結構看不懂一律 throw（呼叫端退回全讀慢刀）。寧可慢，不可錯。
//
// 支援：非 fragmented 的 MP4/MOV、單一 AAC(mp4a) 音軌、stco/co64、uniform/table stsz、
//       elst 0/1 筆（AAC priming 轉成時間平移，跟 mediabunny 的負 timestamp 表示法對齊）、
//       AC-3/E-AC-3 音軌（封包＋stsd 原樣拷貝，kind='passthrough'，瀏覽器解不了＝呼叫端要再轉碼）。
// 拒絕：moof（fragmented）、名單外音軌編碼、多音軌、多 stsd entry、看不懂的 elst。

// ── 低階讀取 ──────────────────────────────────────────────
function u32(dv, p) { return dv.getUint32(p); }
function u64(dv, p) { return Number(dv.getBigUint64(p)); }

// box 迭代器：在一段 buffer 裡走 top-level boxes，回 [type, bodyStart, bodyEnd, headerSize]
function* boxes(dv, start, end) {
  let p = start;
  while (p + 8 <= end) {
    let size = u32(dv, p);
    const type = String.fromCharCode(dv.getUint8(p + 4), dv.getUint8(p + 5), dv.getUint8(p + 6), dv.getUint8(p + 7));
    let hdr = 8;
    if (size === 1) { size = u64(dv, p + 8); hdr = 16; }
    else if (size === 0) size = end - p;
    if (size < hdr || p + size > end) throw new Error(`壞的 box 尺寸: ${type} @${p}`);
    yield [type, p + hdr, p + size];
    p += size;
  }
}

function findBox(dv, start, end, type) {
  for (const [t, a, b] of boxes(dv, start, end)) if (t === type) return [a, b];
  return null;
}
function findPath(dv, start, end, path) {
  let range = [start, end];
  for (const t of path) {
    const r = findBox(dv, range[0], range[1], t);
    if (!r) return null;
    range = r;
  }
  return range;
}

// ── 主解析 ──────────────────────────────────────────────
// read(start, end) => Uint8Array（呼叫端提供，檔案或 Blob 都行）
// fileSize => number
export async function parseAudioTrack(read, fileSize) {
  // 1) 掃 top-level：找 moov（可能在頭或尾），順便驗沒有 moof
  let moovBuf = null;
  {
    let pos = 0;
    while (pos + 16 <= fileSize) {
      const hdr = await read(pos, Math.min(pos + 16, fileSize));
      const dv = new DataView(hdr.buffer, hdr.byteOffset, hdr.byteLength);
      let size = u32(dv, 0);
      const type = String.fromCharCode(hdr[4], hdr[5], hdr[6], hdr[7]);
      let hdrSize = 8;
      if (size === 1) { size = u64(dv, 8); hdrSize = 16; }
      else if (size === 0) size = fileSize - pos;
      if (size < hdrSize || pos + size > fileSize) throw new Error(`壞的 top-level box: ${type}`);
      if (type === 'moof' || type === 'mvex') throw new Error('fragmented MP4 不支援（退慢刀）');
      if (type === 'moov') {
        const body = await read(pos, pos + size);
        moovBuf = { bytes: body, base: 0 };
      }
      pos += size;
    }
  }
  if (!moovBuf) throw new Error('找不到 moov');
  const mv = new DataView(moovBuf.bytes.buffer, moovBuf.bytes.byteOffset, moovBuf.bytes.byteLength);
  const [moovA, moovB] = findBox(mv, 0, moovBuf.bytes.byteLength, 'moov');

  // 檢查 moov 裡也沒有 mvex（fragmented 標記）
  if (findBox(mv, moovA, moovB, 'mvex')) throw new Error('fragmented MP4 不支援（退慢刀）');

  // 2) 找音軌（hdlr == 'soun'）；多條音軌 → 拒絕（保守）
  const audioTraks = [];
  for (const [t, a, b] of boxes(mv, moovA, moovB)) {
    if (t !== 'trak') continue;
    const mdia = findPath(mv, a, b, ['mdia']);
    if (!mdia) continue;
    const hdlr = findBox(mv, mdia[0], mdia[1], 'hdlr');
    if (!hdlr) continue;
    const ht = String.fromCharCode(mv.getUint8(hdlr[0] + 8), mv.getUint8(hdlr[0] + 9), mv.getUint8(hdlr[0] + 10), mv.getUint8(hdlr[0] + 11));
    if (ht === 'soun') audioTraks.push([a, b, mdia]);
  }
  if (audioTraks.length === 0) throw new Error('沒有音軌');
  if (audioTraks.length > 1) throw new Error('多音軌不支援（退慢刀）');
  const [trakA, trakB, mdia] = audioTraks[0];

  // 3) media timescale
  const mdhd = findBox(mv, mdia[0], mdia[1], 'mdhd');
  if (!mdhd) throw new Error('沒有 mdhd');
  const mdhdVer = mv.getUint8(mdhd[0]);
  const timescale = mdhdVer === 1 ? u32(mv, mdhd[0] + 20) : u32(mv, mdhd[0] + 12);

  // 4) stbl
  const stbl = findPath(mv, mdia[0], mdia[1], ['minf', 'stbl']);
  if (!stbl) throw new Error('沒有 stbl');

  // 4a) stsd：單一 entry，mp4a（AAC）或未壓縮 PCM 家族（ProRes 母帶等）
  const stsd = findBox(mv, stbl[0], stbl[1], 'stsd');
  if (!stsd) throw new Error('沒有 stsd');
  const entryCount = u32(mv, stsd[0] + 4);
  if (entryCount !== 1) throw new Error(`stsd entries=${entryCount} 不支援（退慢刀）`);
  const entryStart = stsd[0] + 8;
  const entryType = String.fromCharCode(mv.getUint8(entryStart + 4), mv.getUint8(entryStart + 5), mv.getUint8(entryStart + 6), mv.getUint8(entryStart + 7));
  // PCM 家族（QuickTime 慣用 tag）：位元數/端序/整數浮點各有預設，enda box 可翻端序
  const PCM_TYPES = {
    sowt: { bits: 16, be: false, float: false },
    twos: { bits: 16, be: true, float: false },
    in24: { bits: 24, be: true, float: false },
    in32: { bits: 32, be: true, float: false },
    fl32: { bits: 32, be: true, float: true },
    fl64: { bits: 64, be: true, float: true },
  };
  // 瀏覽器解不了、但結構是標準 AudioSampleEntry 的編碼：封包＋stsd 原樣拷貝出小檔，
  // 由呼叫端拿去轉碼（AC-3 只有 ffmpeg 解得動——先把音軌從整支影片抽瘦再餵它）
  const PASSTHROUGH_TYPES = { 'ac-3': 1, 'ec-3': 1 };
  if (entryType !== 'mp4a' && entryType !== 'lpcm' && !PCM_TYPES[entryType] && !PASSTHROUGH_TYPES[entryType]) {
    throw new Error(`音軌編碼 ${entryType} 不支援（退慢刀）`);
  }
  // sample entry：8 header + 8 reserved + 2 version + 2 revision + 4 vendor + 2 ch + 2 bits + 2 compId + 2 pkt + 4 rate
  const entBody = entryStart + 8;
  const qtVersion = mv.getUint16(entBody + 8);
  let channels = mv.getUint16(entBody + 16);
  let sampleRate = u32(mv, entBody + 24) >>> 16;
  // QuickTime version 1/2 多帶欄位，extensions（esds/wave/enda）位置後移
  let extStart = entBody + 28;
  if (qtVersion === 1) extStart += 16;
  else if (qtVersion === 2) extStart += 36;
  else if (qtVersion !== 0) throw new Error(`sample entry version=${qtVersion} 不支援（退慢刀）`);
  const entryEnd = entryStart + u32(mv, entryStart);

  let asc = null;        // AAC：AudioSpecificConfig
  let pcmFormat = null;  // PCM：{ bits, be, float }
  const passthrough = !!PASSTHROUGH_TYPES[entryType];
  if (passthrough) {
    // 不解內容（dac3/dec3 隨 entry 整塊帶走），channels/sampleRate 用標準欄位值驗合理性即可
  } else if (entryType === 'mp4a') {
    // esds 直掛（MP4 慣例）或包在 wave 裡（QuickTime/MOV 慣例：mp4a → wave → esds）
    let esds = findBox(mv, extStart, entryEnd, 'esds');
    if (!esds) {
      const wave = findBox(mv, extStart, entryEnd, 'wave');
      if (wave) esds = findBox(mv, wave[0], wave[1], 'esds');
    }
    if (!esds) throw new Error('mp4a 沒有 esds（退慢刀）');
    asc = parseEsds(moovBuf.bytes, esds[0] + 4, esds[1]);
    if (!asc) throw new Error('esds 裡找不到 AAC 設定（退慢刀）');
  } else if (entryType === 'lpcm') {
    // lpcm 一定是 v2：真正的規格在 v2 擴充欄位（CoreAudio 風格）
    if (qtVersion !== 2) throw new Error('lpcm 非 v2 不支援（退慢刀）');
    // v2 擴充在 version(2) revision(2) vendor(4) 之後（entBody+16 起）：
    //   always3(2) always16(2) alwaysMinus2(2) always0(2) always65536(4)
    //   sizeOfStructOnly(4) sampleRate(f64) channels(4) always7F(4) bitsPerChannel(4) flags(4) bytesPerPacket(4) framesPerPacket(4)
    const v2 = entBody + 16;
    // 規格錨點驗版面：always65536 不在位＝結構不是想的那樣，明著退，別往下讀出垃圾值
    if (u32(mv, v2 + 8) !== 65536) throw new Error('lpcm v2 版面異常（退慢刀）');
    sampleRate = Math.round(mv.getFloat64(v2 + 16));
    channels = u32(mv, v2 + 24);
    const bits = u32(mv, v2 + 32);
    const flags = u32(mv, v2 + 36);   // kAudioFormatFlag: 1=float, 2=bigEndian, 4=signedInt, 8=packed
    if (!(flags & 8)) throw new Error('lpcm 非 packed 不支援（退慢刀）');
    if (!(flags & 1) && !(flags & 4)) throw new Error('lpcm unsigned 整數不支援（退慢刀）');
    pcmFormat = { bits, be: !!(flags & 2), float: !!(flags & 1) };
  } else {
    pcmFormat = { ...PCM_TYPES[entryType] };
    // enda（端序覆寫）：直掛或包在 wave 裡
    let enda = findBox(mv, extStart, entryEnd, 'enda');
    if (!enda) {
      const wave = findBox(mv, extStart, entryEnd, 'wave');
      if (wave) enda = findBox(mv, wave[0], wave[1], 'enda');
    }
    if (enda) pcmFormat.be = mv.getUint16(enda[0]) !== 1;
  }
  if (pcmFormat && ![16, 24, 32, 64].includes(pcmFormat.bits)) throw new Error(`PCM ${pcmFormat.bits}bit 不支援（退慢刀）`);
  if (!channels || channels > 8 || !sampleRate) throw new Error('聲道/取樣率異常（退慢刀）');

  // 4b) elst：0 筆 OK；1 筆＝AAC priming（media_time>0）→ 時間平移；其他不支援
  let tsShift = 0;
  let priming = 0;   // media timescale 單位的 priming（elst media_time），muxer 原樣帶到輸出
  const edts = findBox(mv, trakA, trakB, 'edts');
  if (edts) {
    const elst = findBox(mv, edts[0], edts[1], 'elst');
    if (elst) {
      const ver = mv.getUint8(elst[0]);
      const n = u32(mv, elst[0] + 4);
      if (n > 1) throw new Error(`elst entries=${n} 不支援（退慢刀）`);
      if (n === 1) {
        const mediaTime = ver === 1 ? Number(mv.getBigInt64(elst[0] + 16)) : mv.getInt32(elst[0] + 12);
        if (mediaTime < 0) throw new Error('elst empty edit 不支援（退慢刀）');
        priming = mediaTime;
        tsShift = -mediaTime / timescale;   // priming：跟 mediabunny 一樣用負 timestamp 表示
      }
    }
  }

  // 4c) stts / stsz / stsc / stco|co64 → 展開每個 sample 的 [offset, size, timestamp, duration]
  const stts = findBox(mv, stbl[0], stbl[1], 'stts');
  const stsz = findBox(mv, stbl[0], stbl[1], 'stsz');
  const stsc = findBox(mv, stbl[0], stbl[1], 'stsc');
  const stco = findBox(mv, stbl[0], stbl[1], 'stco');
  const co64 = findBox(mv, stbl[0], stbl[1], 'co64');
  if (!stts || !stsz || !stsc || (!stco && !co64)) throw new Error('sample table 不完整');

  // sizes
  const uniformSize = u32(mv, stsz[0] + 4);
  const sampleCount = u32(mv, stsz[0] + 8);
  const sizeOf = (i) => uniformSize || u32(mv, stsz[0] + 12 + i * 4);

  // durations（stts run-length）
  const sttsN = u32(mv, stts[0] + 4);
  const durs = [];   // [count, delta] runs
  for (let i = 0; i < sttsN; i++) durs.push([u32(mv, stts[0] + 8 + i * 8), u32(mv, stts[0] + 12 + i * 8)]);

  // chunk offsets
  const chunkCount = u32(mv, (co64 ? co64 : stco)[0] + 4);
  const chunkOff = (i) => co64 ? u64(mv, co64[0] + 8 + i * 8) : u32(mv, stco[0] + 8 + i * 4);

  // stsc runs: [firstChunk, samplesPerChunk, descIdx]
  const stscN = u32(mv, stsc[0] + 4);
  const runs = [];
  for (let i = 0; i < stscN; i++) runs.push([u32(mv, stsc[0] + 8 + i * 12), u32(mv, stsc[0] + 12 + i * 12)]);

  // ── PCM 分支：chunk 級展開（PCM 的 sample＝一個聲音幀，數量以億計，逐個展開會爆）──
  if (pcmFormat) {
    const bytesPerFrame = (pcmFormat.bits / 8) * channels;
    // 白名單：stts 必須單一 run 且 delta=1（timescale=取樣率、每 sample 一幀）、
    // stsz uniform 且 = bytesPerFrame——QuickTime 未壓縮音軌的標準形；其他變形退慢刀
    if (durs.length !== 1 || durs[0][1] !== 1) throw new Error('PCM stts 非每幀一格（退慢刀）');
    if (timescale !== sampleRate) throw new Error('PCM timescale ≠ 取樣率（退慢刀）');
    if (!uniformSize || uniformSize !== bytesPerFrame) throw new Error(`PCM stsz=${uniformSize} ≠ 幀大小 ${bytesPerFrame}（退慢刀）`);
    if (priming !== 0) throw new Error('PCM 帶 elst 不支援（退慢刀）');
    const chunks = [];   // {offset, size, frames}
    let fi = 0;
    for (let ci = 0; ci < chunkCount && fi < sampleCount; ci++) {
      let spc = runs[0][1];
      for (const [first, n] of runs) { if (ci + 1 >= first) spc = n; else break; }
      const frames = Math.min(spc, sampleCount - fi);
      chunks.push({ offset: chunkOff(ci), size: frames * bytesPerFrame, frames });
      fi += frames;
    }
    if (fi !== sampleCount) throw new Error(`PCM 展開 ${fi} 幀、表上 ${sampleCount} 幀——不符（退慢刀）`);
    return {
      kind: 'pcm',
      format: { sampleRate, channels, ...pcmFormat },
      chunks,
      totalFrames: sampleCount,
      bytesPerFrame,
    };
  }

  // ── AAC 分支：逐封包展開 ──
  const packets = [];   // {offset, size, timestamp, duration}
  let si = 0;           // sample index
  let dRun = 0, dLeft = durs[0][0], dDelta = durs[0][1];
  let tAcc = 0;         // 累計時間（timescale 單位）
  for (let ci = 0; ci < chunkCount && si < sampleCount; ci++) {
    // 這個 chunk 幾個 samples（找對應 stsc run）
    let spc = runs[0][1];
    for (const [first, n] of runs) { if (ci + 1 >= first) spc = n; else break; }
    let off = chunkOff(ci);
    for (let k = 0; k < spc && si < sampleCount; k++, si++) {
      const size = sizeOf(si);
      if (dLeft === 0) { dRun++; if (dRun >= durs.length) throw new Error('stts 與 sample 數不符'); dLeft = durs[dRun][0]; dDelta = durs[dRun][1]; }
      packets.push({ offset: off, size, timestamp: tAcc / timescale + tsShift, duration: dDelta / timescale });
      tAcc += dDelta; dLeft--;
      off += size;
    }
  }
  if (si !== sampleCount) throw new Error(`展開 ${si} 個 sample、表上 ${sampleCount} 個——不符（退慢刀）`);

  if (passthrough) {
    return {
      kind: 'passthrough',
      codec: entryType,
      stsdEntryRaw: moovBuf.bytes.slice(entryStart, entryEnd),   // dac3/dec3 隨 entry 整塊帶走
      packets,
      timescale,
      priming,   // 編碼器 delay 的 elst 標記語意跟 AAC 相同，原樣帶到輸出
    };
  }
  return {
    kind: 'aac',
    codec: 'aac',
    decoderConfig: { codec: 'mp4a.40.2', sampleRate, numberOfChannels: channels, description: asc },
    packets,
    timescale,
    priming,
  };
}

// PCM bytes → interleaved Float32（AudioEncoder 的通用輸入格式；順便處理端序/位深/整數浮點）
export function pcmToF32(bytes, format) {
  const { bits, be, float } = format;
  const bpS = bits / 8;
  const n = Math.floor(bytes.length / bpS);
  const out = new Float32Array(n);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (float && bits === 32) for (let i = 0; i < n; i++) out[i] = dv.getFloat32(i * 4, !be);
  else if (float && bits === 64) for (let i = 0; i < n; i++) out[i] = dv.getFloat64(i * 8, !be);
  else if (bits === 16) for (let i = 0; i < n; i++) out[i] = dv.getInt16(i * 2, !be) / 32768;
  else if (bits === 32) for (let i = 0; i < n; i++) out[i] = dv.getInt32(i * 4, !be) / 2147483648;
  else if (bits === 24) {
    for (let i = 0; i < n; i++) {
      const p = i * 3;
      let v = be
        ? (bytes[p] << 16) | (bytes[p + 1] << 8) | bytes[p + 2]
        : (bytes[p + 2] << 16) | (bytes[p + 1] << 8) | bytes[p];
      if (v & 0x800000) v -= 0x1000000;
      out[i] = v / 8388608;
    }
  } else throw new Error(`PCM ${bits}bit 轉換不支援`);
  return out;
}

// ── 極簡 m4a muxer（AAC 專用）────────────────────────────
// 為什麼自己寫：現行工具的輸出端沒有 edit list 概念，AAC 開頭的 priming（暖機樣本）
// 沒標記＝時間軸整體 +21ms；重編碼路徑更疊到 +44ms。這裡原生寫 elst，偏移歸零。
// 佈局 ftyp → mdat → moov（moov 在尾＝流式寫友善：mdat 大小先驗已知，零 seek）。
// 全部 samples 收一個 chunk（stco 1 筆），stts 用 run-length。

const enc = new TextEncoder();
function beU32(n) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n); return b; }
function beU16(n) { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, n); return b; }
// catAll 收陣列：packet 級數量（長片數萬筆）不能經 ...spread 攤成引數——引數上限會爆呼叫堆疊
function catAll(parts) {
  const size = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(size);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
function cat(...parts) { return catAll(parts); }
function mkbox(type, ...parts) {
  const body = cat(...parts);
  return cat(beU32(8 + body.length), enc.encode(type), body);
}
function full(type, version, flags, ...parts) {
  return mkbox(type, new Uint8Array([version, (flags >> 16) & 255, (flags >> 8) & 255, flags & 255]), ...parts);
}
// esds descriptor：tag + 單byte長度（內容都 <128 bytes，AAC 設定夠用）
function desc(tag, body) {
  if (body.length > 127) throw new Error('esds descriptor 過長');
  return cat(new Uint8Array([tag, body.length]), body);
}

// 由 parseAudioTrack 的結果建 m4a 三段：header（ftyp+mdat box 頭）＋ moov（檔尾）。
// 呼叫端把 header、每個 packet 的 data（照 packets 順序）、moov 依序寫出即成完整檔案。
export function buildM4a(parsed) {
  const { packets, decoderConfig, timescale, priming } = parsed;
  const presDurOverride = parsed.presDur;   // PCM 轉檔用：截掉編碼器尾巴 padding 的精確時長
  const dataSize = packets.reduce((s, p) => s + p.size, 0);
  const ftyp = mkbox('ftyp', enc.encode('M4A '), beU32(0), enc.encode('M4A '), enc.encode('mp42'), enc.encode('isom'));
  const mdatHdr = cat(beU32(8 + dataSize), enc.encode('mdat'));
  const dataStart = ftyp.length + mdatHdr.length;

  // 時長（media timescale 單位）：stts 總和；presentation 時長再扣 priming
  const sttsRuns = [];   // [count, delta]
  for (const p of packets) {
    const delta = Math.round(p.duration * timescale);
    const last = sttsRuns.at(-1);
    if (last && last[1] === delta) last[0]++;
    else sttsRuns.push([1, delta]);
  }
  const mediaDur = sttsRuns.reduce((s, [c, d]) => s + c * d, 0);
  const presDur = Math.max(0, Math.min(mediaDur - priming, presDurOverride ?? Infinity));

  let stsd;
  if (parsed.stsdEntryRaw) {
    // passthrough（AC-3 等）：來源 sample entry 原樣搬，內含的 dac3/dec3 一起帶走
    stsd = full('stsd', 0, 0, beU32(1), parsed.stsdEntryRaw);
  } else {
    const { sampleRate, numberOfChannels, description } = decoderConfig;
    // 收口在 muxer：不管 description 從哪來（來源檔 esds 解出的 ASC、或 WebCodecs 編碼器給的
    // 各家方言），進 esds 之前一律正規化成 ASC
    const asc = ascFromDescription(description);

    const esds = full('esds', 0, 0,
      desc(0x03, cat(beU16(1), new Uint8Array([0]),                          // ES_ID=1
        desc(0x04, cat(new Uint8Array([0x40, 0x15]), new Uint8Array(3),      // AAC, AudioStream
          beU32(0), beU32(0),                                                 // maxBitrate/avgBitrate（0＝未知）
          desc(0x05, asc))),
        desc(0x06, new Uint8Array([0x02])))));
    const mp4a = mkbox('mp4a',
      new Uint8Array(6), beU16(1),                     // reserved + data_reference_index
      new Uint8Array(8),                                // version/revision/vendor
      beU16(numberOfChannels), beU16(16), beU32(0),     // channels/bits/compression+packet
      beU32(sampleRate << 16),
      esds);
    stsd = full('stsd', 0, 0, beU32(1), mp4a);
  }
  const stts = full('stts', 0, 0, beU32(sttsRuns.length), catAll(sttsRuns.map(([c, d]) => cat(beU32(c), beU32(d)))));
  const stsc = full('stsc', 0, 0, beU32(1), beU32(1), beU32(packets.length), beU32(1));
  const stsz = full('stsz', 0, 0, beU32(0), beU32(packets.length), catAll(packets.map((p) => beU32(p.size))));
  const stco = full('stco', 0, 0, beU32(1), beU32(dataStart));
  const stbl = mkbox('stbl', stsd, stts, stsc, stsz, stco);

  const dinf = mkbox('dinf', full('dref', 0, 0, beU32(1), full('url ', 0, 1)));
  const smhd = full('smhd', 0, 0, beU32(0));
  const minf = mkbox('minf', smhd, dinf, stbl);
  const hdlr = full('hdlr', 0, 0, beU32(0), enc.encode('soun'), new Uint8Array(12), enc.encode('SoundHandler\0'));
  const mdhd = full('mdhd', 0, 0, beU32(0), beU32(0), beU32(timescale), beU32(mediaDur), beU16(0x55C4), beU16(0));
  const mdia = mkbox('mdia', mdhd, hdlr, minf);

  // elst：presentation 從 priming 之後開始（media_time=priming）——時間軸歸零的關鍵
  const edts = priming > 0 ? mkbox('edts', full('elst', 0, 0, beU32(1), beU32(presDur), beU32(priming), beU32(0x00010000))) : new Uint8Array(0);
  const matrix = cat(beU32(0x10000), beU32(0), beU32(0), beU32(0), beU32(0x10000), beU32(0), beU32(0), beU32(0), beU32(0x40000000));
  const tkhd = full('tkhd', 0, 3, beU32(0), beU32(0), beU32(1), beU32(0), beU32(presDur),
    new Uint8Array(8), beU16(0), beU16(0), beU16(0x0100), beU16(0), matrix, beU32(0), beU32(0));
  const trak = priming > 0 ? mkbox('trak', tkhd, edts, mdia) : mkbox('trak', tkhd, mdia);

  const mvhd = full('mvhd', 0, 0, beU32(0), beU32(0), beU32(timescale), beU32(presDur),
    beU32(0x10000), beU16(0x0100), beU16(0), new Uint8Array(8), matrix, new Uint8Array(24), beU32(2));
  const moov = mkbox('moov', mvhd, trak);

  return { header: cat(ftyp, mdatHdr), moov, dataSize };
}

// WebCodecs 的 decoderConfig.description → AudioSpecificConfig。
// ⚠ 這個欄位各家給的東西不一樣（2026-08-18 實測 Chrome 141 / WebKit 26.4）：
//   Chrome  給 2 bytes 的純 ASC（`11 90`）＝規格書寫的東西
//   WebKit  給 39 bytes 的**整個 ES_Descriptor**（`03 80 80 80 22 …` 內含 tag 0x05 才是 ASC）
// 兩者都以 Uint8Array 出現、長度不同而已，照單全收就會把 ES_Descriptor 當 ASC 再包一層
// esds＝巢狀錯亂，產出的 m4a 沒有解碼器讀得懂（Safari decodeAudioData「Decoding failed」、
// 後端 ffmpeg 也失敗）；同一份東西餵回 WebKit 自己的 AudioDecoder 一樣炸。
// 認法：ASC 第一個 byte 的高 5 bits 是 audioObjectType，不可能是 0（0x03 開頭＝ES_Descriptor tag）。
// 挖不出來就 throw——寧可退慢刀，不可靜默產出壞檔。
export function ascFromDescription(description) {
  if (!description) throw new Error('編碼器沒給 AAC 設定');
  const u8 = description instanceof Uint8Array
    ? description
    : new Uint8Array(description instanceof ArrayBuffer ? description : description.buffer.slice(description.byteOffset, description.byteOffset + description.byteLength));
  const asc = u8[0] === 0x03 ? parseEsds(u8, 0, u8.length) : u8;
  if (!asc || asc.length < 2 || asc.length > 64) throw new Error(`AAC 設定長度異常 ${asc ? asc.length : 0}（退慢刀）`);
  if ((asc[0] >> 3) === 0) throw new Error('AAC 設定不是 AudioSpecificConfig（退慢刀）');
  return asc;
}

// esds → AudioSpecificConfig（DecoderSpecificInfo, tag 0x05）
function parseEsds(bytes, start, end) {
  let p = start;
  function readTagLen() {
    const tag = bytes[p++];
    let len = 0, b;
    do { b = bytes[p++]; len = (len << 7) | (b & 0x7f); } while (b & 0x80);
    return [tag, len];
  }
  const [tag] = readTagLen();               // ES_Descriptor 0x03
  if (tag !== 0x03) return null;
  p += 3;                                    // ES_ID + flags（假設無選配欄位）
  const [t2, l2] = readTagLen();             // DecoderConfigDescriptor 0x04
  if (t2 !== 0x04) return null;
  const oti = bytes[p];
  if (oti !== 0x40) return null;             // 不是 AAC
  p += 13;
  const [t3, l3] = readTagLen();             // DecoderSpecificInfo 0x05
  if (t3 !== 0x05) return null;
  return bytes.slice(p, p + l3);
}

// 聚讀：samples 依檔案位置排序，間隙 < mergeGap 就併成同一次讀。
// maxRegion 給單次讀取封頂（密 interleave 檔全併起來可能等於整支影片——一次讀進記憶體會爆）。
export function planReads(packets, mergeGap = 128 * 1024, maxRegion = 32 * 1024 * 1024) {
  const sorted = packets.map((p, i) => ({ ...p, i })).sort((a, b) => a.offset - b.offset);
  const regions = [];
  for (const s of sorted) {
    const last = regions.at(-1);
    if (last && s.offset - last.end <= mergeGap && s.offset + s.size - last.start <= maxRegion) {
      last.end = Math.max(last.end, s.offset + s.size);
      last.items.push(s);
    } else regions.push({ start: s.offset, end: s.offset + s.size, items: [s] });
  }
  return regions;
}
