const CACHE = 'bwr-v2';

const SHELL = [
  '/bwr-project/map.html',
  '/bwr-project/index.html',
  '/bwr-project/login.html',
  '/bwr-project/css/style.css',
  '/bwr-project/css/login.css',
  '/bwr-project/js/config.js',
  '/bwr-project/js/auth.js',
  '/bwr-project/js/map.js',
  '/bwr-project/icons/icon.svg',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
];

// Install — cache the app shell
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(SHELL)).catch(() => {})
  );
  self.skipWaiting();
});

// Activate — delete old caches
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Fetch — network first for API, cache first for everything else
self.addEventListener('fetch', e => {
  const url = e.request.url;

  // Always go to network for API and tile requests
  if (url.includes('/api/') || url.includes('tile') || url.includes('overpass')) {
    e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
    return;
  }

  // Cache first for static assets
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(res => {
        if (res && res.status === 200 && res.type !== 'opaque') {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return res;
      });
    })
  );
});
