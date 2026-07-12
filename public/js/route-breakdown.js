// route-breakdown.js — "Types de chemins & Revêtements" panels for a computed route.
// Lazy-loaded by routes-planner.js (like elevation.js). Classifies each segment of
// the final route by snapping it to the nearest source path (admin-curated paths +
// the OSM forest-path network fetched during routing), then aggregates the distance
// travelled per way-type and per surface — the two breakdown panels the user wanted.
//
// It reuses globals already on the page: haversineM (graph-router.js),
// fetchOsmPathsForBbox / filterPaths / savedPaths (routes-engine.js + routes-map.js).
// No routing-core change: this is a read-only post-pass over the route geometry, so it
// works for every engine (graph / ORS / OSRM). Segments with no nearby source path
// fall into "Autre" / "Inconnu" rather than failing.

// ── Category maps ─────────────────────────────────────────────────────────────
// Way type inferred from the OSM `highway` tag, falling back to the admin pathType.
function _wayTypeOf(src) {
  const hw = (src._highway || '').replace(/_link$/, '');
  switch (hw) {
    case 'path':                              return 'Sentier';
    case 'footway': case 'pedestrian': case 'steps': case 'corridor': return 'Chemin piéton';
    case 'track':                             return 'Chemin forestier';
    case 'cycleway':                          return 'Piste cyclable';
    case 'bridleway':                         return 'Allée cavalière';
    case 'residential': case 'living_street': case 'service': case 'unclassified':
      return 'Rue';
    case 'primary': case 'secondary': case 'tertiary': case 'trunk':
    case 'motorway': case 'road':
      return 'Route';
  }
  // No OSM highway tag → this is an admin-drawn path; use its declared type.
  if (src.pathType === 'bike') return 'Piste cyclable';
  if (src.pathType || src.status) return 'Sentier';
  return 'Autre';
}

// Surface inferred from the OSM `surface` tag.
function _surfaceOf(src) {
  const s = (src._surface || '').toLowerCase();
  if (!s) return 'Inconnu';
  if (s === 'asphalt') return 'Asphalte';
  if (/^(concrete|paved|paving_stones|sett|cobblestone|metal)$/.test(s)) return 'Revêtu';
  if (/^(compacted|fine_gravel|gravel|pebblestone)$/.test(s)) return 'Gravier';
  if (/^(ground|dirt|earth|mud|grass|soil|clay)$/.test(s)) return 'Naturel';
  if (s === 'sand') return 'Sable';
  if (/^(wood|woodchips)$/.test(s)) return 'Bois';
  if (s === 'unpaved') return 'Non revêtu';
  return 'Inconnu';
}

// Stable colours per category (both themes read fine; muted earth tones).
const WAYTYPE_COLORS = {
  'Sentier':         '#4a8a32',
  'Chemin forestier':'#8a6d3b',
  'Chemin piéton':   '#6aa5c9',
  'Piste cyclable':  '#c98a3b',
  'Allée cavalière': '#9a7bb5',
  'Rue':             '#9aa0a6',
  'Route':           '#5f6368',
  'Autre':           '#c8ccc4',
};
const SURFACE_COLORS = {
  'Asphalte':    '#5f6368',
  'Revêtu':      '#9aa0a6',
  'Gravier':     '#c9a15f',
  'Naturel':     '#a8763b',
  'Sable':       '#e0c07a',
  'Bois':        '#8a6d3b',
  'Non revêtu':  '#b98a5a',
  'Inconnu':     '#22252a',
};

// ── Geometry ──────────────────────────────────────────────────────────────────
// Metres from point P to segment AB, using a local equirectangular projection
// (accurate at these distances/latitudes and far cheaper than repeated haversine).
function _pointSegMeters(pLat, pLon, aLat, aLon, bLat, bLon) {
  const kx = 111320 * Math.cos(pLat * Math.PI / 180);
  const ky = 110540;
  const px = pLon * kx, py = pLat * ky;
  const ax = aLon * kx, ay = aLat * ky;
  const bx = bLon * kx, by = bLat * ky;
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx, cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

// Build a grid index of every source segment. A segment is stamped into *every*
// cell it passes through (sampled at half-cell steps), not just its midpoint —
// OSM ways can have long segments between sparse nodes, and midpoint-only bucketing
// would miss a route point sitting near such a segment's far end.
function _indexSources(sources) {
  const CELL = 0.0006; // ~55–65 m cells → ±1 neighbour covers the 30 m snap radius
  const grid = new Map();
  const stamp = (lat, lon, seg, seen) => {
    const k = `${Math.floor(lat / CELL)},${Math.floor(lon / CELL)}`;
    if (seen.has(k)) return;
    seen.add(k);
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(seg);
  };
  for (const src of sources) {
    const c = src.coordinates;
    if (!Array.isArray(c) || c.length < 2) continue;
    for (let i = 0; i < c.length - 1; i++) {
      const [aLat, aLon] = c[i], [bLat, bLon] = c[i + 1];
      const seg = { aLat, aLon, bLat, bLon, src };
      const span = Math.max(Math.abs(bLat - aLat), Math.abs(bLon - aLon));
      const steps = Math.max(1, Math.ceil(span / (CELL / 2)));
      const seen = new Set();
      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        stamp(aLat + (bLat - aLat) * t, aLon + (bLon - aLon) * t, seg, seen);
      }
    }
  }
  return { grid, CELL };
}

