(function() {
'use strict';

class ApiKeyManager {
  getGroqKey() { return localStorage.getItem('audio_tutor_groq_key') || ''; }
  setGroqKey(key) { localStorage.setItem('audio_tutor_groq_key', key.trim()); }
  getGeminiKey() { return localStorage.getItem('audio_tutor_gemini_key') || ''; }
  setGeminiKey(key) { localStorage.setItem('audio_tutor_gemini_key', key.trim()); }
  hasAllKeys() { return !!this.getGroqKey() && !!this.getGeminiKey(); }
}

class StorageManager {
  constructor() { 
    this.dbName = 'AudioTutorDB'; 
    this.dbVersion = 1; 
  }
  
  async openDB() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, this.dbVersion);
      
      request.onerror = (event) => reject(new Error('Database error: ' + event.target.error));
      
      request.onsuccess = (event) => resolve(event.target.result);
      
      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains('sessions')) {
          db.createObjectStore('sessions', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('audioFallback')) {
          db.createObjectStore('audioFallback');
        }
      };
    });
  }
  
  async saveSession(session) {
    const db = await this.openDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(['sessions'], 'readwrite');
      const store = transaction.objectStore('sessions');
      const request = store.put(session);
      request.onsuccess = () => resolve();
      request.onerror = (e) => reject(e.target.error);
    });
  }
  
  async loadSession(id) {
    const db = await this.openDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(['sessions'], 'readonly');
      const store = transaction.objectStore('sessions');
      const request = store.get(id);
      request.onsuccess = () => resolve(request.result);
      request.onerror = (e) => reject(e.target.error);
    });
  }
  
  async listSessions() {
    const db = await this.openDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(['sessions'], 'readonly');
      const store = transaction.objectStore('sessions');
      const request = store.getAll();
      request.onsuccess = () => {
        const sessions = request.result || [];
        sessions.sort((a, b) => new Date(b.date) - new Date(a.date));
        resolve(sessions);
      };
      request.onerror = (e) => reject(e.target.error);
    });
  }
  
  async deleteSession(id) {
    const db = await this.openDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(['sessions'], 'readwrite');
      const store = transaction.objectStore('sessions');
      const request = store.delete(id);
      request.onsuccess = () => resolve();
      request.onerror = (e) => reject(e.target.error);
    });
  }
  
  async saveAudio(blob, name) {
    try {
      const root = await navigator.storage.getDirectory();
      const handle = await root.getFileHandle(`audio-tutor-${name}`, { create: true });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
    } catch(e) { 
      console.warn('OPFS save failed, using IndexedDB fallback', e);
      const db = await this.openDB();
      return new Promise((resolve, reject) => {
        const transaction = db.transaction(['audioFallback'], 'readwrite');
        const store = transaction.objectStore('audioFallback');
        const request = store.put(blob, name);
        request.onsuccess = () => resolve();
        request.onerror = (err) => reject(err.target.error);
      });
    }
  }
  
  async loadAudio(name) {
    try {
      const root = await navigator.storage.getDirectory();
      const handle = await root.getFileHandle(`audio-tutor-${name}`);
      const file = await handle.getFile();
      return file;
    } catch (e) {
      console.warn('OPFS load failed, trying IndexedDB fallback', e);
      const db = await this.openDB();
      return new Promise((resolve, reject) => {
        const transaction = db.transaction(['audioFallback'], 'readonly');
        const store = transaction.objectStore('audioFallback');
        const request = store.get(name);
        request.onsuccess = () => resolve(request.result);
        request.onerror = (err) => reject(err.target.error);
      });
    }
  }
}

class AudioPipeline {
  constructor(apiKeys, onProgress) {
    this.apiKeys = apiKeys;
    this.onProgress = onProgress;
  }
  
  async extractAudio(file) {
    return new Promise((resolve, reject) => {
      const worker = new Worker('extract-worker.js');
      worker.onmessage = async (ev) => {
        const d = ev.data;
        if (d.type === 'progress') this.onProgress('extract', d.pct, `抽取中 ${d.pct}%`);
        if (d.type === 'done') {
          if (d.mode === 'opfs') {
            try {
              const root = await navigator.storage.getDirectory();
              const handle = await root.getFileHandle(d.name);
              const extractedFile = await handle.getFile();
              resolve(new Blob([await extractedFile.arrayBuffer()], { type: 'audio/mp4' }));
            } catch (err) {
              reject(err);
            }
          } else {
            resolve(new Blob([d.buffer], { type: 'audio/mp4' }));
          }
          worker.terminate();
        }
        if (d.type === 'error') { reject(new Error(d.message)); worker.terminate(); }
      };
      worker.onerror = (e) => {
        reject(new Error("Worker error: " + e.message));
        worker.terminate();
      };
      worker.postMessage({ type: 'extract', file });
    });
  }
  
  async transcribe(audioBlob, language = 'en') {
    this.onProgress('transcribe', 0, '準備音訊...');
    
    const chunks = await this._prepareAudioChunks(audioBlob);
    this.onProgress('transcribe', 20, `已切分 ${chunks.length} 段`);
    
    let allSegments = [];
    for (let i = 0; i < chunks.length; i++) {
      this.onProgress('transcribe', 20 + Math.round((i / chunks.length) * 70), `辨識第 ${i+1}/${chunks.length} 段...`);
      const result = await this._transcribeChunk(chunks[i].blob, language);
      
      if (result && result.segments) {
        for (const seg of result.segments) {
          allSegments.push({
            start: +(Number(seg.start || 0) + chunks[i].timeOffset).toFixed(3),
            end: +(Number(seg.end || 0) + chunks[i].timeOffset).toFixed(3),
            text: (seg.text || '').trim()
          });
        }
      }
    }
    
    allSegments = allSegments.filter(s => s.text.length > 0);
    this.onProgress('transcribe', 100, `辨識完成，共 ${allSegments.length} 句`);
    return allSegments;
  }
  
  async _prepareAudioChunks(audioBlob) {
    const CHUNK_DURATION = 600;
    try {
      const arrayBuffer = await audioBlob.arrayBuffer();
      const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const decoded = await audioCtx.decodeAudioData(arrayBuffer);
      audioCtx.close();
      const totalDuration = decoded.duration;
      const chunks = [];
      for (let start = 0; start < totalDuration; start += CHUNK_DURATION) {
        const end = Math.min(totalDuration, start + CHUNK_DURATION);
        const duration = end - start;
        const sampleRate = 16000;
        const offlineCtx = new OfflineAudioContext(1, Math.floor(duration * sampleRate), sampleRate);
        const src = offlineCtx.createBufferSource();
        src.buffer = decoded;
        src.connect(offlineCtx.destination);
        src.start(0, start, duration);
        const rendered = await offlineCtx.startRendering();
        const pcm = rendered.getChannelData(0);
        const wavBlob = this._encodeWav(pcm, sampleRate);
        chunks.push({ blob: wavBlob, timeOffset: start, duration });
      }
      return chunks;
    } catch(e) {
      console.warn('Web Audio decode failed, using raw blob', e);
      return [{ blob: audioBlob, timeOffset: 0, duration: 0 }];
    }
  }
  
