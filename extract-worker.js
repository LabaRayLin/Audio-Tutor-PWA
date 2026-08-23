/**
 * Audio Tutor PWA - 音訊快速擷取 Web Worker (extract-worker.js)
 * 流程：
 * 1. 優先嘗試 sparse-audio (快刀：直接讀取音軌並封裝為 m4a / WebCodecs PCM 轉 AAC)
 * 2. 若失敗則自動退回 mediabunny (慢刀：完整解碼/轉碼相容處理)
 */

let _mb = null;
async function loadMb() {
  if (!_mb) _mb = await import('/vendor/mediabunny.min.mjs');
  return _mb;
}

let _sp = null;
async function loadSparse() {
  if (!_sp) _sp = await import('/sparse-audio.mjs');
  return _sp;
}

let ioStat = null;
const OPFS_FILENAME = 'audio-tutor-extract.m4a';

self.onmessage = async (ev) => {
  const d = ev.data || {};
  if (d.type !== 'extract' || !d.file) return;

  let sparseErr = null;
  try {
    let useOpfs = true;
    try {
      await navigator.storage.getDirectory();
    } catch {
      useOpfs = false;
    }
    const ua = (self.navigator && self.navigator.userAgent) || '';
    if (/^((?!chrome|crios|android).)*safari/i.test(ua)) useOpfs = false;
    ioStat = null;

    // 1. 優先嘗試 sparse-audio (快刀)
    try {
      const result = await sparseOnce(d.file, useOpfs);
      if (ioStat) self.postMessage({ type: 'note', msg: 'io', data: ioStat });
      if (result.mode === 'opfs') {
        self.postMessage({
          type: 'done',
          mode: 'opfs',
          name: result.name,
          transcode: result.transcode || false,
          via: 'sparse',
        });
      } else {
        self.postMessage(
          {
            type: 'done',
            mode: 'buffer',
            buffer: result.buffer,
            transcode: result.transcode || false,
            via: 'sparse',
          },
          [result.buffer]
        );
      }
      return;
    } catch (e) {
      sparseErr = (e && e.message) || String(e);
      console.warn('[extract-worker] sparse-audio 處理失敗，切換至 mediabunny：', sparseErr);
    }

    if (ioStat) self.postMessage({ type: 'note', msg: 'io', data: ioStat });
    self.postMessage({ type: 'phase', via: 'mediabunny', why: sparseErr });

    // 2. 降級至 mediabunny (慢刀)
    const mb = await loadMb();
    let result = null;
    for (let attempt = 0; ; attempt++) {
      try {
        result = await once(mb, d.file, useOpfs);
        break;
      } catch (e) {
        const msg = String((e && e.message) || e);
        if (
          useOpfs &&
          attempt === 0 &&
          /quota|storage|NoModificationAllowed|InvalidState|OPFS|FileSystem/i.test(msg)
        ) {
          useOpfs = false;
          continue;
        }
        throw e;
      }
    }

    if (result.mode === 'opfs') {
      self.postMessage({ type: 'done', mode: 'opfs', name: result.name, via: 'mediabunny' });
    } else {
      self.postMessage({ type: 'done', mode: 'buffer', buffer: result.buffer, via: 'mediabunny' }, [result.buffer]);
    }
  } catch (e) {
    const msg = String((e && e.message) || e);
    self.postMessage({
      type: 'error',
      message: sparseErr ? `${msg}（sparse-audio: ${sparseErr}）` : msg,
    });
  }
};

/**
 * 快刀抽取流程：分析音訊軌道並重組或轉換
 */
