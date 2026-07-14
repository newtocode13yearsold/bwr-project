'use strict';
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

// ── Browser-globals shim ──────────────────────────────────────────────────────
// features.js wraps itself in (function(global){})(window) and uses localStorage
// directly. We satisfy both by making window === Node's global and providing a
// minimal localStorage implementation.

const _ls = {};
global.window = global;
global.localStorage = {
  getItem:    k     => Object.prototype.hasOwnProperty.call(_ls, k) ? _ls[k] : null,
  setItem:    (k, v) => { _ls[k] = String(v); },
  removeItem: k     => { delete _ls[k]; },
  clear:      ()    => { for (const k in _ls) delete _ls[k]; },
};

require('../public/js/features.js');
// Destructure from the BWR namespace so test bodies can call functions directly.
const { can, limitOf, requiredTier, normalisePlan, readWeekly, bumpWeekly, checkRouteQuota,
  xpFromStats, levelFromXp, xpForLevel, levelProgress, routeBonus, routeLimit,
  levelTitle, levelFrame, nextReward, XP_STEP, LEVEL_REWARDS } = global.BWR;

// ── normalisePlan ─────────────────────────────────────────────────────────────

describe('normalisePlan', () => {
  test('null → free',      () => assert.equal(normalisePlan(null),      'free'));
  test('undefined → free', () => assert.equal(normalisePlan(undefined), 'free'));
  test('unknown value passthrough', () => assert.equal(normalisePlan('unknown'), 'unknown'));
  test('free passthrough', () => assert.equal(normalisePlan('free'),    'free'));
  test('silver passthrough', () => assert.equal(normalisePlan('silver'), 'silver'));
  test('gold passthrough',   () => assert.equal(normalisePlan('gold'),   'gold'));
});

// ── can ───────────────────────────────────────────────────────────────────────

describe('can', () => {
  // Loop mode: all tiers (free capped at 10/week via routes_per_week quota)
  test('loop_mode: free → true',    () => assert.equal(can('loop_mode', 'free'),   true));
  test('loop_mode: silver → true',  () => assert.equal(can('loop_mode', 'silver'), true));
  test('loop_mode: gold → true',    () => assert.equal(can('loop_mode', 'gold'),   true));

  // Satellite tiles: silver+
  test('satellite_tiles: free → false',   () => assert.equal(can('satellite_tiles', 'free'),   false));
  test('satellite_tiles: silver → true',  () => assert.equal(can('satellite_tiles', 'silver'), true));
  test('satellite_tiles: gold → true',    () => assert.equal(can('satellite_tiles', 'gold'),   true));

  // Carrefours: all tiers
  test('carrefours: free → truthy',   () => assert.ok(can('carrefours', 'free')));
  test('carrefours: silver → truthy', () => assert.ok(can('carrefours', 'silver')));
  test('carrefours: gold → truthy',   () => assert.ok(can('carrefours', 'gold')));

  // Admins always receive plan:'gold' from the server — test gold directly
  test('satellite_tiles: gold → true (admin receives gold)', () => assert.equal(can('satellite_tiles', 'gold'), true));
  test('kml_export: gold → true (admin receives gold)',      () => assert.equal(can('kml_export', 'gold'), true));

  // Unknown feature → false
  test('unknown feature → false', () => assert.equal(can('nonexistent_feature', 'gold'), false));

  // Elevation profile: silver+
  test('elevation_profile: free → false',  () => assert.equal(can('elevation_profile', 'free'),   false));
  test('elevation_profile: silver → true', () => assert.equal(can('elevation_profile', 'silver'), true));

  // Difficulty hard: silver+
  test('difficulty_hard: free → false',   () => assert.equal(can('difficulty_hard', 'free'),   false));
  test('difficulty_hard: silver → true',  () => assert.equal(can('difficulty_hard', 'silver'), true));

  // GPX export: silver+
  test('gpx_export: free → false',   () => assert.equal(can('gpx_export', 'free'),   false));
  test('gpx_export: silver → true',  () => assert.equal(can('gpx_export', 'silver'), true));

  // GPX import: open to everyone (acquisition hook)
  test('gpx_import: free → true',    () => assert.equal(can('gpx_import', 'free'),    true));
  test('gpx_import: visitor → true', () => assert.equal(can('gpx_import', 'visitor'), true));
  test('gpx_import: silver → true',  () => assert.equal(can('gpx_import', 'silver'),  true));
  test('gpx_import: gold → true',    () => assert.equal(can('gpx_import', 'gold'),    true));

  // KML export: silver+
  test('kml_export: free → false',   () => assert.equal(can('kml_export', 'free'),   false));
  test('kml_export: silver → true',  () => assert.equal(can('kml_export', 'silver'), true));
  test('kml_export: gold → true',    () => assert.equal(can('kml_export', 'gold'),   true));

  // Weather: silver+
  test('weather: free → false',   () => assert.equal(can('weather', 'free'),   false));
  test('weather: silver → true',  () => assert.equal(can('weather', 'silver'), true));
  test('weather: gold → true',    () => assert.equal(can('weather', 'gold'),   true));

  // Custom route builder ("Sur mesure"): silver+
  test('custom_route_builder: free → false',    () => assert.equal(can('custom_route_builder', 'free'),    false));
  test('custom_route_builder: visitor → false', () => assert.equal(can('custom_route_builder', 'visitor'), false));
  test('custom_route_builder: silver → true',   () => assert.equal(can('custom_route_builder', 'silver'),  true));
  test('custom_route_builder: gold → true',     () => assert.equal(can('custom_route_builder', 'gold'),    true));

  // Gold badges remain gold-only
  test('badges_gold: silver → false', () => assert.equal(can('badges_gold', 'silver'), false));
  test('badges_gold: gold → true',    () => assert.equal(can('badges_gold', 'gold'),   true));
});

