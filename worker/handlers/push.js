import { listItems, listKeys, getUser, putUser, effectivePlan } from '../kv.js';
import { getUserFromToken } from '../auth-utils.js';
import { distanceToPolylineMeters } from '../geo.js';
import { sendPush } from '../webpush.js';
import { notifyRouteHazardEmail } from '../notify.js';

// A report counts as "on" a saved route when it lands within this many metres of
// the route polyline.
const HAZARD_RADIUS_M = 150;

// Human labels for the notification body (kept local so this module doesn't
// depend on reports.js — reports.js imports notifyHazard from here).
const TYPE_LABELS = {
  fallen_tree: 'Arbre tombé', flooded: 'Chemin inondé', muddy: 'Boueux',
  rutted: 'Ornières', broken_sign: 'Carrefour cassé', closed: 'Chemin fermé',
  danger: 'Danger', other: 'Obstacle',
};

/** Short, stable id for a subscription endpoint (KV key suffix). */
async function endpointHash(endpoint) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(endpoint));
  return [...new Uint8Array(buf)].slice(0, 16).map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Web Push subscription endpoints (Silver+ feature).
 *   GET  /api/push/vapid-public-key  → { key }              (public)
 *   POST /api/push/subscribe         { subscription }       (Silver+)
 *   POST /api/push/unsubscribe       { endpoint? }          (auth)
 * Subscriptions are stored per device as pushsub:{userId}:{endpointHash}. The
 * presence of any subscription is mirrored on the user as `alertsEnabled` so the
 * profile UI can reflect the toggle from the cached user object.
 * @param {Request} request
 * @param {import('../kv.js').Env} env
 * @param {{ pathname: string, json: Function, fail: Function }} ctx
 * @returns {Promise<Response|null>}
 */
export async function handlePush(request, env, { pathname, json, fail }) {
  if (pathname === '/api/push/vapid-public-key' && request.method === 'GET') {
    return json({ key: env.VAPID_PUBLIC_KEY || '' });
  }

  if (pathname === '/api/push/subscribe' && request.method === 'POST') {
    const user = await getUserFromToken(env, request);
    if (!user) return fail('Non authentifié.', 401);
    const plan = effectivePlan(user);
    if (plan !== 'gold' && plan !== 'silver') {
      return fail('Les alertes push sont disponibles avec le plan Argent.', 403);
    }

    const body = await request.json().catch(() => ({}));
    const sub = body.subscription;
    if (!sub || typeof sub.endpoint !== 'string' || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) {
      return fail('Abonnement push invalide.', 400);
    }

    const hash = await endpointHash(sub.endpoint);
    await env.BWR_KV.put(`pushsub:${user.id}:${hash}`, JSON.stringify({
      endpoint: sub.endpoint,
      keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth },
      createdAt: new Date().toISOString(),
    }));
    if (!user.alertsEnabled) await putUser(env, { ...user, alertsEnabled: true });
    return json({ success: true }, 201);
  }

  if (pathname === '/api/push/unsubscribe' && request.method === 'POST') {
    const user = await getUserFromToken(env, request);
    if (!user) return fail('Non authentifié.', 401);

    const body = await request.json().catch(() => ({}));
    if (body.endpoint) {
      await env.BWR_KV.delete(`pushsub:${user.id}:${await endpointHash(body.endpoint)}`);
    } else {
      // No endpoint given → drop every subscription for this user.
      const keys = await listKeys(env, `pushsub:${user.id}:`);
      await Promise.all(keys.map(k => env.BWR_KV.delete(k.name)));
    }

    // Reflect "off" on the user only when no subscriptions remain.
    const remaining = await listKeys(env, `pushsub:${user.id}:`);
    if (remaining.length === 0 && user.alertsEnabled) {
      await putUser(env, { ...user, alertsEnabled: false });
    }
    return json({ success: true });
  }

  return null;
}

/**
 * Fan-out: notify every Silver+ subscriber whose saved route passes within
 * HAZARD_RADIUS_M of a freshly-created report. Best-effort — meant to run inside
 * ctx.waitUntil so it never blocks or breaks the report POST. Dead subscriptions
 * (404/410) are pruned. `sendFn` is injectable so tests can assert without
 * hitting a real push service.
 *
 * @param {import('../kv.js').Env} env
 * @param {{ id: string, userId?: string, type?: string, lat: number, lon: number }} report
 * @param {typeof sendPush} [sendFn]
 */
export async function notifyHazard(env, report, sendFn = sendPush) {
  if (typeof report.lat !== 'number' || typeof report.lon !== 'number') return;
  const point = [report.lat, report.lon];

  const routes = await listItems(env, 'savedroute:');
  const matched = new Map(); // userId → first matching route name
  for (const route of routes) {
    if (!route.userId || route.userId === report.userId) continue;       // skip the reporter
    if (!Array.isArray(route.coords) || route.coords.length < 2) continue;
    if (distanceToPolylineMeters(point, route.coords) <= HAZARD_RADIUS_M) {
      if (!matched.has(route.userId)) matched.set(route.userId, route.name || 'votre trajet');
    }
  }
  if (matched.size === 0) return;

  const label = TYPE_LABELS[report.type] || TYPE_LABELS.other;
  for (const [userId, routeName] of matched) {
    const user = await getUser(env, userId);
    if (!user) continue;
    const plan = effectivePlan(user);
    if (plan !== 'silver' && plan !== 'gold') continue;

    // Email is a separate channel from push — send it to matched Silver+ owners
    // whether or not they have a push subscription (respects the opt-out inside).
    await notifyRouteHazardEmail(env, user, routeName, report);

    if (!user.alertsEnabled) continue; // push below requires an active subscription

    const payload = {
      title: '🌲 Nouvel obstacle sur votre trajet',
      body: `${label} signalé près de « ${routeName} ».`,
      url: '/map',
      tag: `hazard-${report.id}`,
    };

    const subKeys = await listKeys(env, `pushsub:${userId}:`);
    for (const k of subKeys) {
      const raw = await env.BWR_KV.get(k.name);
      if (!raw) continue;
      try {
        const result = await sendFn(env, JSON.parse(raw), payload);
        if (result && result.gone) await env.BWR_KV.delete(k.name);
      } catch { /* one bad push must not stop the rest */ }
    }
  }
}
