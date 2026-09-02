// routes-engine.js — routing engines & path math for the route planner.
// Split out of routes.js. Classic script: loaded before js/routes.js (the entry
// file that declares the shared `let` state — transportMode/difficulty/surfaceFilter/
// routingPriority/savedPaths — which these functions read at call time).
// Pure graph functions (haversineM/graphAtob/graphAtobHybrid/graphLoopHybrid) live
// in js/graph-router.js, loaded before this script.

// ── Graph router (uses only your admin-tagged paths) ─────────────────────────
// This guarantees forest-only routing and true loops with no backtracking.

function filterPaths(paths) {
  if (pathType === 'foot')  return paths.filter(p => !p.pathType || p.pathType === 'foot');
  if (pathType === 'bike')  return paths.filter(p => p.pathType === 'bike');
  return paths; // champs / mix: all paths
}

// ── Fetch with timeout ────────────────────────────────────────────────────────
function fetchWithTimeout(url, opts = {}, ms = 10000) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { ...opts, signal: ctrl.signal }).finally(() => clearTimeout(id));
}

// ── ORS fallback (via worker, needs ORS_KEY set in Cloudflare) ─────────────────
function orsProfile() {
  return transportMode === 'bike' ? 'cycling-mountain' : 'foot-hiking';
}
async function callORS(body) {
  const res = await fetchWithTimeout(`${API_URL}/api/route`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeader() },
    body: JSON.stringify(body),
  }, 12000);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `ORS ${res.status}`);
  const feat = data.features?.[0];
  if (!feat) throw new Error('ORS: aucun itinéraire');
  return {
    coords: feat.geometry.coordinates.map(([lon, lat]) => [lat, lon]),
    meters: feat.properties.summary.distance,
    seconds: feat.properties.summary.duration,
  };
}

// ── OSRM fallback (no key needed, always works) ────────────────────────────────
function osrmProfile() { return transportMode === 'bike' ? 'cycling' : 'foot'; }

async function osrmRoute(wpList) {
  const p = osrmProfile();
  const c = wpList.map(w => `${w.lon},${w.lat}`).join(';');
  const res = await fetchWithTimeout(`https://router.project-osrm.org/route/v1/${p}/${c}?overview=full&geometries=geojson`);
  const data = await res.json();
  if (data.code !== 'Ok' || !data.routes?.[0]) throw new Error('OSRM: no route');
  const r = data.routes[0];
  return { coords: r.geometry.coordinates.map(([lon, lat]) => [lat, lon]), meters: r.distance, seconds: r.duration };
}

async function osrmTrip(wpList) {
  const p = osrmProfile();
  const c = wpList.map(w => `${w.lon},${w.lat}`).join(';');
  const res = await fetchWithTimeout(`https://router.project-osrm.org/trip/v1/${p}/${c}?roundtrip=true&source=first&destination=any&overview=full&geometries=geojson`);
  const data = await res.json();
  if (data.code !== 'Ok' || !data.trips?.[0]) throw new Error('OSRM trip: no route');
  const t = data.trips[0];
  return { coords: t.geometry.coordinates.map(([lon, lat]) => [lat, lon]), meters: t.distance, seconds: t.duration };
}

function osrmLoopWaypoints(sLat, sLng, radiusKm, rotationDeg = 0) {
  const rLat = radiusKm / 111;
  const rLng = radiusKm / (111 * Math.cos(sLat * Math.PI / 180));
  const ring = [0, 45, 90, 135, 180, 225, 270, 315].map(deg => {
    const rad = (deg + rotationDeg) * Math.PI / 180;
    return { lat: +(sLat + rLat * Math.cos(rad)).toFixed(6), lon: +(sLng + rLng * Math.sin(rad)).toFixed(6) };
  });
  return [{ lat: sLat, lon: sLng }, ...ring];
}

async function osrmLoopWithRetry(sLat, sLng, targetKm, seed = 0) {
  // Rotate the compass ring by a per-day angle so the loop shape changes daily.
  const rotationDeg = (seed % 8) * 45;
  let r = targetKm / (2 * Math.PI), result;
  for (let i = 0; i < 3; i++) {
    result = await osrmTrip(osrmLoopWaypoints(sLat, sLng, r, rotationDeg));
    const ratio = (targetKm * 1000) / result.meters;
    if (Math.abs(ratio - 1) < 0.2) break;
    r = Math.min(r * ratio, 25);
  }
  return result;
}

