const CACHE = 'bwr-v3';
const TILE_CACHE = 'bwr-offline-tiles';

// Install — skip waiting so update kicks in immediately
self.addEventListener('install', e => {
  self.skipWaiting();
});

// Activate — delete old caches and take control
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE && k !== TILE_CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Fetch — network first for HTML/JS/CSS, cache fallback when offline
self.addEventListener('fetch', e => {
  const url = e.request.url;

  // Always network for API
  if (url.includes('/api/') || url.includes('overpass')) {
    e.respondWith(fetch(e.request).catch(() => new Response('{"error":"offline"}', { status: 503, headers: { 'Content-Type': 'application/json' } })));
    return;
  }

  // Tiles — network first, fallback to offline tile cache
  if (url.includes('tile') || url.includes('opentopomap') || url.includes('geopf.fr')) {
    e.respondWith(
      fetch(e.request).catch(() =>
        caches.open(TILE_CACHE).then(c => c.match(e.request))
      )
    );
    return;
  }

  // Network first for app files — ensures latest version
  if (e.request.method === 'GET' &&
      (url.endsWith('.html') || url.endsWith('.js') || url.endsWith('.css'))) {
    e.respondWith(
      fetch(e.request).then(res => {
        if (res && res.status === 200 && res.type !== 'opaque') {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return res;
      }).catch(() => caches.match(e.request))
    );
    return;
  }

  // Cache first for other assets (images, fonts)
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request))
  );
});
