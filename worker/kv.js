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
// osm:{bbox}         → JSON OSM data  (7-day TTL)
// savedroute:{userId}:{id} → JSON saved route (coords, stats, metadata)
// routeshare:{token}       → JSON { userId, routeId }  (180-day TTL)
// news:{id}                → JSON news item
// pathgrade:{pathId}:{userId} → JSON { walkedWhenGraded: bool }
// walkedpath:{userId}:{pathId} → ISO timestamp string
// aisugg:{userId}:{date}   → JSON AI suggestion  (48h TTL)
// leaderboard:cache        → JSON sorted entries array  (5-min TTL)

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

/** Returns the user's active plan, forcing 'gold' for admin accounts regardless of stored value. */
export function effectivePlan(user) {
  if (user.role === 'admin') return 'gold';
  return user.plan || 'free';
}