// ── OSM path helpers for hybrid A→B routing ───────────────────────────────────
function osmDataToCoordPaths(data) {
  const nodeMap = {};
  data.elements.forEach(el => { if (el.type === 'node') nodeMap[el.id] = [el.lat, el.lon]; });
  const result = [];
  data.elements.forEach(el => {
    if (el.type !== 'way') return;
    const coordinates = el.nodes.map(id => nodeMap[id]).filter(Boolean);
    if (coordinates.length >= 2) result.push({
      coordinates,
      _highway: el.tags?.highway,
      _surface: el.tags?.surface,
    });
  });
  return result;
}

function applyOsmSurfaceWeights(paths) {
  if (surfaceFilter === 'any') return paths;
  return paths.map(p => {
    const highway = p._highway || '';
    const surface = p._surface || '';
    const isPaved = /^(asphalt|paved|concrete|sett|cobblestone|paving_stones)$/.test(surface);
    let w = 1;
    if (surfaceFilter === 'natural') {
      // Prefer unpaved; penalize paved surfaces and types usually paved
      if (isPaved) w = 6;
      else if (highway === 'footway' || highway === 'cycleway') w = 2;
    } else if (surfaceFilter === 'paved') {
      // Prefer asphalt/concrete; penalize dirt tracks and narrow paths
      if (isPaved) w = 1;
      else if (highway === 'footway' || highway === 'cycleway') w = 1.5;
      else if (highway === 'track') w = 5;
      else if (highway === 'path' || highway === 'bridleway') w = 4;
    }
    if (w === 1) return p;
    return { ...p, _weight: (p._weight || 1) * w };
  });
}

// ── Difficulty-aware path weighting ───────────────────────────────────────────
// The chosen difficulty (easy/medium/hard) now steers the *route*, not just its
// colour. Admin paths carry a graded `status` using the same three levels, so we
// make paths whose grade matches the pick cheap to travel and mismatched grades
// progressively more expensive — picking Medium (orange) routes you over the
// orange-graded trails wherever possible. OSM paths have no admin grade, so we
// approximate their toughness from surface/highway roughness instead.
const DIFF_RANK = { easy: 0, medium: 1, hard: 2 };
// Cost multiplier added per grade-level of mismatch. 2.5 → a one-level mismatch
// costs 3.5×, two levels 6×: a strong preference so an orange pick almost always
// routes over orange-graded trails, while still letting the router fall back to a
// mismatched path when no graded alternative exists (so routes never fail).
const DIFF_PENALTY = 2.5;

function pathDifficultyRank(p) {
  // Admin-graded path → trust its status directly.
  if (p.status && p.status in DIFF_RANK) return DIFF_RANK[p.status];
  if (p.status === 'not_passable') return 2; // impassable → treat as hardest terrain
  // OSM path → infer roughness from surface / highway tags.
  const surface = p._surface || '';
  const highway = p._highway || '';
  if (/^(asphalt|paved|concrete|sett|cobblestone|paving_stones)$/.test(surface)) return 0;
  if (highway === 'footway' || highway === 'cycleway') return 0;
  if (highway === 'track' || highway === 'bridleway') return 2;
  if (highway === 'path') {
    return /^(ground|dirt|earth|mud|grass|sand|rock|gravel|fine_gravel|unpaved)$/.test(surface) ? 2 : 1;
  }
  return 1; // unknown → neutral
}

function applyDifficultyWeights(paths) {
  const target = DIFF_RANK[difficulty];
  if (target === undefined) return paths; // safety — unknown difficulty: no bias
  return paths.map(p => {
    const gap = Math.abs(pathDifficultyRank(p) - target);
    if (gap === 0) return p; // perfect grade match — keep it cheap
    return { ...p, _weight: (p._weight || 1) * (1 + gap * DIFF_PENALTY) };
  });
}

// Client-side OSM bbox cache — avoids re-fetching the same area within a session.
// Server already caches 7 days in KV; this cuts even that round-trip for repeated calls.
// Stores the in-flight PROMISE (not just the resolved array) so a prefetch fired
// when the user drops a point and the real fetch fired on "Generate" share a single
// network request instead of racing two identical ones.
const _osmPathCache = new Map(); // bbox -> Promise<paths[]>