  _encodeWav(pcm, sampleRate) {
    const buffer = new ArrayBuffer(44 + pcm.length * 2);
    const view = new DataView(buffer);
    const writeStr = (offset, str) => { for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i)); };
    writeStr(0, 'RIFF');
    view.setUint32(4, 36 + pcm.length * 2, true);
    writeStr(8, 'WAVE');
    writeStr(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeStr(36, 'data');
    view.setUint32(40, pcm.length * 2, true);
    let offset = 44;
    for (let i = 0; i < pcm.length; i++) {
      let s = Math.max(-1, Math.min(1, pcm[i]));
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
      offset += 2;
    }
    return new Blob([view], { type: 'audio/wav' });
  }
  
  async _transcribeChunk(chunkBlob, language) {
    const formData = new FormData();
    formData.append('file', chunkBlob, 'audio.wav');
    formData.append('model', 'whisper-large-v3');
    formData.append('response_format', 'verbose_json');
    formData.append('timestamp_granularities[]', 'segment');
    if (language) {
      formData.append('language', language);
    }
    
    const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${this.apiKeys.groqKey}` },
      body: formData
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Groq API 錯誤 (${res.status}): ${err}`);
    }
    return await res.json();
  }
  
  async analyzeWithGemini(segments, sourceLang = 'en') {
    this.onProgress('analyze', 0, '開始語意解析...');
    const BATCH_SIZE = 10;
    const results = [];
    
    for (let i = 0; i < segments.length; i += BATCH_SIZE) {
      const batch = segments.slice(i, i + BATCH_SIZE);
      const batchNum = Math.floor(i / BATCH_SIZE) + 1;
      const totalBatches = Math.ceil(segments.length / BATCH_SIZE);
      this.onProgress('analyze', Math.round((i / segments.length) * 100), `解析第 ${batchNum}/${totalBatches} 批...`);
      
      const explanations = await this._explainBatch(batch, i, sourceLang);
      results.push(...explanations);
    }
    
    const enriched = segments.map((seg, idx) => ({
      ...seg,
      explanation: results[idx]?.explanation || '',
      cefr: results[idx]?.cefr || 'B1'
    }));
    
    this.onProgress('analyze', 100, `解析完成，共 ${enriched.length} 句`);
    return enriched;
  }
  
  async _explainBatch(batch, startIdx, sourceLang) {
    const sentences = batch.map((s, i) => ({ id: startIdx + i + 1, text: s.text }));
    const langMap = {
      'en': '英文', 'ja': '日文', 'ko': '韓文', 'es': '西班牙文', 'fr': '法文', 'de': '德文'
    };
    const langName = langMap[sourceLang] || '外語';
    
    const prompt = `你是一位專業的${langName}聽力教練。請針對下列${langName}句子清單，逐句提供適合「用語音聽」的簡要繁體中文講解。
講解規則：
1. 語氣自然、口語化，適合 TTS 朗讀。
2. 包含：一句中文精準意譯 + 1個關鍵單字/片語解析。
3. 總長度控制在 20~40 字以內，避免冗長。
4. 為每個句子標注 CEFR 難度等級（A1/A2/B1/B2/C1/C2）。

輸入句子：
${JSON.stringify(sentences)}

請輸出 JSON 陣列：
[{ "id": 1, "explanation": "這句話意思是...，重點片語是...代表...", "cefr": "B1" }]`;
    
    // 多重 Gemini 模型容錯優先鏈 (支援 2.5-flash, 2.0-flash, 1.5-flash, 2.0-flash-lite)
    const candidateModels = [
      'gemini-2.5-flash',
      'gemini-2.0-flash',
      'gemini-1.5-flash',
      'gemini-2.0-flash-lite'
    ];

    if (this._workingGeminiModel) {
      const idx = candidateModels.indexOf(this._workingGeminiModel);
      if (idx > -1) {
        candidateModels.splice(idx, 1);
        candidateModels.unshift(this._workingGeminiModel);
      }
    }

    let lastError = null;

    for (const model of candidateModels) {
      try {
        const res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${this.apiKeys.geminiKey}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{ parts: [{ text: prompt }] }],
              generationConfig: { responseMimeType: 'application/json' }
            })
          }
        );

        if (res.ok) {
          const data = await res.json();
          this._workingGeminiModel = model;
          const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
          if (text) {
            try {
              const cleanText = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
              return JSON.parse(cleanText);
            } catch (parseErr) {
              console.warn(`JSON parse failed for model ${model}:`, parseErr);
            }
          }
        } else {
          const err = await res.text();
          console.warn(`Gemini model ${model} failed (${res.status}):`, err);
          lastError = new Error(`Gemini API 錯誤 (${res.status}): ${err}`);
        }
      } catch (networkErr) {
        console.warn(`Gemini model ${model} network error:`, networkErr);
        lastError = networkErr;
      }
    }

    console.error('All Gemini candidate models failed. Last error:', lastError);
    if (lastError) throw lastError;
    return batch.map((_, i) => ({ id: startIdx + i + 1, explanation: '', cefr: 'B1' }));
  }
}

class AudioTutorPlayer {
  constructor(audioBlob, enrichedSegments, options = {}) {
    this.audioUrl = URL.createObjectURL(audioBlob);
    this.audio = new Audio(this.audioUrl);
    this.audio.preload = 'auto';
    this.timeline = enrichedSegments;
    this.currentIndex = 0;
    this.state = 'idle';
    this.tts = window.speechSynthesis;
    this.options = {
      replayOriginal: options.replayOriginal !== false,
      ttsRate: options.ttsRate || 1.05,
      ttsVoice: options.ttsVoice || null,
      cefrThreshold: options.cefrThreshold || 0,
      ...options
    };
    this.onStateChange = options.onStateChange || (() => {});
    this.onSegmentChange = options.onSegmentChange || (() => {});
    this._abortController = null;
    this._paused = false;
    this._pauseResolve = null;
  }
  
  get cefrLevels() { return ['A1','A2','B1','B2','C1','C2']; }
  
  _cefrToNum(cefr) {
    return this.cefrLevels.indexOf(cefr?.toUpperCase() || 'B1');
  }
  
  shouldExplain(segment) {
    return this._cefrToNum(segment.cefr) >= this.options.cefrThreshold;
  }
  
  async play() {
    if (this.state === 'paused') {
      this._resume();
      return;
    }
    this._paused = false;
    this._playLoop();
  }
  
  async _playLoop() {
    while (this.currentIndex < this.timeline.length) {
      if (this._paused) { await this._waitForResume(); }
      
      const seg = this.timeline[this.currentIndex];
      this.onSegmentChange(this.currentIndex, seg);
      
      // 1. Play original audio slice
      this._setState('playing_original');
      await this._playSlice(seg.start, seg.end);
      
      if (this._paused) { await this._waitForResume(); }
      
      // 2. Speak TTS explanation
      if (this.shouldExplain(seg) && seg.explanation) {
        this._setState('speaking_explanation');
        await this._speak(seg.explanation, 'zh-TW');
        
        if (this._paused) { await this._waitForResume(); }
        
        // 3. Optionally replay original
        if (this.options.replayOriginal) {
          this._setState('replaying_original');
          await this._playSlice(seg.start, seg.end);
        }
      }
      
      this.currentIndex++;
    }
    this._setState('idle');
  }
  
  pause() {
    this._paused = true;
    this.audio.pause();
    this.tts.cancel();
    this._setState('paused');
  }
  
  _resume() {
    this._paused = false;
    if (this._pauseResolve) {
      this._pauseResolve();
      this._pauseResolve = null;
    }
  }
  
  _waitForResume() {
    return new Promise(resolve => { this._pauseResolve = resolve; });
  }
  
  async replayCurrent() {
    this.tts.cancel();
    this.audio.pause();
    this._paused = false;
    if (this._pauseResolve) {
      this._pauseResolve();
      this._pauseResolve = null;
    }
    this._playLoop();
  }
  
  async skipToNext() {
    this.tts.cancel();
    this.audio.pause();
    this._paused = false;
    if (this._pauseResolve) {
      this._pauseResolve();
      this._pauseResolve = null;
    }
    if (this.currentIndex < this.timeline.length - 1) {
      this.currentIndex++;
    }
    this._playLoop();
  }
  
  async skipToPrev() {
    this.tts.cancel();
    this.audio.pause();
    this._paused = false;
    if (this._pauseResolve) {
      this._pauseResolve();
      this._pauseResolve = null;
    }
    if (this.currentIndex > 0) {
      this.currentIndex--;
    }
    this._playLoop();
  }
  
  _setState(state) {
    this.state = state;
    this.onStateChange(state, this.currentIndex);
  }
  
