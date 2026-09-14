'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  gradeAdjustedSeconds, toblerFactor, bikeSpeedFactor, FLAT_SPEED,
} = require('../public/js/elevation.js');

describe('toblerFactor', () => {
  test('flat ground reproduces the baseline (factor 1)', () => {
    assert.ok(Math.abs(toblerFactor(0) - 1) < 1e-9);
  });
  test('peaks around a gentle -5% descent (faster than flat)', () => {
    assert.ok(toblerFactor(-0.05) > 1);
    assert.ok(toblerFactor(-0.05) >= toblerFactor(-0.02));
    assert.ok(toblerFactor(-0.05) >= toblerFactor(-0.10));
  });
  test('uphill is slower than flat', () => {
    assert.ok(toblerFactor(0.10) < 1);
    assert.ok(toblerFactor(0.20) < toblerFactor(0.10));
  });
  test('a steep descent is slow, not fast', () => {
    assert.ok(toblerFactor(-0.25) < 1);
  });
});

describe('bikeSpeedFactor', () => {
  test('flat ground reproduces the baseline (factor 1)', () => {
    assert.ok(Math.abs(bikeSpeedFactor(0) - 1) < 1e-9);
  });
  test('climbs collapse speed harder than they do on foot', () => {
    assert.ok(bikeSpeedFactor(0.10) < toblerFactor(0.10));
  });
  test('descents boost speed but stay capped', () => {
    assert.ok(bikeSpeedFactor(-0.05) > 1);
    assert.equal(bikeSpeedFactor(-1), 1.8); // absurd descent still bounded at the cap
  });
});

describe('gradeAdjustedSeconds', () => {
  test('returns null when there is not enough data', () => {
    assert.equal(gradeAdjustedSeconds(null, 1000), null);
    assert.equal(gradeAdjustedSeconds([100], 1000), null);
    assert.equal(gradeAdjustedSeconds([], 1000), null);
    assert.equal(gradeAdjustedSeconds([100, 100], 0), null);
    assert.equal(gradeAdjustedSeconds([100, NaN, 100], 1000), null);
  });

  test('a flat profile exactly matches the flat-speed estimate', () => {
    const meters = 1000;
    const flat = meters / FLAT_SPEED.foot;
    const got = gradeAdjustedSeconds([100, 100, 100, 100], meters, 'foot');
    assert.ok(Math.abs(got - flat) < 1e-6);
  });

  test('an uphill route takes longer than the flat estimate', () => {
    const meters = 1000;
    const flat = meters / FLAT_SPEED.foot;
    // steadily climbing 0 → 150 m over 1 km
    const uphill = gradeAdjustedSeconds([0, 50, 100, 150], meters, 'foot');
    assert.ok(uphill > flat);
  });

  test('a gently rolling descent can beat the flat estimate', () => {
    const meters = 3000;
    const flat = meters / FLAT_SPEED.foot;
    // -50 m over each 1 km segment → a steady -5% descent, Tobler's fastest grade
    const down = gradeAdjustedSeconds([150, 100, 50, 0], meters, 'foot');
    assert.ok(down < flat);
  });

  test('bike mode uses the bike baseline on flat ground', () => {
    const meters = 3000;
    const got = gradeAdjustedSeconds([200, 200, 200], meters, 'bike');
    assert.ok(Math.abs(got - meters / FLAT_SPEED.bike) < 1e-6);
  });

  test('a cliff-like sample stays finite (speed is floored)', () => {
    const got = gradeAdjustedSeconds([0, 500], 100, 'foot'); // 500% "slope"
    assert.ok(Number.isFinite(got) && got > 0);
  });

  test('an unknown mode falls back to the foot baseline', () => {
    const meters = 1000;
    assert.equal(
      gradeAdjustedSeconds([10, 10, 10], meters, 'unicycle'),
      gradeAdjustedSeconds([10, 10, 10], meters, 'foot'),
    );
  });
});
