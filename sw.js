// Service worker — offline-first for the app shell.
const CACHE = 'worklog-v39';
const SHELL = [
  './',
  './index.html',
  './css/styles.css',
  './js/app.js',
  './js/store.js',
  './js/util.js',
  './js/pdf.js',
  './js/csv.js',
  './js/icons.js',
  './js/pickers.js',
  './js/finance.js',
  './js/config.js',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  // Fetch the shell with cache:'reload' so we never bake a stale HTTP-cached
  // copy into a fresh cache version.
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => Promise.all(SHELL.map((u) => fetch(new Request(u, { cache: 'reload' })).then((r) => c.put(u, r)).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

// Background push from the reminder cron → show a system notification.
self.addEventListener('push', (e) => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch (_) { data = { body: e.data && e.data.text() }; }
  const title = data.title || 'שעון עבודה';
  const body = data.body || 'עוד לא רשמת שעות היום — הקש כדי להזין';
  // Unique tag per push so each one alerts (a fixed tag silently replaces the
  // previous notification without re-alerting on many devices).
  const tag = data.tag || ('wl-' + Date.now());
  e.waitUntil(self.registration.showNotification(title, {
    body, tag, renotify: true, vibrate: [120, 60, 120],
    icon: './icons/icon-192.png', badge: './icons/icon-192.png',
    dir: 'rtl', lang: 'he', data: { url: './' },
  }));
});

// Tapping a reminder notification focuses an open tab or opens the app.
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) { if ('focus' in c) return c.focus(); }
    if (self.clients.openWindow) return self.clients.openWindow('./');
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Never touch Firebase reserved paths (auth handler/iframe) or auth traffic —
  // the SW must not intercept /__/auth/* or serve index.html in their place.
  if (url.pathname.startsWith('/__/')) return;
  if (/firestore|googleapis|firebaseio|identitytoolkit|gstatic\.com\/firebasejs/.test(url.href)) return;

  // Same-origin app shell: NETWORK-FIRST so updates show up immediately when
  // online; fall back to cache (then index.html) only when offline.
  if (url.origin === location.origin) {
    // network-first, bypassing the HTTP cache entirely so a new deploy always
    // wins; fall back to the Cache API (then index.html) only when offline.
    e.respondWith(
      fetch(new Request(req.url, { cache: 'no-store' })).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        return res;
      }).catch(() => caches.match(req).then((hit) => hit || caches.match('./index.html')))
    );
    return;
  }

  // Cross-origin (fonts, CDN libs for PDF): stale-while-revalidate.
  e.respondWith(
    caches.match(req).then((hit) => {
      const net = fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        return res;
      }).catch(() => hit);
      return hit || net;
    })
  );
});
