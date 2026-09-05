import { listItems } from '../kv.js';
import { getUserFromToken } from '../auth-utils.js';

// Hard caps so one recorded activity can't blow past KV's value limits or be
// used to stuff arbitrary data. A 4-hour walk sampled every ~4 s is ~3 600
// points, so 50 000 is comfortably generous while still bounded.
const MAX_POINTS = 50000;
const MAX_NAME   = 80;

/**
 * Recorded activities / hike journal — the Strava-style "record this walk, save
 * it, replay it later" loop. Available to every signed-in user (free included);
 * it is the retention hook, not a paid gate.
 *
 * KV: activity:{userId}:{id} → JSON { id, userId, name, coords, elevations?,
 *     times?, meters, seconds, movingSeconds, ascent, descent, startedAt,
 *     savedAt }
 *
 * @param {Request} request
 * @param {import('../kv.js').Env} env
 * @param {{ pathname: string, json: Function, fail: Function }} ctx
 * @returns {Promise<Response|null>}
 */
export async function handleActivities(request, env, { pathname, json, fail }) {
  if (pathname === '/api/activities' && request.method === 'POST') {
    const user = await getUserFromToken(env, request);
    if (!user) return fail('Non authentifié.', 401);

    const body = await request.json().catch(() => ({}));
    if (!Array.isArray(body.coords) || body.coords.length < 2) {
      return fail('Tracé invalide — au moins deux points requis.');
    }
    if (body.coords.length > MAX_POINTS) {
      return fail('Tracé trop volumineux.');
    }

    // Sanitise the track: keep only finite [lat, lon] pairs, in order.
    const coords = [];
    for (const pt of body.coords) {
      if (!Array.isArray(pt) || pt.length < 2) continue;
      const lat = Number(pt[0]), lon = Number(pt[1]);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      if (lat < -90 || lat > 90 || lon < -180 || lon > 180) continue;
      coords.push([+lat.toFixed(6), +lon.toFixed(6)]);
    }
    if (coords.length < 2) return fail('Tracé invalide — au moins deux points requis.');

    // Optional parallel arrays. Only stored when they line up with the track.
    const elevations = Array.isArray(body.elevations) && body.elevations.length === coords.length
      ? body.elevations.map(e => (Number.isFinite(Number(e)) ? +Number(e).toFixed(1) : null))
      : null;
    const times = Array.isArray(body.times) && body.times.length === coords.length
      ? body.times.map(t => (Number.isFinite(Number(t)) ? Math.round(Number(t)) : null))
      : null;

    const nonNeg = (v) => { const n = Math.round(Number(v)); return Number.isFinite(n) && n >= 0 ? n : 0; };
    const startedAt = typeof body.startedAt === 'string' && !Number.isNaN(Date.parse(body.startedAt))
      ? body.startedAt : new Date().toISOString();

    const id = crypto.randomUUID();
    const activity = {
      id,
      userId: user.id,
      name: (typeof body.name === 'string' && body.name.trim() ? body.name.trim() : 'Sortie sans nom').slice(0, MAX_NAME),
      coords,
      elevations,
      times,
      meters: nonNeg(body.meters),
      seconds: nonNeg(body.seconds),
      movingSeconds: nonNeg(body.movingSeconds) || nonNeg(body.seconds),
      ascent: nonNeg(body.ascent),
      descent: nonNeg(body.descent),
      startedAt,
      savedAt: new Date().toISOString(),
    };

    await env.BWR_KV.put(`activity:${user.id}:${id}`, JSON.stringify(activity));
    return json({ id }, 201);
  }

  if (pathname === '/api/activities' && request.method === 'GET') {
    const user = await getUserFromToken(env, request);
    if (!user) return fail('Non authentifié.', 401);

    const activities = await listItems(env, `activity:${user.id}:`);
    activities.sort((a, b) => (b.startedAt || b.savedAt || '').localeCompare(a.startedAt || a.savedAt || ''));
    // List view: drop the heavy geometry, keep the summary + a light preview.
    const summary = activities.map(({ coords, elevations: _e, times: _t, ...rest }) => ({
      ...rest,
      points: Array.isArray(coords) ? coords.length : 0,
    }));
    return json(summary);
  }

  if (pathname.startsWith('/api/activities/') && request.method === 'GET') {
    const user = await getUserFromToken(env, request);
    if (!user) return fail('Non authentifié.', 401);

    const id = pathname.split('/')[3];
    const raw = await env.BWR_KV.get(`activity:${user.id}:${id}`);
    if (!raw) return fail('Sortie introuvable.', 404);
    return json(JSON.parse(raw));
  }

  if (pathname.startsWith('/api/activities/') && request.method === 'PATCH') {
    const user = await getUserFromToken(env, request);
    if (!user) return fail('Non authentifié.', 401);

    const id = pathname.split('/')[3];
    const key = `activity:${user.id}:${id}`;
    const raw = await env.BWR_KV.get(key);
    if (!raw) return fail('Sortie introuvable.', 404);

    const body = await request.json().catch(() => ({}));
    if (typeof body.name !== 'string' || !body.name.trim()) return fail('Nom invalide.');

    const activity = JSON.parse(raw);
    activity.name = body.name.trim().slice(0, MAX_NAME);
    await env.BWR_KV.put(key, JSON.stringify(activity));
    return json({ success: true, name: activity.name });
  }

  if (pathname.startsWith('/api/activities/') && request.method === 'DELETE') {
    const user = await getUserFromToken(env, request);
    if (!user) return fail('Non authentifié.', 401);

    const id = pathname.split('/')[3];
    const key = `activity:${user.id}:${id}`;
    const raw = await env.BWR_KV.get(key);
    if (!raw) return fail('Sortie introuvable.', 404);

    await env.BWR_KV.delete(key);
    return json({ success: true });
  }

  return null;
}
