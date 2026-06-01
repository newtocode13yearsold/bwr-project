const CACHE = 'bwr-v18';
const TILE_CACHE = 'bwr-offline-tiles';
const TILE_MAX_ENTRIES = 500;
const TILE_MAX_AGE_MS  = 7 * 24 * 60 * 60 * 1000; // 7 days

const APP_SHELL = [
  '/',
  'map',
  'admin',
  'routes',
  'profile',
  'login',
  'plans',
  'news',
  'verify',
  'changelog',
  'leaderboard',
  'manifest.json',
  'icons/icon.svg',
  'lib/leaflet.js',
  'lib/leaflet.css',
  'js/config.js',
  'js/auth.js',
  'js/features.js',
  'js/carrefours.js',
  'js/map.js',
  'js/admin.js',
  'js/routes.js',
  'js/profile.js',
  'js/login.js',
  'js/graph-router.js',
  'js/exporters.js',
  'js/news.js',
  'js/install.js',
  'css/tokens.css',
  'css/style.css',
  'css/login.css',
  'css/plans.css',
  'css/upsell.css',
  'css/routes.css',
  'css/home.css',
  'css/profile.css',
];

// CDN resources still fetched from external CDN (leaflet-draw, admin only)
const CDN_SHELL = [
  'https://unpkg.com/leaflet-draw@1.0.4/dist/leaflet.draw.css',
  'https://unpkg.com/leaflet-draw@1.0.4/dist/leaflet.draw.js',
];

// Install — pre-cache app shell so the app works offline immediately after install
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(async cache => {
      // Local files — must succeed
      await cache.addAll(APP_SHELL);
      // CDN files — best-effort with CORS so responses are cacheable
      await Promise.all(CDN_SHELL.map(url =>
        fetch(new Request(url, { mode: 'cors' }))
          .then(res => { if (res.ok) return cache.put(url, res); })
          .catch(() => {})
      ));
    }).then(() => self.skipWaiting())
  );
});

// Activate — delete old caches and take control immediately
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

  // Tiles — cache first so panning offline is instant; re-fetch when stale or not cached
  if (url.includes('tile') || url.includes('opentopomap') || url.includes('geopf.fr')) {
    e.respondWith(
      caches.open(TILE_CACHE).then(async cache => {
        const cached = await cache.match(e.request);
        if (cached) {
          const age = Date.now() - new Date(cached.headers.get('date') || 0).getTime();
          if (age < TILE_MAX_AGE_MS) return cached;
        }
        const res = await fetch(e.request);
        if (res && res.ok) {
          // Evict oldest entries once the cache reaches the size limit
          const keys = await cache.keys();
          if (keys.length >= TILE_MAX_ENTRIES) {
            await Promise.all(keys.slice(0, keys.length - TILE_MAX_ENTRIES + 1).map(k => cache.delete(k)));
          }
          cache.put(e.request, res.clone());
        }
        return res;
      }).catch(() => new Response('', { status: 504 }))
    );
    return;
  }

  // Network first for app files — ensures latest version is always served when online
  // Navigate requests to .html URLs: the SW redirects to the clean URL (e.g. /map.html → /map).
  // Cloudflare also redirects .html → clean URL, but Chrome raises ERR_FAILED when a SW
  // returns any kind of redirect response (opaque or followed) for a navigate request
  // whose redirect mode is 'manual' (which Chrome always sets on navigate requests).
  // Responding with our own 302 here lets the browser follow it cleanly.
  if (e.request.mode === 'navigate' && url.endsWith('.html')) {
    e.respondWith(Promise.resolve(Response.redirect(url.replace(/\.html$/, ''), 302)));
    return;
  }

  if (e.request.method === 'GET' &&
      (e.request.mode === 'navigate' ||
       url.endsWith('.html') || url.endsWith('.js') || url.endsWith('.css') ||
       url.includes('unpkg.com') || url.includes('fonts.googleapis.com') || url.includes('fonts.gstatic.com'))) {
    e.respondWith(
      fetch(e.request).then(res => {
        if (res && res.status === 200 && res.type !== 'opaque') {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
          return res;
        }
        // Non-200 from network (e.g. CDN 503) → fall back to cache
        return caches.match(e.request).then(cached => cached || res);
      }).catch(() => caches.match(e.request))
    );
    return;
  }

  // Cache first for other assets (images, fonts, etc.)
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request))
  );
});
