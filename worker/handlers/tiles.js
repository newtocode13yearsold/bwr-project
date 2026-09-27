// Tile proxy with Cloudflare edge cache.
//
// Two upstreams, one code path:
//
//   /tiles/ign/:z/:x/:y.png   -> IGN "Plan IGN v2" (data.geopf.fr).  DEFAULT BASEMAP.
//   /tiles/topo/:z/:x/:y.png  -> OpenTopoMap.  Legacy / optional extra style.
//
// Why IGN is the default: it is the French national mapping agency, its data is
// published as open data and may be reused commercially provided IGN is credited.
// The OpenStreetMap Foundation's own tile service (tile.openstreetmap.org) and
// OpenTopoMap are donation-funded volunteer servers whose usage policies exclude
// heavy or commercial use - fine for a hobby project, not fine once BWR charges
// money. IGN also renders forest tracks, contours and carrefour place names
// better than a generic basemap, which is the whole point of this app.
//
// Why proxy at all instead of pointing Leaflet straight at data.geopf.fr:
//   1. Same-origin. The service worker then caches tiles as normal same-origin
//      responses. Opaque (no-cors) cross-origin responses are padded to several MB
//      each by iOS Safari's quota accounting, which blows the offline cache - see
//      the comments in public/js/map-offline.js.
//   2. Edge cache. On map load Leaflet fires a burst of ~20-30 tile requests. We
//      fetch each tile from upstream once and serve it from Cloudflare's edge for
//      30 days, so a warmed tile costs upstream nothing. That keeps us comfortably
//      inside anyone's fair-use expectations and makes repeat loads instant.
//   3. No grey squares. A throttled tile (429/403) leaves Leaflet showing a
//      PERMANENT grey square - it never re-requests on its own. Caching plus the
//      retry below removes the burst that triggers throttling in the first place.
//
// `caches` is absent in the Node test runner and in dev, so every use is guarded -
// proxying there simply passes through to upstream.

const TILE_CACHE_TTL = 2592000; // 30 days

/** Upstream definitions, keyed by the path segment used in /tiles/<key>/... */
const SOURCES = {
  // IGN Plan v2 via the Geoplateforme WMTS endpoint. Open licence, attribution
  // required (rendered client-side on the Leaflet layer).
  ign: {
    maxZoom: 19,
    contentType: 'image/png',
    urls: (z, x, y) => [
      'https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0' +
      '&LAYER=GEOGRAPHICALGRIDSYSTEMS.PLANIGNV2&STYLE=normal&FORMAT=image/png' +
      `&TILEMATRIXSET=PM&TILEMATRIX=${z}&TILEROW=${y}&TILECOL=${x}`,
    ],
  },
  // OpenTopoMap - kept so older cached clients keep working and so the topo style
  // stays available as an optional layer. Rotate the subdomain by tile coord and
  // retry once on a throttle.
  topo: {
    maxZoom: 19,
    contentType: 'image/png',
    urls: (z, x, y) => {
      const subs = ['a', 'b', 'c'];
      const i = (x + y) % 3;
      return [
        `https://${subs[i]}.tile.opentopomap.org/${z}/${x}/${y}.png`,
        `https://${subs[(i + 1) % 3]}.tile.opentopomap.org/${z}/${x}/${y}.png`,
      ];
    },
  },
};

const cacheAvailable = () => typeof caches !== 'undefined' && caches.default;

/**
 * GET /tiles/:source/:z/:x/:y.png - edge-cached basemap proxy.
 * Deliberately NOT under /api/ so the service-worker tile branch (cache-first)
 * picks it up and the generic /api/ network-only branch does not.
 * @param {Request} request
 * @param {import('../kv.js').Env} env
 * @param {{ pathname: string, waitUntil: Function }} ctx
 * @returns {Promise<Response|null>}
 */
export async function handleTiles(request, env, { pathname, waitUntil }) {
  const m = pathname.match(/^\/tiles\/([a-z]+)\/(\d{1,2})\/(\d{1,7})\/(\d{1,7})\.png$/);
  if (!m) return null;

  const source = SOURCES[m[1]];
  if (!source) return null; // unknown source -> let the rest of the router try

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method not allowed', { status: 405 });
  }

  const z = Number(m[2]), x = Number(m[3]), y = Number(m[4]);
  // Validate coordinates so the cache can't be poisoned with junk keys.
  const max = 2 ** z;
  if (z > source.maxZoom || x >= max || y >= max) {
    return new Response('Bad tile', { status: 400 });
  }

  const cache = cacheAvailable() ? caches.default : null;
  // Origin-agnostic cache key (a plain https URL, not the incoming request whose
  // host varies across preview deploys) so every colo shares one cached tile.
  // The source is part of the key, so IGN and topo tiles never collide - which
  // also means changing a route's upstream can never serve the old imagery.
  const cacheKey = new Request(`https://bwr-internal-cache/tiles/${m[1]}/${z}/${x}/${y}.png`);

  if (cache) {
    const hit = await cache.match(cacheKey);
    if (hit) {
      const h = new Headers(hit.headers);
      h.set('X-Tile-Cache', 'HIT');
      return new Response(hit.body, { status: 200, headers: h });
    }
  }

  // Fetch upstream; on a throttle (429/403) try the next candidate URL to ride
  // out the rate-limit window.
  let upstream = null;
  for (const url of source.urls(z, x, y)) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'BWRmaps/1.0 (+https://bwrmaps.com)' },
      });
      if (res.ok) { upstream = res; break; }
      upstream = res; // remember the error in case every candidate fails
      if (res.status !== 429 && res.status !== 403) break;
    } catch { /* try next candidate */ }
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
    'Content-Type': source.contentType,
    'Cache-Control': `public, max-age=${TILE_CACHE_TTL}, immutable`,
    'X-Tile-Cache': 'MISS',
    'Access-Control-Allow-Origin': '*',
  };

  if (cache) {
    const store = new Response(buf, {
      headers: { 'Content-Type': source.contentType, 'Cache-Control': `public, max-age=${TILE_CACHE_TTL}, immutable` },
    });
    const put = cache.put(cacheKey, store);
    if (waitUntil) waitUntil(put); else await put.catch(() => {});
  }

  return new Response(buf, { headers });
}
