/**
 * Audio Tutor PWA - Service Worker
 * 提供離線快取支援與網路優先策略 (支援 GitHub Pages 與本地端)
 */

const CACHE_NAME = 'audio-tutor-v6.4';
const PRECACHE_ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.json',
  './icon.svg',
  './sparse-audio.mjs',
  './extract-worker.js',
  './vendor/mediabunny.min.mjs'
];

// 安裝階段：預先快取核心靜態資源
self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      await Promise.allSettled(
        PRECACHE_ASSETS.map((url) =>
          cache.add(url).catch((err) => {
            console.warn(`[Service Worker] 快取失敗: ${url}`, err);
          })
        )
      );
    })
  );
});

// 啟用階段：清除舊版本的快取並立即接管所有頁面
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            console.log(`[Service Worker] 清除舊快取: ${key}`);
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
    hostname.includes('api.') ||
    url.pathname.startsWith('/api/')
  );
}

// 擷取階段策略：Network First (網路優先，斷網時才使用離線快取)
self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  if (!url.protocol.startsWith('http')) return;

  // 1. API 請求：Network Only / Network First
  if (isApiRequest(url) || req.method !== 'GET') {
    event.respondWith(
      fetch(req).catch(async (err) => {
        const cached = await caches.match(req);
        if (cached) return cached;
        throw err;
      })
    );
    return;
  }

  // 2. 靜態代碼與資源：Network First（確保每次發布代碼能第一時間更新，斷網時回退快取）
  event.respondWith(
    fetch(req)
      .then((networkResponse) => {
        if (networkResponse && networkResponse.status === 200 && networkResponse.type !== 'opaque') {
          const responseToCache = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(req, responseToCache);
          });
        }
        return networkResponse;
      })
      .catch(async () => {
        const cachedResponse = await caches.match(req);
        if (cachedResponse) {
          return cachedResponse;
        }
        if (req.mode === 'navigate') {
          const cachedIndex = await caches.match('./index.html') || await caches.match('index.html');
          if (cachedIndex) return cachedIndex;
        }
        return new Response('離線狀態，無法載入資源', {
          status: 503,
          headers: { 'Content-Type': 'text/plain; charset=utf-8' }
        });
      })
  );
});

