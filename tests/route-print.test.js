'use strict';
// Unit tests for the pure geometry behind the printable roadbook
// (public/js/route-print.js): carrefoursAlongRoute() finds the named forest
// junctions a route passes through, in order, with cumulative distance — the
// data that fills the print sheet's "feuille de route".
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { carrefoursAlongRoute, _rpHaversineM, _rpBuildMapSvg } = require('../public/js/route-print.js');

describe('_rpHaversineM', () => {
  test('zero distance for identical points', () => {
    assert.equal(_rpHaversineM(49.35, 2.90, 49.35, 2.90), 0);
  });

  test('~1 km for ~0.009° of latitude', () => {
    const d = _rpHaversineM(49.35, 2.90, 49.359, 2.90);
    assert.ok(Math.abs(d - 1000) < 20, `expected ~1000 m, got ${d}`);
  });
});

describe('carrefoursAlongRoute', () => {
  // A straight west→east route along latitude 49.350.
  const route = [];
  for (let i = 0; i <= 20; i++) route.push([49.350, 2.900 + i * 0.001]); // ~1.45 km total

  const carrefours = [
    { name: 'Carrefour A', lat: 49.3500, lon: 2.9000 }, // exactly on the start
    { name: 'Carrefour B', lat: 49.3505, lon: 2.9100 }, // ~55 m off the route, mid-way
    { name: 'Carrefour C', lat: 49.3600, lon: 2.9100 }, // ~1.1 km off — far, excluded
  ];

  test('keeps only carrefours within the threshold', () => {
    const hits = carrefoursAlongRoute(route, carrefours, { thresholdM: 80 });
    const names = hits.map(h => h.name);
    assert.deepEqual(names, ['Carrefour A', 'Carrefour B']);
  });

  test('a tighter threshold drops the off-route carrefour', () => {
    const hits = carrefoursAlongRoute(route, carrefours, { thresholdM: 30 });
    assert.deepEqual(hits.map(h => h.name), ['Carrefour A']);
  });

  test('orders hits by cumulative distance along the route', () => {
    const hits = carrefoursAlongRoute(route, carrefours, { thresholdM: 80 });
    assert.ok(hits[0].cumM < hits[1].cumM);
    assert.equal(hits[0].cumM, 0);                 // A sits on the start vertex
    assert.ok(hits[1].cumM > 600 && hits[1].cumM < 850); // B is roughly half-way
  });

  test('reports the min distance from the route to each carrefour', () => {
    const hits = carrefoursAlongRoute(route, carrefours, { thresholdM: 80 });
    const b = hits.find(h => h.name === 'Carrefour B');
    assert.ok(b.distM > 0 && b.distM < 80);
  });

  test('collapses the same carrefour re-hit within minGapM', () => {
    // Two carrefour entries with the SAME name, both near the start.
    const dup = [
      { name: 'Carrefour A', lat: 49.3500, lon: 2.9000 },
      { name: 'Carrefour A', lat: 49.3500, lon: 2.9001 },
    ];
    const hits = carrefoursAlongRoute(route, dup, { thresholdM: 80, minGapM: 300 });
    assert.equal(hits.length, 1);
  });

  test('degenerate input → empty list (no throw)', () => {
    assert.deepEqual(carrefoursAlongRoute([[49.35, 2.9]], carrefours), []);
    assert.deepEqual(carrefoursAlongRoute(null, carrefours), []);
    assert.deepEqual(carrefoursAlongRoute(route, null), []);
  });

  test('ignores carrefours with non-finite coordinates', () => {
    const bad = [{ name: 'Bad', lat: NaN, lon: 2.9 }, { name: 'Carrefour A', lat: 49.35, lon: 2.9 }];
    const hits = carrefoursAlongRoute(route, bad, { thresholdM: 80 });
    assert.deepEqual(hits.map(h => h.name), ['Carrefour A']);
  });
});

describe('_rpBuildMapSvg', () => {
  const coords = [];
  for (let i = 0; i <= 20; i++) coords.push([49.350, 2.900 + i * 0.001]);
  const hits = [
    { name: "Carrefour de l'Étoile", lat: 49.3500, lon: 2.9000, distM: 0, cumM: 0 },
    { name: 'Carrefour du Puits du Roi', lat: 49.3500, lon: 2.9100, distM: 10, cumM: 700 },
  ];

  test('prints each carrefour NAME on the map (crisp vector, print-only)', () => {
    const svg = _rpBuildMapSvg(coords, hits, [], { color: '#22c55e', isLoop: true });
    // Names are XML-escaped in the SVG (é/apostrophe survive; & → &amp; etc.).
    assert.ok(svg.includes('Carrefour de l&#39;Étoile'), 'first carrefour name missing');
    assert.ok(svg.includes('Carrefour du Puits du Roi'), 'second carrefour name missing');
    // A white halo keeps the label legible over route/context lines.
    assert.ok(svg.includes('paint-order'), 'label halo (paint-order) missing');
  });

  test('draws the route polyline and a start marker', () => {
    const svg = _rpBuildMapSvg(coords, hits, [], { color: '#ef4444', isLoop: false });
    assert.ok(svg.includes('<polyline'), 'route polyline missing');
    assert.ok(svg.includes('#ef4444'), 'route colour not applied');
    assert.ok(svg.trim().startsWith('<svg'), 'not an SVG document');
  });
});
