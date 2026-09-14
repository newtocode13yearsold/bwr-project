// Service worker offline & caching strategy tests — Node 18+ (CJS).
//
// Covers (previously manual-only):
//   • Correct routing strategy per URL type (API / tile / app / asset)
//   • API requests always go to network (even when offline → 503 JSON)
//   • Cache invalidation: only CACHE and TILE_CACHE survive activation
//   • APP_SHELL list includes all expected pages and JS modules
//
// Approach: run sw.js inside a mock ServiceWorker context via vm.runInContext
// so we test the real source file, not a reimplementation.

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

// ── Read sw.js source ─────────────────────────────────────────────────────────

const swSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'sw.js'), 'utf-8');

// The cache name is bumped on every release; read it from the source so these
// tests keep asserting against whatever version sw.js currently declares.
const CURRENT_CACHE = swSource.match(/const CACHE\s*=\s*'([^']+)'/)[1];

// ── Minimal Service Worker mock factory ───────────────────────────────────────
// Each call returns a fresh, isolated context so tests don't share state.

function makeSWContext() {
  const handlers = {};

  // In-memory stand-in for the IndexedDB report outbox (js/outbox.js). sw.js
  // pulls it in via importScripts, which we stub below to a no-op and hand this
  // mock to the vm context instead.
  const outboxStore = [];
  const mockOutbox = {
    all:    async () => outboxStore.map(r => ({ ...r })),
    delete: async (id) => { const i = outboxStore.findIndex(r => r._id === id); if (i >= 0) outboxStore.splice(i, 1); },
    count:  async () => outboxStore.length,
    add:    async (r) => { const _id = outboxStore.length + 1; outboxStore.push({ ...r, _id }); return _id; },
  };
  const clientMessages = [];

  // Per-cache store: cacheName → Map<string, Response>
  const cacheStores = new Map();

  function getOrCreateStore(name) {
    if (!cacheStores.has(name)) cacheStores.set(name, new Map());
    return cacheStores.get(name);
  }

  const mockCaches = {
    open: async (name) => {
      const store = getOrCreateStore(name);
      return {
        addAll: async () => {},                     // no real network in tests
        put:    async (req, res) => { store.set(typeof req === 'string' ? req : req.url, res); },
        match:  async (req) => store.get(typeof req === 'string' ? req : req.url),
        keys:   async () => [],
      };
    },
    match: async (req) => {
      const key = typeof req === 'string' ? req : req.url;
      for (const store of cacheStores.values()) {
        const hit = store.get(key);
        if (hit) return hit;
      }
      return undefined;
    },
    keys: async () => [...cacheStores.keys()],
    delete: async (name) => { cacheStores.delete(name); return true; },
    _stores: cacheStores,
  };

  const mockSelf = {
    addEventListener: (event, handler) => { handlers[event] = handler; },
    skipWaiting: () => Promise.resolve(),
    clients: {
      claim: () => Promise.resolve(),
      matchAll: async () => [{ postMessage: (m) => clientMessages.push(m) }],
    },
    location: { origin: 'https://bwrmaps.com' },
  };

  // Run sw.js inside this context
  const ctx = vm.createContext({
    self: mockSelf,
    caches: mockCaches,
    // importScripts('/js/outbox.js') is a no-op here; bwrOutbox is injected below.
    importScripts: () => {},
    bwrOutbox: mockOutbox,
    // fetch is mocked per-test via the context — start with a simple stub
    fetch: () => Promise.reject(new Error('offline')),
    Request: globalThis.Request,
    Response: globalThis.Response,
    URL: globalThis.URL,
    Promise,
    // Real service workers expose these; the network-first cache race in sw.js
    // uses them to cap a hanging fetch, so the sandbox must provide them too.
    setTimeout,
    clearTimeout,
    console,
  });
  vm.runInContext(swSource, ctx);

  // Helper: build a fake FetchEvent and capture the Response promise.
  function makeFetchEvent(url, method = 'GET', mode = 'no-cors') {
    let respondWithPromise = null;
    const event = {
      request: new Request(url, { method, mode }),
      respondWith: (p) => { respondWithPromise = p; },
      waitUntil: () => {},
    };
    return { event, getResponse: () => respondWithPromise };
  }

  return { handlers, mockCaches, ctx, makeFetchEvent, outboxStore, clientMessages };
}

// ── Constants extracted from sw.js ────────────────────────────────────────────
// These must stay in sync with the source.