async function sparseOnce(file, useOpfs) {
  const sp = await loadSparse();
  const { parseAudioTrack, planReads, buildM4a } = sp;
  let lat = null,
    thr = null;

  const read = async (a, b) => {
    const t0 = performance.now();
    const buf = new Uint8Array(await file.slice(a, b).arrayBuffer());
    const dt = Math.max(0.0001, (performance.now() - t0) / 1000);
    if (b - a <= 64) {
      if (lat === null) lat = dt;
    } else if (b - a >= 1e6) {
      thr = (b - a) / dt;
    }
    ioStat = {
      latMs: lat === null ? null : +(lat * 1000).toFixed(1),
      thrMBs: thr === null ? null : Math.round(thr / 1e6),
    };
    return buf;
  };

  const parsed = await parseAudioTrack(read, file.size);
  if (parsed.kind === 'pcm') return sparsePcm(sp, parsed, read, useOpfs);

  for (let i = 1; i < parsed.packets.length; i++) {
    if (parsed.packets[i].offset < parsed.packets[i - 1].offset) {
      throw new Error('封包位置亂序');
    }
  }

  const regions = planReads(parsed.packets);
  const audioBytes = regions.reduce((s, r) => s + (r.end - r.start), 0);
  const L = lat ?? 0.002,
    T = thr ?? 150e6;
  if (regions.length * L + audioBytes / T > (file.size / T) * 1.2) {
    throw new Error('跳讀效能不划算');
  }

  const { header, moov, dataSize } = buildM4a(parsed);
  const total = header.length + dataSize + moov.length;
  let written = 0,
    lastPct = -1,
    lastPost = 0;

  const progress = () => {
    const pct = Math.round((written / dataSize) * 100);
    const now = Date.now();
    if (pct === lastPct && now - lastPost < 400) return;
    lastPct = pct;
    lastPost = now;
    self.postMessage({ type: 'progress', pct, bytes: written });
  };

  if (useOpfs) {
    const root = await navigator.storage.getDirectory();
    const oh = await root.getFileHandle(OPFS_FILENAME, { create: true });
    const w = await oh.createWritable();
    try {
      await w.write(header);
      for (const rg of regions) {
        const buf = await read(rg.start, rg.end);
        for (const it of rg.items) {
          await w.write(buf.subarray(it.offset - rg.start, it.offset - rg.start + it.size));
          written += it.size;
        }
        progress();
      }
      if (written !== dataSize) throw new Error(`寫入量 ${written} ≠ 預期 ${dataSize}`);
      await w.write(moov);
      await w.close();
    } catch (e) {
      try {
        await w.abort();
      } catch {}
      throw e;
    }
    const f = await oh.getFile();
    if (f.size !== total) throw new Error('輸出大小不符');
    return { mode: 'opfs', name: OPFS_FILENAME, transcode: parsed.kind === 'passthrough' };
  }

  const out = new Uint8Array(total);
  out.set(header, 0);
  let o = header.length;
  for (const rg of regions) {
    const buf = await read(rg.start, rg.end);
    for (const it of rg.items) {
      out.set(buf.subarray(it.offset - rg.start, it.offset - rg.start + it.size), o);
      o += it.size;
      written += it.size;
    }
    progress();
  }
  if (written !== dataSize) throw new Error(`寫入量 ${written} ≠ 預期 ${dataSize}`);
  out.set(moov, o);
  return { mode: 'buffer', buffer: out.buffer, transcode: parsed.kind === 'passthrough' };
}

/**
 * PCM 格式轉換與 AAC 編碼
 */
