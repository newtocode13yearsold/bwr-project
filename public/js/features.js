/* ── BWR Feature Gating ────────────────────────────────────────────────────────
 *
 * Single source of truth for plan-based feature access.
 *
 * Usage from any page (after <script src="js/features.js"></script>):
 *
 *   if (BWR.can('loop_mode', user.plan)) { ... }
 *   const limit = BWR.limitOf('routes_per_week', user.plan);   // numeric quotas
 *   const tag   = BWR.requiredTier('elevation_profile');       // 'silver' | 'gold'
 *
 * Add a row here when you introduce a new gated capability. Never inline
 * a `plan === 'silver'` check in page code — always go through BWR.can().
 * ────────────────────────────────────────────────────────────────────────────── */

(function (global) {
  'use strict';

  // Truthy values mean "available". For numeric quotas the value IS the limit.
  const FEATURES = {
    /* — Core routing — */
    routes_per_week:     { free: 10,    visitor: Infinity, silver: Infinity, gold: Infinity },
    loop_mode:           { free: true,  visitor: true,     silver: true,     gold: true     },
    loops_per_week:      { free: 3,     visitor: Infinity, silver: Infinity, gold: Infinity },
    difficulty_hard:     { free: false, visitor: true,     silver: true,     gold: true     },

    /* — Map & layers — */
    satellite_tiles:     { free: false, visitor: false,    silver: true,     gold: true     },
    ign_topo_tiles:      { free: false, visitor: false,    silver: true,     gold: true     },
    carrefours:          { free: true,  visitor: true,     silver: true,     gold: true     },

    /* — Trip analysis & export — */
    elevation_profile:   { free: false, visitor: true,     silver: true,     gold: true     },
    gpx_export:          { free: false, visitor: true,     silver: true,     gold: true     },
    kml_export:          { free: false, visitor: false,    silver: true,     gold: true     },
    strava_komoot_push:  { free: false, visitor: false,    silver: true,     gold: true     },
    offline_cache:       { free: 0,     visitor: 1,        silver: 20,       gold: 20       },

    /* — Reports & alerts — */
    reports_create:      { free: true,  visitor: true,     silver: true,     gold: true     },
    path_alerts:         { free: false, visitor: false,    silver: true,     gold: true     },

    /* — Path editing — */
    path_difficulty_edit: { free: true,  visitor: true,   silver: true,     gold: true     },
    path_select:          { free: true,  visitor: true,   silver: true,     gold: true     },

    /* — Personalisation & gamification — */
    daily_wheel:         { free: false, visitor: true,     silver: true,     gold: true     },
    custom_goals:        { free: false, visitor: false,    silver: true,     gold: true     },
    weather:             { free: false, visitor: false,    silver: true,     gold: true     },
    custom_route_color:  { free: false, visitor: false,    silver: true,     gold: true     },
    // "Sur mesure" planner mode: build a route via an ordered list of stops /
    // carrefours the user picks themselves. See public/js/routes-planner.js.
    custom_route_builder: { free: false, visitor: false,   silver: true,     gold: true     },

    /* — Badges & progression — */
    badges_free:         { free: true,  visitor: true,     silver: true,     gold: true     },
    badges_silver:       { free: false, visitor: true,     silver: true,     gold: true     },
    badges_gold:         { free: false, visitor: false,    silver: false,    gold: true     },

    /* — Route history & sharing — */
    route_history:       { free: false, visitor: true,     silver: true,     gold: true     },
    route_sharing:       { free: false, visitor: true,     silver: true,     gold: true     },

    /* — Support / perks — */
    priority_support:    { free: false, visitor: false,    silver: true,     gold: true     },
    early_access:        { free: false, visitor: false,    silver: true,     gold: true     },

    /* — Community forum — */
    // forum_post: create topics + reply. forum_topics_visible: how many topics a
    // free account may read (the rest are locked behind an upsell). Mirror any
    // change in worker/handlers/forum.js (FREE_VISIBLE_TOPICS) + the tests.
    forum_post:           { free: false, visitor: true,    silver: true,     gold: true     },
    forum_topics_visible: { free: 5,     visitor: Infinity, silver: Infinity, gold: Infinity },

  };

  function normalisePlan(plan) {
    if (!plan) return 'free';
    return plan;
  }

  /**
   * Returns the feature value for a plan. Use it as a boolean to gate UI;
   * for quotas, compare numerically (e.g. `limitOf('routes_per_week', plan)`).
   */
  function can(feature, plan) {
    const p = normalisePlan(plan);
    const row = FEATURES[feature];
    if (!row) return false;
    const v = row[p];
    return v === undefined ? false : v;
  }

  /** Numeric quota (0 when unavailable, Infinity for unlimited). */
  function limitOf(feature, plan) {
    const v = can(feature, plan);
    if (v === true)  return Infinity;
    if (v === false) return 0;
    if (typeof v === 'number') return v;
    return 0;
  }

  /** Cheapest tier that unlocks a feature — for upsell badges in UI. */
  function requiredTier(feature) {
    const row = FEATURES[feature];
    if (!row) return null;
    if (row.free   && row.free   !== 0) return 'free';
    if (row.silver && row.silver !== 0) return 'silver';
    if (row.gold   && row.gold   !== 0) return 'gold';
    return 'gold';
  }

  /** Human-readable tier label for upsell prompts. */
  const TIER_LABEL = { free: 'Gratuit', visitor: 'Visiteur', silver: 'Argent', gold: 'Or' };
  const TIER_ICON  = { free: '🌿',      visitor: '🎫',       silver: '🥈',     gold: '🥇' };

  /* ── Weekly route quota helpers ─────────────────────────────────────────── */

  function isoMonday(d = new Date()) {
    const day = (d.getDay() + 6) % 7; // 0 = Monday
    const monday = new Date(d);
    monday.setDate(d.getDate() - day);
    monday.setHours(0, 0, 0, 0);
    return monday.toISOString().slice(0, 10);
  }

  function readWeekly() {
    try {
      const raw = localStorage.getItem('bwr_routes_week');
      if (!raw) return { weekStart: isoMonday(), count: 0 };
      const parsed = JSON.parse(raw);
      // Reset the counter when a new week begins.
      if (parsed.weekStart !== isoMonday()) {
        return { weekStart: isoMonday(), count: 0 };
      }
      return parsed;
    } catch {
      return { weekStart: isoMonday(), count: 0 };
    }
  }

  function bumpWeekly() {
    const w = readWeekly();
    w.count += 1;
    localStorage.setItem('bwr_routes_week', JSON.stringify(w));
    return w;
  }

  /**
   * Quota check used before generating a route.
   * Returns { ok: true } or { ok: false, used, limit, plan }.
   */
  function checkRouteQuota(plan) {
    const limit = limitOf('routes_per_week', plan);
    const { count } = readWeekly();
    if (count >= limit) {
      return { ok: false, used: count, limit, plan: normalisePlan(plan) };
    }
    return { ok: true, used: count, limit };
  }

  global.BWR = {
    FEATURES,
    can,
    limitOf,
    requiredTier,
    TIER_LABEL,
    TIER_ICON,
    normalisePlan,
    isoMonday,
    readWeekly,
    bumpWeekly,
    checkRouteQuota,
  };
})(window);
