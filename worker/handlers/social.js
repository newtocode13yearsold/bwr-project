import { listItems, listKeys, putUser, effectivePlan, patchLeaderboardCache } from '../kv.js';
import { getUserFromToken, checkRateLimit } from '../auth-utils.js';

/**
 * Social and gamification endpoints: walked paths, leaderboard, push alerts,
 * and AI suggestions/tips (lazy-imported on first call per request).
 * @param {Request} request
 * @param {import('../kv.js').Env} env
 * @param {{ pathname: string, json: Function, fail: Function }} ctx
 * @returns {Promise<Response|null>}
 */
export async function handleSocial(request, env, { pathname, json, fail }) {
  if (pathname === '/api/walkedpaths' && request.method === 'POST') {
    const user = await getUserFromToken(env, request);
    if (!user) return json({ error: 'Non authentifié' }, 401);

    const body = await request.json().catch(() => ({}));
    const pathIds = Array.isArray(body.pathIds) ? body.pathIds.slice(0, 200) : [];

    if (pathIds.length === 0) return json({ walkedPathsCount: user.stats?.walkedPathsCount || 0 });

    const checks = await Promise.all(
      pathIds.map(pid => env.BWR_KV.get(`walkedpath:${user.id}:${pid}`))
    );
    const newPaths = pathIds.filter((_, i) => !checks[i]);

    const now = new Date().toISOString();
    await Promise.all(pathIds.map(pid => env.BWR_KV.put(`walkedpath:${user.id}:${pid}`, now)));

    if (newPaths.length > 0) {
      const prev = user.stats?.walkedPathsCount || 0;
      const walkedUser = { ...user, stats: { ...(user.stats || {}), walkedPathsCount: prev + newPaths.length } };
      await putUser(env, walkedUser);
      patchLeaderboardCache(env, walkedUser);
    }

    return json({ walkedPathsCount: (user.stats?.walkedPathsCount || 0) + newPaths.length });
  }

  if (pathname === '/api/walkedpaths' && request.method === 'GET') {
    const user = await getUserFromToken(env, request);
    if (!user) return json({ error: 'Non authentifié' }, 401);

    const plan = effectivePlan(user);
    const walkedPathsCount = user.stats?.walkedPathsCount || 0;
    const pathKeyPage = await env.BWR_KV.list({ prefix: 'path:', limit: 1000 });
    const totalPaths = pathKeyPage.keys.length;
    const coverage = totalPaths > 0 ? Math.round(walkedPathsCount / totalPaths * 100) : 0;

    if (plan !== 'gold') {
      return json({ walkedPathIds: [], coverage, total: totalPaths });
    }

    const walkedKeys = await env.BWR_KV.list({ prefix: `walkedpath:${user.id}:`, limit: 1000 });
    const walkedPathIds = walkedKeys.keys.map(k => k.name.split(':').slice(2).join(':'));
    return json({ walkedPathIds, coverage, total: totalPaths });
  }

  if (pathname === '/api/leaderboard' && request.method === 'GET') {
    const cached = await env.BWR_KV.get('leaderboard:cache');
    if (cached) return json(JSON.parse(cached));

    const [allUsers, pathKeys] = await Promise.all([
      listItems(env, 'user:'),
      listKeys(env, 'path:'),
    ]);
    const totalPaths = pathKeys.length;

    const entries = allUsers
      .filter(u => u.id && u.name)
      .map(u => {
        const s = u.stats || {};
        const reports = s.reports || 0;
        const pathGrades = s.pathGrades || 0;
        const points = reports * 2 + pathGrades;
        const walkedPathsCount = s.walkedPathsCount || 0;
        const forestCoverage = totalPaths > 0 ? Math.round(walkedPathsCount / totalPaths * 100) : 0;
        return { id: u.id, name: u.name, reports, pathGrades, points, forestCoverage };
      })
      .sort((a, b) => b.points - a.points || b.reports - a.reports);

    await env.BWR_KV.put('leaderboard:cache', JSON.stringify(entries), { expirationTtl: 300 });
    return json(entries);
  }

  if (pathname === '/api/push/subscribe' && request.method === 'POST') {
    const user = await getUserFromToken(env, request);
    if (!user) return fail('Non authentifié.', 401);
    if (effectivePlan(user) !== 'gold') return fail('Les alertes push sont disponibles avec le plan Or.', 403);

    const channel = `bwr-u-${user.id.slice(0, 8)}`;
    await putUser(env, { ...user, alertsEnabled: true, alertsChannel: channel });
    return json({ channel });
  }

  if (pathname === '/api/push/unsubscribe' && request.method === 'POST') {
    const user = await getUserFromToken(env, request);
    if (!user) return fail('Non authentifié.', 401);

    await putUser(env, { ...user, alertsEnabled: false });
    return json({ success: true });
  }

  // ── AI endpoints — module lazy-imported to avoid loading on every request ──
  if (pathname === '/api/ai-suggestion' && request.method === 'GET') {
    const user = await getUserFromToken(env, request);
    if (!user) return fail('Non authentifié.', 401);
    const plan = effectivePlan(user);
    if (plan === 'free') return fail('Réservé aux membres Argent et Or.', 403);

    const today = new Date().toLocaleDateString('fr-CA', { timeZone: 'Europe/Paris' });
    const cacheKey = `aisugg:${user.id}:${today}`;
    const cached = await env.BWR_KV.get(cacheKey);
    if (cached) return json(JSON.parse(cached));

    const { generateAISuggestionForUser } = await import('../ai.js');
    const suggestion = await generateAISuggestionForUser(env, user, today);
    await env.BWR_KV.put(cacheKey, JSON.stringify(suggestion), { expirationTtl: 172800 });
    return json(suggestion);
  }

  if (pathname === '/api/ai-tip' && request.method === 'POST') {
    const user = await getUserFromToken(env, request);
    if (!user) return fail('Non authentifié.', 401);

    if (!env.ANTHROPIC_API_KEY) {
      const fallbacks = [
        'Essaye un nouveau sentier aujourd\'hui pour varier les plaisirs !',
        'Observe la faune au lever du jour — la forêt s\'éveille doucement.',
        'Une sortie en boucle est parfaite pour se ressourcer.',
      ];
      return json({ tip: fallbacks[Math.floor(Math.random() * fallbacks.length)] });
    }

    const allowed = await checkRateLimit(env, 'aitip', user.id, 5, 86400);
    if (!allowed) return fail('Limite de conseils atteinte pour aujourd\'hui.', 429);

    const stats = user.stats || {};
    const km = (stats.km || 0).toFixed(1);
    const routes = stats.routes || 0;
    const month = new Date().getMonth();
    const season = month <= 1 || month === 11 ? 'hiver' : month <= 4 ? 'printemps' : month <= 7 ? 'été' : 'automne';
    const plan = effectivePlan(user);
    const level = plan === 'gold' ? 'expert' : plan === 'silver' ? 'intermédiaire' : 'débutant';

    const prompt = `Tu es un guide de randonnée expert de la Forêt de Compiègne en France.
Génère UN conseil de randonnée personnalisé et motivant en français (1-2 phrases, 20-35 mots max).
Le conseil doit être concret, spécifique à la forêt de Compiègne, et adapté à ce profil :
- Kilomètres parcourus au total : ${km} km
- Nombre de sorties effectuées : ${routes}
- Saison actuelle : ${season}
- Niveau du randonneur : ${level}
Réponds uniquement avec le texte du conseil, sans guillemets ni explication.`;

    try {
      const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 120,
          messages: [{ role: 'user', content: prompt }],
        }),
      });
      if (!aiRes.ok) throw new Error('AI error');
      const aiData = await aiRes.json();
      const tip = aiData.content?.[0]?.text?.trim() || 'Profite de la forêt aujourd\'hui !';
      return json({ tip });
    } catch {
      return json({ tip: 'La forêt t\'attend — sors et découvre un nouveau sentier !' });
    }
  }

  return null;
}