// A cold OSM fetch *through the worker* is the real reason loops feel slow: Overpass
// rate-limits Cloudflare's shared egress IPs (measured ~24 s from the worker), while a
// browser's own residential IP gets the same query back in ~1 s. Overpass sends
// `Access-Control-Allow-Origin: *` and overpass-api.de is already in our CSP
// connect-src, and a form-encoded POST is a "simple" CORS request (no preflight), so
// the browser can hit it directly. We therefore HEDGE every fetch:
//   1. ask the worker (instant on a warm 7-day KV cache),
//   2. only if it stays silent past HEDGE_MS, also fetch Overpass straight from the
//      browser, and take whichever answers first.
// Warm-cache hits are served by the worker and never touch Overpass directly; cold
// misses fall onto the fast ~1 s browser path instead of the throttled 24 s one — and
// the worker request keeps running in the background, warming the shared KV cache for
// the next visitor even when the direct fetch won the race.
const OVERPASS_DIRECT = 'https://overpass-api.de/api/interpreter'; // must stay in CSP connect-src
// The worker gets only a short head-start: on a cold area its Overpass fetch is
// throttled from Cloudflare's egress (~24 s / 502) and never warms the KV cache, so
// the direct-from-browser path (~0.5 s on the user's own IP) is almost always the real
// winner. A tiny delay still lets a genuinely warm KV cache answer first without firing
// a needless direct Overpass request.
const HEDGE_MS = 250;

async function fetchOsmData(bbox) {
  let workerAnswered = false;

  const viaWorker = (async () => {
    const res = await fetchWithTimeout(`${API_URL}/api/osm?bbox=${bbox}`, {}, 35000);
    if (!res.ok) throw new Error(`worker osm ${res.status}`);
    const data = await res.json();
    workerAnswered = true; // signal the hedge it no longer needs to hit Overpass
    return data;
  })();

  const viaOverpass = (async () => {
    await new Promise(r => setTimeout(r, HEDGE_MS));
    if (workerAnswered) throw new Error('worker answered first'); // skip Overpass entirely
    const [s, w, n, e] = bbox.split(',');
    const q = `[out:json][timeout:25];(way["highway"~"^(path|track|footway|bridleway|cycleway)$"](${s},${w},${n},${e});>;);out body;`;
    const res = await fetchWithTimeout(OVERPASS_DIRECT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `data=${encodeURIComponent(q)}`,
    }, 20000);
    if (!res.ok) throw new Error(`overpass ${res.status}`);
    return res.json();
  })();

  // First VALID response wins. Promise.any ignores the rejections (worker error, or the
  // hedge's "worker answered first" skip) unless every source fails.
  return Promise.any([viaWorker, viaOverpass]);
}

// ── Pre-baked forest path bundle (fast path, no network) ──────────────────────
// The whole forest's OSM path network is shipped as a static asset
// (public/data/forest-paths.json, built by scripts/build-forest-paths.mjs) in the
// same { coordinates, _highway?, _surface? } shape osmDataToCoordPaths produces. When
// the requested area is inside FOREST_BOUNDS we filter that in-memory list instead of
// touching Overpass — so route/loop generation is instant, needs no network, and works
// offline. Anything outside the forest (or a failed bundle load) falls back to the
// hedged live fetch above. The bundle is cache-first via the service worker, so it
// loads once and is reused across sessions.
let _forestPaths = null;         // parsed array once loaded (null = not loaded / failed)
let _forestPathsPromise = null;  // in-flight load, shared so we fetch it only once

function loadForestPaths() {
  if (_forestPaths) return Promise.resolve(_forestPaths);
  if (_forestPathsPromise) return _forestPathsPromise;
  _forestPathsPromise = (async () => {
    try {
      // Relative URL → always the page's own origin (matches carrefours / quests.json),
      // so *.pages.dev previews load their own copy and the SW can cache it.
      const res = await fetchWithTimeout('data/forest-paths.json', {}, 15000);
      if (!res.ok) throw new Error(`forest-paths ${res.status}`);
      const data = await res.json();
      if (!Array.isArray(data)) throw new Error('forest-paths malformed');
      _forestPaths = data;
      return data;
    } catch (e) {
      console.warn('loadForestPaths:', e.message);
      _forestPaths = null; _forestPathsPromise = null; // allow a later retry
      return null;
    }
  })();
  return _forestPathsPromise;
}

// True when the whole requested bbox lies inside the pre-baked forest bounds.
function bboxWithinForest(minLat, minLng, maxLat, maxLng, bounds) {
  const b = bounds || (typeof FOREST_BOUNDS !== 'undefined' ? FOREST_BOUNDS : null);
  if (!b) return false;
  return minLat >= b.minLat && minLng >= b.minLng && maxLat <= b.maxLat && maxLng <= b.maxLng;
}

