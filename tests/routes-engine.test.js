'use strict';
// Unit tests for the pre-baked forest-bundle helpers in public/js/routes-engine.js.
// These are the pure pieces of the "route from a static asset instead of live Overpass"
// fast path: bboxWithinForest() decides whether the requested area can be served from
// the bundle, and filterPathsToBbox() slices the in-memory network to that area.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { bboxWithinForest, filterPathsToBbox } = require('../public/js/routes-engine.js');

// Mirrors FOREST_BOUNDS in public/js/config.js (not loaded in Node, so passed explicitly).
const BOUNDS = { minLat: 49.28, minLng: 2.74, maxLat: 49.50, maxLng: 3.05 };

describe('bboxWithinForest', () => {
  test('a bbox fully inside the forest bounds → true', () => {
    assert.equal(bboxWithinForest(49.34, 2.88, 49.36, 2.92, BOUNDS), true);
  });

  test('a bbox equal to the bounds (inclusive edges) → true', () => {
    assert.equal(bboxWithinForest(49.28, 2.74, 49.50, 3.05, BOUNDS), true);
  });

  test('a bbox spilling past the north/east edge → false', () => {
    assert.equal(bboxWithinForest(49.34, 2.88, 49.55, 3.10, BOUNDS), false);
  });

  test('a bbox fully outside (e.g. Paris) → false', () => {
    assert.equal(bboxWithinForest(48.80, 2.30, 48.90, 2.40, BOUNDS), false);
  });

  test('no bounds available → false (forces the network fallback)', () => {
    assert.equal(bboxWithinForest(49.34, 2.88, 49.36, 2.92, null), false);
  });
});

describe('filterPathsToBbox', () => {
  const paths = [
    { coordinates: [[49.350, 2.900], [49.351, 2.901]] },           // inside
    { coordinates: [[49.480, 3.040], [49.490, 3.048]] },           // NE corner, inside
    { coordinates: [[48.850, 2.350], [48.860, 2.360]] },           // Paris, outside
    { coordinates: [[49.200, 2.900], [49.355, 2.905]] },           // straddles south edge, one point inside
  ];

  test('keeps only paths with at least one coordinate inside the bbox', () => {
    const out = filterPathsToBbox(paths, 49.34, 2.88, 49.50, 3.05);
    assert.equal(out.length, 3);
    assert.ok(!out.includes(paths[2]), 'the Paris path is excluded');
  });

  test('a straddling path is kept when one endpoint is inside', () => {
    const out = filterPathsToBbox(paths, 49.34, 2.88, 49.36, 2.92);
    assert.ok(out.includes(paths[3]), 'kept because [49.355,2.905] is inside');
  });

  test('returns the SAME path objects (no copy — router only reads them)', () => {
    const out = filterPathsToBbox(paths, 49.34, 2.88, 49.50, 3.05);
    assert.equal(out[0], paths[0]);
  });

  test('empty when nothing intersects', () => {
    assert.equal(filterPathsToBbox(paths, 49.00, 2.00, 49.10, 2.10).length, 0);
  });
});