const _SNAP_M = 30; // max distance a route point may sit from a source path to inherit its tags

// For a route segment midpoint, find the nearest source segment within _SNAP_M.
function _nearestSource(index, mLat, mLon) {
  const { grid, CELL } = index;
  const cr = Math.floor(mLat / CELL), cc = Math.floor(mLon / CELL);
  let best = null, bd = _SNAP_M;
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      const bucket = grid.get(`${cr + dr},${cc + dc}`);
      if (!bucket) continue;
      for (const seg of bucket) {
        const d = _pointSegMeters(mLat, mLon, seg.aLat, seg.aLon, seg.bLat, seg.bLon);
        if (d < bd) { bd = d; best = seg.src; }
      }
    }
  }
  return best;
}

// ── Classification ────────────────────────────────────────────────────────────
// coords: [[lat,lon], …] of the final route. sources: array of {coordinates, …tags}.
// Returns { wayTypes:[{label,meters,color}], surfaces:[…], total } sorted desc.
function classifyRoute(coords, sources) {
  const index = _indexSources(sources);
  const wayM = new Map(), surfM = new Map();
  let total = 0;
  for (let i = 0; i < coords.length - 1; i++) {
    const [aLat, aLon] = coords[i], [bLat, bLon] = coords[i + 1];
    const segM = haversineM(aLat, aLon, bLat, bLon);
    if (!segM) continue;
    total += segM;
    const src = _nearestSource(index, (aLat + bLat) / 2, (aLon + bLon) / 2);
    const wt = src ? _wayTypeOf(src) : 'Autre';
    const sf = src ? _surfaceOf(src) : 'Inconnu';
    wayM.set(wt, (wayM.get(wt) || 0) + segM);
    surfM.set(sf, (surfM.get(sf) || 0) + segM);
  }
  const toRows = (map, colors, fallback) => [...map.entries()]
    .map(([label, meters]) => ({ label, meters, color: colors[label] || fallback }))
    .sort((a, b) => b.meters - a.meters);
  return {
    total,
    wayTypes: toRows(wayM, WAYTYPE_COLORS, '#c8ccc4'),
    surfaces: toRows(surfM, SURFACE_COLORS, '#22252a'),
  };
}

// ── Rendering ─────────────────────────────────────────────────────────────────
function _fmtDist(m) {
  if (m < 100)   return '< 100 m';
  if (m < 1000)  return `${Math.round(m / 10) * 10} m`;
  return `${(m / 1000).toFixed(2)} km`;
}

function _renderBlock(title, rows, total) {
  if (!rows.length || total <= 0) return '';
  const bar = rows.map(r =>
    `<span class="bd-seg" style="flex:${r.meters};background:${r.color}"></span>`).join('');
  const legend = rows.map(r => `
    <div class="bd-row">
      <span class="bd-swatch" style="background:${r.color}"></span>
      <span class="bd-label">${r.label}</span>
      <span class="bd-dist">${_fmtDist(r.meters)}</span>
    </div>`).join('');
  return `
    <div class="bd-block">
      <div class="bd-title">${title}</div>
      <div class="bd-bar">${bar}</div>
      <div class="bd-legend">${legend}</div>
    </div>`;
}

// Public entry point called from displayRoute. Fetches the OSM path network for the
// route's bounding box (already cached from routing → usually instant), merges it
// with the admin paths, classifies the route, and paints the two panels.
async function renderRouteBreakdown(coords) {
  const wrap = document.getElementById('breakdownWrap');
  if (!wrap || !coords || coords.length < 2) return;
  try {
    let minLat = 90, minLng = 180, maxLat = -90, maxLng = -180;
    for (const [lat, lon] of coords) {
      if (lat < minLat) minLat = lat; if (lat > maxLat) maxLat = lat;
      if (lon < minLng) minLng = lon; if (lon > maxLng) maxLng = lon;
    }
    const pad = 0.01;
    const osmPaths = await fetchOsmPathsForBbox(
      minLat - pad, minLng - pad, maxLat + pad, maxLng + pad);
    const admin = Array.isArray(savedPaths) && savedPaths.length ? filterPaths(savedPaths) : [];
    const sources = [...admin, ...(osmPaths || [])];
    const bd = classifyRoute(coords, sources);
    const html = _renderBlock('Types de chemins', bd.wayTypes, bd.total)
               + _renderBlock('Revêtements',     bd.surfaces, bd.total);
    if (!html) { wrap.classList.add('hidden'); return; }
    wrap.innerHTML = html;
    wrap.classList.remove('hidden');
  } catch (e) {
    console.warn('renderRouteBreakdown:', e.message);
    wrap.classList.add('hidden');
  }
}

// CJS export for unit tests (pure functions only).
if (typeof module !== 'undefined') {
  module.exports = { classifyRoute, _wayTypeOf, _surfaceOf, _pointSegMeters, _fmtDist };
}
