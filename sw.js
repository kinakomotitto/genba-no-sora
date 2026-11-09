/* 現場の空 v0.8: ホーム画面用のアプリ本体をオフライン保存 */
const CACHE = 'genba-no-sora-shell-v0.9.1';
const PREFIX = 'genba-no-sora-shell-';
const SHELL = [
  './', './index.html', './manifest.webmanifest', './icon.svg',
  './icon-180.png', './icon-192.png', './icon-512.png'
];
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting())
  );
});
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(key => key.startsWith(PREFIX) && key !== CACHE)
          .map(key => caches.delete(key))
    )).then(() => self.clients.claim())
  );
});
self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).then(response => {
        if (response.ok) {
          const copy = response.clone();
          event.waitUntil(caches.open(CACHE).then(c => c.put('./index.html', copy)).catch(() => {}));
        }
        return response;
      }).catch(() => caches.match('./index.html').then(cached => cached || Response.error()))
    );
    return;
  }
  event.respondWith(
    caches.match(request).then(cached => cached || fetch(request).then(response => {
      if (response.ok) {
        const copy = response.clone();
        event.waitUntil(caches.open(CACHE).then(c => c.put(request, copy)).catch(() => {}));
      }
      return response;
    }))
  );
});