import { listItems, getPath, putReport, putUser, patchLeaderboardCache, addPeriodXp } from '../kv.js';
import { getUserFromToken } from '../auth-utils.js';
import { notifyHazard } from './push.js';

const TYPE_LABELS = {
  fallen_tree: 'Arbre tombé', flooded: 'Chemin inondé', muddy: 'Boueux',
  rutted: 'Ornières', broken_sign: 'Carrefour cassé', closed: 'Chemin fermé',
  danger: 'Danger', other: 'Autre',
};

// ── Edge cache for GET /api/reports ──────────────────────────────────────────
// Same pattern as GET /api/paths: the report list is identical for everyone and
// only changes on create/dismiss, yet building it costs one KV read per report
// on every map load. Cache the assembled (userId-stripped) JSON at Cloudflare's
// edge. `caches` is absent in the Node test runner and dev, so every use is
// guarded and simply no-ops there.
const REPORTS_CACHE_KEY = 'https://bwr-internal-cache/api/reports';
const REPORTS_CACHE_TTL = 60; // seconds; short so other colos self-heal (cache.delete only purges the local one)

const cacheAvailable = () => typeof caches !== 'undefined' && caches.default;

/** Best-effort purge of the cached report list after a write. */
async function purgeReportsCache() {
  if (!cacheAvailable()) return;
  try { await caches.default.delete(new Request(REPORTS_CACHE_KEY)); } catch {}
}

/**
 * Report and photo endpoints (crowd-sourced problem reporting).
 * @param {Request} request
 * @param {import('../kv.js').Env} env
 * @param {{ pathname: string, json: Function, fail: Function, cors: Object }} ctx
 * @returns {Promise<Response|null>}
 */
export async function handleReports(request, env, { pathname, json, fail, cors, waitUntil }) {
  if (pathname === '/api/reports' && request.method === 'GET') {
    const cache = cacheAvailable() ? caches.default : null;
    const cacheKey = cache ? new Request(REPORTS_CACHE_KEY) : null;

    if (cache) {
      const hit = await cache.match(cacheKey);
      if (hit) {
        const body = await hit.text();
        return new Response(body, {
          headers: { ...cors, 'Content-Type': 'application/json', 'X-Cache': 'HIT' },
        });
      }
    }

    const reports = await listItems(env, 'report:');
    const body = JSON.stringify(reports.map(({ userId: _, ...r }) => r));

    if (cache) {
      const store = new Response(body, {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${REPORTS_CACHE_TTL}` },
      });
      const put = cache.put(cacheKey, store);
      if (waitUntil) waitUntil(put); else await put.catch(() => {});
    }

    return new Response(body, {
      headers: { ...cors, 'Content-Type': 'application/json', 'X-Cache': cache ? 'MISS' : 'BYPASS' },
    });
  }

  if (pathname.startsWith('/api/photos/') && request.method === 'GET') {
    const reportId = pathname.split('/')[3];
    const dataUri = await env.BWR_KV.get(`photo:${reportId}`);
    if (!dataUri) return new Response('Not found', { status: 404, headers: cors });
    const [header, b64] = dataUri.split(',');
    const mime = header.match(/data:([^;]+)/)?.[1] || 'image/jpeg';
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    return new Response(bytes, {
      headers: { ...cors, 'Content-Type': mime, 'Cache-Control': 'public, max-age=2592000' },
    });
  }

  if (pathname === '/api/reports' && request.method === 'POST') {
    const reporter = await getUserFromToken(env, request);
    if (!reporter) return fail('Connexion requise.', 401);
    // Reporting a problem is free for every signed-in user (all tiers).

    const body = await request.json();

    let pathName = 'Chemin inconnu';
    if (body.pathId) {
      const found = await getPath(env, body.pathId);
      if (found) pathName = found.name || 'Chemin sans nom';
    }

    const isValidCoord = (v, min, max) => typeof v === 'number' && isFinite(v) && v >= min && v <= max;
    const lat = isValidCoord(body.lat, -90, 90) ? body.lat : null;
    const lon = isValidCoord(body.lon, -180, 180) ? body.lon : null;

    const report = {
      id: crypto.randomUUID(),
      userId: reporter.id,
      pathId: body.pathId || null,
      type: TYPE_LABELS[body.type] ? body.type : 'other',
      note: (body.note || '').slice(0, 300),
      hasPhoto: !!body.photo,
      lat,
      lon,
      date: new Date().toISOString(),
      status: 'open',
    };

    if (body.photo) {
      const MAX_PHOTO_BYTES = 1_048_576;
      if (body.photo.length > MAX_PHOTO_BYTES) {
        return new Response(JSON.stringify({ error: 'Photo trop volumineuse (max 1 Mo)' }), {
          status: 413,
          headers: { ...cors, 'Content-Type': 'application/json' },
        });
      }
      await env.BWR_KV.put(`photo:${report.id}`, body.photo, { expirationTtl: 7776000 });
    }

    await putReport(env, report);
    const rStats = reporter.stats || { routes: 0, km: 0 };
    const updatedReporter = { ...reporter, stats: { ...rStats, reports: (rStats.reports || 0) + 1 } };
    await putUser(env, updatedReporter);
    await patchLeaderboardCache(env, updatedReporter);
    await addPeriodXp(env, updatedReporter, { reports: 1 });

    try {
      await fetch('https://ntfy.sh/bwr-ciril8596', {
        method: 'POST',
        headers: { 'Title': 'BWR — Nouveau signalement', 'Tags': 'warning', 'Content-Type': 'text/plain; charset=utf-8' },
        body: `${TYPE_LABELS[report.type] || report.type} sur "${pathName}"${report.note ? '\n' + report.note : ''}`,
      });
    } catch {}

    // Web Push fan-out: alert Silver+ users whose saved route passes near this
    // hazard. Best-effort, off the response path, and only when push is
    // configured (VAPID secrets present) and the report is geolocated.
    if (report.lat != null && report.lon != null && env.VAPID_PRIVATE_KEY && waitUntil) {
      waitUntil(notifyHazard(env, report).catch(() => {}));
    }

    await purgeReportsCache();
    return json(report, 201);
  }

  if (pathname.startsWith('/api/reports/') && request.method === 'DELETE') {
    const user = await getUserFromToken(env, request);
    if (!user || user.role !== 'admin') return fail('Accès refusé.', 403);

    const id = pathname.split('/')[3];
    await Promise.all([
      env.BWR_KV.delete(`report:${id}`),
      env.BWR_KV.delete(`photo:${id}`),
    ]);
    await purgeReportsCache();
    return json({ success: true });
  }

  return null;
}