async function sparsePcm(sp, parsed, read, useOpfs) {
  if (typeof AudioEncoder === 'undefined' || typeof AudioDecoder === 'undefined') {
    throw new Error('此瀏覽器環境無 WebCodecs 音訊支援');
  }
  const { format, chunks, totalFrames, bytesPerFrame } = parsed;
  const config = {
    codec: 'mp4a.40.2',
    sampleRate: format.sampleRate,
    numberOfChannels: format.channels,
    bitrate: 192000,
  };
  const sup = await AudioEncoder.isConfigSupported(config).catch(() => null);
  if (!sup || !sup.supported) throw new Error('當前環境不支援 AAC 編碼');

  const priming = await measurePriming(sp, config);
  const pktMeta = [];
  const outQ = [];
  let descRaw = null,
    encErr = null;

  const encoder = new AudioEncoder({
    output: (chunk, meta) => {
      const d = meta && meta.decoderConfig && meta.decoderConfig.description;
      if (!descRaw && d) {
        descRaw = new Uint8Array(
          d instanceof ArrayBuffer ? d.slice(0) : d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength)
        );
      }
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      outQ.push({ data, duration: chunk.duration });
    },
    error: (e) => {
      encErr = e;
    },
  });
  encoder.configure(config);

  const HDR = 36;
  let writer = null,
    opfsHandle = null,
    bufParts = null,
    written = 0;

  if (useOpfs) {
    const root = await navigator.storage.getDirectory();
    opfsHandle = await root.getFileHandle(OPFS_FILENAME, { create: true });
    writer = await opfsHandle.createWritable();
    await writer.write(new Uint8Array(HDR));
  } else {
    bufParts = [];
  }

  const writeOut = async (data) => {
    if (writer) await writer.write(data);
    else bufParts.push(data);
    written += data.length;
  };

  const drain = async () => {
    if (encErr) throw encErr;
    while (outQ.length) {
      const p = outQ.shift();
      pktMeta.push({
        size: p.data.length,
        duration:
          (p.duration != null ? p.duration : Math.round((1024 / config.sampleRate) * 1e6)) / 1e6,
      });
      await writeOut(p.data);
    }
  };

  try {
    const STEP = Math.floor((32 * 1024 * 1024) / bytesPerFrame) * bytesPerFrame;
    let framesFed = 0,
      lastPct = -1,
      lastPost = 0;

    for (const c of chunks) {
      for (let off = 0; off < c.size; off += STEP) {
        const len = Math.min(STEP, c.size - off);
        const bytes = await read(c.offset + off, c.offset + off + len);
        const f32 = sp.pcmToF32(bytes, format);
        const frames = Math.floor(f32.length / format.channels);
        encoder.encode(
          new AudioData({
            format: 'f32',
            sampleRate: format.sampleRate,
            numberOfFrames: frames,
            numberOfChannels: format.channels,
            timestamp: Math.round((framesFed / format.sampleRate) * 1e6),
            data: f32,
          })
        );
        framesFed += frames;
        while (encoder.encodeQueueSize > 8) await new Promise((r) => setTimeout(r, 5));
        await drain();
        const pct = Math.round((framesFed / totalFrames) * 100);
        const now = Date.now();
        if (pct !== lastPct || now - lastPost > 400) {
          lastPct = pct;
          lastPost = now;
          self.postMessage({ type: 'progress', pct, bytes: framesFed * bytesPerFrame });
        }
      }
    }
    if (framesFed !== totalFrames) throw new Error(`餵入 ${framesFed} 幀 ≠ 表上 ${totalFrames} 幀`);

    await encoder.flush();
    encoder.close();
    await drain();

    if (!pktMeta.length || !descRaw) throw new Error('編碼未產生輸出');
    const outFrames = pktMeta.reduce((s, p) => s + Math.round(p.duration * config.sampleRate), 0);
    if (Math.abs(outFrames - priming - totalFrames) > config.sampleRate) {
      throw new Error(`輸出 ${outFrames} 幀與輸入 ${totalFrames} + 暖機 ${priming} 不符`);
    }

    const { header, moov, dataSize } = sp.buildM4a({
      packets: pktMeta,
      decoderConfig: {
        codec: config.codec,
        sampleRate: config.sampleRate,
        numberOfChannels: config.numberOfChannels,
        description: descRaw,
      },
      timescale: config.sampleRate,
      priming,
      presDur: totalFrames,
    });

    if (header.length !== HDR) throw new Error(`檔頭 ${header.length} ≠ 佔位 ${HDR}`);
    if (dataSize !== written) throw new Error(`寫入量 ${written} ≠ 預期 ${dataSize}`);

    if (writer) {
      await writer.write(moov);
      await writer.write({ type: 'write', position: 0, data: header });
      await writer.close();
      const f = await opfsHandle.getFile();
      if (f.size !== HDR + dataSize + moov.length) throw new Error('輸出檔案大小不符');
      return { mode: 'opfs', name: OPFS_FILENAME };
    }

    const out = new Uint8Array(HDR + dataSize + moov.length);
    out.set(header, 0);
    let o = HDR;
    for (const part of bufParts) {
      out.set(part, o);
      o += part.length;
    }
    out.set(moov, o);
    return { mode: 'buffer', buffer: out.buffer };
  } catch (e) {
    try {
      encoder.close();
    } catch {}
    if (writer) {
      try {
        await writer.abort();
      } catch {}
    }
    throw e;
  }
}

/**
 * 測量 AAC 編碼器暖機延遲幀數 (Priming Delay)
 */
