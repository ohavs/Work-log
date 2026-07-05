// Service worker — offline-first for the app shell.
const CACHE = 'worklog-v26';
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
