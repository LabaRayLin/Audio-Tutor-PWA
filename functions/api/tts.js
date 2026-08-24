/**
 * Cloudflare Pages Functions - /api/tts
 * 處理 Edge-TTS 語音合成代理 (自動隨 GitHub 推送生效)
 */

export async function onRequest(context) {
  const { request } = context;

  // 1. 處理 CORS 預檢請求
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Max-Age': '86400',
      }
    });
  }

  const url = new URL(request.url);
  let text = '';
  let voice = 'zh-TW-HsiaoChenNeural';
  let rateStr = '+0%';

  if (request.method === 'POST') {
    try {
      const body = await request.json();
      text = body.text || body.input || '';
      voice = body.voice || voice;
      if (body.speed !== undefined) {
        const p = Math.round((parseFloat(body.speed) - 1.0) * 100);
        rateStr = (p >= 0 ? `+${p}%` : `${p}%`);
      } else if (body.rate !== undefined) {
        rateStr = String(body.rate);
        if (!rateStr.endsWith('%')) {
          const r = parseFloat(rateStr);
          if (!isNaN(r)) {
            const p = Math.round((r - 1.0) * 100);
            rateStr = (p >= 0 ? `+${p}%` : `${p}%`);
          }
        }
      }
    } catch (e) {
      return new Response(JSON.stringify({ error: '無效的 JSON 格式' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }
  } else {
    text = url.searchParams.get('text') || '';
    voice = url.searchParams.get('voice') || voice;
    rateStr = url.searchParams.get('rate') || '+0%';
  }

  if (!text || !text.trim()) {
    return new Response(JSON.stringify({ error: '請提供 text 或 input 參數' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }

  const connId = crypto.randomUUID().replace(/-/g, '');
  const reqId = crypto.randomUUID().replace(/-/g, '');
  const wsUrl = `wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=6A5AA1D4EA651143B48DA8F676841211&ConnectionId=${connId}`;

  try {
    const resp = await fetch(wsUrl, {
      headers: {
        'Upgrade': 'websocket',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0',
        'Origin': 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
        'Pragma': 'no-cache',
        'Cache-Control': 'no-cache'
      }
    });

    const ws = resp.webSocket;
    if (!ws) {
      return new Response(JSON.stringify({ error: '無法建立 Edge-TTS WebSocket 連線' }), {
        status: 502,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }

    ws.accept();

    return await new Promise((resolve) => {
      const audioParts = [];
      let isCompleted = false;

      const timeout = setTimeout(() => {
        if (!isCompleted) {
          isCompleted = true;
          try { ws.close(); } catch(e){}
          resolve(new Response(JSON.stringify({ error: 'Edge-TTS 請求超時' }), {
            status: 504,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
          }));
        }
      }, 15000);

      // 1. 發送設定與 SSML
      const configMsg = "Content-Type:application/json;charset=utf-8\r\nPath:speech.config\r\n\r\n" +
        JSON.stringify({
          context: {
            synthesis: {
              audio: {
                metadataoptions: { sentenceBoundaryEnabled: "false", wordBoundaryEnabled: "false" },
                outputFormat: "audio-24khz-48kbitrate-mono-mp3"
              }
            }
          }
        });
      ws.send(configMsg);

      const cleanText = text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
      const dateStr = new Date().toUTCString();
      const ssmlMsg = `X-RequestId:${reqId}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${dateStr}\r\nPath:ssml\r\n\r\n` +
        `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='zh-TW'>` +
        `<voice name='${voice}'><prosody pitch='+0Hz' rate='${rateStr}'>${cleanText}</prosody></voice>` +
        `</speak>`;
      ws.send(ssmlMsg);

      // 2. 接收音訊二進位流
      ws.addEventListener('message', (event) => {
        if (typeof event.data === 'string') {
          if (event.data.includes('Path:turn.end')) {
            if (isCompleted) return;
            isCompleted = true;
            clearTimeout(timeout);
            try { ws.close(); } catch(e){}

            const totalLen = audioParts.reduce((acc, p) => acc + p.byteLength, 0);
            const combined = new Uint8Array(totalLen);
            let offset = 0;
            for (const part of audioParts) {
              combined.set(new Uint8Array(part), offset);
              offset += part.byteLength;
            }

            resolve(new Response(combined, {
              status: 200,
              headers: {
                'Content-Type': 'audio/mpeg',
                'Access-Control-Allow-Origin': '*',
                'Cache-Control': 'public, max-age=86400'
              }
            }));
          }
        } else if (event.data instanceof ArrayBuffer) {
          const dv = new DataView(event.data);
          if (event.data.byteLength >= 2) {
            const headerLen = dv.getUint16(0);
            if (event.data.byteLength >= 2 + headerLen) {
              const headerBytes = new Uint8Array(event.data, 2, headerLen);
              const headerStr = new TextDecoder().decode(headerBytes);
              if (headerStr.includes('Path:audio')) {
                const audioBytes = event.data.slice(2 + headerLen);
                if (audioBytes.byteLength > 0) {
                  audioParts.push(audioBytes);
                }
              }
            }
          }
        }
      });

      ws.addEventListener('error', (err) => {
        if (isCompleted) return;
        isCompleted = true;
        clearTimeout(timeout);
        resolve(new Response(JSON.stringify({ error: 'Edge-TTS 連線發生錯誤' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        }));
      });

      ws.addEventListener('close', () => {
        if (!isCompleted && audioParts.length > 0) {
          isCompleted = true;
          clearTimeout(timeout);
          const totalLen = audioParts.reduce((acc, p) => acc + p.byteLength, 0);
          const combined = new Uint8Array(totalLen);
          let offset = 0;
          for (const part of audioParts) {
            combined.set(new Uint8Array(part), offset);
            offset += part.byteLength;
          }
          resolve(new Response(combined, {
            status: 200,
            headers: {
              'Content-Type': 'audio/mpeg',
              'Access-Control-Allow-Origin': '*',
              'Cache-Control': 'public, max-age=86400'
            }
          }));
        }
      });
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: `連線失敗: ${err.message}` }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }
}
