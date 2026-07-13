// ── Geo helpers (server-side, ESM) ────────────────────────────────────────────
// Small, dependency-free distance maths used by the hazard push fan-out to decide
// whether a new report lands "on" one of a user's saved routes. All points are
// [lat, lon] pairs: report coords are lat/lon, saved-route coords are Leaflet
// [lat, lng] — same order — so the two are directly comparable.

const EARTH_RADIUS_M = 6_371_000;
const DEG2RAD = Math.PI / 180;

/** Great-circle distance in metres between two [lat, lon] points. */
export function haversineMeters(a, b) {
  const dLat = (b[0] - a[0]) * DEG2RAD;
  const dLon = (b[1] - a[1]) * DEG2RAD;
  const lat1 = a[0] * DEG2RAD;
  const lat2 = b[0] * DEG2RAD;
  const h = Math.sin(dLat / 2) ** 2 +
            Math.sin(dLon / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Projects a [lat, lon] point onto a local east/north plane (metres) centred on
 * `ref`. Accurate for the short distances (< a few km) this feature cares about.
 */
function toLocalXY(pt, ref) {
  const x = (pt[1] - ref[1]) * DEG2RAD * Math.cos(ref[0] * DEG2RAD) * EARTH_RADIUS_M;
  const y = (pt[0] - ref[0]) * DEG2RAD * EARTH_RADIUS_M;
  return [x, y];
}

/** Shortest distance (m) from point `p` to segment a–b, all [lat, lon]. */
function distanceToSegmentMeters(p, a, b) {
  // Work in a local metric plane centred on the point being tested.
  const A = toLocalXY(a, p);
  const B = toLocalXY(b, p);
  // P is the origin (0,0) in this frame; distance = |proj of -A onto AB|.
  const dx = B[0] - A[0];
  const dy = B[1] - A[1];
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(A[0], A[1]); // degenerate segment
  let t = -(A[0] * dx + A[1] * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const cx = A[0] + t * dx;
  const cy = A[1] + t * dy;
  return Math.hypot(cx, cy);
}

/**
 * Shortest distance (m) from point `p` to a polyline `coords` ([[lat,lon],…]).
 * Returns Infinity for an empty/invalid polyline; falls back to the vertex
 * distance for a single-point "line".
 */
export function distanceToPolylineMeters(p, coords) {
  if (!Array.isArray(coords) || coords.length === 0) return Infinity;
  if (coords.length === 1) return haversineMeters(p, coords[0]);
  let min = Infinity;
  for (let i = 0; i < coords.length - 1; i++) {
    const d = distanceToSegmentMeters(p, coords[i], coords[i + 1]);
    if (d < min) min = d;
  }
  return min;
}
