'use strict';
// Unit tests for the pure geometry behind the printable roadbook
// (public/js/route-print.js): carrefoursAlongRoute() finds the named forest
// junctions a route passes through, in order, with cumulative distance — the
// data that fills the print sheet's "feuille de route".
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  carrefoursAlongRoute, computeDirections, _rpBearing, _rpCardinal,
  _rpHaversineM, _rpBuildMapSvg, _rpBuildTileMap, _rpMercator, _rpBuildDoc,
} = require('../public/js/route-print.js');

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

describe('_rpMercator / _rpBuildTileMap (topo map)', () => {
  const coords = [];
  for (let i = 0; i <= 20; i++) coords.push([49.350, 2.900 + i * 0.001]);
  const hits = [{ name: "Carrefour de l'Étoile", lat: 49.3501, lon: 2.9005, distM: 5, cumM: 40, idx: 5 }];

  test('mercator x grows with longitude, y grows southward', () => {
    const [x0, y0] = _rpMercator(49.35, 2.90, 14);
    const [x1] = _rpMercator(49.35, 2.91, 14);
    const [, y1] = _rpMercator(49.34, 2.90, 14); // more south → larger y
    assert.ok(x1 > x0);
    assert.ok(y1 > y0);
  });

  test('embeds same-origin topo tiles as SVG images + the route + a carrefour', () => {
    const svg = _rpBuildTileMap(coords, hits, [], { color: '#22c55e', isLoop: true });
    assert.ok(svg.includes('<image href="/tiles/topo/'), 'topo tile images missing');
    assert.ok(svg.includes('<polyline'), 'route polyline missing');
    assert.ok(svg.includes("Carrefour de l&#39;Étoile"), 'carrefour label missing');
    assert.ok(svg.trim().startsWith('<svg'), 'not an SVG document');
  });

  test('_rpBuildDoc uses tiles when useTiles is set', () => {
    let m = 0;
    for (let i = 1; i < coords.length; i++) m += _rpHaversineM(coords[i-1][0], coords[i-1][1], coords[i][0], coords[i][1]);
    const html = _rpBuildDoc({ coords, meters: m, seconds: m }, {
      hits, contextPaths: [], color: '#22c55e', isLoop: true, useTiles: true,
      title: 'T', typeLabel: 'x', modeLabel: 'Boucle', diffLabel: 'facile',
    });
    assert.ok(html.includes('/tiles/topo/'), 'tile background not used when useTiles set');
  });
});

describe('_rpBearing / _rpCardinal', () => {
  test('due north / east / south / west bearings', () => {
    assert.ok(Math.abs(_rpBearing(49.0, 2.0, 49.1, 2.0) - 0) < 1);    // north
    assert.ok(Math.abs(_rpBearing(49.0, 2.0, 49.0, 2.1) - 90) < 1);   // east
    assert.ok(Math.abs(_rpBearing(49.1, 2.0, 49.0, 2.0) - 180) < 1);  // south
    assert.ok(Math.abs(_rpBearing(49.0, 2.1, 49.0, 2.0) - 270) < 1);  // west
  });

  test('cardinal buckets to the 8-point compass', () => {
    assert.equal(_rpCardinal(0), 'N');
    assert.equal(_rpCardinal(45), 'N-E');
    assert.equal(_rpCardinal(90), 'E');
    assert.equal(_rpCardinal(315), 'N-O');
    assert.equal(_rpCardinal(359), 'N'); // wraps back to North
  });
});

describe('computeDirections', () => {
  // Heading east, then a 90° turn to head north (a LEFT turn — north is to the
  // left of east), then later a leg heading east again.
  const coords = [];
  for (let i = 0; i <= 10; i++) coords.push([49.350, 2.900 + i * 0.001]); // east, ~1.1 km
  for (let i = 1; i <= 10; i++) coords.push([49.350 + i * 0.001, 2.910]);  // north

  test('start hit has no turn, only a heading', () => {
    const hits = [{ name: 'Start', idx: 0 }];
    const [d] = computeDirections(coords, hits);
    assert.equal(d.turn, null);
    assert.equal(d.cardinal, 'E'); // route leaves heading east
  });

  test('detects a left turn at the corner (east → north)', () => {
    const corner = 10; // the vertex where east flips to north
    const [d] = computeDirections(coords, [{ name: 'Corner', idx: corner }], { lookM: 40 });
    assert.equal(d.turn, 'à gauche'); // east→north is a left turn
    assert.equal(d.cardinal, 'N');
  });

  test('a straight passage reads "tout droit"', () => {
    const [d] = computeDirections(coords, [{ name: 'Mid', idx: 5 }], { lookM: 30 });
    assert.equal(d.turn, 'tout droit');
    assert.equal(d.cardinal, 'E');
  });

  test('output is aligned 1:1 with the hits', () => {
    const hits = [{ name: 'A', idx: 0 }, { name: 'B', idx: 5 }, { name: 'C', idx: 15 }];
    assert.equal(computeDirections(coords, hits).length, 3);
  });
});

describe('_rpBuildDoc roadbook directions', () => {
  const coords = [];
  for (let i = 0; i <= 10; i++) coords.push([49.350, 2.900 + i * 0.001]);
  for (let i = 1; i <= 10; i++) coords.push([49.350 + i * 0.001, 2.910]);
  let m = 0;
  for (let i = 1; i < coords.length; i++) m += _rpHaversineM(coords[i-1][0], coords[i-1][1], coords[i][0], coords[i][1]);
  const hits = [
    { name: 'Carrefour Départ', lat: 49.350, lon: 2.900, distM: 0, cumM: 0, idx: 0 },
    { name: 'Carrefour Coude',  lat: 49.350, lon: 2.910, distM: 0, cumM: 700, idx: 10 },
  ];

  test('renders a Direction column naming the next carrefour', () => {
    const html = _rpBuildDoc({ coords, meters: m, seconds: m / 1.11 }, {
      hits, contextPaths: [], color: '#22c55e', isLoop: false,
      title: 'Test', typeLabel: 'Chemin forestier', modeLabel: 'Trajet A → B', diffLabel: 'facile',
    });
    assert.ok(html.includes('Direction à suivre'), 'direction column header missing');
    assert.ok(html.includes('Départ'), 'start row missing');
    // Each instruction names the NEXT carrefour: "… vers Carrefour Coude".
    assert.ok(html.includes('vers <strong>Carrefour Coude</strong>'), 'next-carrefour instruction missing');
    assert.ok(html.includes('cap'), 'compass heading missing');
    assert.ok(html.includes('Arrivée'), 'arrival row missing for A→B');
  });
});