// ── limitOf ───────────────────────────────────────────────────────────────────

describe('limitOf', () => {
  test('routes_per_week: free = 10',         () => assert.equal(limitOf('routes_per_week', 'free'),   10));
  test('routes_per_week: silver = Infinity', () => assert.equal(limitOf('routes_per_week', 'silver'), Infinity));
  test('routes_per_week: gold = Infinity',   () => assert.equal(limitOf('routes_per_week', 'gold'),   Infinity));

  test('loops_per_week: free = 3',           () => assert.equal(limitOf('loops_per_week', 'free'),   3));
  test('loops_per_week: silver = Infinity',  () => assert.equal(limitOf('loops_per_week', 'silver'), Infinity));
  test('loops_per_week: gold = Infinity',    () => assert.equal(limitOf('loops_per_week', 'gold'),   Infinity));

  test('offline_cache: free = 0',   () => assert.equal(limitOf('offline_cache', 'free'),   0));
  test('offline_cache: silver = 20', () => assert.equal(limitOf('offline_cache', 'silver'), 20));
  test('offline_cache: gold = 20',  () => assert.equal(limitOf('offline_cache', 'gold'),   20));

  // Boolean features → Infinity when true
  test('loop_mode: free → Infinity', () => assert.equal(limitOf('loop_mode', 'free'),   Infinity));
  test('loop_mode: silver → Infinity', () => assert.equal(limitOf('loop_mode', 'silver'), Infinity));

  test('kml_export: free → 0',   () => assert.equal(limitOf('kml_export', 'free'),   0));
  test('kml_export: gold → Infinity', () => assert.equal(limitOf('kml_export', 'gold'), Infinity));
});

// ── requiredTier ──────────────────────────────────────────────────────────────

describe('requiredTier', () => {
  test('carrefours → free (available to all)', () => assert.equal(requiredTier('carrefours'), 'free'));
  test('routes_per_week → free (quota is 10, but truthy)', () => assert.equal(requiredTier('routes_per_week'), 'free'));
  test('loop_mode → free',           () => assert.equal(requiredTier('loop_mode'),         'free'));
  test('elevation_profile → silver', () => assert.equal(requiredTier('elevation_profile'), 'silver'));
  test('gpx_export → silver',        () => assert.equal(requiredTier('gpx_export'),        'silver'));
  test('gpx_import → free',          () => assert.equal(requiredTier('gpx_import'),        'free'));
  test('satellite_tiles → silver',   () => assert.equal(requiredTier('satellite_tiles'),   'silver'));
  test('kml_export → silver',        () => assert.equal(requiredTier('kml_export'),        'silver'));
  test('weather → silver',           () => assert.equal(requiredTier('weather'),           'silver'));
  test('custom_route_color → silver',() => assert.equal(requiredTier('custom_route_color'), 'silver'));
  test('custom_route_builder → silver',() => assert.equal(requiredTier('custom_route_builder'), 'silver'));
  test('badges_gold → gold',         () => assert.equal(requiredTier('badges_gold'),       'gold'));
  test('unknown feature → null',     () => assert.equal(requiredTier('nonexistent'), null));
});

// ── Weekly quota helpers ──────────────────────────────────────────────────────