  _playSlice(start, end) {
    return new Promise((resolve) => {
      this.audio.currentTime = start;
      this.audio.play().catch(resolve);
      const onTimeUpdate = () => {
        if (this._paused) {
          this.audio.removeEventListener('timeupdate', onTimeUpdate);
          resolve();
          return;
        }
        if (this.audio.currentTime >= end) {
          this.audio.pause();
          this.audio.removeEventListener('timeupdate', onTimeUpdate);
          resolve();
        }
      };
      this.audio.addEventListener('timeupdate', onTimeUpdate);
      const maxDur = (end - start + 2) * 1000;
      setTimeout(() => {
        this.audio.removeEventListener('timeupdate', onTimeUpdate);
        this.audio.pause();
        resolve();
      }, maxDur);
    });
  }
  
  _speak(text, lang = 'zh-TW') {
    return new Promise((resolve) => {
      if (!text) { resolve(); return; }
      const utter = new SpeechSynthesisUtterance(text);
      utter.lang = lang;
      utter.rate = this.options.ttsRate;
      if (this.options.ttsVoice) {
        const voices = this.tts.getVoices();
        const v = voices.find(v => v.name === this.options.ttsVoice);
        if (v) utter.voice = v;
      }
      utter.onend = resolve;
      utter.onerror = resolve;
      this.tts.speak(utter);
    });
  }
  
  updateOptions(opts) {
    Object.assign(this.options, opts);
  }
  
  destroy() {
    this.audio.pause();
    this.tts.cancel();
    URL.revokeObjectURL(this.audioUrl);
  }
  
  setupMediaSession(fileName) {
    if (!('mediaSession' in navigator)) return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: '精聽學習中',
      artist: `第 ${this.currentIndex + 1} / ${this.timeline.length} 句`,
      album: fileName || 'Audio Tutor'
    });
    navigator.mediaSession.setActionHandler('play', () => this.play());
    navigator.mediaSession.setActionHandler('pause', () => this.pause());
    navigator.mediaSession.setActionHandler('previoustrack', () => this.skipToPrev());
    navigator.mediaSession.setActionHandler('nexttrack', () => this.skipToNext());
  }
}

// ─────────────────────────────────────────────────────────────
// 全球精選 Podcast 推薦清單 (BBC, TED, NPR, VOA, 生活會話)
// ─────────────────────────────────────────────────────────────
const CURATED_PODCASTS = [
  // BBC
  {
    id: 'bbc-6min',
    category: 'bbc',
    provider: 'BBC Learning English',
    title: 'BBC 6 Minute English',
    desc: '專為英語學習者設計的 6 分鐘主題對話，包含每集精華生詞與片語解析。',
    badge: '🇬🇧 BBC 英語',
    tag: '英式發音 · 學習必備 · 6分鐘',
    feedUrl: 'https://podcasts.files.bbci.co.uk/p02pc9tn.rss',
    cover: 'https://ichef.bbci.co.uk/images/ic/3000x3000/p0hxqkd0.jpg',
    color: '#bb1919'
  },
  {
    id: 'bbc-english-we-speak',
    category: 'bbc',
    provider: 'BBC Learning English',
    title: 'BBC The English We Speak',
    desc: '每次 3 分鐘解析一組最道地的英式流行俚語、慣用語與日常對話。',
    badge: '🇬🇧 BBC 英語',
    tag: '道地俚語 · 3分鐘速學',
    feedUrl: 'https://podcasts.files.bbci.co.uk/p02pc9wq.rss',
    cover: 'https://ichef.bbci.co.uk/images/ic/3000x3000/p0hxqkdm.jpg',
    color: '#bb1919'
  },
  {
    id: 'bbc-global-news',
    category: 'bbc',
    provider: 'BBC World Service',
    title: 'BBC Global News Podcast',
    desc: '全球收看度最高的國際新聞廣播，權威英式新聞發音與時事詞彙。',
    badge: '🇬🇧 BBC 新聞',
    tag: '國際時事 · 英式新聞 · 30分鐘',
    feedUrl: 'https://podcasts.files.bbci.co.uk/p02nq0gn.rss',
    cover: 'https://ichef.bbci.co.uk/images/ic/3000x3000/p0hxqk8g.jpg',
    color: '#bb1919'
  },
  {
    id: 'bbc-6min-vocab',
    category: 'bbc',
    provider: 'BBC Learning English',
    title: 'BBC 6 Minute Vocabulary',
    desc: '專注單字前綴、字根、同義字與文法結構精闢解析。',
    badge: '🇬🇧 BBC 單字',
    tag: '字彙擴充 · 文法解析',
    feedUrl: 'https://podcasts.files.bbci.co.uk/p02pc9v6.rss',
    cover: 'https://ichef.bbci.co.uk/images/ic/3000x3000/p0hxqkd0.jpg',
    color: '#bb1919'
  },
  // TED
  {
    id: 'ted-talks-daily',
    category: 'ted',
    provider: 'TED',
    title: 'TED Talks Daily',
    desc: '每日精選各領域頂尖思想家、科學家與創新家的精彩演講。',
    badge: '💡 TED 演講',
    tag: '思維創新 · 科技人文 · 10-15分鐘',
    feedUrl: 'https://feeds.feedburner.com/TEDTalks_audio',
    cover: 'https://pi.tedcdn.com/r/pb-assets.tedcdn.com/system/ba/assets/1032/TEDTalksDaily_PodcastTile_3000x3000.png',
    color: '#e62b1e'
  },
  {
    id: 'ted-radio-hour',
    category: 'ted',
    provider: 'NPR & TED',
    title: 'TED Radio Hour',
    desc: '深度訪談多位 TED 講者，主題式探討人類好奇心、發明與生命故事。',
    badge: '💡 TED 深度',
    tag: '深度訪談 · 啟發思考',
    feedUrl: 'https://feeds.npr.org/510298/podcast.xml',
    cover: 'https://media.npr.org/assets/img/2023/06/07/ted-radio-hour-podcast-tile-2023_sq-6b58ceca5a11cbe0da7c6ae1e67cfc0a5ffdf319.jpg',
    color: '#e62b1e'
  },
  {
    id: 'ted-business',
    category: 'ted',
    provider: 'TED',
    title: 'TED Business',
    desc: '世界級商業領袖與創新者分享商業趨勢、談判策略與職涯智慧。',
    badge: '💡 TED 商業',
    tag: '商業職場 · 領袖思維',
    feedUrl: 'https://feeds.feedburner.com/tedtalksbusiness',
    cover: 'https://pi.tedcdn.com/r/pb-assets.tedcdn.com/system/ba/assets/1032/TEDTalksDaily_PodcastTile_3000x3000.png',
    color: '#e62b1e'
  },
  // NPR
  {
    id: 'npr-news-now',
    category: 'npr',
    provider: 'NPR',
    title: 'NPR News Now',
    desc: '每小時更新的 5 分鐘美國權威新聞快訊，標準美式發音與即時國際動態。',
    badge: '🇺🇸 NPR 新聞',
    tag: '5分鐘快訊 · 標準美語',
    feedUrl: 'https://feeds.npr.org/500005/podcast.xml',
    cover: 'https://media.npr.org/assets/img/2018/08/02/nprnewsnow_podcasttile_sq-13350b5551dc03816664d99c4c730e6206038a8e.png',
    color: '#21759b'
  },
  {
    id: 'npr-short-wave',
    category: 'npr',
    provider: 'NPR',
    title: 'NPR Short Wave',
    desc: '每天 10~15 分鐘日常生活中的科學新知，生動幽默的美語對話。',
    badge: '🇺🇸 NPR 科普',
    tag: '日常科學 · 輕鬆對話 · 10分鐘',
    feedUrl: 'https://feeds.npr.org/510351/podcast.xml',
    cover: 'https://media.npr.org/assets/img/2019/10/01/shortwave_tile_sq-100236a2979216ae9d8e7cbe3f7e65839211df5a.png',
    color: '#21759b'
  },
  {
    id: 'npr-life-kit',
    category: 'npr',
    provider: 'NPR',
    title: 'NPR Life Kit',
    desc: '心理成長、人際溝通、金錢管理與健康生活的實用生活指南。',
    badge: '🇺🇸 NPR 生活',
    tag: '生活指南 · 實用溝通 · 15分鐘',
    feedUrl: 'https://feeds.npr.org/510338/podcast.xml',
    cover: 'https://media.npr.org/assets/img/2019/12/10/lifekit_tile_sq-ea475f3a0972c3d0b8c66e2c39db5c54d1d91a92.png',
    color: '#21759b'
  },
  {
    id: 'npr-planet-money',
    category: 'npr',
    provider: 'NPR',
    title: 'NPR Planet Money',
    desc: '用生動故事解釋經濟、商業與世界運作方式，全球最受歡迎的經濟 Podcast。',
    badge: '🇺🇸 NPR 經濟',
    tag: '經濟故事 · 商業常識',
    feedUrl: 'https://feeds.npr.org/510289/podcast.xml',
    cover: 'https://media.npr.org/assets/img/2021/08/18/planet-money_sq-69f88d55169a19dc81045b4c1062f689f4175317.png',
    color: '#21759b'
  },
  // ESL & Daily
  {
    id: 'all-ears-english',
    category: 'daily',
    provider: 'All Ears English',
    title: 'All Ears English Podcast',
    desc: '「Connection NOT Perfection!」美國生活文化、日常對話技巧與自然流利美語。',
    badge: '🗣️ 美語會話',
    tag: '自然口語 · 美式生活會話',
    feedUrl: 'https://allearsenglish.libsyn.com/rss',
    cover: 'https://ssl-static.libsyn.com/p/assets/7/2/f/2/72f2d93e8a3297a7/AEE_New_Cover_Art_Final_2020.png',
    color: '#f59e0b'
  },
  {
    id: 'luke-english-podcast',
    category: 'daily',
    provider: 'Luke Thompson',
    title: "Luke's English Podcast",
    desc: '多次獲獎的知名英式英語學習節目，結合英國文化、幽默與生活對話。',
    badge: '🗣️ 生活會話',
    tag: '英式幽默 · 生活對話',
    feedUrl: 'https://teacherluke.co.uk/feed/podcast/',
    cover: 'https://teacherluke.co.uk/wp-content/uploads/2021/04/LEP-Logo-3000x3000-1.jpg',
    color: '#d97706'
  }
];

