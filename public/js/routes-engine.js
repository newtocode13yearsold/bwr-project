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
const _osmPathCache = new Map();

async function fetchOsmPathsForBbox(minLat, minLng, maxLat, maxLng) {
  const bbox = `${minLat.toFixed(4)},${minLng.toFixed(4)},${maxLat.toFixed(4)},${maxLng.toFixed(4)}`;
  if (_osmPathCache.has(bbox)) return _osmPathCache.get(bbox);
  try {
    // Generous timeout: the worker may retry a flaky Overpass instance. A late
    // success is still cached server-side, making the user's next attempt instant.
    const res = await fetchWithTimeout(`${API_URL}/api/osm?bbox=${bbox}`, {}, 35000);
    if (!res.ok) { console.warn('OSM bbox fetch failed:', res.status); return []; }
    const data = await res.json();
    if (!Array.isArray(data?.elements)) { console.warn('OSM response malformed'); return []; }
    const paths = osmDataToCoordPaths(data);
    // Evict oldest entry to bound memory usage
    if (_osmPathCache.size >= 5) _osmPathCache.delete(_osmPathCache.keys().next().value);
    _osmPathCache.set(bbox, paths);
    return paths;
  } catch (e) { console.warn('fetchOsmPathsForBbox:', e.message); return []; }
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
    if (weightedOsmPaths.length) {
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