// Keep every path that has at least one coordinate inside the bbox. Pure — the router
// only reads the coordinate arrays (weighting helpers shallow-copy), so sharing them
// with the bundle is safe.
function filterPathsToBbox(paths, minLat, minLng, maxLat, maxLng) {
  return paths.filter(p => p.coordinates.some(([la, lo]) =>
    la >= minLat && la <= maxLat && lo >= minLng && lo <= maxLng));
}

function fetchOsmPathsForBbox(minLat, minLng, maxLat, maxLng) {
  const bbox = `${minLat.toFixed(4)},${minLng.toFixed(4)},${maxLat.toFixed(4)},${maxLng.toFixed(4)}`;
  if (_osmPathCache.has(bbox)) return _osmPathCache.get(bbox);
  const p = (async () => {
    // Fast path: filter the pre-baked forest bundle in memory — no network.
    if (bboxWithinForest(minLat, minLng, maxLat, maxLng)) {
      const forest = await loadForestPaths();
      if (forest) return filterPathsToBbox(forest, minLat, minLng, maxLat, maxLng);
      // bundle unavailable → fall through to the live fetch below
    }
    // Fallback: live network fetch (out-of-forest, or the bundle failed to load).
    try {
      const data = await fetchOsmData(bbox);
      if (!Array.isArray(data?.elements)) { console.warn('OSM response malformed'); _osmPathCache.delete(bbox); return []; }
      return osmDataToCoordPaths(data);
    } catch (e) {
      // Drop the failed promise so a later attempt can retry instead of caching the failure.
      // (AggregateError from Promise.any means both the worker and the direct fetch failed.)
      console.warn('fetchOsmPathsForBbox:', e.message); _osmPathCache.delete(bbox); return [];
    }
  })();
  // Evict oldest entry (Map keeps insertion order) to bound memory usage.
  if (_osmPathCache.size >= 5) _osmPathCache.delete(_osmPathCache.keys().next().value);
  _osmPathCache.set(bbox, p);
  return p;
}

// Warm the forest bundle as early as possible (browser only) so the first loop is fast.
if (typeof window !== 'undefined') { try { loadForestPaths(); } catch (e) {} }

// ── OSM prefetch — warm the cache as soon as the user places their point(s) ────
// The OSM round-trip is the dominant cost of a route; kicking it off on point
// placement (and again, concurrently, at Generate time) hides that latency behind
// the user's think-time. Fire-and-forget; the bbox math mirrors routeLoop / routeAtob
// exactly so the cache key matches and the eventual route reuses this request.
function prefetchLoopOsm(sLat, sLng, targetKm) {
  const radiusKm = Math.max((targetKm || 10) / 2, 1);
  const padLat = radiusKm / 111;
  const padLng = radiusKm / (111 * Math.cos(sLat * Math.PI / 180));
  try { fetchOsmPathsForBbox(sLat - padLat, sLng - padLng, sLat + padLat, sLng + padLng); } catch {}
}
function prefetchAtobOsm(sLat, sLng, eLat, eLng) {
  const pad = 0.05;
  try {
    fetchOsmPathsForBbox(
      Math.min(sLat, eLat) - pad, Math.min(sLng, eLng) - pad,
      Math.max(sLat, eLat) + pad, Math.max(sLng, eLng) + pad,
    );
  } catch {}
}

