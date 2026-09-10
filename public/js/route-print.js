// ── Route print / PDF (roadbook) ──────────────────────────────────────────────
// Lazy-loaded by routes.js on first "Imprimer / PDF" click (same pattern as
// route-save.js). Turns the route currently on screen into a print-ready A4
// sheet: a crisp VECTOR map (no tiles — so it never blurs when zoomed and works
// offline once printed) plus a big, legible "roadbook" — the ordered list of
// named carrefours the route passes through, with the cumulative distance to
// each. This is the paper a hiker carries into the forest where there is no
// mobile signal (the #1 request from an early user).
//
// Globals read at call time (declared in routes.js / loaded on routes.html):
//   lastRoute, savedPaths, difficulty, pathType, mode, CARREFOURS,
//   showToast, escapeHtml.
//
// The pure geometry helpers (haversineM / carrefoursAlongRoute) are exported for
// the Node unit tests via the module.exports guard at the bottom; in the browser
// that guard is a no-op, so this stays a classic script.

function _rpHaversineM(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2
          + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180)
          * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * The named carrefours a route passes through, in traversal order.
 * @param {Array<[number,number]>} coords  route as [lat,lon] pairs
 * @param {Array<{name,lat,lon}>}  carrefours
 * @param {{thresholdM?:number, minGapM?:number}} opts
 *   thresholdM — how close (m) a carrefour must come to the route to count (default 80)
 *   minGapM    — collapse the SAME carrefour hit again within this many metres of
 *                cumulative distance (route wiggling past one junction) (default 200)
 * @returns {Array<{name,lat,lon,distM,cumM}>} sorted by cumulative distance along the route
 */
function carrefoursAlongRoute(coords, carrefours, opts = {}) {
  const thresholdM = opts.thresholdM != null ? opts.thresholdM : 80;
  const minGapM    = opts.minGapM    != null ? opts.minGapM    : 200;
  if (!Array.isArray(coords) || coords.length < 2 || !Array.isArray(carrefours)) return [];

  // Cumulative distance at each route vertex.
  const cum = new Array(coords.length);
  cum[0] = 0;
  for (let i = 1; i < coords.length; i++) {
    cum[i] = cum[i - 1] + _rpHaversineM(coords[i - 1][0], coords[i - 1][1], coords[i][0], coords[i][1]);
  }

  const hits = [];
  for (const c of carrefours) {
    if (!c || !isFinite(c.lat) || !isFinite(c.lon)) continue;
    let best = Infinity, bestCum = 0, bestIdx = 0;
    for (let i = 0; i < coords.length; i++) {
      const d = _rpHaversineM(c.lat, c.lon, coords[i][0], coords[i][1]);
      if (d < best) { best = d; bestCum = cum[i]; bestIdx = i; }
    }
    if (best <= thresholdM) hits.push({ name: c.name, lat: c.lat, lon: c.lon, distM: best, cumM: bestCum, idx: bestIdx });
  }

  hits.sort((a, b) => a.cumM - b.cumM);

  // Collapse the same-named carrefour re-hit within minGapM (route brushing past
  // a single junction produces several near-vertices) — distinct junctions stay.
  const kept = [];
  for (const h of hits) {
    const prev = kept[kept.length - 1];
    if (prev && prev.name === h.name && (h.cumM - prev.cumM) < minGapM) continue;
    kept.push(h);
  }
  return kept;
}

// ── Turn-by-turn directions ────────────────────────────────────────────────
// For each carrefour: which way to turn (relative to how you arrived) and the
// compass heading you leave on. This is what makes the roadbook navigable — the
// hiker reads "au Carrefour X, tout droit, cap N-E" at each junction.

