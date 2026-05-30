import { listItems, getPath, putReport, putUser, effectivePlan, patchLeaderboardCache } from '../kv.js';
import { getUserFromToken } from '../auth-utils.js';

const TYPE_LABELS = {
  fallen_tree: 'Arbre tombé', flooded: 'Chemin inondé', muddy: 'Boueux',
  rutted: 'Ornières', broken_sign: 'Carrefour cassé', closed: 'Chemin fermé',
  danger: 'Danger', other: 'Autre',
};

/**
 * Report and photo endpoints (crowd-sourced problem reporting).
 * @param {Request} request
 * @param {import('../kv.js').Env} env
 * @param {{ pathname: string, json: Function, fail: Function, cors: Object }} ctx
 * @returns {Promise<Response|null>}
 */
export async function handleReports(request, env, { pathname, json, fail, cors }) {
  if (pathname === '/api/reports' && request.method === 'GET') {
    return json(await listItems(env, 'report:'));
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
    if (effectivePlan(reporter) === 'free') return fail('Abonnement Argent requis pour signaler un problème.', 403);

    const body = await request.json();

    let pathName = 'Chemin inconnu';
    if (body.pathId) {
      const found = await getPath(env, body.pathId);
      if (found) pathName = found.name || 'Chemin sans nom';
    }

    const report = {
      id: crypto.randomUUID(),
      userId: reporter.id,
      pathId: body.pathId || null,
      type: body.type || 'other',
      note: (body.note || '').slice(0, 300),
      hasPhoto: !!body.photo,
      lat: body.lat || null,
      lon: body.lon || null,
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
    patchLeaderboardCache(env, updatedReporter);

    try {
      await fetch('https://ntfy.sh/bwr-ciril8596', {
        method: 'POST',
        headers: { 'Title': 'BWR — Nouveau signalement', 'Tags': 'warning', 'Content-Type': 'text/plain; charset=utf-8' },
        body: `${TYPE_LABELS[report.type] || report.type} sur "${pathName}"${report.note ? '\n' + report.note : ''}`,
      });
    } catch {}

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
    return json({ success: true });
  }

  return null;
}
