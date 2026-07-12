// Unit tests for the route way-types & surfaces breakdown (pure functions).
// CJS + Node test runner, matching tests/graph-router.test.js.
const test = require('node:test');
const assert = require('node:assert');

// classifyRoute references the global `haversineM` (provided by graph-router.js in
// the browser). Wire it up before requiring the module under test.
global.haversineM = require('../public/js/graph-router.js').haversineM;
const {
  classifyRoute, _wayTypeOf, _surfaceOf, _pointSegMeters, _fmtDist,
} = require('../public/js/route-breakdown.js');

test('_wayTypeOf maps OSM highway tags to French labels', () => {
  assert.equal(_wayTypeOf({ _highway: 'path' }), 'Sentier');
  assert.equal(_wayTypeOf({ _highway: 'track' }), 'Chemin forestier');
  assert.equal(_wayTypeOf({ _highway: 'cycleway' }), 'Piste cyclable');
  assert.equal(_wayTypeOf({ _highway: 'residential' }), 'Rue');
  assert.equal(_wayTypeOf({ _highway: 'primary' }), 'Route');
  assert.equal(_wayTypeOf({ _highway: 'primary_link' }), 'Route'); // _link stripped
});

test('_wayTypeOf falls back to admin pathType when no OSM tag', () => {
  assert.equal(_wayTypeOf({ pathType: 'bike' }), 'Piste cyclable');
  assert.equal(_wayTypeOf({ pathType: 'foot' }), 'Sentier');
  assert.equal(_wayTypeOf({ status: 'easy' }), 'Sentier'); // admin path, no pathType
  assert.equal(_wayTypeOf({}), 'Autre');                    // no info at all
});

test('_surfaceOf maps OSM surface tags to French buckets', () => {
  assert.equal(_surfaceOf({ _surface: 'asphalt' }), 'Asphalte');
  assert.equal(_surfaceOf({ _surface: 'gravel' }), 'Gravier');
  assert.equal(_surfaceOf({ _surface: 'ground' }), 'Naturel');
  assert.equal(_surfaceOf({ _surface: 'sand' }), 'Sable');
  assert.equal(_surfaceOf({ _surface: 'paved' }), 'Revêtu');
  assert.equal(_surfaceOf({}), 'Inconnu');
});

test('_pointSegMeters: point on the segment is ~0, offset is measured', () => {
  // A point exactly on a horizontal segment.
  assert.ok(_pointSegMeters(49.35, 2.90, 49.35, 2.89, 49.35, 2.91) < 1);
  // A point ~111 m north of the segment midpoint (0.001° lat ≈ 111 m).
  const d = _pointSegMeters(49.351, 2.90, 49.35, 2.89, 49.35, 2.91);
  assert.ok(d > 100 && d < 120, `expected ~111 m, got ${d}`);
});

test('_fmtDist formats metres and km like the panel', () => {
  assert.equal(_fmtDist(40), '< 100 m');
  assert.equal(_fmtDist(432), '430 m');
  assert.equal(_fmtDist(4720), '4.72 km');
});

test('classifyRoute aggregates distance per way-type and surface', () => {
  // A route running due east along y=49.35. Two source paths cover its two halves:
  // west half = an asphalt cycleway, east half = a natural-surface path.
  const coords = [
    [49.35, 2.900],
    [49.35, 2.905], // ~360 m into the west source
    [49.35, 2.910], // ~360 m into the east source
  ];
  const sources = [
    { coordinates: [[49.35, 2.8995], [49.35, 2.9055]], _highway: 'cycleway', _surface: 'asphalt' },
    { coordinates: [[49.35, 2.9045], [49.35, 2.9105]], _highway: 'path',     _surface: 'ground'  },
  ];
  const bd = classifyRoute(coords, sources);
  assert.ok(bd.total > 600, `total should span both halves, got ${bd.total}`);

  const way = Object.fromEntries(bd.wayTypes.map(r => [r.label, r.meters]));
  assert.ok(way['Piste cyclable'] > 0);
  assert.ok(way['Sentier'] > 0);

  const surf = Object.fromEntries(bd.surfaces.map(r => [r.label, r.meters]));
  assert.ok(surf['Asphalte'] > 0);
  assert.ok(surf['Naturel'] > 0);

  // Rows carry a colour and are sorted by distance descending.
  assert.ok(bd.wayTypes[0].color);
  for (let i = 1; i < bd.wayTypes.length; i++) {
    assert.ok(bd.wayTypes[i - 1].meters >= bd.wayTypes[i].meters);
  }
});

test('classifyRoute snaps to LONG source segments (grid stamps whole segment)', () => {
  // A single ~290 m source segment (sparse OSM nodes) fully underlies the route.
  // Regression: midpoint-only bucketing left the segment's far end unmatched,
  // dumping real distance into Autre/Inconnu. The whole route must classify.
  const src = [{ coordinates: [[49.350, 2.8990], [49.350, 2.9030]], _highway: 'track', _surface: 'ground' }];
  const coords = [];
  for (let lon = 2.8992; lon <= 2.9028; lon += 0.0002) coords.push([49.350, +lon.toFixed(5)]);
  const bd = classifyRoute(coords, src);
  const autre = bd.wayTypes.find(r => r.label === 'Autre');
  assert.ok(!autre, `no segment should be Autre, got ${autre && Math.round(autre.meters)} m`);
  assert.equal(bd.wayTypes[0].label, 'Chemin forestier');
  assert.equal(bd.surfaces[0].label, 'Naturel');
});

test('classifyRoute buckets far-from-any-source segments as Autre/Inconnu', () => {
  const coords = [[48.0, 2.0], [48.0, 2.01]]; // nowhere near the source
  const sources = [
    { coordinates: [[49.35, 2.90], [49.35, 2.91]], _highway: 'path', _surface: 'ground' },
  ];
  const bd = classifyRoute(coords, sources);
  assert.equal(bd.wayTypes[0].label, 'Autre');
  assert.equal(bd.surfaces[0].label, 'Inconnu');
});
