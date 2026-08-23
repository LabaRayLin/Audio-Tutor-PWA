/**
 * Audio Tutor PWA - Service Worker
 * 提供離線快取支援與 API 網路優先策略
 */

const CACHE_NAME = 'audio-tutor-v1';
const PRECACHE_ASSETS = [
  '/',
  '/index.html',
  '/style.css',
  '/app.js',
  '/manifest.json',
  '/icon.svg',
  '/sparse-audio.mjs',
  '/extract-worker.js',
  '/vendor/mediabunny.min.mjs'
];

// 安裝階段：預先快取核心靜態資源
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      // 容錯快取：逐一加入，避免單一檔案失敗導致整個 install 失敗
      await Promise.allSettled(
        PRECACHE_ASSETS.map((url) =>
          cache.add(url).catch((err) => {
            console.warn(`[Service Worker] 快取失敗: ${url}`, err);
          })
        )
      );
    }).then(() => self.skipWaiting())
  );
});

// 啟用階段：清除舊版本的快取
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

// 判斷是否為 API 呼叫（如 Groq, Google APIs）
function isApiRequest(url) {
  const hostname = url.hostname.toLowerCase();
  return (
    hostname.includes('groq.com') ||
    hostname.includes('googleapis.com') ||
    hostname.includes('api.')
  );
}

// 擷取階段策略
self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // 僅處理 http/https 請求，忽略 chrome-extension 等
  if (!url.protocol.startsWith('http')) return;

  // 1. API 請求：Network-first（網路優先）
  if (isApiRequest(url) || req.method !== 'GET') {
    event.respondWith(
      fetch(req).catch(async (err) => {
        // 若網路不可用，嘗試從快取中讀取（若有）
        const cached = await caches.match(req);
        if (cached) return cached;
        throw err;
      })
    );
    return;
  }

  // 2. 靜態資源：Cache-first（快取優先，若無則抓取並寫入快取）
  event.respondWith(
    caches.match(req).then((cachedResponse) => {
      if (cachedResponse) {
        return cachedResponse;
      }

      return fetch(req).then((networkResponse) => {
        // 僅快取成功的 GET 請求
        if (
          !networkResponse ||
          networkResponse.status !== 200 ||
          networkResponse.type === 'opaque'
        ) {
          return networkResponse;
        }

        const responseToCache = networkResponse.clone();
        caches.open(CACHE_NAME).then((cache) => {
          cache.put(req, responseToCache);
        });

        return networkResponse;
      }).catch(async () => {
        // 導航請求若離線且找不到，回傳預設的 index.html
        if (req.mode === 'navigate') {
          const cachedIndex = await caches.match('/index.html');
          if (cachedIndex) return cachedIndex;
        }
        return new Response('離線狀態，無法載入資源', {
          status: 503,
          headers: { 'Content-Type': 'text/plain; charset=utf-8' }
        });
      });
    })
  );
});
