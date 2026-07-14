// Offline report outbox (IndexedDB) — shared with the map page. Loaded here so
// the `sync` handler below can drain queued reports even when no page is open.
importScripts('/js/outbox.js');

const CACHE = 'bwr-v54';
// Tiles live in two separate caches:
//   • TILE_CACHE — forests the user explicitly downloaded ("Cartes hors-ligne").
//     Permanent: never expired, never evicted, so a downloaded forest stays
//     complete offline no matter how much the user pans around afterwards.
//   • BROWSE_TILE_CACHE — tiles picked up opportunistically while panning online.
//     LRU-capped so it can't grow unbounded.
// Keeping them apart is what prevents online browsing from evicting the
// deliberately-downloaded offline zones (the cause of the "white spot" gaps).
const TILE_CACHE = 'bwr-offline-tiles';
const BROWSE_TILE_CACHE = 'bwr-tile-cache';
const TILE_MAX_ENTRIES = 500;
const TILE_MAX_AGE_MS  = 7 * 24 * 60 * 60 * 1000; // 7 days

// Public, read-only API data worth keeping for offline use: forest paths and
// hazard reports. These are global (not per-user), so caching them in the shared
// app cache is safe. Strategy: network-first (fresh when online) with a cache
// fallback, so the map still shows trails and reports with no signal.
const CACHEABLE_API = ['/api/paths', '/api/reports'];

const APP_SHELL = [
  '/',
  'map',
  'admin',
  'admin-panel',
  'routes',
  'profile',
  'login',
  'plans',
  'news',
  'forum',
  'quests',
  'verify',
  'reset',
  'changelog',
  'leaderboard',
  'guide',
  'manifest.json',
  'data/quests.json',
  'icons/icon.svg',
  'icons/icon-180.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'lib/leaflet.js',
  'lib/leaflet.css',
  'js/config.js',
  'js/auth.js',
  'js/features.js',
  'js/carrefours.js',
  'js/map.js',
  'js/map-paths.js',
  'js/map-locate.js',
  'js/map-sync.js',
  'js/outbox.js',
  'js/admin.js',
  'js/routes.js',
  'js/routes-engine.js',
  'js/routes-map.js',
  'js/routes-planner.js',
  'js/gps-tracker.js',
  'js/profile.js',
  'js/profile-stats.js',
  'js/profile-wheel.js',
  'js/profile-plan.js',
  'js/login.js',
  'js/graph-router.js',
  'js/exporters.js',
  'js/news.js',
  'js/forum.js',
  'js/quests.js',
  'js/install.js',
  'js/theme.js',
  'js/forests.js',
  'js/notif.js',
  'js/push.js',
  'js/ui-shared.js',
  'js/onboarding.js',
  'js/map-offline.js',
  'js/elevation.js',
  'js/map-edit.js',
  'js/route-save.js',
  'js/plans.js',
  'js/leaderboard.js',
  'js/verify.js',
  'js/reset.js',
  'js/track.js',
  'js/index.js',
  'css/tokens.css',
  'css/style.css',
  'css/login.css',
  'css/plans.css',
  'css/upsell.css',
  'css/routes.css',
  'css/home.css',
  'css/profile.css',
  'css/changelog.css',
  'css/leaderboard.css',
  'css/legal.css',
  'css/blog.css',
  'css/onboarding.css',
  'css/guide.css',
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
      Promise.all(keys.filter(k => k !== CACHE && k !== TILE_CACHE && k !== BROWSE_TILE_CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// ── Web Push ──────────────────────────────────────────────────────────────────
// The server sends an aes128gcm-encrypted JSON payload { title, body, url, tag }.
// Show it as a native notification; a click focuses an open tab on `url` or
// opens a new one.
self.addEventListener('push', e => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; }
  catch { data = { body: e.data ? e.data.text() : '' }; }

  const title = data.title || 'BWR — Balades en forêt';
  const options = {
    body:  data.body || '',
    icon:  data.icon  || '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    tag:   data.tag   || 'bwr',
    data:  { url: data.url || '/map' },
  };
  e.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const target = (e.notification.data && e.notification.data.url) || '/map';
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      if (c.url.includes(target) && 'focus' in c) return c.focus();
    }
    if (self.clients.openWindow) return self.clients.openWindow(target);
  })());
});

