/* ── BWR Feature Gating ────────────────────────────────────────────────────────
 *
 * Single source of truth for plan-based feature access.
 *
 * Usage from any page (after <script src="js/features.js"></script>):
 *
 *   if (can('loop_mode', user.plan)) { ... }
 *   const limit = limitOf('routes_per_week', user.plan);   // numeric quotas
 *   const tag   = requiredTier('elevation_profile');       // 'silver' | 'gold'
 *
 * Add a row here when you introduce a new gated capability. Never inline
 * a `plan === 'silver'` check in page code — always go through can().
 * ────────────────────────────────────────────────────────────────────────────── */

(function (global) {
  'use strict';

  // Truthy values mean "available". For numeric quotas the value IS the limit.
  // ai_suggestions uses 'weekly' | 'daily' to denote cadence.
  const FEATURES = {
    /* — Core routing — */
    routes_per_week:     { free: 3,     silver: Infinity, gold: Infinity },
    loop_mode:           { free: false, silver: true,     gold: true     },
    multistop_mode:      { free: false, silver: false,    gold: true     },
    difficulty_hard:     { free: false, silver: true,     gold: true     },

    /* — Map & layers — */
    satellite_tiles:     { free: false, silver: false,    gold: true     },
    ign_topo_tiles:      { free: false, silver: true,     gold: true     },
    carrefours:          { free: false, silver: true,     gold: true     },
    scenic_pois:         { free: false, silver: true,     gold: true     },

    /* — Trip analysis & export — */
    elevation_profile:   { free: false, silver: true,     gold: true     },
    gpx_export:          { free: false, silver: true,     gold: true     },
    kml_export:          { free: false, silver: false,    gold: true     },
    strava_komoot_push:  { free: false, silver: false,    gold: true     },
    offline_cache:       { free: 0,     silver: 1,        gold: 20       },

    /* — Reports & alerts — */
    reports_create:      { free: false, silver: true,     gold: true     },
    path_alerts:         { free: false, silver: false,    gold: true     },

    /* — Cloud & history — */
    cloud_sync:          { free: false, silver: true,     gold: true     },
    photo_journal:       { free: 0,     silver: 5,        gold: Infinity },
    route_history:       { free: false, silver: true,     gold: true     },

    /* — Personalisation & gamification — */
    daily_wheel:         { free: false, silver: true,     gold: true     },
    custom_goals:        { free: false, silver: false,    gold: true     },
    weather:             { free: false, silver: false,    gold: true     },
    custom_route_color:  { free: false, silver: false,    gold: true     },
    animated_frame:      { free: false, silver: false,    gold: true     },
    ai_suggestions:      { free: false, silver: 'weekly', gold: 'daily'  },

    /* — Badges & progression — */
    badges_free:         { free: true,  silver: true,     gold: true     },
    badges_silver:       { free: false, silver: true,     gold: true     },
    badges_gold:         { free: false, silver: false,    gold: true     },

    /* — Social — */
    groups_join:         { free: false, silver: true,     gold: true     },
    groups_create:       { free: false, silver: false,    gold: true     },
    leaderboard_full:    { free: false, silver: true,     gold: true     },

    /* — Support / perks — */
    priority_support:    { free: false, silver: false,    gold: true     },
    early_access:        { free: false, silver: false,    gold: true     },
    discord_community:   { free: false, silver: false,    gold: true     },
  };

  // Admins get every premium capability automatically (server also forces gold).
  function normalisePlan(plan) {
    if (!plan) return 'free';
    if (plan === 'admin') return 'gold';
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
  const TIER_LABEL = { free: 'Gratuit', silver: 'Argent', gold: 'Or' };
  const TIER_ICON  = { free: '🌿',      silver: '🥈',     gold: '🥇' };

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

  global.BWR_FEATURES = FEATURES;
  global.can = can;
  global.limitOf = limitOf;
  global.requiredTier = requiredTier;
  global.TIER_LABEL = TIER_LABEL;
  global.TIER_ICON = TIER_ICON;
  global.normalisePlan = normalisePlan;
  global.readWeekly = readWeekly;
  global.bumpWeekly = bumpWeekly;
  global.checkRouteQuota = checkRouteQuota;
})(window);
