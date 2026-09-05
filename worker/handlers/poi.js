import { listItems, effectivePlan } from '../kv.js';
import { getUserFromToken } from '../auth-utils.js';

// Points of interest: the practical map furniture hikers ask for most — parking,
// water points, picnic spots, viewpoints, toilets. Reading is public (the layer
// loads for everyone, signed-in or not). Adding a POI is a curation action, so
// it's gated to Silver+/admin, exactly like drawing a path; editing/deleting is
// author-or-admin.
//
// KV keys:
//   poi:{id} → JSON { id, type, name, lat, lon, note, createdBy, createdByName,
//                     createdAt, updatedAt }

// The supported POI kinds. Keep in sync with POI_TYPES in public/js/map-poi.js.
const POI_TYPES = new Set(['parking', 'water', 'picnic', 'viewpoint', 'toilet']);

// ── Edge cache for GET /api/pois ─────────────────────────────────────────────
// Same pattern as GET /api/paths and /api/reports: the list is identical for
// everyone and only changes on a write, yet costs one KV read per POI on every
// map load. `caches` is absent in the Node test runner / dev, so every use is
// guarded and simply no-ops there.
const POIS_CACHE_KEY = 'https://bwr-internal-cache/api/pois';
const POIS_CACHE_TTL = 60; // seconds; short so other colos self-heal after a write

const cacheAvailable = () => typeof caches !== 'undefined' && caches.default;

/** Best-effort purge of the cached POI list after a write. */
async function purgePoisCache() {
  if (!cacheAvailable()) return;
  try { await caches.default.delete(new Request(POIS_CACHE_KEY)); } catch {}
}

const isValidCoord = (v, min, max) => typeof v === 'number' && isFinite(v) && v >= min && v <= max;

/**
 * Points-of-interest endpoints.
 * @param {Request} request
 * @param {import('../kv.js').Env} env
 * @param {{ pathname: string, json: Function, fail: Function, cors: Object, waitUntil: Function }} ctx
 * @returns {Promise<Response|null>}
 */
export async function handlePoi(request, env, { pathname, json, fail, cors, waitUntil }) {
  // ── Public list ──
  if (pathname === '/api/pois' && request.method === 'GET') {
    const cache = cacheAvailable() ? caches.default : null;
    const cacheKey = cache ? new Request(POIS_CACHE_KEY) : null;

    if (cache) {
      const hit = await cache.match(cacheKey);
      if (hit) {
        const body = await hit.text();
        return new Response(body, {
          headers: { ...cors, 'Content-Type': 'application/json', 'X-Cache': 'HIT' },
        });
      }
    }

    const pois = await listItems(env, 'poi:');
    // Strip nothing sensitive (createdBy is a UUID, kept so the client can show
    // edit/delete controls to the author) — but sort newest-first for stability.
    pois.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
    const body = JSON.stringify(pois);

    if (cache) {
      const store = new Response(body, {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${POIS_CACHE_TTL}` },
      });
      const put = cache.put(cacheKey, store);
      if (waitUntil) waitUntil(put); else await put.catch(() => {});
    }

    return new Response(body, {
      headers: { ...cors, 'Content-Type': 'application/json', 'X-Cache': cache ? 'MISS' : 'BYPASS' },
    });
  }

  // ── Create (Silver+/admin) ──
  if (pathname === '/api/pois' && request.method === 'POST') {
    const user = await getUserFromToken(env, request);
    if (!user) return fail('Connexion requise.', 401);
    const plan = effectivePlan(user);
    if (plan !== 'gold' && plan !== 'silver') return fail('Abonnement Argent requis.', 403);

    const body = await request.json().catch(() => ({}));
    if (!POI_TYPES.has(body.type)) return fail('Type de point invalide.', 400);
    if (!isValidCoord(body.lat, -90, 90) || !isValidCoord(body.lon, -180, 180)) {
      return fail('Coordonnées invalides.', 400);
    }

    const now = new Date().toISOString();
    const poi = {
      id: crypto.randomUUID(),
      type: body.type,
      name: String(body.name || '').slice(0, 120).trim(),
      lat: body.lat,
      lon: body.lon,
      note: String(body.note || '').slice(0, 500).trim(),
      createdBy: user.id,
      createdByName: user.name || 'Anonyme',
      createdAt: now,
      updatedAt: now,
    };
    await env.BWR_KV.put(`poi:${poi.id}`, JSON.stringify(poi));
    await purgePoisCache();
    return json(poi, 201);
  }

  // ── Edit (author or admin) ──
  if (pathname.startsWith('/api/pois/') && request.method === 'PUT') {
    const id = decodeURIComponent(pathname.slice('/api/pois/'.length));
    const user = await getUserFromToken(env, request);
    if (!user) return fail('Connexion requise.', 401);

    const raw = await env.BWR_KV.get(`poi:${id}`);
    if (!raw) return fail('Point introuvable.', 404);
    const existing = JSON.parse(raw);
    if (user.role !== 'admin' && existing.createdBy !== user.id) return fail('Accès refusé.', 403);

    const body = await request.json().catch(() => ({}));
    const updated = { ...existing };
    if (body.type !== undefined) {
      if (!POI_TYPES.has(body.type)) return fail('Type de point invalide.', 400);
      updated.type = body.type;
    }
    if (body.name !== undefined) updated.name = String(body.name || '').slice(0, 120).trim();
    if (body.note !== undefined) updated.note = String(body.note || '').slice(0, 500).trim();
    if (body.lat !== undefined || body.lon !== undefined) {
      const lat = body.lat !== undefined ? body.lat : existing.lat;
      const lon = body.lon !== undefined ? body.lon : existing.lon;
      if (!isValidCoord(lat, -90, 90) || !isValidCoord(lon, -180, 180)) {
        return fail('Coordonnées invalides.', 400);
      }
      updated.lat = lat; updated.lon = lon;
    }
    updated.updatedAt = new Date().toISOString();
    await env.BWR_KV.put(`poi:${id}`, JSON.stringify(updated));
    await purgePoisCache();
    return json(updated);
  }

  // ── Delete (author or admin) ──
  if (pathname.startsWith('/api/pois/') && request.method === 'DELETE') {
    const id = decodeURIComponent(pathname.slice('/api/pois/'.length));
    const user = await getUserFromToken(env, request);
    if (!user) return fail('Connexion requise.', 401);

    const raw = await env.BWR_KV.get(`poi:${id}`);
    if (!raw) return fail('Point introuvable.', 404);
    const existing = JSON.parse(raw);
    if (user.role !== 'admin' && existing.createdBy !== user.id) return fail('Accès refusé.', 403);

    await env.BWR_KV.delete(`poi:${id}`);
    await purgePoisCache();
    return json({ ok: true });
  }

  return null;
}