describe('readWeekly + bumpWeekly', () => {
  beforeEach(() => localStorage.clear());

  test('fresh read returns count 0', () => {
    const { count } = readWeekly();
    assert.equal(count, 0);
  });

  test('weekStart is a YYYY-MM-DD string within the past 7 days', () => {
    const { weekStart } = readWeekly();
    assert.match(weekStart, /^\d{4}-\d{2}-\d{2}$/, 'weekStart must be YYYY-MM-DD');
    // Must be a recent date (today or within the past 6 days)
    const daysDiff = (Date.now() - new Date(weekStart).getTime()) / 86400000;
    assert.ok(daysDiff >= 0 && daysDiff < 8, `weekStart ${weekStart} should be within the past 7 days`);
  });

  test('bumpWeekly increments count to 1', () => {
    const { count } = bumpWeekly();
    assert.equal(count, 1);
  });

  test('two bumps → count 2', () => {
    bumpWeekly();
    const { count } = bumpWeekly();
    assert.equal(count, 2);
  });

  test('stale weekStart resets count to 0 on read', () => {
    // Write a record from a past week
    localStorage.setItem('bwr_routes_week', JSON.stringify({ weekStart: '2000-01-03', count: 99 }));
    const { count } = readWeekly();
    assert.equal(count, 0);
  });

  test('same weekStart preserves count', () => {
    bumpWeekly(); // count = 1 for this week
    const { count } = readWeekly();
    assert.equal(count, 1);
  });
});

// ── checkRouteQuota ───────────────────────────────────────────────────────────

describe('checkRouteQuota', () => {
  beforeEach(() => localStorage.clear());

  test('free at 0 routes → ok', () => {
    const result = checkRouteQuota('free');
    assert.ok(result.ok);
    assert.equal(result.used, 0);
    assert.equal(result.limit, 10);
  });

  test('free at 9 routes → ok', () => {
    for (let i = 0; i < 9; i++) bumpWeekly();
    assert.ok(checkRouteQuota('free').ok);
  });

  test('free at 10 routes → not ok', () => {
    for (let i = 0; i < 10; i++) bumpWeekly();
    const result = checkRouteQuota('free');
    assert.equal(result.ok, false);
    assert.equal(result.used, 10);
    assert.equal(result.limit, 10);
  });

  test('free at 11 routes → still not ok', () => {
    for (let i = 0; i < 11; i++) bumpWeekly();
    assert.equal(checkRouteQuota('free').ok, false);
  });

  test('silver at 100 routes → always ok (Infinity limit)', () => {
    for (let i = 0; i < 100; i++) bumpWeekly();
    assert.ok(checkRouteQuota('silver').ok);
  });

  test('gold at 100 routes → always ok', () => {
    for (let i = 0; i < 100; i++) bumpWeekly();
    assert.ok(checkRouteQuota('gold').ok);
  });

  test('gold plan → always ok (admins receive gold)', () => {
    for (let i = 0; i < 10; i++) bumpWeekly();
    assert.ok(checkRouteQuota('gold').ok);
  });

  test('null plan treated as free → blocks at 10', () => {
    for (let i = 0; i < 10; i++) bumpWeekly();
    assert.equal(checkRouteQuota(null).ok, false);
  });

  test('free at level 4 gets +1 bonus → ok at 10 routes', () => {
    for (let i = 0; i < 10; i++) bumpWeekly();
    const result = checkRouteQuota('free', 4);
    assert.ok(result.ok);
    assert.equal(result.limit, 11);
  });

  test('free at level 7 gets +2 bonus → blocks only at 12', () => {
    for (let i = 0; i < 11; i++) bumpWeekly();
    assert.ok(checkRouteQuota('free', 7).ok);
    bumpWeekly(); // 12
    assert.equal(checkRouteQuota('free', 7).ok, false);
  });

  test('free at level 9 (405 XP contributor) still +2 bonus', () => {
    assert.equal(levelFromXp(405), 9);
    for (let i = 0; i < 11; i++) bumpWeekly();
    assert.ok(checkRouteQuota('free', levelFromXp(405)).ok);
    assert.equal(routeLimit('free', levelFromXp(405)), 12);
  });

  test('silver at high level stays Infinity (bonus never applies)', () => {
    for (let i = 0; i < 100; i++) bumpWeekly();
    assert.ok(checkRouteQuota('silver', 10).ok);
  });
});

// ── Level / XP reward ladder ──────────────────────────────────────────────────

