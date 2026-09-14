// ── Elevation profile (Open-Elevation API) ────────────────────────────────────
// Lazy-loaded by routes.js on first route generation.

async function fetchElevation(coords) {
  // Sample up to 100 evenly-spaced points to stay under API limits
  const step = Math.max(1, Math.floor(coords.length / 100));
  const sampled = coords.filter((_, i) => i % step === 0);
  if (sampled[sampled.length - 1] !== coords[coords.length - 1])
    sampled.push(coords[coords.length - 1]);

  const locations = sampled.map(([lat, lon]) => ({ latitude: lat, longitude: lon }));
  const token = localStorage.getItem('bwr_token');
  // The elevation provider (Open-Elevation, proxied through /api/elevation) is a
  // third party that regularly times out or goes down. A bare rejection here used
  // to bubble up as an uncaught error and get beaconed to the admin error monitor,
  // making a normal upstream outage look like a code bug. Swallow it and return
  // null — the elevation profile is a nice-to-have; drawElevationChart treats a
  // null/short result as "no data" and simply hides the chart.
  try {
    const res = await fetch(`${API_URL}/api/elevation`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ locations }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (data.status !== 'OK' || !Array.isArray(data.results)) return null;
    return data.results.map(r => r.elevation);
  } catch (e) {
    return null;
  }
}

// ── Grade-adjusted duration ───────────────────────────────────────────────────
// The router's own time estimate uses a flat speed (see graphToResult), which is
// wrong on a hilly forest loop: an uphill km takes far longer than a downhill one.
// Once the elevation profile is loaded we recompute the duration from the real
// slope of each segment. Flat ground reproduces the original estimate exactly, so
// nothing regresses when a route happens to be flat (or elevation is unavailable).

// Flat-ground baseline paces (m/s) — MUST stay in sync with `speed` in
// graphToResult (graph-router.js) and routeCustom (routes-engine.js).
const FLAT_SPEED = { foot: 1.11, bike: 4.17 };

// Tobler's hiking function, normalised so slope 0 === the flat baseline pace.
// factor = exp(-3.5 * (|slope + 0.05| - 0.05)), slope = rise/run (tangent):
//   slope  0.00 (flat)        → 1.00 (baseline, unchanged)
//   slope -0.05 (gentle down) → 1.19 (Tobler's peak — fastest walking grade)
//   slope +0.10 (10% up)      → 0.70
//   slope -0.20 (20% down)    → 0.70 (steep descents are slow, not fast)
function toblerFactor(slope) {
  return Math.exp(-3.5 * (Math.abs(slope + 0.05) - 0.05));
}

// Cycling speed factor vs. the flat baseline. Grade bites a rider much harder than
// a walker: steep climbs collapse speed, descents give a capped boost (braking /
// trail safety keep it bounded).
//   slope +0.05 (5% up)   → 0.50    slope -0.05 (5% down)  → 1.15
//   slope +0.10 (10% up)  → 0.25    slope -0.10 (10% down) → 1.30 (cap 1.8)
function bikeSpeedFactor(slope) {
  if (slope > 0) return Math.exp(-14 * slope);
  return Math.min(1.8, 1 + (-slope) * 3);
}

// Grade-adjusted travel time (seconds) from an evenly-sampled elevation profile.
// elevations: metres along the route (as fetchElevation returns); meters: total
// horizontal length. Returns null when there isn't enough data so the caller keeps
// the flat estimate. The horizontal length is split evenly across samples — the
// same assumption drawElevationChart already makes for its ascent/descent totals.
function gradeAdjustedSeconds(elevations, meters, mode = 'foot') {
  if (!Array.isArray(elevations) || elevations.length < 2 || !(meters > 0)) return null;
  const base = FLAT_SPEED[mode] || FLAT_SPEED.foot;
  const dx = meters / (elevations.length - 1); // horizontal length per segment
  if (!(dx > 0)) return null;
  let seconds = 0;
  for (let i = 1; i < elevations.length; i++) {
    const dh = elevations[i] - elevations[i - 1];
    if (!Number.isFinite(dh)) return null;
    const slope = dh / dx;
    const factor = mode === 'bike' ? bikeSpeedFactor(slope) : toblerFactor(slope);
    const v = Math.max(base * factor, 0.15); // floor so a cliff-like sample can't → ∞
    seconds += dx / v;
  }
  return seconds;
}

function drawElevationChart(elevations, meters) {
  const wrap = document.getElementById('elevationWrap');
  const el = document.getElementById('elevationChart');
  if (!elevations || elevations.length < 2) { wrap.classList.add('hidden'); return; }

  const minE = Math.min(...elevations);
  const maxE = Math.max(...elevations);
  const range = maxE - minE || 1;
  const W = 260, H = 70, PAD = 4;

  const pts = elevations.map((e, i) => {
    const x = PAD + (i / (elevations.length - 1)) * (W - PAD * 2);
    const y = H - PAD - ((e - minE) / range) * (H - PAD * 2);
    return `${x},${y}`;
  });

  const polyFill = `M${pts[0]} ` + pts.slice(1).map(p => `L${p}`).join(' ')
    + ` L${W - PAD},${H - PAD} L${PAD},${H - PAD} Z`;
  const polyLine = `M${pts[0]} ` + pts.slice(1).map(p => `L${p}`).join(' ');

  let ascent = 0, descent = 0;
  for (let i = 1; i < elevations.length; i++) {
    const d = elevations[i] - elevations[i - 1];
    if (d > 0) ascent += d; else descent -= d;
  }

  document.getElementById('statAscent').textContent =
    `+${Math.round(ascent)} m / -${Math.round(descent)} m`;

  el.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:${H}px;display:block">
      <path d="${polyFill}" fill="rgba(30,77,20,0.15)" stroke="none"/>
      <path d="${polyLine}" fill="none" stroke="#1e4d14" stroke-width="2" stroke-linejoin="round"/>
      <text x="${PAD}" y="${H - 2}" font-size="9" fill="#6b7280">${Math.round(minE)} m</text>
      <text x="${PAD}" y="10" font-size="9" fill="#6b7280">${Math.round(maxE)} m</text>
      <text x="${W / 2}" y="${H - 2}" font-size="9" fill="#9ca3af" text-anchor="middle">${(meters / 1000).toFixed(1)} km</text>
    </svg>
  `;
  wrap.classList.remove('hidden');
}

// Expose the pure grade helpers for Node unit tests. No-op in the browser (no
// `module`), where elevation.js stays a lazy-loaded classic script.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { gradeAdjustedSeconds, toblerFactor, bikeSpeedFactor, FLAT_SPEED };
}