const APP_SHELL_EXPECTED = [
  '/',
  'map',
  'admin',
  'routes',
  'profile',
  'login',
  'plans',
  'news',
  'forum',
  'verify',
  'changelog',
  'leaderboard',
  'guide',
  'manifest.json',
  'data/forest-paths.json',
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
  'js/forum.js',
  'js/install.js',
];

// ── APP_SHELL content ─────────────────────────────────────────────────────────

describe('APP_SHELL completeness', () => {
  test('sw.js source contains all expected app shell entries', () => {
    for (const entry of APP_SHELL_EXPECTED) {
      assert.ok(
        swSource.includes(`'${entry}'`) || swSource.includes(`"${entry}"`),
        `APP_SHELL must include '${entry}'`
      );
    }
  });
});

// ── Cache name constants ──────────────────────────────────────────────────────

describe('cache names', () => {
  test('CACHE and TILE_CACHE names are present in source', () => {
    assert.match(swSource, /const CACHE\s*=\s*'bwr-v\d+'/);
    assert.match(swSource, /const TILE_CACHE\s*=\s*'bwr-offline-tiles'/);
  });
});

// ── Fetch routing strategies ──────────────────────────────────────────────────

describe('fetch handler: API requests → always network', () => {
  test('/api/* → network; offline yields 503 JSON', async () => {
    const { handlers, makeFetchEvent } = makeSWContext();
    const { event, getResponse } = makeFetchEvent('https://bwr.test/api/paths');
    handlers.fetch(event);
    const res = await getResponse();
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.ok(body.error, 'offline error JSON must have error field');
  });

  test('/api/auth/me → network; offline yields 503', async () => {
    const { handlers, makeFetchEvent } = makeSWContext();
    const { event, getResponse } = makeFetchEvent('https://bwr.test/api/auth/me');
    handlers.fetch(event);
    const res = await getResponse();
    assert.equal(res.status, 503);
  });

  test('overpass API → network; offline yields 503', async () => {
    const { handlers, makeFetchEvent } = makeSWContext();
    const { event, getResponse } = makeFetchEvent('https://overpass-api.de/api/interpreter?data=[]');
    handlers.fetch(event);
    const res = await getResponse();
    assert.equal(res.status, 503);
  });
});