describe('XP + level math', () => {
  test('xpFromStats: reports×2 + pathGrades', () => {
    assert.equal(xpFromStats({ reports: 3, pathGrades: 4 }), 10);
    assert.equal(xpFromStats({}), 0);
    assert.equal(xpFromStats(null), 0);
  });

  // Progressive curve: xpForLevel(n) = 5·n·(n−1)
  test('levelFromXp: 0 XP → level 1',   () => assert.equal(levelFromXp(0), 1));
  test('levelFromXp: 9 XP → level 1',   () => assert.equal(levelFromXp(9), 1));
  test('levelFromXp: 10 XP → level 2',  () => assert.equal(levelFromXp(10), 2));
  test('levelFromXp: 29 XP → level 2',  () => assert.equal(levelFromXp(29), 2));
  test('levelFromXp: 30 XP → level 3',  () => assert.equal(levelFromXp(30), 3));
  test('levelFromXp: 60 XP → level 4',  () => assert.equal(levelFromXp(60), 4));
  test('levelFromXp: 405 XP → level 9', () => assert.equal(levelFromXp(405), 9));
  test('levelFromXp: 450 XP → level 10',() => assert.equal(levelFromXp(450), 10));
  test('levelFromXp: negative clamps to level 1', () => assert.equal(levelFromXp(-5), 1));

  test('xpForLevel: cumulative floor of a level (5·n·(n−1))', () => {
    assert.equal(xpForLevel(1), 0);
    assert.equal(xpForLevel(2), 10);
    assert.equal(xpForLevel(4), 60);
    assert.equal(xpForLevel(7), 210);
    assert.equal(xpForLevel(10), 450);
  });

  test('level spans grow by XP_STEP each level', () => {
    // span for level L = xpForLevel(L+1) − xpForLevel(L) = XP_STEP × L
    for (let L = 1; L <= 9; L++) {
      assert.equal(xpForLevel(L + 1) - xpForLevel(L), XP_STEP * L);
    }
  });

  test('levelProgress: 405 XP → level 9, 45/90 into it', () => {
    const p = levelProgress(405);
    assert.equal(p.level, 9);
    assert.equal(p.xpIn, 45);       // 405 − xpForLevel(9)=360
    assert.equal(p.span, 90);       // XP_STEP × 9
    assert.equal(p.xpToNext, 45);
    assert.equal(p.pct, 50);
  });

  test('levelProgress: 34 XP → level 3, 4/30 into it', () => {
    const p = levelProgress(34); // level 3 floor=30, span=30 (3→4)
    assert.equal(p.level, 3);
    assert.equal(p.xpIn, 4);
    assert.equal(p.span, 30);
    assert.equal(p.xpToNext, 26);
    assert.equal(Math.round(p.pct), 13);
  });
});

describe('routeBonus + routeLimit', () => {
  test('routeBonus: 0 below level 4',  () => assert.equal(routeBonus(3), 0));
  test('routeBonus: +1 at level 4-6',  () => { assert.equal(routeBonus(4), 1); assert.equal(routeBonus(6), 1); });
  test('routeBonus: +2 at level 7+',   () => { assert.equal(routeBonus(7), 2); assert.equal(routeBonus(20), 2); });

  test('routeLimit: free base 10 + bonus', () => {
    assert.equal(routeLimit('free', 1), 10);
    assert.equal(routeLimit('free', 4), 11);
    assert.equal(routeLimit('free', 7), 12);
  });
  test('routeLimit: silver stays Infinity', () => assert.equal(routeLimit('silver', 10), Infinity));
  test('routeLimit: defaults level 1 when omitted', () => assert.equal(routeLimit('free'), 10));
});

describe('level cosmetics + nextReward', () => {
  test('levelTitle: none before level 2', () => assert.equal(levelTitle(1), null));
  test('levelTitle: Promeneur at level 2', () => assert.equal(levelTitle(2), 'Promeneur'));
  test('levelTitle: highest wins at level 8', () => assert.equal(levelTitle(9), 'Gardien de la forêt'));
  test('levelTitle: Légende at level 10', () => assert.equal(levelTitle(10), 'Légende de Compiègne'));

  test('levelFrame: none before level 3', () => assert.equal(levelFrame(2), null));
  test('levelFrame: bronze at 3, silver at 6, gold at 9', () => {
    assert.equal(levelFrame(3), 'bronze');
    assert.equal(levelFrame(6), 'silver');
    assert.equal(levelFrame(9), 'gold');
  });

  test('nextReward: level 1 → level 2 reward', () => assert.equal(nextReward(1).level, 2));
  test('nextReward: maxed out → null', () => assert.equal(nextReward(10), null));

  test('LEVEL_REWARDS has 10 sequential levels', () => {
    assert.equal(LEVEL_REWARDS.length, 10);
    LEVEL_REWARDS.forEach((r, i) => assert.equal(r.level, i + 1));
  });
});