// ── Public routing entry points ───────────────────────────────────────────────
async function routeAtob(sLat, sLng, eLat, eLng) {
  // Shortest mode: Dijkstra on raw OSM forest paths (no admin bias, no weight penalty).
  // Fetches path/track/footway/bridleway/cycleway in a wide bbox and finds the
  // genuinely shortest forest route. Falls back to ORS then OSRM only if graph fails.
  if (routingPriority === 'shortest') {
    try {
      const pad = 0.05;
      const osmPaths = await fetchOsmPathsForBbox(
        Math.min(sLat, eLat) - pad, Math.min(sLng, eLng) - pad,
        Math.max(sLat, eLat) + pad, Math.max(sLng, eLng) + pad,
      );
      if (osmPaths.length) {
        const r = graphAtob(sLat, sLng, eLat, eLng, applyOsmSurfaceWeights(osmPaths), transportMode);
        console.info(`routing: OSM graph (${osmPaths.length} chemins, ${(r.meters/1000).toFixed(1)} km)`);
        return r;
      }
    } catch (e) { console.warn('OSM graph shortest:', e.message); }
    try {
      const r = await callORS({ profile: orsProfile(), coordinates: [[sLng, sLat], [eLng, eLat]] });
      console.info(`routing: ORS (${(r.meters/1000).toFixed(1)} km)`);
      return r;
    } catch (e) { console.warn('ORS shortest:', e.message); }
    console.info('routing: OSRM fallback');
    return osrmRoute([{ lat: sLat, lon: sLng }, { lat: eLat, lon: eLng }]);
  }

  // Forest mode: route over ALL paths on the map. The OSM forest-path network
  // (path/track/footway/bridleway/cycleway) plus the admin paths are merged into one
  // stitched graph (see buildGraph), so the router can use every path and transfer
  // between networks wherever they cross — no more being trapped on the admin network.
  const straightM = haversineM(sLat, sLng, eLat, eLng);
  const pad = 0.05;
  const osmPaths = await fetchOsmPathsForBbox(
    Math.min(sLat, eLat) - pad, Math.min(sLng, eLng) - pad,
    Math.max(sLat, eLat) + pad, Math.max(sLng, eLng) + pad,
  );
  // Surface preference first, then bias toward paths matching the chosen difficulty.
  const weightedOsmPaths = applyDifficultyWeights(applyOsmSurfaceWeights(osmPaths));
  const admin = applyDifficultyWeights(savedPaths.length ? filterPaths(savedPaths) : []);

  // 1. Combined admin + OSM graph (admin mildly preferred). Also compute the OSM-only
  //    route and keep whichever is shorter — guards against any residual admin detour.
  if (weightedOsmPaths.length || admin.length) {
    let best = null;
    try {
      const hybrid = graphAtobHybrid(sLat, sLng, eLat, eLng, admin, weightedOsmPaths, transportMode);
      if (hybrid.meters <= straightM * 4) best = hybrid;
    } catch (e) { console.warn('graph hybrid:', e.message); }
    // The OSM-only route guards against an admin-path detour. Skip it when there
    // are no admin paths: the hybrid graph is then just the OSM network with a
    // uniform gap-fill weight, whose shortest path is identical — so a second
    // full graph build + Dijkstra would be pure wasted work.
    if (weightedOsmPaths.length && admin.length) {
      try {
        const osmOnly = graphAtob(sLat, sLng, eLat, eLng, weightedOsmPaths, transportMode);
        if (osmOnly.meters <= straightM * 4 && (!best || osmOnly.meters < best.meters)) best = osmOnly;
      } catch (e) { console.warn('OSM graph:', e.message); }
    }
    if (best) { console.info(`routing: forest graph (${(best.meters / 1000).toFixed(1)} km)`); return best; }
  }
  // 2. ORS (needs ORS_KEY in Cloudflare)
  try {
    return await callORS({ profile: orsProfile(), coordinates: [[sLng, sLat], [eLng, eLat]] });
  } catch (e) { console.warn('ORS:', e.message); }
  // 3. OSRM — last resort, uses all roads and paths
  return osrmRoute([{ lat: sLat, lon: sLng }, { lat: eLat, lon: eLng }]);
}

// A small integer that changes once per day (and per start point), so the same
// start point produces a different boucle from one day to the next. Stable
// within a given day so a refresh shows the same loop.
function dailyLoopSeed(sLat, sLng) {
  const day = new Date().toISOString().slice(0, 10); // YYYY-MM-DD, local-day granularity
  const key = `${day}|${sLat.toFixed(4)}|${sLng.toFixed(4)}`;
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0;
  return Math.abs(h) % 100000 + 1; // never 0 (0 = deterministic mode)
}

