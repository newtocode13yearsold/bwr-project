// Tile proxy with Cloudflare edge cache.
//
// Why this exists: the topographic basemap (OpenTopoMap) is a volunteer server
// with no CDN. On map load Leaflet fires a burst of ~20-30 tile requests at once,
// OpenTopoMap rate-limits part of the burst (429/403), and Leaflet leaves those
// tiles a PERMANENT grey square — the "grey map" users see. Its tiles are also
// ~3× the bytes of standard OSM and there's no cache shared between visitors.
//
// We proxy the topo tiles through the Worker and cache them at Cloudflare's edge
// for 30 days. After the first visitor warms a tile, everyone else is served it
// straight from the edge — instant, and with no upstream burst to be throttled.
// This also REDUCES load on OpenTopoMap (one upstream fetch per tile / 30 days
// globally instead of one per visitor), so it's friendlier than the direct
// hammering it replaces. `caches` is absent in the Node test runner and in dev,
// so every use is guarded — proxying there simply passes through to upstream.

const UPSTREAM_SUBS = ['a', 'b', 'c'];
const TILE_CACHE_TTL = 2592000; // 30 days
const cacheAvailable = () => typeof caches !== 'undefined' && caches.default;

/**
 * GET /tiles/topo/:z/:x/:y.png — edge-cached OpenTopoMap proxy.
 * Deliberately NOT under /api/ so the service-worker tile branch (cache-first)
 * picks it up and the generic /api/ network-only branch does not.
 * @param {Request} request
 * @param {import('../kv.js').Env} env
 * @param {{ pathname: string, waitUntil: Function }} ctx
 * @returns {Promise<Response|null>}
 */
export async function handleTiles(request, env, { pathname, waitUntil }) {
  const m = pathname.match(/^\/tiles\/topo\/(\d{1,2})\/(\d{1,7})\/(\d{1,7})\.png$/);
  if (!m) return null;
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method not allowed', { status: 405 });
  }

  const z = Number(m[1]), x = Number(m[2]), y = Number(m[3]);
  // Validate coordinates so the cache can't be poisoned with junk keys.
  const max = 2 ** z;
  if (z > 19 || x >= max || y >= max) {
    return new Response('Bad tile', { status: 400 });
  }

  const cache = cacheAvailable() ? caches.default : null;
  // Origin-agnostic cache key (a plain https URL, not the incoming request whose
  // host varies across preview deploys) so every colo shares one cached tile.
  const cacheKey = new Request(`https://bwr-internal-cache/tiles/topo/${z}/${x}/${y}.png`);

  if (cache) {
    const hit = await cache.match(cacheKey);
    if (hit) {
      const h = new Headers(hit.headers);
      h.set('X-Tile-Cache', 'HIT');
      return new Response(hit.body, { status: 200, headers: h });
    }
  }

  // Fetch upstream, rotating the subdomain by tile coord; retry once on a
  // throttle (429/403) with the next subdomain to ride out the rate-limit window.
  const order = [(x + y) % 3, ((x + y) % 3 + 1) % 3];
  let upstream = null;
  for (const i of order) {
    try {
      const res = await fetch(`https://${UPSTREAM_SUBS[i]}.tile.opentopomap.org/${z}/${x}/${y}.png`, {
        headers: { 'User-Agent': 'BWRmaps/1.0 (+https://bwrmaps.com)' },
      });
      if (res.ok) { upstream = res; break; }
      if (res.status !== 429 && res.status !== 403) { upstream = res; break; }
    } catch { /* try next subdomain */ }
  }

  if (!upstream) {
    return new Response('Tile fetch failed', { status: 502 });
  }
  if (!upstream.ok) {
    // Pass through the upstream error status; don't cache it.
    return new Response(upstream.body, { status: upstream.status });
  }

  const buf = await upstream.arrayBuffer();
  const headers = {
    'Content-Type': 'image/png',
    'Cache-Control': `public, max-age=${TILE_CACHE_TTL}, immutable`,
    'X-Tile-Cache': 'MISS',
    'Access-Control-Allow-Origin': '*',
  };

  if (cache) {
    const store = new Response(buf, {
      headers: { 'Content-Type': 'image/png', 'Cache-Control': `public, max-age=${TILE_CACHE_TTL}, immutable` },
    });
    const put = cache.put(cacheKey, store);
    if (waitUntil) waitUntil(put); else await put.catch(() => {});
  }

  return new Response(buf, { headers });
}
