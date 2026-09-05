import { listItems, getPath } from '../kv.js';
import { getUserFromToken } from '../auth-utils.js';

// Per-trail reviews: a star rating (1–5) + optional free-text comment left on an
// individual curated path (chemin). One review per account per path, editable.
// Unlike the whole-site rating, the comments here are PUBLIC — they're the point
// of trail reviews (like AllTrails): hikers read each other's notes before going.
//
// KV keys:
//   pathreview:{pathId}:{userId} → JSON { pathId, userId, name, stars, comment,
//                                         createdAt, updatedAt }
//     (pathId-first so listItems('pathreview:{pathId}:') gathers one trail's
//      reviews in a single prefix scan; erasure filters by the `:userId` suffix.)

/** Aggregate { avg, count, dist:{1..5} } from a list of review objects. */
function summarise(reviews) {
  const dist = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  let sum = 0;
  for (const rv of reviews) {
    const s = Number(rv.stars);
    if (s >= 1 && s <= 5) { dist[s]++; sum += s; }
  }
  const count = dist[1] + dist[2] + dist[3] + dist[4] + dist[5];
  const avg = count > 0 ? Math.round((sum / count) * 10) / 10 : 0;
  return { avg, count, dist };
}

const REVIEWS_RE = /^\/api\/paths\/([^/]+)\/reviews$/;
const REVIEW_ONE_RE = /^\/api\/paths\/([^/]+)\/reviews\/([^/]+)$/;

/**
 * Per-path review endpoints. Runs BEFORE handlePaths in the dispatch chain so a
 * DELETE /api/paths/:id/reviews/:userId isn't swallowed by the generic
 * /api/paths/:id DELETE (path deletion).
 *
 * @param {Request} request
 * @param {import('../kv.js').Env} env
 * @param {{ pathname: string, json: Function, fail: Function }} ctx
 * @returns {Promise<Response|null>}
 */
export async function handlePathReviews(request, env, { pathname, json, fail }) {
  const listMatch = pathname.match(REVIEWS_RE);
  const oneMatch = pathname.match(REVIEW_ONE_RE);

  // ── Public: aggregate + review list (+ caller's own when authenticated) ──
  if (listMatch && request.method === 'GET') {
    const pathId = decodeURIComponent(listMatch[1]);
    const reviews = await listItems(env, `pathreview:${pathId}:`);
    reviews.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));

    const user = await getUserFromToken(env, request);
    let mine = null;
    if (user) {
      const own = reviews.find(rv => rv.userId === user.id);
      if (own) mine = { stars: own.stars, comment: own.comment || '' };
    }

    const publicReviews = reviews.map(({ name, stars, comment, createdAt, updatedAt }) =>
      ({ name, stars, comment: comment || '', createdAt, updatedAt }));
    return json({ ...summarise(reviews), reviews: publicReviews, mine });
  }

  // ── Submit / update my review (one per account per path, editable) ──
  if (listMatch && request.method === 'POST') {
    const pathId = decodeURIComponent(listMatch[1]);
    const user = await getUserFromToken(env, request);
    if (!user) return fail('Connectez-vous pour laisser un avis.', 401);

    const path = await getPath(env, pathId);
    if (!path) return fail('Chemin introuvable.', 404);

    const body = await request.json().catch(() => ({}));
    const stars = Number(body.stars);
    if (!Number.isInteger(stars) || stars < 1 || stars > 5) {
      return fail('Note invalide (1 à 5 étoiles).', 400);
    }
    const comment = String(body.comment || '').slice(0, 1000).trim();

    const key = `pathreview:${pathId}:${user.id}`;
    const existingRaw = await env.BWR_KV.get(key);
    const existing = existingRaw ? JSON.parse(existingRaw) : null;
    const now = new Date().toISOString();
    const review = {
      pathId,
      userId: user.id,
      name: user.name || 'Anonyme',
      stars,
      comment,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    };
    await env.BWR_KV.put(key, JSON.stringify(review));

    const reviews = await listItems(env, `pathreview:${pathId}:`);
    return json({ ok: true, ...summarise(reviews), mine: { stars, comment } });
  }

  // ── Delete a review (author or admin) ──
  if (oneMatch && request.method === 'DELETE') {
    const pathId = decodeURIComponent(oneMatch[1]);
    const targetId = decodeURIComponent(oneMatch[2]);
    const user = await getUserFromToken(env, request);
    if (!user) return fail('Connexion requise.', 401);
    if (user.role !== 'admin' && user.id !== targetId) return fail('Accès refusé.', 403);

    await env.BWR_KV.delete(`pathreview:${pathId}:${targetId}`);
    const reviews = await listItems(env, `pathreview:${pathId}:`);
    return json({ ok: true, ...summarise(reviews) });
  }

  return null;
}