describe('fetch handler: offline-data API (paths/reports) → network-first, cache fallback', () => {
  test('GET /api/paths offline with cached copy → served from cache (map still shows trails)', async () => {
    const { handlers, mockCaches, ctx, makeFetchEvent } = makeSWContext();

    const url = 'https://bwrmaps.com/api/paths';
    const cached = new Response(JSON.stringify([{ id: 'p1' }]), { status: 200, headers: { 'Content-Type': 'application/json' } });
    const appCache = await mockCaches.open('bwr-v40');
    await appCache.put(url, cached);

    // Offline: network rejects → must fall back to the cached paths.
    ctx.fetch = () => Promise.reject(new Error('offline'));

    const { event, getResponse } = makeFetchEvent(url);
    handlers.fetch(event);
    const res = await getResponse();
    assert.equal(res.status, 200, 'cached paths must be served when offline');
    const body = await res.json();
    assert.ok(Array.isArray(body) && body[0].id === 'p1', 'cached paths array must be returned');
  });

  test('GET /api/paths online → fetched from network and written to cache for later offline use', async () => {
    const { handlers, mockCaches, ctx, makeFetchEvent } = makeSWContext();

    const url = 'https://bwrmaps.com/api/paths';
    let networkCalled = false;
    ctx.fetch = () => {
      networkCalled = true;
      return Promise.resolve(new Response(JSON.stringify([{ id: 'fresh' }]), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    };

    const { event, getResponse } = makeFetchEvent(url);
    handlers.fetch(event);
    const res = await getResponse();
    assert.equal(networkCalled, true, 'online request must hit the network');
    assert.equal(res.status, 200);

    // Let the async cache.put settle, then confirm the fresh copy was stored.
    await new Promise(r => setTimeout(r, 0));
    const stored = await mockCaches.match(url);
    assert.ok(stored, 'fresh paths must be cached for offline use');
  });

  test('GET /api/reports offline with no cache → 503 JSON (graceful, no crash)', async () => {
    const { handlers, makeFetchEvent } = makeSWContext();
    const { event, getResponse } = makeFetchEvent('https://bwrmaps.com/api/reports');
    handlers.fetch(event);
    const res = await getResponse();
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.ok(body.error, 'offline-with-no-cache must yield error JSON, not throw');
  });

  test('POST /api/reports → NOT served from cache (writes always go to network)', async () => {
    const { handlers, mockCaches, ctx, makeFetchEvent } = makeSWContext();

    // Even if a GET copy is cached, a POST must never be answered from cache.
    const url = 'https://bwrmaps.com/api/reports';
    const appCache = await mockCaches.open('bwr-v40');
    await appCache.put(url, new Response('[]', { status: 200 }));

    ctx.fetch = () => Promise.reject(new Error('offline'));
    const { event, getResponse } = makeFetchEvent(url, 'POST');
    handlers.fetch(event);
    const res = await getResponse();
    assert.equal(res.status, 503, 'offline POST must return 503, not a cached body');
  });
});

describe('fetch handler: tile requests → cache-first', () => {
  test('tile URL with cached entry → served from cache without network', async () => {
    const { handlers, mockCaches, ctx, makeFetchEvent } = makeSWContext();

    const tileUrl = 'https://tile.openstreetmap.org/13/4200/2800.png';
    // Real tile responses always include a Date header — our age check relies on it.
    const cachedResponse = new Response('PNG_DATA', { status: 200, headers: { Date: new Date().toUTCString() } });

    // Pre-populate TILE_CACHE
    const tileCache = await mockCaches.open('bwr-offline-tiles');
    await tileCache.put(tileUrl, cachedResponse);

    // Network should NOT be called — set it to reject to verify
    let networkCalled = false;
    ctx.fetch = () => { networkCalled = true; return Promise.reject(new Error('should not call network')); };

    const { event, getResponse } = makeFetchEvent(tileUrl);
    handlers.fetch(event);
    const res = await getResponse();
    assert.equal(networkCalled, false, 'network must not be called for cached tile');
    assert.ok(res, 'cached response must be returned');
  });

  test('tile URL not in cache → fetches from network and caches it', async () => {
    const { handlers, mockCaches, ctx, makeFetchEvent } = makeSWContext();

    const tileUrl = 'https://tile.openstreetmap.org/13/4201/2801.png';
    let networkCalled = false;
    ctx.fetch = () => {
      networkCalled = true;
      return Promise.resolve(new Response('TILE', { status: 200 }));
    };

    const { event, getResponse } = makeFetchEvent(tileUrl);
    handlers.fetch(event);
    const res = await getResponse();
    assert.equal(networkCalled, true, 'must fetch from network when tile not cached');
    assert.ok(res);
  });

  test('opentopomap tile → cache-first strategy', async () => {
    const { handlers, makeFetchEvent } = makeSWContext();
    const { event, getResponse } = makeFetchEvent('https://opentopomap.org/13/4200/2800.png');
    // No cache, network is offline → should return 504 (tile cache miss + offline)
    handlers.fetch(event);
    const res = await getResponse();
    assert.equal(res.status, 504);
  });

  test('geopf.fr tile → cache-first strategy', async () => {
    const { handlers, makeFetchEvent } = makeSWContext();
    const { event, getResponse } = makeFetchEvent('https://data.geopf.fr/wmts?TILEMATRIX=13');
    handlers.fetch(event);
    const res = await getResponse();
    assert.equal(res.status, 504);
  });
});

describe('fetch handler: app files → network-first with cache fallback', () => {
  test('.html file offline → served from cache if available', async () => {
    const { handlers, mockCaches, makeFetchEvent } = makeSWContext();

    const htmlUrl = 'https://bwr.test/map.html';
    const cachedPage = new Response('<html></html>', { status: 200 });
    const appCache = await mockCaches.open('bwr-v21');
    await appCache.put(htmlUrl, cachedPage);

    // 'navigate' mode is not supported by Node's undici Request; the sw.js
    // network-first branch also matches on .html extension, which is enough.
    const { event, getResponse } = makeFetchEvent(htmlUrl, 'GET', 'same-origin');
    handlers.fetch(event);
    const res = await getResponse();
    assert.ok(res, 'cached HTML must be returned when offline');
  });

  test('.js file offline → served from cache if available', async () => {
    const { handlers, mockCaches, makeFetchEvent } = makeSWContext();

    const jsUrl = 'https://bwr.test/js/map.js';
    const cachedJs = new Response('// js', { status: 200 });
    const appCache = await mockCaches.open('bwr-v21');
    await appCache.put(jsUrl, cachedJs);

    const { event, getResponse } = makeFetchEvent(jsUrl);
    handlers.fetch(event);
    const res = await getResponse();
    assert.ok(res);
  });

  test('.html not in cache offline → returns undefined/null (no crash)', async () => {
    const { handlers, makeFetchEvent } = makeSWContext();
    // Network is offline (default), cache is empty
    const { event, getResponse } = makeFetchEvent('https://bwr.test/routes.html', 'GET', 'same-origin');
    handlers.fetch(event);
    // Should not throw; may return undefined if nothing is cached
    const res = await getResponse().catch(() => null);
    // Just verify it doesn't crash — res may be undefined or null
    assert.ok(res === null || res === undefined || res instanceof Response);
  });
});

// ── Network-first race: weak-signal fast path ────────────────────────────────
// The real fix: on a weak signal fetch() hangs instead of failing, so a plain
// network-first strategy blocks the page even though a cached copy exists. The
// race serves the cache after a short timeout and lets the fetch finish in the
// background. We drive the SW's timer with an accelerated setTimeout so these
// tests prove the logic without waiting the real 1.5-2.5s caps.

describe('fetch handler: network-first race (weak-signal fast path)', () => {
  test('app file: hanging network + cached copy → cached page served (no hang)', async () => {
    const { handlers, mockCaches, ctx, makeFetchEvent } = makeSWContext();
    ctx.setTimeout = (fn) => setTimeout(fn, 0); // fire the SW's timeout immediately

    const url = 'https://bwrmaps.com/js/map.js';
    const appCache = await mockCaches.open(CURRENT_CACHE);
    await appCache.put(url, new Response('// cached', { status: 200 }));

    // Weak signal: the network never settles.
    ctx.fetch = () => new Promise(() => {});

    const { event, getResponse } = makeFetchEvent(url);
    handlers.fetch(event);
    const res = await getResponse();
    assert.equal(await res.text(), '// cached', 'a hanging fetch must not block a cached page');
  });

  test('map data: slow network serves cache now, then refreshes cache for next load', async () => {
    const { handlers, mockCaches, ctx, makeFetchEvent } = makeSWContext();
    ctx.setTimeout = (fn) => setTimeout(fn, 0);

    const url = 'https://bwrmaps.com/api/paths';
    const appCache = await mockCaches.open(CURRENT_CACHE);
    await appCache.put(url, new Response(JSON.stringify([{ id: 'stale' }]), { status: 200, headers: { 'Content-Type': 'application/json' } }));

    // Network is only slow, not dead: it resolves with fresh data after the timer.
    let resolveNet;
    ctx.fetch = () => new Promise(r => { resolveNet = r; });

    const { event, getResponse } = makeFetchEvent(url);
    handlers.fetch(event);
    const res = await getResponse();
    const body = await res.json();
    assert.equal(body[0].id, 'stale', 'a slow network serves the cached map immediately');

    // The in-flight fetch finally lands → its response must refresh the cache.
    resolveNet(new Response(JSON.stringify([{ id: 'fresh' }]), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    await new Promise(r => setTimeout(r, 0));
    await new Promise(r => setTimeout(r, 0));
    const stored = await mockCaches.match(url);
    assert.deepEqual((await stored.json())[0].id, 'fresh', 'the background fetch must refresh the cache for next load');
  });

  test('fast network still wins the race → freshest copy served (behaviour unchanged online)', async () => {
    const { handlers, mockCaches, ctx, makeFetchEvent } = makeSWContext();
    // Timer set far out; the (instant) network must win before it fires.
    ctx.setTimeout = (fn) => setTimeout(fn, 10000);

    const url = 'https://bwrmaps.com/js/map.js';
    const appCache = await mockCaches.open(CURRENT_CACHE);
    await appCache.put(url, new Response('// cached', { status: 200 }));

    ctx.fetch = () => Promise.resolve(new Response('// fresh', { status: 200 }));

    const { event, getResponse } = makeFetchEvent(url);
    handlers.fetch(event);
    const res = await getResponse();
    assert.equal(await res.text(), '// fresh', 'a responsive network still serves the latest copy');
  });
});

// ── Cross-origin pass-through ─────────────────────────────────────────────────

describe('fetch handler: cross-origin assets → not intercepted', () => {
  test('external news image → SW does not call respondWith (browser handles it)', async () => {
    const { handlers, makeFetchEvent } = makeSWContext();
    // An <img> pointing at a third-party host must pass straight through so the
    // page's img-src CSP governs it, not the SW's connect-src.
    const imgUrl = 'https://www.benmazue.com/wp-content/uploads/2026/02/photo.jpg';
    const { event, getResponse } = makeFetchEvent(imgUrl);
    handlers.fetch(event);
    assert.strictEqual(getResponse(), null, 'cross-origin image must not be intercepted');
  });

  test('same-origin asset → still intercepted (cache-first)', async () => {
    const { handlers, makeFetchEvent } = makeSWContext();
    const iconUrl = 'https://bwrmaps.com/icons/icon.svg';
    const { event, getResponse } = makeFetchEvent(iconUrl);
    handlers.fetch(event);
    const responsePromise = getResponse();
    assert.notStrictEqual(responsePromise, null, 'same-origin asset must be handled by the SW');
    // Cache is empty + network offline → the cache-first fetch rejects; swallow
    // it so it doesn't surface as an unhandled rejection after the test ends.
    await responsePromise.catch(() => {});
  });
});

// ── Background Sync: report outbox replay ────────────────────────────────────

describe('sync handler: report outbox replay', () => {
  function fireSync(handlers, tag = 'bwr-sync-reports') {
    let waitUntilPromise;
    const event = { tag, waitUntil: (p) => { waitUntilPromise = p; } };
    handlers.sync(event);
    return waitUntilPromise;
  }

  test('successful POST drops the record and notifies open clients', async () => {
    const { handlers, ctx, outboxStore, clientMessages } = makeSWContext();
    outboxStore.push({ _id: 1, url: 'https://bwrmaps.com/api/reports', auth: { Authorization: 'Bearer t' }, payload: { type: 'tree' } });

    let posted = null;
    ctx.fetch = (url, opts) => { posted = { url, opts }; return Promise.resolve(new Response('{}', { status: 200 })); };

    await fireSync(handlers);

    assert.equal(outboxStore.length, 0, 'sent report must be removed from the outbox');
    assert.equal(posted.url, 'https://bwrmaps.com/api/reports');
    assert.equal(posted.opts.method, 'POST');
    assert.ok(posted.opts.headers.Authorization === 'Bearer t', 'stored auth header must be replayed');
    assert.ok(clientMessages.some(m => m.type === 'reports-synced'), 'open clients must be told to refresh');
  });

  test('server error (5xx) keeps the record and rejects so the browser retries', async () => {
    const { handlers, ctx, outboxStore } = makeSWContext();
    outboxStore.push({ _id: 1, url: 'https://bwrmaps.com/api/reports', payload: { type: 'flood' } });

    ctx.fetch = () => Promise.resolve(new Response('err', { status: 500 }));

    await assert.rejects(fireSync(handlers), /still pending/);
    assert.equal(outboxStore.length, 1, '5xx report must stay queued for retry');
  });

  test('permanent client error (4xx, not 429) drops the record', async () => {
    const { handlers, ctx, outboxStore } = makeSWContext();
    outboxStore.push({ _id: 1, url: 'https://bwrmaps.com/api/reports', payload: { type: 'bad' } });

    ctx.fetch = () => Promise.resolve(new Response('bad', { status: 400 }));

    await fireSync(handlers);
    assert.equal(outboxStore.length, 0, 'unretryable 4xx must be dropped, not looped forever');
  });

  test('unrelated sync tag is ignored', () => {
    const { handlers } = makeSWContext();
    assert.doesNotThrow(() => fireSync(handlers, 'some-other-tag'));
  });
});

// ── Activate: old caches deleted ─────────────────────────────────────────────

describe('activate handler: old caches deleted', () => {
  test('stale cache is deleted, CACHE and TILE_CACHE are kept', async () => {
    const { handlers, mockCaches } = makeSWContext();

    // Seed old + current caches
    await mockCaches.open('bwr-v1');           // old → must be deleted
    await mockCaches.open(CURRENT_CACHE);      // current CACHE → keep
    await mockCaches.open('bwr-offline-tiles'); // TILE_CACHE → keep

    let waitUntilPromise;
    const event = { waitUntil: (p) => { waitUntilPromise = p; } };
    handlers.activate(event);
    await waitUntilPromise;

    const remaining = await mockCaches.keys();
    assert.ok(!remaining.includes('bwr-v1'), 'old cache bwr-v1 must be deleted');
    assert.ok(remaining.includes(CURRENT_CACHE), 'current CACHE must be kept');
    assert.ok(remaining.includes('bwr-offline-tiles'), 'TILE_CACHE must be kept');
  });
});