class PodcastManager {
  constructor() {
    this.cachedFeeds = new Map();
    this.previewAudio = null;
    this.currentPlayingUrl = null;
  }

  async fetchFeed(feedUrl) {
    if (this.cachedFeeds.has(feedUrl)) {
      return this.cachedFeeds.get(feedUrl);
    }

    let xmlText = null;
    // 1. Try local server proxy
    try {
      const res = await fetch('/api/proxy?url=' + encodeURIComponent(feedUrl));
      if (res.ok) {
        const text = await res.text();
        if (text && (text.includes('<rss') || text.includes('<feed') || text.includes('<xml') || text.includes('<channel'))) {
          xmlText = text;
        }
      }
    } catch (e) {
      console.warn('Local proxy failed:', e);
    }

    // 2. Try public proxy fallback
    if (!xmlText) {
      try {
        const res = await fetch(`https://api.allorigins.win/raw?url=${encodeURIComponent(feedUrl)}`);
        if (res.ok) xmlText = await res.text();
      } catch (e) {
        console.warn('Public proxy failed:', e);
      }
    }

    // 3. Try direct fetch
    if (!xmlText) {
      const res = await fetch(feedUrl);
      xmlText = await res.text();
    }

    if (!xmlText) throw new Error('無法讀取 RSS 來源');

    const feedData = this.parseRssXml(xmlText, feedUrl);
    this.cachedFeeds.set(feedUrl, feedData);
    return feedData;
  }

  parseRssXml(xmlText, feedUrl) {
    const parser = new DOMParser();
    const xml = parser.parseFromString(xmlText, 'text/xml');
    
    // Check parser error
    const parseError = xml.querySelector('parsererror');
    if (parseError) throw new Error('XML 格式解析失敗');

    const channel = xml.querySelector('channel');
    const channelTitle = channel?.querySelector('title')?.textContent?.trim() || 'Podcast 節目';
    const channelDesc = channel?.querySelector('description')?.textContent?.trim() || '';
    const channelImg = channel?.querySelector('image url')?.textContent?.trim() ||
                       channel?.querySelector('itunes\\:image')?.getAttribute('href') ||
                       '';

    const items = xml.querySelectorAll('item');
    const episodes = [];

    items.forEach((item, idx) => {
      if (idx >= 30) return; // Keep top 30 episodes for snappy UX
      const title = item.querySelector('title')?.textContent?.trim() || `第 ${idx + 1} 集`;
      const rawDate = item.querySelector('pubDate')?.textContent?.trim() || '';
      let formattedDate = '';
      if (rawDate) {
        try {
          const d = new Date(rawDate);
          if (!isNaN(d.getTime())) formattedDate = d.toLocaleDateString('zh-TW', { year: 'numeric', month: 'short', day: 'numeric' });
          else formattedDate = rawDate.split(' ').slice(0, 4).join(' ');
        } catch { formattedDate = rawDate; }
      }

      const desc = (item.querySelector('description')?.textContent || item.querySelector('itunes\\:summary')?.textContent || '')
                   .replace(/<[^>]*>/g, '').trim();
      const rawDur = item.querySelector('itunes\\:duration')?.textContent?.trim() || '';
      const duration = this._formatDuration(rawDur);

      const enclosure = item.querySelector('enclosure');
      const audioUrl = enclosure?.getAttribute('url') || item.querySelector('link')?.textContent?.trim() || '';

      if (audioUrl) {
        episodes.push({
          id: idx,
          title,
          pubDate: formattedDate,
          desc,
          duration,
          audioUrl
        });
      }
    });

    return {
      title: channelTitle,
      desc: channelDesc,
      cover: channelImg,
      episodes
    };
  }

  _formatDuration(raw) {
    if (!raw) return '';
    if (raw.includes(':')) {
      const parts = raw.split(':');
      if (parts.length === 2) return `${parts[0].padStart(2, '0')}:${parts[1].padStart(2, '0')}`;
      if (parts.length === 3) return `${parts[0]}:${parts[1].padStart(2, '0')}:${parts[2].padStart(2, '0')}`;
      return raw;
    }
    const sec = parseInt(raw);
    if (!isNaN(sec)) {
      const m = Math.floor(sec / 60);
      const s = sec % 60;
      return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    }
    return raw;
  }

  togglePreview(audioUrl, onPlayChange) {
    if (this.previewAudio && this.currentPlayingUrl === audioUrl) {
      if (this.previewAudio.paused) {
        this.previewAudio.play();
        onPlayChange(true);
      } else {
        this.previewAudio.pause();
        onPlayChange(false);
      }
      return;
    }

    if (this.previewAudio) {
      this.previewAudio.pause();
      this.previewAudio = null;
    }

    // Proxy preview audio
    const proxiedUrl = '/api/proxy?url=' + encodeURIComponent(audioUrl);
    this.previewAudio = new Audio(proxiedUrl);
    this.currentPlayingUrl = audioUrl;

    this.previewAudio.onended = () => onPlayChange(false);
    this.previewAudio.onerror = () => {
      // Fallback to direct URL if proxy failed
      this.previewAudio = new Audio(audioUrl);
      this.previewAudio.play().catch(() => onPlayChange(false));
    };

    this.previewAudio.play().then(() => onPlayChange(true)).catch(() => onPlayChange(false));
  }

  stopPreview() {
    if (this.previewAudio) {
      this.previewAudio.pause();
      this.previewAudio = null;
      this.currentPlayingUrl = null;
    }
  }

