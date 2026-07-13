import { listItems, listKeys, putUser, effectivePlan, patchLeaderboardCache, periodKeyFor } from '../kv.js';
import { getUserFromToken, checkRateLimit } from '../auth-utils.js';
const CLAUDE_MODEL = 'claude-haiku-4-5-20251001';
// Current Cloudflare Workers AI model (the free, primary AI engine). The previous
// '@cf/meta/llama-3.1-8b-instruct' was deprecated 2026-05-30; this FP8 8B variant is
// its direct successor — fast (~2-4 s) with JSON-mode support. (The 70B model is far
// smarter but takes ~50 s, which blows past the client's request timeout.)
const CF_AI_MODEL = '@cf/meta/llama-3.1-8b-instruct-fp8';

/**
 * Social and gamification endpoints: walked paths, leaderboard, push alerts,
 * and the daily-wheel AI tip.
 * @param {Request} request
 * @param {import('../kv.js').Env} env
 * @param {{ pathname: string, json: Function, fail: Function }} ctx
 * @returns {Promise<Response|null>}
 */
export async function handleSocial(request, env, { pathname, url, json, fail }) {
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
      await patchLeaderboardCache(env, walkedUser);
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
    const scope = url.searchParams.get('period') || 'all'; // 'all' | 'week' | 'month'
    const periodKey = periodKeyFor(scope);

    // ── Weekly / monthly board: built from the per-period xp:{period}:{userId} buckets ──
    if (periodKey) {
      const cacheKey = `leaderboard:cache:${scope}`;
      const cached = await env.BWR_KV.get(cacheKey);
      if (cached) return json(JSON.parse(cached));

      const bucketKeys = await listKeys(env, `xp:${periodKey}:`);
      const buckets = await Promise.all(bucketKeys.map(async k => {
        const raw = await env.BWR_KV.get(k.name);
        return raw ? { id: k.name.slice(`xp:${periodKey}:`.length), ...JSON.parse(raw) } : null;
      }));

      const entries = buckets
        .filter(b => b && b.name)
        .map(b => {
          const reports = b.reports || 0;
          const pathGrades = b.pathGrades || 0;
          return { id: b.id, name: b.name, reports, pathGrades, points: reports * 2 + pathGrades, forestCoverage: null };
        })
        .filter(e => e.points > 0)
        .sort((a, b) => b.points - a.points || b.reports - a.reports);

      await env.BWR_KV.put(cacheKey, JSON.stringify(entries), { expirationTtl: 300 });
      return json(entries);
    }

    // ── All-time board (default) ──
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

  // Push subscription endpoints (/api/push/*) now live in worker/handlers/push.js
  // — real Web Push replaced the earlier ntfy-channel stub.

  // ── AI tip — used by the daily-wheel "Conseil sentier" prize ──
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

    const prompt = `Tu es un guide de randonnée expert des forêts de l'Oise en France.
Génère UN conseil de randonnée personnalisé et motivant en français (1-2 phrases, 20-35 mots max).
Le conseil doit être concret, spécifique aux forêts de l'Oise (Compiègne, Chantilly, Halatte, Laigue…), et adapté à ce profil :
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
          model: CLAUDE_MODEL,
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

  // ── AI route planner — natural language → structured planner intent ──
  // The user types e.g. "une boucle de 23 km par les étangs Saint-Pierre" and we
  // return the planner controls (mode, distance, transport…) + a place name. The
  // client resolves the place to coordinates and drives the existing route engine.
  if (pathname === '/api/ai-plan' && request.method === 'POST') {
    const user = await getUserFromToken(env, request);
    if (!user) return fail('Non authentifié.', 401);

    const body = await request.json().catch(() => ({}));
    const text = String(body.text || '').slice(0, 300).trim();
    if (text.length < 3) return fail('Décris ta balade en quelques mots.', 400);

    if (!env.AI && !env.ANTHROPIC_API_KEY) return fail('Le planificateur IA est momentanément indisponible.', 503);

    // Quota: free → 2 / week, Silver & Gold → 20 / day (cost guard, effectively unlimited).
    const plan = effectivePlan(user);
    const [limit, window] = plan === 'free' ? [2, 604800] : [20, 86400];
    const allowed = await checkRateLimit(env, 'aiplan', user.id, limit, window);
    if (!allowed) {
      return fail(plan === 'free'
        ? 'Tu as utilisé tes 2 demandes IA gratuites. Passe à Argent ou Or pour des balades IA illimitées.'
        : 'Limite de demandes IA atteinte pour aujourd\'hui. Réessaie demain.', 429);
    }

    const prompt = `Tu es l'assistant de randonnée de BWR, une appli de balades dans la Forêt de Compiègne (Oise, France). Tu parles français de façon naturelle et chaleureuse, comme un guide local sympathique. L'utilisateur te décrit librement la balade qu'il a envie de faire — parfois précisément, souvent en quelques mots vagues — et tu remplis les réglages d'un planificateur de trajet.

Demande de l'utilisateur : "${text}"

Comprends l'INTENTION même quand c'est vague, familier ou incomplet. Ne demande JAMAIS à l'utilisateur de reformuler : déduis toujours une balade plausible avec des valeurs par défaut raisonnables, puis propose-la. Exemples : "envie de marcher un peu" → petite boucle facile à pied ; "un gros truc sportif en vélo" → grande boucle difficile en vélo ; "une rando peinarde cet aprèm" → boucle facile de longueur moyenne.

Règles de remplissage :
- understood : true si la demande concerne une balade/randonnée/sortie vélo (même très vague). false UNIQUEMENT si c'est totalement hors-sujet (météo, salutation, question sans rapport avec une balade).
- mode : "loop" (boucle, retour au départ) par défaut ; "atob" seulement si l'utilisateur indique clairement un départ ET une arrivée différents.
- distanceKm : la distance en km (1 à 100). Si non précisée, choisis une valeur par défaut sensée selon le ton : ~8 km pour une petite/tranquille, ~15 km pour une normale, ~30 km pour une grande/sportive.
- transport : "bike" si vélo/VTT/cyclisme, sinon "foot".
- pathType : "bike" pour vélo, "champs" pour champs/plaines, "mix" si mélange forêt+route, sinon "foot" (forestier).
- difficulty : "hard" si sportif/difficile/dénivelé, "medium" si modéré, sinon "easy".
- startPlace : le lieu de départ OU un lieu à traverser/"passer par" (ex : "les étangs Saint-Pierre", "carrefour de la Faisanderie", "Pierrefonds"). Omets si aucun lieu cité (le départ sera alors le centre de la forêt).
- endPlace : le lieu d'arrivée, uniquement en mode "atob". Omets sinon.
- summary : une phrase courte qui résume le trajet retenu (ex : "Boucle forestière facile de 8 km").
- reply : une réponse conversationnelle, courte et naturelle (1 phrase, comme un humain). Si understood=true, confirme avec entrain ce que tu prépares. Si understood=false, réponds gentiment et ramène la personne vers une balade (ex : "Je m'occupe surtout de tes balades en forêt ! Dis-moi plutôt la distance ou l'ambiance que tu cherches 🌲").

Réponds UNIQUEMENT avec un objet JSON valide (sans texte autour, sans balises Markdown) ayant exactement ces clés : understood (booléen), mode ("loop" ou "atob"), distanceKm (nombre 1-100, ou null), transport ("foot" ou "bike"), pathType ("foot"/"bike"/"champs"/"mix"), difficulty ("easy"/"medium"/"hard"), startPlace (texte ou null), endPlace (texte ou null), summary (texte), reply (texte).`;

    // Structured-output JSON schema for Cloudflare Workers AI (the free, primary engine).
    const jsonSchema = {
      type: 'object',
      properties: {
        understood: { type: 'boolean' },
        mode: { type: 'string' },
        distanceKm: { type: ['number', 'null'] },
        transport: { type: 'string' },
        pathType: { type: 'string' },
        difficulty: { type: 'string' },
        startPlace: { type: ['string', 'null'] },
        endPlace: { type: ['string', 'null'] },
        summary: { type: 'string' },
        reply: { type: 'string' },
      },
      required: ['understood', 'mode', 'transport', 'pathType', 'difficulty', 'summary', 'reply'],
    };

    // Parse a Workers AI result that may be an object or a JSON string (with stray prose).
    const coerce = (r) => {
      if (r && typeof r === 'object') return r;
      if (typeof r === 'string') {
        try { return JSON.parse(r); } catch { /* try to extract */ }
        const m = r.match(/\{[\s\S]*\}/);
        if (m) { try { return JSON.parse(m[0]); } catch { /* give up */ } }
      }
      return null;
    };

    try {
      let p = null;

      // 1. Cloudflare Workers AI — free, already bound, no external key needed.
      if (env.AI) {
        const messages = [
          { role: 'system', content: 'Tu remplis les réglages d\'un planificateur de balade en forêt. Réponds uniquement avec l\'objet JSON demandé, en français pour les textes.' },
          { role: 'user', content: prompt },
        ];
        // Attempt A: structured JSON output (json_schema).
        try {
          const cfRes = await env.AI.run(CF_AI_MODEL, {
            messages,
            response_format: { type: 'json_schema', json_schema: jsonSchema },
            max_tokens: 500,
          });
          p = coerce(cfRes.response);
        } catch (e) {
          console.error('ai-plan: structured Workers AI failed', String(e).slice(0, 200));
        }
        // Attempt B: plain completion, extract the JSON ourselves (model may not support json_schema).
        if (!p) {
          try {
            const cfRes = await env.AI.run(CF_AI_MODEL, { messages, max_tokens: 500 });
            p = coerce(cfRes.response);
          } catch (e) {
            console.error('ai-plan: plain Workers AI failed', String(e).slice(0, 200));
          }
        }
      }

      // 2. Fallback — Anthropic tool use, only if a key is configured.
      if ((!p || typeof p !== 'object') && env.ANTHROPIC_API_KEY) {
        const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': env.ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model: CLAUDE_MODEL,
            max_tokens: 400,
            tools: [{
              name: 'set_route_plan',
              description: 'Définit les réglages du planificateur de trajet à partir de la demande.',
              input_schema: {
                type: 'object',
                properties: {
                  understood: { type: 'boolean' },
                  mode: { type: 'string', enum: ['loop', 'atob'] },
                  distanceKm: { type: 'number' },
                  transport: { type: 'string', enum: ['foot', 'bike'] },
                  pathType: { type: 'string', enum: ['foot', 'bike', 'champs', 'mix'] },
                  difficulty: { type: 'string', enum: ['easy', 'medium', 'hard'] },
                  startPlace: { type: 'string' },
                  endPlace: { type: 'string' },
                  summary: { type: 'string' },
                  reply: { type: 'string' },
                },
                required: ['understood', 'mode', 'transport', 'pathType', 'difficulty', 'summary', 'reply'],
              },
            }],
            tool_choice: { type: 'tool', name: 'set_route_plan' },
            messages: [{ role: 'user', content: prompt }],
          }),
        });
        if (aiRes.ok) {
          const aiData = await aiRes.json();
          const toolUse = (aiData.content || []).find(c => c.type === 'tool_use');
          if (toolUse && toolUse.input) p = toolUse.input;
        } else {
          const errBody = await aiRes.text().catch(() => '');
          console.error('ai-plan: Anthropic API error', aiRes.status, errBody.slice(0, 300));
        }
      }

      if (!p || typeof p !== 'object') throw new Error('No AI output');

      const understood = p.understood !== false;
      const reply = p.reply ? String(p.reply).slice(0, 280) : null;
      const clean = {
        mode: p.mode === 'atob' ? 'atob' : 'loop',
        distanceKm: typeof p.distanceKm === 'number' ? Math.min(100, Math.max(1, p.distanceKm)) : null,
        transport: p.transport === 'bike' ? 'bike' : 'foot',
        pathType: ['foot', 'bike', 'champs', 'mix'].includes(p.pathType) ? p.pathType : 'foot',
        difficulty: ['easy', 'medium', 'hard'].includes(p.difficulty) ? p.difficulty : 'easy',
        startPlace: p.startPlace ? String(p.startPlace).slice(0, 120) : null,
        endPlace: p.endPlace ? String(p.endPlace).slice(0, 120) : null,
        summary: String(p.summary || 'Trajet personnalisé').slice(0, 200),
      };
      console.log('ai-plan ok', JSON.stringify({ text, understood, startPlace: clean.startPlace, endPlace: clean.endPlace, distanceKm: clean.distanceKm, mode: clean.mode }));
      return json({ plan: clean, understood, reply });
    } catch {
      return fail('Petit souci de mon côté, je n\'ai pas pu préparer ton trajet. Réessaie dans un instant 🙏', 502);
    }
  }

  return null;
}