async function measurePriming(sp, config) {
  const sr = config.sampleRate,
    ch = config.numberOfChannels;
  const N = Math.round(sr * 0.3);
  let seed = 123456789;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x40000000) - 1;
  const noise = new Float32Array(N * ch);
  for (let i = 0; i < N * ch; i++) noise[i] = rnd() * 0.5;

  const encChunks = [];
  let desc = null,
    encErr = null;
  const enc = new AudioEncoder({
    output: (c, m) => {
      const d = m && m.decoderConfig && m.decoderConfig.description;
      if (!desc && d) desc = d;
      encChunks.push(c);
    },
    error: (e) => {
      encErr = e;
    },
  });
  enc.configure(config);
  enc.encode(
    new AudioData({
      format: 'f32',
      sampleRate: sr,
      numberOfFrames: N,
      numberOfChannels: ch,
      timestamp: 0,
      data: noise,
    })
  );
  await enc.flush();
  enc.close();
  if (encErr || !encChunks.length) throw new Error('校準編碼失敗');

  const decoded = [];
  let decErr = null;
  const asc = desc ? sp.ascFromDescription(desc) : null;
  const dec = new AudioDecoder({
    output: (ad) => decoded.push(ad),
    error: (e) => {
      decErr = e;
    },
  });
  dec.configure(
    Object.assign(
      { codec: config.codec, sampleRate: sr, numberOfChannels: ch },
      asc ? { description: asc } : {}
    )
  );
  for (const c of encChunks) dec.decode(c);
  await dec.flush();
  dec.close();
  if (decErr || !decoded.length) throw new Error('校準解碼失敗');

  let total = 0;
  for (const ad of decoded) total += ad.numberOfFrames;
  const y = new Float32Array(total);
  let o = 0;
  for (const ad of decoded) {
    const tmp = new Float32Array(ad.numberOfFrames);
    ad.copyTo(tmp, { planeIndex: 0, format: 'f32-planar' });
    y.set(tmp, o);
    o += ad.numberOfFrames;
    ad.close();
  }
  const M = Math.min(N, 8192);
  let best = 0,
    bestV = -Infinity;
  for (let lag = 0; lag <= 4600 && lag + M <= y.length; lag++) {
    let s = 0;
    for (let i = 0; i < M; i += 7) s += noise[i * ch] * y[lag + i];
    if (s > bestV) {
      bestV = s;
      best = lag;
    }
  }
  return best;
}

/**
 * mediabunny 降級抽取流程
 */
async function once(mb, file, useOpfs) {
  const input = new mb.Input({ source: new mb.BlobSource(file), formats: mb.ALL_FORMATS });
  let opfsHandle = null,
    writable = null,
    target;

  if (useOpfs) {
    const root = await navigator.storage.getDirectory();
    opfsHandle = await root.getFileHandle(OPFS_FILENAME, { create: true });
    writable = await opfsHandle.createWritable();
    target = new mb.StreamTarget(writable, { chunked: true });
  } else {
    target = new mb.BufferTarget();
  }

  const output = new mb.Output({
    format: new mb.Mp4OutputFormat(useOpfs ? { fastStart: false } : {}),
    target,
  });

  let audioOpt = null;
  try {
    const at = await input.getPrimaryAudioTrack();
    const codec = at ? await at.getCodec() : null;
    if (codec && (codec.startsWith('pcm-') || codec === 'ulaw' || codec === 'alaw')) {
      audioOpt = { codec: 'aac', bitrate: 192000 };
      self.postMessage({ type: 'note', msg: 'pcm-to-aac', data: { codec } });
    }
  } catch {}

  let conversion = null;
  try {
    conversion = await mb.Conversion.init({
      input,
      output,
      video: { discard: true },
      ...(audioOpt ? { audio: audioOpt } : {}),
      showWarnings: false,
    });
    conversion.onProgress = (p) => {
      self.postMessage({ type: 'progress', pct: Math.round(p * 100) });
    };
    if (!conversion.isValid) throw new Error('音訊來源中未找到可用的聲音軌');
    await conversion.execute();
  } catch (e) {
    if (writable) {
      try {
        await writable.abort();
      } catch {}
    }
    throw e;
  }

  if (writable) {
    const f = await opfsHandle.getFile();
    if (!f.size) throw new Error('擷取出的音訊檔案為空');
    return { mode: 'opfs', name: OPFS_FILENAME };
  }

  const buf = output.target.buffer;
  if (!buf || !buf.byteLength) throw new Error('擷取出的音訊資料為空');
  return { mode: 'buffer', buffer: buf };
}