async function routeLoop(sLat, sLng, targetKm) {
  const seed = dailyLoopSeed(sLat, sLng);
  // 1. Hybrid graph router — real loop. Admin paths are the primary network and
  //    OSM (unnoted) paths fill gaps, so the loop continues past the edge of the
  //    curated network instead of stopping where noted paths run out.
  try {
    const admin = applyDifficultyWeights(filterPaths(savedPaths));
    // bbox roughly covers the loop's reach around the start point (radius ≈ half the target)
    const radiusKm = Math.max(targetKm / 2, 1);
    const padLat = radiusKm / 111;
    const padLng = radiusKm / (111 * Math.cos(sLat * Math.PI / 180));
    const osmPaths = applyDifficultyWeights(applyOsmSurfaceWeights(
      await fetchOsmPathsForBbox(sLat - padLat, sLng - padLng, sLat + padLat, sLng + padLng),
    ));
    if (admin.length || osmPaths.length) {
      // seed rotates the turnaround direction each day → a fresh loop daily
      return graphLoopHybrid(sLat, sLng, targetKm, admin, osmPaths, transportMode, seed);
    }
  } catch (e) { console.warn('graph loop hybrid:', e.message); }
  // 2. ORS round_trip (needs ORS_KEY) — vary the seed daily so the shape changes
  try {
    return await callORS({
      profile: orsProfile(),
      coordinates: [[sLng, sLat]],
      round_trip: { length: Math.round(targetKm * 1000), points: 5, seed },
    });
  } catch (e) { console.warn('ORS:', e.message); }
  // 3. OSRM trip — always works; rotate its waypoint ring by the daily seed
  return osrmLoopWithRetry(sLat, sLng, targetKm, seed);
}

// ── Custom "Sur mesure" route — user-chosen ordered stops ─────────────────────
// waypoints: [{ lat, lng }, …] with length ≥ 2, in the order the user placed them.
// Builds ONE combined admin + OSM graph over the bbox of all stops (so we fetch
// OSM once, not per leg) then routes each consecutive pair on that shared graph
// with Dijkstra and concatenates the legs. Any leg the forest graph can't connect
// falls back to a direct OSRM route for just that leg, so the whole route never
// fails outright. Honors the current difficulty/surface/path-type preferences via
// the same weighting helpers the other engines use.
async function routeCustom(waypoints) {
  if (!Array.isArray(waypoints) || waypoints.length < 2) {
    throw new Error('Ajoute au moins deux points pour un trajet sur mesure');
  }

  // 1. bbox over every stop + a pad, fetch OSM forest paths once (cached server + client).
  const lats = waypoints.map(w => w.lat);
  const lngs = waypoints.map(w => w.lng);
  const pad = 0.05;
  const osmPaths = await fetchOsmPathsForBbox(
    Math.min(...lats) - pad, Math.min(...lngs) - pad,
    Math.max(...lats) + pad, Math.max(...lngs) + pad,
  );

  // 2. Same weighting the forest A→B engine uses: surface preference, then difficulty bias.
  const weightedOsm = applyDifficultyWeights(applyOsmSurfaceWeights(osmPaths));
  const admin = applyDifficultyWeights(savedPaths.length ? filterPaths(savedPaths) : []);

  // 3. One stitched graph for every leg (admin primary, OSM weighted gap-fill).
  const combined = [...admin, ...tagOsmGapFill(weightedOsm)];
  let nodes = null, adj = null;
  if (combined.length) {
    try {
      ({ nodes, adj } = buildGraph(combined));
    } catch (e) { console.warn('routeCustom buildGraph:', e.message); }
  }

  // 4. Route each consecutive pair; concat coords (dropping the duplicated shared node).
  let coords = [];
  let meters = 0;
  for (let i = 0; i < waypoints.length - 1; i++) {
    const a = waypoints[i], b = waypoints[i + 1];
    let leg = null;
    if (nodes && adj) {
      try {
        const s = nearestNode(nodes, a.lat, a.lng);
        const e = nearestNode(nodes, b.lat, b.lng);
        if (s && e) {
          const { prev } = dijkstra(adj, s.k, e.k);
          const keys = rebuildPath(prev, s.k, e.k);
          if (keys) leg = graphToResult(nodes, keys, transportMode);
        }
      } catch (err) { console.warn(`routeCustom leg ${i} graph:`, err.message); }
    }
    // Per-leg fallback: a direct OSRM route so a single unconnected pair never
    // sinks the whole custom route.
    if (!leg) {
      leg = await osrmRoute([{ lat: a.lat, lon: a.lng }, { lat: b.lat, lon: b.lng }]);
    }
    coords = coords.length ? coords.concat(leg.coords.slice(1)) : leg.coords.slice();
    meters += leg.meters;
  }

  const speed = transportMode === 'bike' ? 4.17 : 1.11; // m/s (mirror graphToResult)
  return { coords, meters, seconds: meters / speed };
}

// Expose the pure forest-bundle helpers for unit tests (Node CJS). The guard is false
// in the browser (no `module`), so this is a no-op there — routes-engine.js stays a
// classic script that reads the shared `let` state declared in routes.js.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { bboxWithinForest, filterPathsToBbox };
}