function _rpBearing(lat1, lon1, lat2, lon2) {
  const toRad = d => d * Math.PI / 180;
  const φ1 = toRad(lat1), φ2 = toRad(lat2), Δλ = toRad(lon2 - lon1);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

// 8-point compass, French abbreviations.
function _rpCardinal(bearing) {
  const dirs = ['N', 'N-E', 'E', 'S-E', 'S', 'S-O', 'O', 'N-O'];
  return dirs[Math.round(((bearing % 360) + 360) % 360 / 45) % 8];
}

// A point `deltaM` metres before (<0) / after (>0) vertex `idx`, interpolated
// along the route so bearings aren't thrown off by a single noisy GPS vertex.
function _rpPointAtOffset(coords, cum, idx, deltaM) {
  const target = cum[idx] + deltaM;
  const total = cum[cum.length - 1];
  if (target <= 0) return coords[0];
  if (target >= total) return coords[coords.length - 1];
  for (let i = 0; i < cum.length - 1; i++) {
    if (cum[i] <= target && target <= cum[i + 1]) {
      const seg = cum[i + 1] - cum[i];
      const f = seg > 0 ? (target - cum[i]) / seg : 0;
      return [
        coords[i][0] + (coords[i + 1][0] - coords[i][0]) * f,
        coords[i][1] + (coords[i + 1][1] - coords[i][1]) * f,
      ];
    }
  }
  return coords[idx];
}

/**
 * Direction annotation for each hit, aligned 1:1 with `hits`.
 * @returns {Array<{turn:string|null, cardinal:string, bearing:number}>}
 *   turn — 'tout droit' | 'à gauche' | 'à droite' | 'demi-tour' | null (at the start)
 *   cardinal — the compass heading you leave the carrefour on (N, N-E, …)
 */
function computeDirections(coords, hits, opts = {}) {
  const lookM = opts.lookM != null ? opts.lookM : 35;
  if (!Array.isArray(coords) || coords.length < 2 || !Array.isArray(hits)) {
    return (hits || []).map(() => ({ turn: null, cardinal: null, bearing: 0 }));
  }
  const cum = new Array(coords.length);
  cum[0] = 0;
  for (let i = 1; i < coords.length; i++) {
    cum[i] = cum[i - 1] + _rpHaversineM(coords[i - 1][0], coords[i - 1][1], coords[i][0], coords[i][1]);
  }

  return hits.map(h => {
    const idx = h.idx != null ? h.idx : 0;
    const here   = coords[idx];
    const before = _rpPointAtOffset(coords, cum, idx, -lookM);
    const after  = _rpPointAtOffset(coords, cum, idx, lookM);
    const outB = _rpBearing(here[0], here[1], after[0], after[1]);
    const cardinal = _rpCardinal(outB);

    // No incoming leg at the very start → just a heading.
    if (idx === 0 || (before[0] === here[0] && before[1] === here[1])) {
      return { turn: null, cardinal, bearing: outB };
    }
    const inB = _rpBearing(before[0], before[1], here[0], here[1]);
    const delta = ((outB - inB + 540) % 360) - 180; // [-180,180]; + = right
    const a = Math.abs(delta);
    let turn;
    if (a < 25) turn = 'tout droit';
    else if (a <= 140) turn = delta > 0 ? 'à droite' : 'à gauche';
    else turn = 'demi-tour';
    return { turn, cardinal, bearing: outB };
  });
}

// ── Rendering (browser only) ────────────────────────────────────────────────

function _rpBounds(coordsList) {
  let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
  for (const [lat, lon] of coordsList) {
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
  }
  return { minLat, maxLat, minLon, maxLon };
}

// Curated paths whose bbox overlaps the (padded) route bounds — drawn as faint
// context lines so the vector map isn't a lone squiggle.
function _rpContextPaths(paths, b) {
  if (!Array.isArray(paths)) return [];
  return paths.filter(p => {
    const cs = p && p.coordinates;
    if (!Array.isArray(cs) || cs.length < 2) return false;
    return cs.some(([lat, lon]) =>
      lat >= b.minLat && lat <= b.maxLat && lon >= b.minLon && lon <= b.maxLon);
  });
}

function _rpEsc(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function _rpFmtKm(m) {
  return (m / 1000).toLocaleString('fr-FR', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + ' km';
}

function _rpFmtDuration(seconds) {
  const h = Math.floor(seconds / 3600);
  const min = Math.round((seconds % 3600) / 60);
  return h > 0 ? `${h}h${String(min).padStart(2, '0')}` : `${min} min`;
}

/**
 * Build the SVG vector map. Pure string builder so it needs no live tiles:
 * route (coloured, white-cased), faint context paths, numbered carrefour
 * markers keyed to the roadbook, a north arrow and a scale bar.
 */
function _rpBuildMapSvg(coords, hits, contextPaths, opts) {
  const color = opts.color || '#22c55e';
  const isLoop = opts.isLoop;

  // Bounds over the route + its carrefours, padded 8 %.
  const all = coords.slice();
  hits.forEach(h => all.push([h.lat, h.lon]));
  let b = _rpBounds(all);
  const padLat = Math.max((b.maxLat - b.minLat) * 0.08, 0.0008);
  const padLon = Math.max((b.maxLon - b.minLon) * 0.08, 0.0012);
  b = { minLat: b.minLat - padLat, maxLat: b.maxLat + padLat,
        minLon: b.minLon - padLon, maxLon: b.maxLon + padLon };

  const midLat   = (b.minLat + b.maxLat) / 2;
  const lonScale = Math.cos(midLat * Math.PI / 180);
  const geoW = (b.maxLon - b.minLon) * lonScale; // degrees, aspect-corrected
  const geoH = (b.maxLat - b.minLat);

  const landscape = geoW >= geoH;
  const VBW = landscape ? 1000 : 720;
  const VBH = landscape ? 700  : 1000;
  const M = 42;
  const availW = VBW - 2 * M, availH = VBH - 2 * M;
  const scale = Math.min(availW / geoW, availH / geoH); // svg units per degree-lat
  const drawW = geoW * scale, drawH = geoH * scale;
  const offX = M + (availW - drawW) / 2;
  const offY = M + (availH - drawH) / 2;

  const project = (lat, lon) => [
    offX + (lon - b.minLon) * lonScale * scale,
    offY + (b.maxLat - lat) * scale,
  ];
  const ptStr = cs => cs.map(([lat, lon]) => {
    const [x, y] = project(lat, lon);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');

  const parts = [];
  parts.push(`<svg viewBox="0 0 ${VBW} ${VBH}" xmlns="http://www.w3.org/2000/svg" class="rp-svg">`);
  parts.push(`<rect x="0" y="0" width="${VBW}" height="${VBH}" fill="#f8faf7"/>`);

  // Faint context paths.
  for (const p of contextPaths) {
    parts.push(`<polyline points="${ptStr(p.coordinates)}" fill="none" stroke="#c3cdbb" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>`);
  }

  // Route — white casing then colour.
  const routePts = ptStr(coords);
  parts.push(`<polyline points="${routePts}" fill="none" stroke="#ffffff" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>`);
  parts.push(`<polyline points="${routePts}" fill="none" stroke="${color}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>`);

  // Carrefour markers (numbered, keyed to the roadbook) + their NAME printed in
  // place. Because this is vector text it stays sharp at any zoom / on a photocopy
  // — the whole point of the print sheet vs. a blurry screenshot. The label sits on
  // the outer side of the marker (left of the pin on the map's left half, right on
  // the right half) so names lean away from the route instead of over it, and a
  // white halo (paint-order:stroke) keeps them readable across lines.
  hits.forEach((h, i) => {
    const [x, y] = project(h.lat, h.lon);
    const onRight = x > VBW / 2;
    const lx = onRight ? x + 14 : x - 14;
    const anchor = onRight ? 'start' : 'end';
    parts.push(`<text x="${lx.toFixed(1)}" y="${(y + 3.4).toFixed(1)}" text-anchor="${anchor}" font-size="10.5" font-weight="600" fill="#14532d" stroke="#ffffff" stroke-width="2.6" paint-order="stroke" style="paint-order:stroke">${i + 1}. ${_rpEsc(h.name)}</text>`);
    parts.push(`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="10" fill="#ffffff" stroke="#1f2937" stroke-width="1.6"/>`);
    parts.push(`<text x="${x.toFixed(1)}" y="${(y + 3.6).toFixed(1)}" text-anchor="middle" font-size="11" font-weight="700" fill="#1f2937">${i + 1}</text>`);
  });

  // Start (and end for A→B).
  const [sx, sy] = project(coords[0][0], coords[0][1]);
  parts.push(`<circle cx="${sx.toFixed(1)}" cy="${sy.toFixed(1)}" r="13" fill="#16a34a" stroke="#ffffff" stroke-width="2.4"/>`);
  parts.push(`<text x="${sx.toFixed(1)}" y="${(sy + 4.5).toFixed(1)}" text-anchor="middle" font-size="13" font-weight="800" fill="#ffffff">D</text>`);
  if (!isLoop) {
    const [ex, ey] = project(coords[coords.length - 1][0], coords[coords.length - 1][1]);
    parts.push(`<circle cx="${ex.toFixed(1)}" cy="${ey.toFixed(1)}" r="13" fill="#dc2626" stroke="#ffffff" stroke-width="2.4"/>`);
    parts.push(`<text x="${ex.toFixed(1)}" y="${(ey + 4.5).toFixed(1)}" text-anchor="middle" font-size="13" font-weight="800" fill="#ffffff">A</text>`);
  }

  // North arrow (top-right).
  const nx = VBW - 30, ny = 46;
  parts.push(`<g>
    <polygon points="${nx},${ny - 20} ${nx - 7},${ny} ${nx},${ny - 6} ${nx + 7},${ny}" fill="#1f2937"/>
    <text x="${nx}" y="${ny + 16}" text-anchor="middle" font-size="13" font-weight="700" fill="#1f2937">N</text>
  </g>`);

  // Scale bar — pick a "nice" length that stays under a quarter of the drawing.
  const metersPerDeg = 111320;
  const unitsPerMeter = scale / metersPerDeg;
  const niceMeters = [100, 200, 250, 500, 1000, 2000, 5000];
  let barM = niceMeters[0];
  for (const n of niceMeters) { if (n * unitsPerMeter <= availW * 0.25) barM = n; }
  const barW = barM * unitsPerMeter;
  const bx = M, by = VBH - 26;
  const barLabel = barM >= 1000 ? `${barM / 1000} km` : `${barM} m`;
  parts.push(`<g>
    <rect x="${bx}" y="${by - 4}" width="${barW.toFixed(1)}" height="5" fill="#1f2937"/>
    <rect x="${bx}" y="${by - 4}" width="${(barW / 2).toFixed(1)}" height="5" fill="#ffffff" stroke="#1f2937" stroke-width="0.8"/>
    <text x="${(bx + barW + 8).toFixed(1)}" y="${(by + 1).toFixed(1)}" font-size="12" font-weight="600" fill="#1f2937">${barLabel}</text>
  </g>`);

  parts.push('</svg>');
  return parts.join('');
}

function _rpBuildDoc(route, meta) {
  const coords = route.coords;
  const hits = meta.hits;
  const color = meta.color;

  const svg = _rpBuildMapSvg(coords, hits, meta.contextPaths, { color, isLoop: meta.isLoop });

  const dirs = computeDirections(coords, hits);
  const TURN_ARROW = { 'tout droit': '↑', 'à gauche': '←', 'à droite': '→', 'demi-tour': '↩' };

  const rows = hits.map((h, i) => {
    const badge = `<span class="rp-num">${i + 1}</span>`;
    const d = dirs[i] || {};
    let dirText;
    if (i === 0 || !d.turn) {
      dirText = `<span class="rp-dir-go">Départ</span> · cap ${_rpEsc(d.cardinal || '—')}`;
    } else {
      const arrow = TURN_ARROW[d.turn] || '↑';
      dirText = `<span class="rp-arrow">${arrow}</span> ${_rpEsc(d.turn)} · cap ${_rpEsc(d.cardinal || '—')}`;
    }
    return `<tr>
      <td class="rp-c-num">${badge}</td>
      <td class="rp-c-name">${_rpEsc(h.name)}</td>
      <td class="rp-c-dir">${dirText}</td>
      <td class="rp-c-km">km ${(h.cumM / 1000).toLocaleString('fr-FR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}</td>
    </tr>`;
  }).join('');

  const endKm = 'km ' + (route.meters / 1000).toLocaleString('fr-FR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const endRow = `<tr class="rp-return">
      <td class="rp-c-num">🏁</td>
      <td class="rp-c-name">${meta.isLoop ? 'Retour au point de départ' : 'Arrivée'}</td>
      <td class="rp-c-dir">—</td>
      <td class="rp-c-km">${endKm}</td>
    </tr>`;

  const roadbook = hits.length
    ? `<table class="rp-roadbook">
        <thead><tr><th></th><th>Carrefour</th><th>Direction à suivre</th><th>Distance</th></tr></thead>
        <tbody>${rows}${endRow}</tbody>
      </table>`
    : `<p class="rp-empty">Aucun carrefour nommé n'a été détecté le long de cet itinéraire. Suivez le tracé sur la carte ci-dessus.</p>`;

  const today = new Date().toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });

  return `<!doctype html><html lang="fr"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${_rpEsc(meta.title)} — BWR</title>
<style>
  :root { --green:#166534; --ink:#1f2937; --muted:#6b7280; --line:#e5e7eb; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    color: var(--ink); background: #fff; line-height: 1.4;
    -webkit-print-color-adjust: exact; print-color-adjust: exact;
  }
  .rp-page { max-width: 800px; margin: 0 auto; padding: 20px 22px 40px; }
  .rp-hint {
    background: #ecfdf5; border: 1px solid #a7f3d0; color: #065f46;
    padding: 10px 14px; border-radius: 10px; font-size: 14px; margin-bottom: 18px;
  }
  .rp-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; border-bottom: 3px solid var(--green); padding-bottom: 10px; margin-bottom: 14px; }
  .rp-title { font-size: 24px; font-weight: 800; margin: 0 0 4px; color: var(--green); }
  .rp-sub { font-size: 14px; color: var(--muted); margin: 0; }
  .rp-brand { text-align: right; font-size: 13px; color: var(--muted); white-space: nowrap; }
  .rp-brand strong { color: var(--green); font-size: 15px; display: block; }
  .rp-stats { display: flex; flex-wrap: wrap; gap: 8px 22px; margin: 0 0 16px; font-size: 15px; }
  .rp-stats b { color: var(--green); }
  .rp-map { border: 1px solid var(--line); border-radius: 12px; overflow: hidden; margin-bottom: 18px; }
  .rp-svg { display: block; width: 100%; height: auto; }
  .rp-section { font-size: 17px; font-weight: 800; margin: 0 0 8px; color: var(--ink); }
  .rp-roadbook { width: 100%; border-collapse: collapse; font-size: 17px; }
  .rp-roadbook th { text-align: left; font-size: 12px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); border-bottom: 2px solid var(--line); padding: 4px 8px; }
  .rp-roadbook td { padding: 9px 8px; border-bottom: 1px solid var(--line); vertical-align: middle; }
  .rp-roadbook tr { page-break-inside: avoid; }
  .rp-c-num { width: 38px; }
  .rp-c-name { font-weight: 700; }
  .rp-c-dir { font-size: 15px; color: var(--ink); white-space: nowrap; }
  .rp-c-dir .rp-arrow { display: inline-block; font-weight: 800; color: var(--green); margin-right: 3px; }
  .rp-c-dir .rp-dir-go { font-weight: 700; color: var(--green); }
  .rp-c-km { white-space: nowrap; text-align: right; color: var(--green); font-weight: 700; }
  .rp-num { display: inline-flex; align-items: center; justify-content: center; width: 26px; height: 26px; border-radius: 50%; background: var(--ink); color: #fff; font-size: 13px; font-weight: 700; }
  .rp-return td { background: #f0fdf4; font-weight: 700; }
  .rp-empty { font-size: 15px; color: var(--muted); background: #f9fafb; border: 1px dashed var(--line); border-radius: 10px; padding: 16px; }
  .rp-foot { margin-top: 22px; padding-top: 10px; border-top: 1px solid var(--line); font-size: 12px; color: var(--muted); display: flex; justify-content: space-between; gap: 12px; }
  @media print { .rp-hint { display: none; } .rp-page { max-width: none; padding: 0; } }
  @page { size: A4; margin: 12mm; }
</style>
</head><body>
  <div class="rp-page">
    <div class="rp-hint">🖨️ Utilisez la boîte d'impression pour imprimer, ou « Enregistrer au format PDF ». Astuce : gardez ce feuillet dans votre poche — il reste lisible sans réseau. (Ctrl/Cmd + P pour réimprimer.)</div>
    <div class="rp-head">
      <div>
        <h1 class="rp-title">${_rpEsc(meta.title)}</h1>
        <p class="rp-sub">${_rpEsc(meta.modeLabel)} · ${_rpEsc(meta.typeLabel)} · niveau ${_rpEsc(meta.diffLabel)}</p>
      </div>
      <div class="rp-brand"><strong>BWR</strong>Forêt de Compiègne<br>bwrmaps.com</div>
    </div>
    <div class="rp-stats">
      <span>📏 <b>${_rpFmtKm(route.meters)}</b></span>
      <span>⏱️ <b>${_rpFmtDuration(route.seconds)}</b></span>
      <span>📅 ${today}</span>
      <span>🧭 ${hits.length} carrefour${hits.length > 1 ? 's' : ''}</span>
    </div>
    <div class="rp-map">${svg}</div>
    <h2 class="rp-section">📖 Feuille de route</h2>
    ${roadbook}
    <div class="rp-foot">
      <span>Généré par BWR — Balades en forêt de Compiègne</span>
      <span>bwrmaps.com</span>
    </div>
  </div>
</body></html>`;
}

// ── Entry points ───────────────────────────────────────────────────────────────
// printRouteData() is the shared worker: it takes an explicit route + metadata,
// so it serves BOTH the live planner (printCurrentRoute, reading page globals)
// AND the saved-routes history (which passes a route fetched from the API).
//
// @param {{coords:Array<[number,number]>, meters:number, seconds:number}} route
// @param {{difficulty?, pathType?, mode?, name?}} opts
function printRouteData(route, opts = {}) {
  if (!route || !Array.isArray(route.coords) || route.coords.length < 2) {
    if (typeof showToast === 'function') showToast('Itinéraire indisponible pour l\'impression.');
    return;
  }
  const coords = route.coords;
  const carrefours = (typeof CARREFOURS !== 'undefined' && Array.isArray(CARREFOURS)) ? CARREFOURS : [];
  const hits = carrefoursAlongRoute(coords, carrefours);

  const b0 = _rpBounds(coords);
  const padLat = Math.max((b0.maxLat - b0.minLat) * 0.12, 0.001);
  const padLon = Math.max((b0.maxLon - b0.minLon) * 0.12, 0.0015);
  const padded = { minLat: b0.minLat - padLat, maxLat: b0.maxLat + padLat,
                   minLon: b0.minLon - padLon, maxLon: b0.maxLon + padLon };
  const contextPaths = _rpContextPaths(typeof savedPaths !== 'undefined' ? savedPaths : [], padded);

  const diff = opts.difficulty || 'easy';
  const pt   = opts.pathType || 'foot';
  const md   = opts.mode || 'loop';

  const color = diff === 'easy' ? '#22c55e' : diff === 'medium' ? '#f97316' : '#ef4444';
  const typeLabel = { foot: 'Chemin forestier', bike: 'Piste cyclable', champs: 'Chemin de champs', mix: 'Mixte' }[pt] || 'Itinéraire';
  const modeLabel = { loop: 'Boucle', atob: 'Trajet A → B', custom: 'Trajet sur mesure', import: 'Trajet importé' }[md] || 'Trajet';
  const diffLabel = { easy: 'facile', medium: 'moyen', hard: 'difficile' }[diff] || diff;
  const title = opts.name ? opts.name : `${modeLabel} · ${_rpFmtKm(route.meters)}`;

  const html = _rpBuildDoc(route, {
    hits, contextPaths, color, isLoop: md === 'loop',
    title, typeLabel, modeLabel, diffLabel,
  });

  const w = window.open('', '_blank');
  if (!w) {
    if (typeof showToast === 'function') showToast('Autorisez les fenêtres pop-up pour imprimer.');
    return;
  }
  w.document.open();
  w.document.write(html);
  w.document.close();
  w.focus();
  // Give the SVG a beat to lay out before the print dialog opens.
  setTimeout(() => { try { w.print(); } catch (_) {} }, 450);
}

// Wired from the planner's "Imprimer / PDF" button — reads the route on screen.
function printCurrentRoute() {
  if (typeof lastRoute === 'undefined' || !lastRoute || !Array.isArray(lastRoute.coords) || lastRoute.coords.length < 2) {
    if (typeof showToast === 'function') showToast('Générez d\'abord un itinéraire.');
    return;
  }
  printRouteData(lastRoute, {
    difficulty: typeof difficulty !== 'undefined' ? difficulty : 'easy',
    pathType:   typeof pathType   !== 'undefined' ? pathType   : 'foot',
    mode:       typeof mode       !== 'undefined' ? mode       : 'loop',
  });
}

// Node CJS export for the unit tests (no-op in the browser).
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { carrefoursAlongRoute, computeDirections, _rpBearing, _rpCardinal, _rpHaversineM, _rpBuildDoc, _rpBuildMapSvg, _rpContextPaths, _rpBounds };
}
