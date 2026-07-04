// ── KV key schema ─────────────────────────────────────────────────────────────
// user:{id}          → JSON user object
// uemail:{email}     → userId string  (email index for fast lookup)
// pending:{token}    → JSON pending registration  (24-hour TTL, deleted on verify)
// pemail:{email}     → token string  (index so login can detect unverified accounts)
// path:{id}          → JSON path object
// report:{id}        → JSON report object
// photo:{reportId}   → data-URI string, 90-day TTL
// contact:{id}       → JSON contact message
// session:{token}    → JSON { userId, expiresAt }
// reset:{token}      → JSON { userId, expiresAt }  (1-hour TTL, single-use password reset)
// osm:{bbox}         → JSON OSM data  (7-day TTL)
// savedroute:{userId}:{id} → JSON saved route (coords, stats, metadata)
// routeshare:{token}       → JSON { userId, routeId }  (180-day TTL)
// news:{id}                → JSON news item (incl. likes / dislikes counts)
// forum:topic:{id}         → JSON forum topic { userId, authorName, title, body, createdAt, lastActivityAt, replyCount }
// forum:reply:{topicId}:{paddedTs}:{id} → JSON reply { topicId, userId, authorName, body, createdAt }
//                            (ts in the key keeps replies ordered within a topic)
// newsreact:{newsId}:{voter} → 'like' | 'dislike'  (voter = u:{userId} or ip:{addr})
// pathgrade:{pathId}:{userId} → JSON { walkedWhenGraded: bool }
// walkedpath:{userId}:{pathId} → ISO timestamp string
// aisugg:{userId}:{date}   → legacy AI-suggestion cache (feature removed; keys self-expire, 48h TTL)
// leaderboard:cache        → JSON sorted entries array  (5-min TTL, "all-time" board)
// leaderboard:cache:{week|month} → JSON sorted entries for the current period (5-min TTL)
// xp:{period}:{userId}     → JSON { name, reports, pathGrades } earned in that period
//                            (period = ISO week "2026-W26" or month "2026-06"; ~70-day TTL)
// event:{ts}:{id}          → JSON auth event { type:'login'|'signup', ... }  (90-day TTL)
//                            Only real logins / new accounts are recorded — page
//                            views are NOT tracked (they could be search-engine bots).

/** Paginates KV list() to return all keys under a prefix (KV caps single calls at 1 000). */
export async function listKeys(env, prefix) {
  const keys = [];
  let cursor;
  do {
    const opts = { prefix, limit: 1000 };
    if (cursor) opts.cursor = cursor;
    const page = await env.BWR_KV.list(opts);
    keys.push(...page.keys);
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor !== undefined);
  return keys;
}

/** Fetches and JSON-parses every value whose key starts with `prefix`. */
export async function listItems(env, prefix) {
  const keys = await listKeys(env, prefix);
  if (keys.length === 0) return [];
  const values = await Promise.all(keys.map(k => env.BWR_KV.get(k.name)));
  return values.filter(Boolean).map(v => JSON.parse(v));
}

/** Returns the user object for `id`, or null if not found. */
export async function getUser(env, id) {
  const raw = await env.BWR_KV.get(`user:${id}`);
  return raw ? JSON.parse(raw) : null;
}

export async function putUser(env, user) {
  await env.BWR_KV.put(`user:${user.id}`, JSON.stringify(user));
}

/** Resolves email → userId via the uemail: index, then fetches the user. O(2) KV reads. */
export async function getUserByEmail(env, email) {
  const userId = await env.BWR_KV.get(`uemail:${email.toLowerCase()}`);
  if (!userId) return null;
  return getUser(env, userId);
}

export async function getPath(env, id) {
  const raw = await env.BWR_KV.get(`path:${id}`);
  return raw ? JSON.parse(raw) : null;
}

export async function putPath(env, path) {
  await env.BWR_KV.put(`path:${path.id}`, JSON.stringify(path));
}

export async function putReport(env, report) {
  await env.BWR_KV.put(`report:${report.id}`, JSON.stringify(report));
}

/**
 * Records a real auth event (a login or a brand-new account) for the admin
 * activity panel. Page views are intentionally NOT tracked — only humans who
 * actually sign in or create an account, which search-engine bots never do.
 * Admin accounts are skipped so the owner's own logins don't inflate the count.
 * Best-effort: never throws, so it can't break the login/verify flow.
 *
 * @param {import('./kv.js').Env} env
 * @param {'login'|'signup'} type
 * @param {{ id: string, name?: string, email?: string, role?: string }} user
 */