  async downloadEpisodeAudio(audioUrl, title, onProgress) {
    this.stopPreview();
    if (onProgress) onProgress('下載 Podcast 音訊...', 15);

    let res = null;
    // 1. Try local server proxy (when running locally)
    try {
      res = await fetch('/api/proxy?url=' + encodeURIComponent(audioUrl));
      if (!res.ok) res = null;
    } catch (e) {
      res = null;
    }

    // 2. Try direct fetch (many podcast CDNs like Libsyn / NPR / BBC support CORS)
    if (!res) {
      try {
        res = await fetch(audioUrl);
        if (!res.ok) res = null;
      } catch (e) {
        res = null;
      }
    }

    // 3. Try public CORS proxy fallback (e.g. for GitHub Pages)
    if (!res) {
      try {
        res = await fetch(`https://api.allorigins.win/raw?url=${encodeURIComponent(audioUrl)}`);
        if (!res.ok) res = null;
      } catch (e) {
        res = null;
      }
    }

    if (!res || !res.ok) throw new Error(`音訊下載失敗：無法取得音訊串流`);
    
    if (onProgress) onProgress('正在讀取音訊串流...', 60);
    const blob = await res.blob();
    
    const safeTitle = (title || 'Podcast_Episode').replace(/[/\\?%*:|"<>]/g, '_');
    return new File([blob], `${safeTitle}.mp3`, { type: blob.type || 'audio/mpeg' });
  }
}

class UIController {
  constructor() {
    this.apiKeys = new ApiKeyManager();
    this.storage = new StorageManager();
    this.podcasts = new PodcastManager();
    this.player = null;
    this.currentSession = null;
    this.currentChannel = null;
    this.currentEpisodes = [];
    this.activeTab = 'podcast'; // 'podcast' | 'local' | 'custom' | 'history' | 'settings'

    this._bindUI();
    this._loadSettings();
    this._loadHistory();
    this._populateVoices();
    this._registerSW();
    this._renderPodcastChannels('all');
    
    if (window.speechSynthesis) {
      window.speechSynthesis.onvoiceschanged = () => this._populateVoices();
    }
  }

  _registerSW() {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(e => console.warn('SW registration failed', e));
    }
  }
  
  _bindUI() {
    // ─────────────────────────────────────────────────────────
    // 1. 置底 App 導覽列切換 (Bottom Navigation Bar)
    // ─────────────────────────────────────────────────────────
    const navItems = document.querySelectorAll('.bottom-nav .nav-item');
    navItems.forEach(item => {
      item.addEventListener('click', () => {
        const tab = item.getAttribute('data-tab');
        if (tab) this.switchTab(tab);
      });
    });

    // ─────────────────────────────────────────────────────────
    // 2. Podcast 頻道分類與單集列表
    // ─────────────────────────────────────────────────────────
    const filterPills = document.querySelectorAll('.filter-pill');
    filterPills.forEach(pill => {
      pill.addEventListener('click', () => {
        filterPills.forEach(p => p.classList.remove('active'));
        pill.classList.add('active');
        const filter = pill.getAttribute('data-filter') || 'all';
        this._renderPodcastChannels(filter);
        document.getElementById('podcast-channel-grid')?.classList.remove('hidden');
        document.getElementById('podcast-episode-view')?.classList.add('hidden');
      });
    });

    // 返回精選頻道清單
    const btnBackToChannels = document.getElementById('btn-back-to-channels');
    btnBackToChannels?.addEventListener('click', () => {
      this.podcasts.stopPreview();
      document.getElementById('podcast-channel-grid')?.classList.remove('hidden');
      document.getElementById('podcast-episode-view')?.classList.add('hidden');
    });

    // 單集搜尋過濾
    const epSearchInput = document.getElementById('ep-search-input');
    epSearchInput?.addEventListener('input', (e) => {
      const q = e.target.value.toLowerCase().trim();
      this._filterEpisodes(q);
    });

    // 自訂 RSS / URL 解析
    const btnParseCustom = document.getElementById('btn-parse-custom-url');
    const customUrlInput = document.getElementById('custom-url-input');
    btnParseCustom?.addEventListener('click', () => {
      const url = customUrlInput?.value.trim();
      if (url) this._handleCustomUrl(url);
      else this._showToast('請輸入有效的網址', 'error');
    });

    // 常用快捷填入
    const presetBtns = document.querySelectorAll('.preset-btn');
    presetBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        const url = btn.getAttribute('data-url');
        if (customUrlInput && url) {
          customUrlInput.value = url;
          this._handleCustomUrl(url);
        }
      });
    });

    // ─────────────────────────────────────────────────────────
    // 3. 本機拖拽與檔案選取
    // ─────────────────────────────────────────────────────────
    const dropZone = document.getElementById('drop-zone');
    const fileInput = document.getElementById('file-input');
    
    if (dropZone) {
      dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
      dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
      dropZone.addEventListener('drop', e => {
        e.preventDefault();
        dropZone.classList.remove('drag-over');
        if (e.dataTransfer.files.length) this._handleFile(e.dataTransfer.files[0]);
      });
      dropZone.addEventListener('click', () => fileInput && fileInput.click());
    }
    
    if (fileInput) {
      fileInput.addEventListener('change', e => {
        if (e.target.files.length) this._handleFile(e.target.files[0]);
      });
    }
    
    // ─────────────────────────────────────────────────────────
    // 4. 播放器按鈕控制
    // ─────────────────────────────────────────────────────────
    const btnPlayPause = document.getElementById('btn-play-pause');
    if (btnPlayPause) {
      btnPlayPause.addEventListener('click', () => {
        if (!this.player) return;
        if (this.player.state === 'idle' || this.player.state === 'paused') {
          this.player.play();
        } else {
          this.player.pause();
        }
      });
    }
    
    const btnPrev = document.getElementById('btn-prev');
    if (btnPrev) btnPrev.addEventListener('click', () => this.player?.skipToPrev());
    
    const btnNext = document.getElementById('btn-next');
    if (btnNext) btnNext.addEventListener('click', () => this.player?.skipToNext());
    
    const btnReplay = document.getElementById('btn-replay');
    if (btnReplay) btnReplay.addEventListener('click', () => this.player?.replayCurrent());

    // 返回選集清單 / 更換單集
    const btnBackHome = document.getElementById('btn-back-home');
    btnBackHome?.addEventListener('click', () => {
      if (this.player) this.player.pause();
      this._showSection('source');
    });

    // ─────────────────────────────────────────────────────────
    // 5. 設定頁面儲存與即時監聽
    // ─────────────────────────────────────────────────────────
    const btnSaveGroq = document.getElementById('btn-save-groq');
    if (btnSaveGroq) {
      btnSaveGroq.addEventListener('click', () => {
        const val = document.getElementById('groq-key-input')?.value || '';
        this.apiKeys.setGroqKey(val);
        this._showToast(val ? '✅ Groq API Key 已儲存' : '⚠️ Groq API Key 已清除');
      });
    }
    
    const btnSaveGemini = document.getElementById('btn-save-gemini');
    if (btnSaveGemini) {
      btnSaveGemini.addEventListener('click', () => {
        const val = document.getElementById('gemini-key-input')?.value || '';
        this.apiKeys.setGeminiKey(val);
        this._showToast(val ? '✅ Gemini API Key 已儲存' : '⚠️ Gemini API Key 已清除');
      });
    }
    
    // CEFR 滑桿
    const cefrSlider = document.getElementById('cefr-slider');
    if (cefrSlider) {
      const labels = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];
      const cefrLabel = document.getElementById('cefr-label');
      cefrSlider.addEventListener('input', e => {
        const idx = parseInt(e.target.value) - 1;
        if (cefrLabel) cefrLabel.textContent = labels[idx] || 'A1';
        localStorage.setItem('audio_tutor_cefr_threshold', idx);
        if (this.player) this.player.updateOptions({ cefrThreshold: idx });
      });
    }
    
    // TTS 速度
    const ttsRate = document.getElementById('tts-rate');
    if (ttsRate) {
      const ttsRateLabel = document.getElementById('tts-rate-label');
      ttsRate.addEventListener('input', e => {
        if (ttsRateLabel) ttsRateLabel.textContent = parseFloat(e.target.value).toFixed(2);
        localStorage.setItem('audio_tutor_tts_rate', e.target.value);
        if (this.player) this.player.updateOptions({ ttsRate: parseFloat(e.target.value) });
      });
    }
    
    // 重播切換
    const toggleReplay = document.getElementById('toggle-replay');
    if (toggleReplay) {
      toggleReplay.addEventListener('change', e => {
        localStorage.setItem('audio_tutor_replay_original', e.target.checked);
        if (this.player) this.player.updateOptions({ replayOriginal: e.target.checked });
      });
    }
    
    // TTS 語音選擇
    const ttsVoice = document.getElementById('tts-voice');
    if (ttsVoice) {
      ttsVoice.addEventListener('change', e => {
        localStorage.setItem('audio_tutor_tts_voice', e.target.value);
        if (this.player) this.player.updateOptions({ ttsVoice: e.target.value || null });
      });
    }
    
    // 來源語言
    const sourceLang = document.getElementById('source-lang');
    if (sourceLang) {
      sourceLang.addEventListener('change', e => {
        localStorage.setItem('audio_tutor_source_lang', e.target.value);
      });
    }
  }

  switchTab(tabName) {
    this.activeTab = tabName;
    this.podcasts.stopPreview();

    // 更新置底導覽列按鈕 active 狀態
    const navItems = document.querySelectorAll('.bottom-nav .nav-item');
    navItems.forEach(item => {
      const tab = item.getAttribute('data-tab');
      item.classList.toggle('active', tab === tabName);
    });

    // 隱藏所有 tab-section
    const tabSections = document.querySelectorAll('.tab-section');
    tabSections.forEach(sec => sec.classList.add('hidden'));

    // 隱藏 processing & player
    document.getElementById('processing-section')?.classList.add('hidden');
    document.getElementById('player-section')?.classList.add('hidden');

    // 顯示目標 tab-section
    if (tabName === 'podcast') {
      document.getElementById('podcast-section')?.classList.remove('hidden');
    } else if (tabName === 'local') {
      document.getElementById('import-section')?.classList.remove('hidden');
    } else if (tabName === 'custom') {
      document.getElementById('custom-link-section')?.classList.remove('hidden');
    } else if (tabName === 'history') {
      document.getElementById('history-section')?.classList.remove('hidden');
      this._loadHistory();
    } else if (tabName === 'settings') {
      document.getElementById('settings-section')?.classList.remove('hidden');
      this._loadSettings();
    }

    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  _renderPodcastChannels(filter = 'all') {
    const grid = document.getElementById('podcast-channel-grid');
    if (!grid) return;

    grid.innerHTML = '';
    const filtered = filter === 'all' ? CURATED_PODCASTS : CURATED_PODCASTS.filter(p => p.category === filter);

    filtered.forEach(podcast => {
      const card = document.createElement('div');
      card.className = 'channel-card';
      card.style.setProperty('--channel-color', podcast.color || '#4f46e5');

      card.innerHTML = `
        <div class="channel-header">
          <img class="channel-cover" src="${podcast.cover}" alt="${podcast.title}" loading="lazy" onerror="this.src='icon.svg'">
          <div class="channel-info">
            <span class="channel-badge-tag">${podcast.badge}</span>
            <h3 class="channel-title">${podcast.title}</h3>
          </div>
        </div>
        <p class="channel-desc">${podcast.desc}</p>
        <div class="channel-footer">
          <span>${podcast.tag}</span>
          <span class="channel-cta">瀏覽節目 →</span>
        </div>
      `;

      card.addEventListener('click', () => this._openPodcastChannel(podcast));
      grid.appendChild(card);
    });
  }

  async _openPodcastChannel(podcast) {
    this.currentChannel = podcast;
    this.podcasts.stopPreview();

    const grid = document.getElementById('podcast-channel-grid');
    const epView = document.getElementById('podcast-episode-view');
    const loading = document.getElementById('episodes-loading');
    const list = document.getElementById('podcast-episodes-list');

    grid?.classList.add('hidden');
    epView?.classList.remove('hidden');
    loading?.classList.remove('hidden');
    if (list) list.innerHTML = '';

    // Update banner
    const coverImg = document.getElementById('ep-channel-cover');
    if (coverImg) coverImg.src = podcast.cover;
    const titleEl = document.getElementById('ep-channel-title');
    if (titleEl) titleEl.textContent = podcast.title;
    const descEl = document.getElementById('ep-channel-desc');
    if (descEl) descEl.textContent = podcast.desc;
    const badgeEl = document.getElementById('ep-channel-badge');
    if (badgeEl) badgeEl.textContent = podcast.badge;

    // Reset search
    const searchInput = document.getElementById('ep-search-input');
    if (searchInput) searchInput.value = '';

    try {
      const feedData = await this.podcasts.fetchFeed(podcast.feedUrl);
      this.currentEpisodes = feedData.episodes || [];
      if (feedData.cover && coverImg) {
        coverImg.src = feedData.cover;
      }
      loading?.classList.add('hidden');
      this._renderEpisodes(this.currentEpisodes);
    } catch (e) {
      loading?.classList.add('hidden');
      if (list) list.innerHTML = `<div class="empty-state">❌ 無法載入節目清單 (${this._escapeHtml(e.message)})<br>請確認網路連線或稍後再試。</div>`;
    }
  }

  _renderEpisodes(episodes) {
    const list = document.getElementById('podcast-episodes-list');
    if (!list) return;

    list.innerHTML = '';
    if (!episodes || episodes.length === 0) {
      list.innerHTML = '<div class="empty-state">尚無符合條件的單集</div>';
      return;
    }

    episodes.forEach((ep) => {
      const item = document.createElement('div');
      item.className = 'episode-item';

      item.innerHTML = `
        <h4 class="ep-title">${this._escapeHtml(ep.title)}</h4>
        <div class="ep-meta-row">
          ${ep.pubDate ? `<span>📅 ${this._escapeHtml(ep.pubDate)}</span>` : ''}
          ${ep.duration ? `<span>⏱️ ${this._escapeHtml(ep.duration)}</span>` : ''}
        </div>
        ${ep.desc ? `<p class="ep-summary">${this._escapeHtml(ep.desc)}</p>` : ''}
        <div class="ep-actions">
          <button class="btn-preview-audio" data-url="${this._escapeHtml(ep.audioUrl)}">▶️ 試聽</button>
          <button class="btn-learn" data-title="${this._escapeHtml(ep.title)}" data-url="${this._escapeHtml(ep.audioUrl)}">🎧 開始沉浸式學習</button>
        </div>
      `;

      // Preview audio button
      const btnPreview = item.querySelector('.btn-preview-audio');
      btnPreview?.addEventListener('click', (e) => {
        e.stopPropagation();
        this.podcasts.togglePreview(ep.audioUrl, (isPlaying) => {
          document.querySelectorAll('.btn-preview-audio').forEach(b => {
            if (b !== btnPreview) b.textContent = '▶️ 試聽';
          });
          btnPreview.textContent = isPlaying ? '⏸️ 暫停' : '▶️ 試聽';
        });
      });

      // Learn button (import into audio tutor pipeline)
      const btnLearn = item.querySelector('.btn-learn');
      btnLearn?.addEventListener('click', (e) => {
        e.stopPropagation();
        this._startPodcastLearning(ep.title, ep.audioUrl);
      });

      list.appendChild(item);
    });
  }

  _filterEpisodes(query) {
    if (!query) {
      this._renderEpisodes(this.currentEpisodes);
      return;
    }
    const filtered = this.currentEpisodes.filter(ep => 
      ep.title.toLowerCase().includes(query) || (ep.desc && ep.desc.toLowerCase().includes(query))
    );
    this._renderEpisodes(filtered);
  }

  async _handleCustomUrl(url) {
    if (!url) return;
    this.podcasts.stopPreview();

    const loading = document.getElementById('custom-feed-loading');
    const resultBox = document.getElementById('custom-feed-result');

    loading?.classList.remove('hidden');
    resultBox?.classList.add('hidden');
    if (resultBox) resultBox.innerHTML = '';

    // If direct audio URL (.mp3, .m4a, .wav)
    if (url.match(/\.(mp3|m4a|wav|aac|ogg)(\?.*)?$/i)) {
      loading?.classList.add('hidden');
      const title = url.split('/').pop().split('?')[0] || '線上音訊';
      this._startPodcastLearning(title, url);
      return;
    }

    // Try parsing as RSS feed
    try {
      const feedData = await this.podcasts.fetchFeed(url);
      loading?.classList.add('hidden');
      resultBox?.classList.remove('hidden');

      resultBox.innerHTML = `
        <div class="channel-info-banner" style="margin-bottom: 1rem;">
          ${feedData.cover ? `<img src="${feedData.cover}" style="width:56px;height:56px;border-radius:8px;object-fit:cover;">` : ''}
          <div>
            <h4 style="font-weight:bold;font-size:1.05rem;">${this._escapeHtml(feedData.title)}</h4>
            <p style="font-size:0.8rem;color:var(--text-secondary);margin-top:0.2rem;">共 ${feedData.episodes.length} 個單集</p>
          </div>
        </div>
        <div class="podcast-episodes-list"></div>
      `;

      const epListContainer = resultBox.querySelector('.podcast-episodes-list');
      feedData.episodes.forEach(ep => {
        const item = document.createElement('div');
        item.className = 'episode-item';
        item.innerHTML = `
          <h4 class="ep-title">${this._escapeHtml(ep.title)}</h4>
          <div class="ep-meta-row">
            ${ep.pubDate ? `<span>📅 ${this._escapeHtml(ep.pubDate)}</span>` : ''}
            ${ep.duration ? `<span>⏱️ ${this._escapeHtml(ep.duration)}</span>` : ''}
          </div>
          ${ep.desc ? `<p class="ep-summary">${this._escapeHtml(ep.desc)}</p>` : ''}
          <div class="ep-actions">
            <button class="btn-preview-audio">▶️ 試聽</button>
            <button class="btn-learn">🎧 開始沉浸式學習</button>
          </div>
        `;

        const btnPreview = item.querySelector('.btn-preview-audio');
        btnPreview?.addEventListener('click', () => {
          this.podcasts.togglePreview(ep.audioUrl, (isPlaying) => {
            btnPreview.textContent = isPlaying ? '⏸️ 暫停' : '▶️ 試聽';
          });
        });

        const btnLearn = item.querySelector('.btn-learn');
        btnLearn?.addEventListener('click', () => {
          this._startPodcastLearning(ep.title, ep.audioUrl);
        });

        epListContainer.appendChild(item);
      });
    } catch (e) {
      loading?.classList.add('hidden');
      resultBox?.classList.remove('hidden');
      resultBox.innerHTML = `<div class="empty-state">❌ RSS 解析失敗：${this._escapeHtml(e.message)}<br>若這是一個直接音訊連結，請確保附帶副檔名。</div>`;
    }
  }

  async _startPodcastLearning(title, audioUrl) {
    if (!this.apiKeys.hasAllKeys()) {
      this.switchTab('settings');
      this._showToast('⚠️ 請先填入 Groq 與 Gemini API 密鑰', 'error');
      return;
    }

    this._showSection('processing');
    this._updateProgress('extract', 10, `正在下載單集音訊：${title}...`);

    try {
      const audioFile = await this.podcasts.downloadEpisodeAudio(audioUrl, title, (msg, pct) => {
        this._updateProgress('extract', pct, msg);
      });

      await this._handleFile(audioFile);
    } catch (e) {
      console.error('Podcast learning failed:', e);
      this._showToast(`❌ 載入失敗：${e.message}`, 'error');
      this._showSection('source');
    }
  }
  
  _loadSettings() {
    const groqKey = this.apiKeys.getGroqKey();
    const geminiKey = this.apiKeys.getGeminiKey();
    const lang = localStorage.getItem('audio_tutor_source_lang') || 'en';
    const rate = localStorage.getItem('audio_tutor_tts_rate') || '1.05';
    const cefr = localStorage.getItem('audio_tutor_cefr_threshold') || '2';  // 預設 B1 (index 2)
    const replay = localStorage.getItem('audio_tutor_replay_original') !== 'false';
    
    const groqInput = document.getElementById('groq-key-input');
    if (groqInput) groqInput.value = groqKey;

    const geminiInput = document.getElementById('gemini-key-input');
    if (geminiInput) geminiInput.value = geminiKey;

    const langEl = document.getElementById('source-lang');
    if (langEl) langEl.value = lang;
    
    const rateEl = document.getElementById('tts-rate');
    const ttsRateLabel = document.getElementById('tts-rate-label');
    if (rateEl) rateEl.value = rate;
    if (ttsRateLabel) ttsRateLabel.textContent = parseFloat(rate).toFixed(2);
    
    const cefrEl = document.getElementById('cefr-slider');
    if (cefrEl) {
      cefrEl.value = parseInt(cefr) + 1;
      const labels = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];
      const cefrLabel = document.getElementById('cefr-label');
      if (cefrLabel) cefrLabel.textContent = labels[cefr] || 'B1';
    }
    
    const replayEl = document.getElementById('toggle-replay');
    if (replayEl) replayEl.checked = replay;
  }
  
  _populateVoices() {
    if (!window.speechSynthesis) return;
    const voices = window.speechSynthesis.getVoices();
    const select = document.getElementById('tts-voice');
    if (!select || voices.length === 0) return;
    
    const savedVoice = localStorage.getItem('audio_tutor_tts_voice');
    select.innerHTML = '<option value="">系統預設繁中語音</option>';
    
    const zhVoices = voices.filter(v => v.lang.startsWith('zh'));
    zhVoices.forEach(v => {
      const option = document.createElement('option');
      option.value = v.name;
      option.textContent = `${v.name} (${v.lang})`;
      if (savedVoice === v.name) option.selected = true;
      select.appendChild(option);
    });
  }
  
  async _loadHistory() {
    const list = document.getElementById('history-list');
    if (!list) return;
    
    try {
      const sessions = await this.storage.listSessions();
      list.innerHTML = '';
      if (sessions.length === 0) {
        list.innerHTML = '<p class="empty-state">尚無學習紀錄</p>';
        return;
      }
      
      sessions.forEach(session => {
        const card = document.createElement('div');
        card.className = 'history-card';
        
        const info = document.createElement('div');
        info.className = 'history-info';
        const date = new Date(session.date).toLocaleDateString('zh-TW');
        info.innerHTML = `<h4 class="history-name">${this._escapeHtml(session.fileName)}</h4>
                          <p class="history-meta">${date} · ${session.segments?.length || 0} 句精聽解析</p>`;
        
        const actions = document.createElement('div');
        actions.className = 'history-actions';
        
        const btnResume = document.createElement('button');
        btnResume.className = 'btn-resume';
        btnResume.textContent = '▶ 繼續精聽';
        btnResume.onclick = () => this._resumeSession(session.id);
        
        const btnDel = document.createElement('button');
        btnDel.className = 'btn-delete';
        btnDel.textContent = '✕';
        btnDel.title = '刪除紀錄';
        btnDel.onclick = (e) => { e.stopPropagation(); this._deleteSession(session.id); };
        
        actions.appendChild(btnResume);
        actions.appendChild(btnDel);
        
        card.appendChild(info);
        card.appendChild(actions);
        list.appendChild(card);
      });
    } catch(e) {
      console.warn('Failed to load history', e);
    }
  }
  
  _escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }
  
  async _handleFile(file) {
    if (!this.apiKeys.hasAllKeys()) {
      this.switchTab('settings');
      this._showToast('⚠️ 請先設定 Groq 與 Gemini API Keys', 'error');
      return;
    }
    
    this._showSection('processing');
    
    const pipeline = new AudioPipeline(
      { groqKey: this.apiKeys.getGroqKey(), geminiKey: this.apiKeys.getGeminiKey() },
      (stage, pct, msg) => this._updateProgress(stage, pct, msg)
    );
    
    try {
      // Stage 1: 音軌抽取
      this._activateStage('extract');
      let audioBlob;
      if (file.type && file.type.startsWith('audio/')) {
        audioBlob = file;
        this._updateProgress('extract', 100, '音檔就緒');
        this._completeStage('extract');
      } else {
        audioBlob = await pipeline.extractAudio(file);
        this._completeStage('extract');
      }
      
      // Stage 2: 語音辨識
      this._activateStage('transcribe');
      const sourceLang = document.getElementById('source-lang')?.value || 'en';
      const segments = await pipeline.transcribe(audioBlob, sourceLang);
      if (!segments || segments.length === 0) {
        throw new Error('未能辨識出任何文字');
      }
      this._completeStage('transcribe');
      
      // Stage 3: Gemini 語意解析
      this._activateStage('analyze');
      const enrichedSegments = await pipeline.analyzeWithGemini(segments, sourceLang);
      this._completeStage('analyze');
      
      // 存檔
      const session = {
        id: Date.now().toString(),
        fileName: file.name,
        date: new Date().toISOString(),
        segments: enrichedSegments
      };
      
      await this.storage.saveSession(session);
      await this.storage.saveAudio(audioBlob, session.id);
      this.currentSession = session;
      
      this._initPlayer(audioBlob, enrichedSegments, file.name);
      
    } catch(e) {
      console.error('Pipeline error:', e);
      this._showToast(`❌ 處理失敗：${e.message}`, 'error');
      this._showSection('source');
    }
  }
  
  _initPlayer(audioBlob, segments, fileName) {
    if (this.player) this.player.destroy();
    
    const cefrThreshold = parseInt(localStorage.getItem('audio_tutor_cefr_threshold') || '2');
    const replayOriginal = localStorage.getItem('audio_tutor_replay_original') !== 'false';
    const ttsRate = parseFloat(localStorage.getItem('audio_tutor_tts_rate') || '1.05');
    const ttsVoice = localStorage.getItem('audio_tutor_tts_voice') || null;
    
    this.player = new AudioTutorPlayer(audioBlob, segments, {
      replayOriginal,
      ttsRate,
      ttsVoice,
      cefrThreshold,
      onStateChange: (state, idx) => this._onPlayerStateChange(state, idx),
      onSegmentChange: (idx, seg) => this._onSegmentChange(idx, seg)
    });
    
    this.player.setupMediaSession(fileName);
    
    const fileNameEl = document.getElementById('file-name');
    if (fileNameEl) fileNameEl.textContent = fileName;
    
    const progressEl = document.getElementById('sentence-progress');
    if (progressEl) progressEl.textContent = `第 1 / ${segments.length} 句`;
    
    this._showSection('player');
    this._loadHistory();
    
    // 顯示第一句
    if (this.player.timeline.length > 0) {
      this._onSegmentChange(0, this.player.timeline[0]);
    }
  }
  
  _onPlayerStateChange(state, idx) {
    const stateEl = document.getElementById('play-state');
    const btnPlayPause = document.getElementById('btn-play-pause');
    const stateLabels = {
      'idle': '⏹ 已停止',
      'playing_original': '🔊 播放原文',
      'speaking_explanation': '🗣️ 語音講解',
      'replaying_original': '🔁 重播原文',
      'paused': '⏸ 已暫停'
    };
    if (stateEl) stateEl.textContent = stateLabels[state] || state;
    if (btnPlayPause) btnPlayPause.textContent = (state === 'paused' || state === 'idle') ? '▶️' : '⏸️';
    
    // 更新 MediaSession
    if (this.player && 'mediaSession' in navigator) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: '精聽學習中',
        artist: `第 ${idx + 1} / ${this.player.timeline.length} 句`,
        album: document.getElementById('file-name')?.textContent || 'Audio Tutor'
      });
    }
  }
  
  _onSegmentChange(idx, seg) {
    const progressEl = document.getElementById('sentence-progress');
    if (progressEl) progressEl.textContent = `第 ${idx + 1} / ${this.player.timeline.length} 句`;
    
    const origTextEl = document.getElementById('original-text');
    if (origTextEl) origTextEl.textContent = seg.text;
    
    const explTextEl = document.getElementById('explanation-text');
    if (explTextEl) explTextEl.textContent = seg.explanation || '';
    
    // CEFR 徽章
    const badge = document.getElementById('cefr-badge');
    if (badge) {
      const cefr = seg.cefr || 'B1';
      badge.textContent = cefr;
      badge.className = `cefr-badge cefr-${cefr.toLowerCase()}`;
      badge.classList.remove('hidden');
    }
    
    // Seek bar
    const seekFill = document.querySelector('#seek-bar .seek-fill');
    if (seekFill) seekFill.style.width = `${((idx + 1) / this.player.timeline.length) * 100}%`;
  }
  
  _updateProgress(stage, pct, msg) {
    const fill = document.querySelector(`#stage-${stage} .progress-fill`);
    const status = document.querySelector(`#stage-${stage} .status-text`);
    if (fill) fill.style.width = `${pct}%`;
    if (status) status.textContent = msg;
  }
  
  _activateStage(stage) {
    const el = document.getElementById(`stage-${stage}`);
    if (el) el.classList.add('active');
  }
  
  _completeStage(stage) {
    const el = document.getElementById(`stage-${stage}`);
    if (el) {
      el.classList.remove('active');
      el.classList.add('done');
      const fill = el.querySelector('.progress-fill');
      if (fill) fill.style.width = '100%';
      const status = el.querySelector('.status-text');
      if (status) status.textContent = '✓ 完成';
    }
  }
  
  _showSection(name) {
    const tabSections = document.querySelectorAll('.tab-section');
    const procSec = document.getElementById('processing-section');
    const playerSec = document.getElementById('player-section');
    const bottomNav = document.getElementById('bottom-nav');
    
    if (name === 'source') {
      this.switchTab(this.activeTab || 'podcast');
    } else if (name === 'processing') {
      tabSections.forEach(sec => sec.classList.add('hidden'));
      procSec?.classList.remove('hidden');
      playerSec?.classList.add('hidden');

      // 重置所有 stage
      document.querySelectorAll('.stage').forEach(el => {
        el.classList.remove('active', 'done');
        const fill = el.querySelector('.progress-fill');
        if (fill) fill.style.width = '0%';
        const status = el.querySelector('.status-text');
        if (status) status.textContent = '等待中...';
      });
    } else if (name === 'player') {
      tabSections.forEach(sec => sec.classList.add('hidden'));
      procSec?.classList.add('hidden');
      playerSec?.classList.remove('hidden');
    }
  }
  
  _showToast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = message;
    container.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add('show'));
    setTimeout(() => {
      toast.classList.remove('show');
      setTimeout(() => toast.remove(), 300);
    }, 4000);
  }
  
  async _resumeSession(sessionId) {
    try {
      const session = await this.storage.loadSession(sessionId);
      const audioBlob = await this.storage.loadAudio(sessionId);
      if (!session || !audioBlob) { 
        this._showToast('找不到學習紀錄或音訊檔案', 'error'); 
        return; 
      }
      this.currentSession = session;
      this._initPlayer(audioBlob, session.segments, session.fileName);
    } catch(e) {
      this._showToast(`讀取失敗：${e.message}`, 'error');
    }
  }
  
  async _deleteSession(sessionId) {
    try {
      await this.storage.deleteSession(sessionId);
      this._loadHistory();
      this._showToast('已刪除學習紀錄');
    } catch(e) {
      this._showToast(`刪除失敗：${e.message}`, 'error');
    }
  }
}

// 啟動應用
document.addEventListener('DOMContentLoaded', () => {
  window.app = new UIController();
});

})();