// Background Sync — replay queued hazard reports once connectivity returns, even
// if the page that queued them is closed. The page registers the 'bwr-sync-reports'
// tag (see requestReportSync in js/map-sync.js); the browser fires this event when
// online and retries automatically if we reject the waitUntil promise.
async function replayReportOutbox() {
  const records = await bwrOutbox.all();
  if (!records.length) return;
  let failed = 0;
  for (const rec of records) {
    try {
      const res = await fetch(rec.url || '/api/reports', {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json' }, rec.auth || {}),
        body: JSON.stringify(rec.payload),
      });
      // Drop on success, or on a permanent client error (bad/duplicate) — a retry
      // wouldn't help. Keep on 5xx / 429 / network error so the sync retries.
      if (res.ok || (res.status >= 400 && res.status < 500 && res.status !== 429)) {
        await bwrOutbox.delete(rec._id);
      } else {
        failed++;
      }
    } catch { failed++; }
  }
  // Nudge any open page to refresh its reports layer + clear the pending banner.
  const clients = await self.clients.matchAll({ includeUncontrolled: true });
  clients.forEach(c => c.postMessage({ type: 'reports-synced' }));
  // Rejecting tells the browser to reschedule the sync (backoff) for what's left.
  if (failed > 0) throw new Error(`report outbox: ${failed} still pending`);
}

self.addEventListener('sync', e => {
  if (e.tag === 'bwr-sync-reports') e.waitUntil(replayReportOutbox());
});

// Fetch — network first for HTML/JS/CSS, cache fallback when offline
self.addEventListener('fetch', e => {
  const url = e.request.url;

  // Offline-first data: forest paths & hazard reports. Network-first so the data
  // is fresh online, but fall back to the last cached copy when offline so the
  // map keeps showing trails and reports with no signal. Must come before the
  // generic /api/ branch below (which always returns 503 offline).
  if (e.request.method === 'GET' && CACHEABLE_API.includes(new URL(url).pathname)) {
    e.respondWith(
      fetch(e.request).then(res => {
        if (res && res.ok) {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return res;
      }).catch(() => caches.match(e.request, { ignoreVary: true }).then(cached =>
        cached || new Response('{"error":"offline"}', { status: 503, headers: { 'Content-Type': 'application/json' } })
      ))
    );
    return;
  }

  // Always network for API
  if (url.includes('/api/') || url.includes('overpass')) {
    e.respondWith(fetch(e.request).catch(() => new Response('{"error":"offline"}', { status: 503, headers: { 'Content-Type': 'application/json' } })));
    return;
  }

  // Tiles — cache first so panning offline is instant; re-fetch when stale or not cached
  if (url.includes('tile') || url.includes('opentopomap') || url.includes('geopf.fr')) {
    e.respondWith((async () => {
      // 1. Downloaded offline zone wins outright — serve as-is, no expiry, no
      //    eviction. These are opaque (no-cors) responses with no Date header,
      //    so a staleness check would wrongly mark them expired → white square.
      const offline = await caches.open(TILE_CACHE);
      const saved = await offline.match(e.request);
      if (saved) return saved;

      // 2. Opportunistic browse cache — a fresh-enough copy avoids the network.
      const browse = await caches.open(BROWSE_TILE_CACHE);
      const cached = await browse.match(e.request);
      if (cached) {
        const dateHeader = cached.headers.get('date');
        // Opaque/dateless tiles are trusted (a possibly-stale tile beats a white
        // gap offline); dated tiles honour the 7-day TTL.
        const age = dateHeader ? Date.now() - new Date(dateHeader).getTime() : 0;
        if (age < TILE_MAX_AGE_MS) return cached;
      }

      // 3. Network, then populate the browse cache with LRU eviction. Opaque
      //    responses (cross-origin tiles fetched without CORS) have status 0, so
      //    accept them too — otherwise panning online would never warm the cache.
      try {
        const res = await fetch(e.request);
        if (res && (res.ok || res.type === 'opaque')) {
          const keys = await browse.keys();
          if (keys.length >= TILE_MAX_ENTRIES) {
            await Promise.all(keys.slice(0, keys.length - TILE_MAX_ENTRIES + 1).map(k => browse.delete(k)));
          }
          browse.put(e.request, res.clone());
        }
        return res;
      } catch {
        // Offline with nothing fresh → fall back to a stale browse copy if we
        // have one, otherwise signal a tile miss.
        return cached || new Response('', { status: 504 });
      }
    })());
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

  // Cross-origin requests we don't specifically handle (e.g. external news
  // article images) must NOT be intercepted: a fetch() issued from inside the
  // service worker is governed by the SW's own CSP connect-src, which doesn't
  // list arbitrary third-party hosts. Letting the request pass through to the
  // browser means it's governed by the page's img-src instead (allows https:).
  if (new URL(url).origin !== self.location.origin) return;

  // Cache first for other same-origin assets (images, fonts, etc.)
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request))
  );
});