export async function recordAuthEvent(env, type, user) {
  try {
    if (!user || user.role === 'admin') return;
    const ts = Date.now();
    const id = crypto.randomUUID();
    const event = {
      id,
      type,
      timestamp: new Date(ts).toISOString(),
      userId: user.id,
      userName: user.name || '',
      email: user.email || '',
    };
    const counterKey = type === 'signup' ? 'analytics:total_signups' : 'analytics:total_logins';
    const totalRaw = await env.BWR_KV.get(counterKey);
    await Promise.all([
      env.BWR_KV.put(`event:${String(ts).padStart(13, '0')}:${id}`, JSON.stringify(event),
        { expirationTtl: 60 * 60 * 24 * 90 }), // 90-day TTL
      env.BWR_KV.put(counterKey, String((totalRaw ? parseInt(totalRaw, 10) : 0) + 1)),
    ]);
  } catch {
    /* analytics must never break auth */
  }
}

/**
 * Updates a single entry in the leaderboard cache without a full rebuild.
 * No-ops when the cache key is absent (next GET /api/leaderboard will rebuild it).
 */
export async function patchLeaderboardCache(env, updatedUser) {
  const raw = await env.BWR_KV.get('leaderboard:cache');
  if (!raw) return;
  const entries = JSON.parse(raw);
  const totalPaths = (await listKeys(env, 'path:')).length;
  const s = updatedUser.stats || {};
  const reports = s.reports || 0;
  const pathGrades = s.pathGrades || 0;
  const points = reports * 2 + pathGrades;
  const forestCoverage = totalPaths > 0
    ? Math.round((s.walkedPathsCount || 0) / totalPaths * 100) : 0;
  const entry = { id: updatedUser.id, name: updatedUser.name, reports, pathGrades, points, forestCoverage };
  const idx = entries.findIndex(e => e.id === updatedUser.id);
  if (idx >= 0) entries[idx] = entry; else entries.push(entry);
  entries.sort((a, b) => b.points - a.points || b.reports - a.reports);
  await env.BWR_KV.put('leaderboard:cache', JSON.stringify(entries), { expirationTtl: 300 });
}

// ── Period keys for the weekly / monthly leaderboards ──────────────────────────
/** ISO-8601 week key for a date, e.g. "2026-W26". Weeks start Monday. */
export function isoWeekKey(d = new Date()) {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = date.getUTCDay() || 7;            // Sunday → 7
  date.setUTCDate(date.getUTCDate() + 4 - day); // shift to the Thursday of this week
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((date - yearStart) / 86400000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/** Calendar-month key for a date, e.g. "2026-06". */
export function monthKey(d = new Date()) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** The period key for a leaderboard scope. Returns null for 'all' (no bucket). */
export function periodKeyFor(scope, d = new Date()) {
  if (scope === 'week') return isoWeekKey(d);
  if (scope === 'month') return monthKey(d);
  return null;
}

/**
 * Adds XP deltas (a report and/or a graded path) to a user's current
 * week and month buckets, so the periodic leaderboards reflect recent activity.
 * Counts are clamped at 0 (a reversal can't push a bucket negative). Best-effort —
 * never throws, so it can't break a report/grade write.
 *
 * @param {import('./kv.js').Env} env
 * @param {{ id: string, name?: string }} user
 * @param {{ reports?: number, pathGrades?: number }} delta
 */
export async function addPeriodXp(env, user, delta) {
  try {
    const dReports = delta.reports || 0;
    const dGrades = delta.pathGrades || 0;
    if (dReports === 0 && dGrades === 0) return;
    const now = new Date();
    const TTL = 60 * 60 * 24 * 70; // 70 days — outlasts any current week or month
    await Promise.all([isoWeekKey(now), monthKey(now)].map(async period => {
      const key = `xp:${period}:${user.id}`;
      const raw = await env.BWR_KV.get(key);
      const cur = raw ? JSON.parse(raw) : { reports: 0, pathGrades: 0 };
      cur.name = user.name;
      cur.reports = Math.max(0, (cur.reports || 0) + dReports);
      cur.pathGrades = Math.max(0, (cur.pathGrades || 0) + dGrades);
      await env.BWR_KV.put(key, JSON.stringify(cur), { expirationTtl: TTL });
    }));
  } catch {
    /* periodic-XP tracking must never break the underlying write */
  }
}

/**
 * Returns the user's active plan.
 * - Admin accounts always resolve to 'gold'.
 * - 'visitor' is a time-limited Silver alias: resolves to 'silver' while
 *   planExpiresAt is in the future, or 'free' once it has elapsed.
 */
export function effectivePlan(user) {
  if (user.role === 'admin') return 'gold';
  const plan = user.plan || 'free';
  if (plan === 'visitor') {
    if (user.planExpiresAt && new Date(user.planExpiresAt) < new Date()) return 'free';
    return 'silver';
  }
  return plan;
}
