import { listItems } from '../kv.js';
import { getUserFromToken } from '../auth-utils.js';

// Whole-site rating ("comme un avis Google"): one review per account, editable.
// The average + count + distribution are PUBLIC (footer social proof); the
// individual comments are ADMIN-ONLY (surfaced in the Panneau admin "Avis" tab).
//
// KV keys:
//   review:{userId}  → JSON { userId, name, stars, comment, createdAt, updatedAt }
//   reviewsummary    → JSON { avg, count, dist:{1..5} }  cached aggregate (5-min TTL)
//                      (deliberately NOT prefixed "review:" so listItems('review:')
//                       never picks up the cache blob)

const SUMMARY_CACHE = 'reviewsummary';

/** Recompute the public aggregate from every review:{id} and cache it 5 min. */
async function computeSummary(env) {
  const reviews = await listItems(env, 'review:');
  const dist = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  let sum = 0;
  for (const r of reviews) {
    const s = Number(r.stars);
    if (s >= 1 && s <= 5) { dist[s]++; sum += s; }
  }
  const count = dist[1] + dist[2] + dist[3] + dist[4] + dist[5];
  const avg = count > 0 ? Math.round((sum / count) * 10) / 10 : 0;
  const summary = { avg, count, dist };
  await env.BWR_KV.put(SUMMARY_CACHE, JSON.stringify(summary), { expirationTtl: 300 });
  return summary;
}

/**
 * Site-rating endpoints.
 * @param {Request} request
 * @param {import('../kv.js').Env} env
 * @param {{ pathname: string, json: Function, fail: Function }} ctx
 * @returns {Promise<Response|null>}
 */
export async function handleRating(request, env, { pathname, json, fail }) {
  // ── Public aggregate (+ caller's own review when authenticated) ──
  if (pathname === '/api/rating' && request.method === 'GET') {
    const cached = await env.BWR_KV.get(SUMMARY_CACHE);
    const summary = cached ? JSON.parse(cached) : await computeSummary(env);

    const user = await getUserFromToken(env, request);
    let mine = null;
    if (user) {
      const raw = await env.BWR_KV.get(`review:${user.id}`);
      if (raw) { const r = JSON.parse(raw); mine = { stars: r.stars, comment: r.comment || '' }; }
    }
    return json({ ...summary, mine });
  }

  // ── Submit / update my review (one per account, editable) ──
  if (pathname === '/api/rating' && request.method === 'POST') {
    const user = await getUserFromToken(env, request);
    if (!user) return fail('Connectez-vous pour laisser un avis.', 401);

    const body = await request.json().catch(() => ({}));
    const stars = Number(body.stars);
    if (!Number.isInteger(stars) || stars < 1 || stars > 5) {
      return fail('Note invalide (1 à 5 étoiles).', 400);
    }
    const comment = String(body.comment || '').slice(0, 1000).trim();

    const existingRaw = await env.BWR_KV.get(`review:${user.id}`);
    const existing = existingRaw ? JSON.parse(existingRaw) : null;
    const now = new Date().toISOString();
    const review = {
      userId: user.id,
      name: user.name || 'Anonyme',
      stars,
      comment,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    };
    await env.BWR_KV.put(`review:${user.id}`, JSON.stringify(review));
    await env.BWR_KV.delete(SUMMARY_CACHE); // force recompute on next GET
    const summary = await computeSummary(env);
    return json({ ok: true, ...summary, mine: { stars, comment } });
  }

  // ── Admin: full review list (comments included) ──
  if (pathname === '/api/ratings' && request.method === 'GET') {
    const admin = await getUserFromToken(env, request);
    if (!admin || admin.role !== 'admin') return fail('Accès refusé.', 403);

    const reviews = await listItems(env, 'review:');
    reviews.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
    const cached = await env.BWR_KV.get(SUMMARY_CACHE);
    const summary = cached ? JSON.parse(cached) : await computeSummary(env);
    return json({ ...summary, reviews });
  }

  // ── Admin: delete a review ──
  if (pathname.startsWith('/api/ratings/') && request.method === 'DELETE') {
    const admin = await getUserFromToken(env, request);
    if (!admin || admin.role !== 'admin') return fail('Accès refusé.', 403);

    const targetId = decodeURIComponent(pathname.slice('/api/ratings/'.length));
    if (!targetId) return fail('Identifiant manquant.', 400);
    await env.BWR_KV.delete(`review:${targetId}`);
    await env.BWR_KV.delete(SUMMARY_CACHE);
    const summary = await computeSummary(env);
    return json({ ok: true, ...summary });
  }

  return null;
}
