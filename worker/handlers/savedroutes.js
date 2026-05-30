import { listItems, effectivePlan } from '../kv.js';
import { getUserFromToken } from '../auth-utils.js';

/**
 * Saved routes endpoints (Silver+ feature): save, list, get, delete, share.
 * @param {Request} request
 * @param {import('../kv.js').Env} env
 * @param {{ pathname: string, json: Function, fail: Function }} ctx
 * @returns {Promise<Response|null>}
 */
export async function handleSavedRoutes(request, env, { pathname, json, fail }) {
  if (pathname === '/api/savedroutes' && request.method === 'POST') {
    const user = await getUserFromToken(env, request);
    if (!user) return fail('Non authentifié.', 401);
    if (effectivePlan(user) === 'free') return fail('Abonnement Argent requis pour sauvegarder des trajets.', 403);

    const body = await request.json();
    if (!Array.isArray(body.coords) || body.coords.length < 2) return fail('Coordonnées invalides.');

    const id = crypto.randomUUID();
    const shareToken = crypto.randomUUID().replace(/-/g, '').slice(0, 16);

    const route = {
      id,
      userId: user.id,
      name: (body.name || 'Trajet sans nom').slice(0, 80),
      coords: body.coords,
      meters: Math.round(body.meters) || 0,
      seconds: Math.round(body.seconds) || 0,
      difficulty: body.difficulty || 'easy',
      pathType: body.pathType || 'foot',
      mode: body.mode || 'atob',
      shareToken,
      savedAt: new Date().toISOString(),
    };

    await Promise.all([
      env.BWR_KV.put(`savedroute:${user.id}:${id}`, JSON.stringify(route)),
      env.BWR_KV.put(`routeshare:${shareToken}`, JSON.stringify({ userId: user.id, routeId: id }), { expirationTtl: 15552000 }),
    ]);

    return json({ id, shareToken }, 201);
  }

  if (pathname === '/api/savedroutes' && request.method === 'GET') {
    const user = await getUserFromToken(env, request);
    if (!user) return fail('Non authentifié.', 401);
    if (effectivePlan(user) === 'free') return fail('Abonnement Argent requis.', 403);

    const routes = await listItems(env, `savedroute:${user.id}:`);
    routes.sort((a, b) => (b.savedAt || '').localeCompare(a.savedAt || ''));
    const summary = routes.map(({ coords: _c, ...rest }) => rest);
    return json(summary);
  }

  if (pathname.startsWith('/api/savedroutes/share/') && request.method === 'GET') {
    const token = pathname.split('/')[4];
    if (!token) return fail('Token manquant.', 400);

    const refRaw = await env.BWR_KV.get(`routeshare:${token}`);
    if (!refRaw) return fail('Lien invalide ou expiré.', 404);

    const { userId, routeId } = JSON.parse(refRaw);
    const routeRaw = await env.BWR_KV.get(`savedroute:${userId}:${routeId}`);
    if (!routeRaw) return fail('Trajet introuvable.', 404);

    const route = JSON.parse(routeRaw);
    const { userId: _uid, ...publicRoute } = route;
    return json(publicRoute);
  }

  if (pathname.startsWith('/api/savedroutes/') && request.method === 'GET') {
    const user = await getUserFromToken(env, request);
    if (!user) return fail('Non authentifié.', 401);

    const id = pathname.split('/')[3];
    const raw = await env.BWR_KV.get(`savedroute:${user.id}:${id}`);
    if (!raw) return fail('Trajet introuvable.', 404);
    return json(JSON.parse(raw));
  }

  if (pathname.startsWith('/api/savedroutes/') && request.method === 'DELETE') {
    const user = await getUserFromToken(env, request);
    if (!user) return fail('Non authentifié.', 401);

    const id = pathname.split('/')[3];
    const raw = await env.BWR_KV.get(`savedroute:${user.id}:${id}`);
    if (!raw) return fail('Trajet introuvable.', 404);

    const route = JSON.parse(raw);
    await Promise.all([
      env.BWR_KV.delete(`savedroute:${user.id}:${id}`),
      env.BWR_KV.delete(`routeshare:${route.shareToken}`),
    ]);
    return json({ success: true });
  }

  return null;
}
