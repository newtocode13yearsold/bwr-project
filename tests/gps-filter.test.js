'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { createGpsDistanceFilter, haversineKm, DEFAULTS } = require('../public/js/gps-filter.js');

// ── deterministic helpers ─────────────────────────────────────────────────────
// Seeded PRNG so the noise-based assertions are reproducible across runs.
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function gaussFrom(rand, sd) {
  let u = 0, v = 0;
  while (u === 0) u = rand();
  while (v === 0) v = rand();
  return sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

const LAT = 49.35;                       // Compiègne latitude
const M_PER_DEG_LAT = 111320;
const M_PER_DEG_LNG = 111320 * Math.cos(LAT * Math.PI / 180);
const dLat = (m) => m / M_PER_DEG_LAT;
const dLng = (m) => m / M_PER_DEG_LNG;

// Naive "old" method: straight sum of raw fixes with the old thresholds, so we
// can prove the filter is dramatically closer to the truth on a noisy track.
function naiveSumMeters(fixes) {
  let last = null, km = 0;
  for (const f of fixes) {
    if (f.acc > 40) continue;
    if (!last) { last = f; continue; }
    const dtH = (f.t - last.t) / 3.6e6;
    const d = haversineKm(last.lat, last.lng, f.lat, f.lng);
    const kmh = dtH > 0 ? d / dtH : 0;
    if (kmh > 50) continue;
    if (d < 0.005) continue;
    km += d; last = f;
  }
  return km * 1000;
}

function runFilter(fixes, opts) {
  const gps = createGpsDistanceFilter(opts);
  for (const f of fixes) gps.push(f.lat, f.lng, f.acc, f.t);
  return gps.totalKm * 1000;
}

// ── haversineKm ───────────────────────────────────────────────────────────────
describe('haversineKm', () => {
  test('zero distance for identical points', () => {
    assert.equal(haversineKm(LAT, 2.9, LAT, 2.9), 0);
  });
  test('~111 m for 0.001° of latitude', () => {
    const m = haversineKm(LAT, 2.9, LAT + 0.001, 2.9) * 1000;
    assert.ok(Math.abs(m - 111.3) < 1, `got ${m}`);
  });
});

// ── accuracy gate ─────────────────────────────────────────────────────────────
describe('accuracy gate', () => {
  test('rejects fixes worse than maxAccuracyM', () => {
    const gps = createGpsDistanceFilter();
    const r = gps.push(LAT, 2.9, 200, 1000);
    assert.equal(r.accepted, false);
    assert.equal(r.added, 0);
  });
  test('accepts a fix within the gate', () => {
    const gps = createGpsDistanceFilter();
    const r = gps.push(LAT, 2.9, 8, 1000);
    assert.equal(r.accepted, true);
  });
});

// ── stationary: must NOT invent distance ──────────────────────────────────────
describe('standing still', () => {
  test('10 min of ±10 m jitter yields well under 100 m (old code invented ~1 km)', () => {
    const rand = mulberry32(42);
    const fixes = [];
    for (let t = 0; t <= 600000; t += 2000) {
      fixes.push({ lat: LAT + dLat(gaussFrom(rand, 10)), lng: 2.9 + dLng(gaussFrom(rand, 10)), acc: 18, t });
    }
    const filtered = runFilter(fixes);
    const naive = naiveSumMeters(fixes);
    assert.ok(filtered < 150, `filtered invented ${filtered.toFixed(0)} m`);
    assert.ok(naive > filtered * 3, `expected naive (${naive.toFixed(0)}) >> filtered (${filtered.toFixed(0)})`);
  });
});

// ── real walk: close to truth, and far closer than the naive sum ──────────────
describe('a real 1000 m walk', () => {
  function walk(seed, sd) {
    const rand = mulberry32(seed);
    const step = 2.78, total = 1000, fixes = [];
    let d = 0, t = 0;
    while (d <= total) {
      fixes.push({ lat: LAT + dLat(d) + dLat(gaussFrom(rand, sd)), lng: 2.9 + dLng(gaussFrom(rand, sd)), acc: Math.max(5, 1.8 * sd), t });
      d += step; t += 2000;
    }
    return fixes;
  }

  test('noiseless walk lands within 15% of 1000 m', () => {
    const rand = () => 0; // unused
    const step = 5, total = 1000, fixes = [];
    let d = 0, t = 0;
    while (d <= total) { fixes.push({ lat: LAT + dLat(d), lng: 2.9, acc: 5, t }); d += step; t += 2000; }
    const m = runFilter(fixes);
    assert.ok(m > 850 && m < 1150, `got ${m.toFixed(0)} m`);
  });

  test('noisy walk (±10 m): filter within 25%, and at least 2× closer than naive', () => {
    const fixes = walk(7, 10);
    const filtered = runFilter(fixes);
    const naive = naiveSumMeters(fixes);
    const errFiltered = Math.abs(filtered - 1000);
    const errNaive = Math.abs(naive - 1000);
    assert.ok(errFiltered < 250, `filter off by ${errFiltered.toFixed(0)} m (got ${filtered.toFixed(0)})`);
    assert.ok(errFiltered * 2 < errNaive, `filter (${filtered.toFixed(0)}) not clearly better than naive (${naive.toFixed(0)})`);
  });
});

// ── speed spike rejection ─────────────────────────────────────────────────────
describe('teleport spike', () => {
  test('a single huge jump is not counted', () => {
    const gps = createGpsDistanceFilter();
    gps.push(LAT, 2.9, 5, 0);
    gps.push(LAT, 2.9, 5, 2000);
    // ~2 km away, 2 s later → ~3600 km/h: must be rejected
    const before = gps.totalKm;
    gps.push(LAT + dLat(2000), 2.9, 5, 4000);
    assert.equal(gps.totalKm, before);
  });
});

// ── reset ─────────────────────────────────────────────────────────────────────
describe('reset', () => {
  test('clears the running total', () => {
    const gps = createGpsDistanceFilter();
    gps.push(LAT, 2.9, 5, 0);
    gps.push(LAT + dLat(50), 2.9, 5, 20000);
    assert.ok(gps.totalKm > 0);
    gps.reset();
    assert.equal(gps.totalKm, 0);
  });
});

// ── config surface ────────────────────────────────────────────────────────────
describe('DEFAULTS', () => {
  test('exposes the tunables', () => {
    assert.ok(DEFAULTS.maxAccuracyM > 0 && DEFAULTS.q > 0 && DEFAULTS.maxSpeedKmh > 0);
  });
});
