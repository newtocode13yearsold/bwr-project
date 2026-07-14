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
    // GPX import is deliberately open to everyone (incl. free/visitor) — it's an
    // acquisition hook: bring a Strava/Garmin route onto the graded BWR map.
    gpx_import:          { free: true,  visitor: true,     silver: true,     gold: true     },
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

  /* ── Level / XP reward ladder ───────────────────────────────────────────────
   * XP is earned through community contributions (NOT distance / subscription):
   *   XP = reports×2 + pathGrades   (same formula as the leaderboard points)
   *
   * PROGRESSIVE curve: the gap between levels grows the higher you climb, so a
   * top contributor isn't instantly at "level 40". Each level L→L+1 costs
   * XP_STEP·L (10, 20, 30, …), so the cumulative XP to *reach* level n is
   *   xpForLevel(n) = XP_STEP · n·(n−1)/2  = 5·n·(n−1)
   * → L2:10  L3:30  L4:60  L5:100  L6:150  L7:210  L8:280  L9:360  L10:450.
   *
   * Levels unlock STATUS + COSMETICS (titles, profile frames) plus ONE light
   * functional perk (bonus weekly routes for free accounts) — the ladder
   * deliberately does NOT unlock paid Silver/Gold features, so it rewards
   * contribution without cannibalising the subscription. Keep this in sync with
   * the server bonus in worker/handlers/auth.js (consume-route) and the tests.
   * ──────────────────────────────────────────────────────────────────────────── */
  const XP_STEP = 10; // base increment; per-level cost is XP_STEP × level

  // bonusRoutes is CUMULATIVE by "highest reached" (see routeBonus): reaching a
  // level with a higher bonusRoutes replaces the previous one, it does not stack.
  const LEVEL_REWARDS = [
    { level: 1,  icon: '🌱', title: null,                    frame: null,     bonusRoutes: 0, label: 'Bienvenue',                 desc: 'Ton aventure commence' },
    { level: 2,  icon: '🥾', title: 'Promeneur',             frame: null,     bonusRoutes: 0, label: 'Titre « Promeneur »',       desc: 'Un titre affiché sur ton profil' },
    { level: 3,  icon: '🥉', title: null,                    frame: 'bronze', bonusRoutes: 0, label: 'Cadre Bronze',              desc: 'Cadre de profil bronze' },
    { level: 4,  icon: '➕', title: null,                    frame: null,     bonusRoutes: 1, label: '+1 trajet / semaine',       desc: 'Quota hebdo gratuit augmenté' },
    { level: 5,  icon: '🧭', title: 'Éclaireur',             frame: null,     bonusRoutes: 0, label: 'Titre « Éclaireur »',       desc: 'Un nouveau titre de profil' },
    { level: 6,  icon: '🥈', title: null,                    frame: 'silver', bonusRoutes: 0, label: 'Cadre Argent',              desc: 'Cadre de profil argent' },
    { level: 7,  icon: '➕', title: null,                    frame: null,     bonusRoutes: 2, label: '+2 trajets / semaine',      desc: 'Quota hebdo gratuit augmenté' },
    { level: 8,  icon: '🌲', title: 'Gardien de la forêt',   frame: null,     bonusRoutes: 0, label: 'Titre « Gardien de la forêt »', desc: 'Un titre prestigieux' },
    { level: 9,  icon: '✨', title: null,                    frame: 'gold',   bonusRoutes: 0, label: 'Cadre Or animé',            desc: 'Cadre de profil or, animé' },
    { level: 10, icon: '👑', title: 'Légende de Compiègne',  frame: null,     bonusRoutes: 0, label: 'Titre « Légende »',         desc: 'Le titre ultime + reconnaissance' },
  ];

  /** Community XP from a user's stats object. */
  function xpFromStats(stats) {
    const s = stats || {};
    return (s.reports || 0) * 2 + (s.pathGrades || 0);
  }

  /** Cumulative XP needed to *reach* a level: 5·n·(n−1) (progressive curve). */
  function xpForLevel(level) {
    const n = Math.max(1, level);
    return (XP_STEP * n * (n - 1)) / 2;
  }

  /** Level (1-based) for a given XP total — inverse of the curve above. */
  function levelFromXp(xp) {
    const x = Math.max(0, xp || 0);
    // Solve 5·n·(n−1) ≤ x → n = floor((1 + √(1 + 8x/XP_STEP)) / 2)
    return Math.floor((1 + Math.sqrt(1 + (8 * x) / XP_STEP)) / 2);
  }

  /** Progress inside the current level → { xp, level, xpIn, span, xpToNext, pct }. */
  function levelProgress(xp) {
    const x = Math.max(0, xp || 0);
    const level = levelFromXp(x);
    const floor = xpForLevel(level);
    const span  = xpForLevel(level + 1) - floor; // XP_STEP × level
    const xpIn  = x - floor;
    const pct   = span > 0 ? Math.min(100, (xpIn / span) * 100) : 100;
    return { xp: x, level, xpIn, span, xpToNext: span - xpIn, pct };
  }

  /** Bonus weekly routes unlocked by level (0 / 1 / 2). Highest-reached wins. */
  function routeBonus(level) {
    return LEVEL_REWARDS
      .filter(r => r.level <= level)
      .reduce((best, r) => Math.max(best, r.bonusRoutes || 0), 0);
  }

  /** Highest title unlocked at a level, or null. */
  function levelTitle(level) {
    let t = null;
    LEVEL_REWARDS.forEach(r => { if (r.level <= level && r.title) t = r.title; });
    return t;
  }

  /** Highest profile frame unlocked at a level, or null. */
  function levelFrame(level) {
    let f = null;
    LEVEL_REWARDS.forEach(r => { if (r.level <= level && r.frame) f = r.frame; });
    return f;
  }

  /** The next reward the user hasn't reached yet, or null if maxed out. */
  function nextReward(level) {
    return LEVEL_REWARDS.find(r => r.level > level) || null;
  }

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
   * Effective weekly route limit for a plan, including the level bonus.
   * `level` is optional (defaults to 1 → no bonus). The bonus only lifts the
   * finite free limit; Infinity (Silver/Gold/visitor) stays Infinity.
   */
  function routeLimit(plan, level) {
    const base = limitOf('routes_per_week', plan);
    if (!isFinite(base)) return base;
    return base + routeBonus(level || 1);
  }

  /**
   * Quota check used before generating a route.
   * Returns { ok: true } or { ok: false, used, limit, plan }.
   */
  function checkRouteQuota(plan, level) {
    const limit = routeLimit(plan, level);
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
    // Level / XP reward ladder
    XP_STEP,
    LEVEL_REWARDS,
    xpFromStats,
    levelFromXp,
    xpForLevel,
    levelProgress,
    routeBonus,
    routeLimit,
    levelTitle,
    levelFrame,
    nextReward,
  };
})(window);
