/* 現場の空 v0.8: ホーム画面用のアプリ本体をオフライン保存 */
const CACHE = 'genba-no-sora-shell-v0.45-amedas-temp1';
const PREFIX = 'genba-no-sora-shell-';
const SHELL = [
  './', './index.html', './municipalities-gsi.js', './location-label.js', './weather-watch-auto.js', './model-comparison.js', './observation-verification.js', './amedas-nearby.js', './manifest.webmanifest', './icon.svg',
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
  // The backend connection switches from disabled to enabled only after
  // a private push server exists. Never cache stale push config forever.
  if (url.pathname.endsWith('/push-config.json')) {
    event.respondWith(fetch(request,{cache:'no-store'}).catch(()=>
      new Response('{"schema":1,"backendOrigin":""}',{
        headers:{'content-type':'application/json;charset=utf-8'}
      })
    ));
    return;
  }

  if (request.mode === 'navigate') {
    // Only cache the actual app homepage as the offline app shell.
    // Independent setup pages must never replace the app's cached index.html.
    const scopePath = new URL(self.registration.scope).pathname;
    const isAppHome = (url.pathname === scopePath ||
      url.pathname === scopePath + 'index.html');
    if (!isAppHome) return;
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
/* v0.10: Daily reminder receiver only.
   Actual push subscription & secure server scheduling are NOT implemented yet. */
self.addEventListener('push', (event) => {
  let message=null;
  try {
    if(event.data)message=event.data.json();
  }catch(_){}
  const isWatch=message?.data?.kind==='weather-watch'&&
    typeof message.body==='string'&&message.body.length<=600;
  event.waitUntil(self.registration.showNotification(
    isWatch?'하늘 · 天気の変化':'하늘', {
      body: isWatch?message.body:'今日の現場のお天気はどう？☁️ タップして記録してね ♡',
      icon: './icon-192.png',
      badge: './icon-192.png',
      tag: isWatch?'weather-watch-change':'daily-weather-check',
      data: { kind: isWatch?'weather-watch':'daily-weather-record' }
    }
  ));
});
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const destination=event.notification.data?.kind==='weather-watch'?
    '#home':'#weather-record';
  const target = new URL(destination, self.registration.scope).href;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const scopeUrl = new URL(self.registration.scope);
    for (const client of windows) {
      try {
        const url = new URL(client.url);
        if (url.origin !== scopeUrl.origin || !url.pathname.startsWith(scopeUrl.pathname)) continue;
        if ('navigate' in client) {
          await client.navigate(target);
        }
        if ('focus' in client) return client.focus();
      } catch (err) {
        // A closed/invalid client is not a reason to lose the reminder.
      }
    }
    if (self.clients.openWindow) return self.clients.openWindow(target);
  })());
});
