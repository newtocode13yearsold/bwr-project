import { listItems, listKeys, putUser, getUser } from '../kv.js';
import { getUserFromToken, hashPassword } from '../auth-utils.js';

/**
 * Admin-only endpoints: one-time setup/migration, user list, contact messages.
 * @param {Request} request
 * @param {import('../kv.js').Env} env
 * @param {{ pathname: string, json: Function, fail: Function }} ctx
 * @returns {Promise<Response|null>}
 */
export async function handleAdmin(request, env, { pathname, json, fail }) {
  if (pathname === '/api/migrate' && request.method === 'POST') {
    const admin = await getUserFromToken(env, request);
    if (!admin || admin.role !== 'admin') return fail('Accès refusé.', 403);

    const results = { users: 0, paths: 0, reports: 0, contacts: 0 };

    const usersRaw = await env.BWR_KV.get('users');
    if (usersRaw) {
      const users = JSON.parse(usersRaw);
      await Promise.all(users.map(u => Promise.all([
        env.BWR_KV.put(`user:${u.id}`, JSON.stringify(u)),
        env.BWR_KV.put(`uemail:${u.email.toLowerCase()}`, u.id),
      ])));
      results.users = users.length;
    }

    const pathsRaw = await env.BWR_KV.get('paths');
    if (pathsRaw) {
      const paths = JSON.parse(pathsRaw);
      await Promise.all(paths.map(p => env.BWR_KV.put(`path:${p.id}`, JSON.stringify(p))));
      results.paths = paths.length;
    }

    const reportsRaw = await env.BWR_KV.get('reports');
    if (reportsRaw) {
      const reports = JSON.parse(reportsRaw);
      await Promise.all(reports.map(r => env.BWR_KV.put(`report:${r.id}`, JSON.stringify(r))));
      results.reports = reports.length;
    }

    const contactRaw = await env.BWR_KV.get('contact_messages');
    if (contactRaw) {
      const contacts = JSON.parse(contactRaw);
      await Promise.all(contacts.map(c => env.BWR_KV.put(`contact:${c.id}`, JSON.stringify(c))));
      results.contacts = contacts.length;
    }

    return json({ success: true, migrated: results });
  }

  if (pathname === '/api/migrate/reset-km' && request.method === 'POST') {
    const admin = await getUserFromToken(env, request);
    if (!admin || admin.role !== 'admin') return fail('Accès refusé.', 403);

    const users = await listItems(env, 'user:');
    await Promise.all(users.map(u => {
      const updated = {
        ...u,
        stats: {
          ...(u.stats || {}),
          km: 0,
          dailyLog: {},
          longestRoute: 0,
        },
      };
      return putUser(env, updated);
    }));

    return json({ success: true, usersReset: users.length });
  }

  if (pathname === '/api/setup' && request.method === 'POST') {
    const existing = await env.BWR_KV.list({ prefix: 'user:', limit: 1 });
    if (!existing.list_complete || existing.keys.length > 0) return fail('Setup already completed.', 403);

    const body = await request.json();
    if (!body.password) return fail('Password required.');

    const salt = crypto.randomUUID();
    const passwordHash = await hashPassword(body.password, salt);

    const adminName = env.ADMIN_NAME;
    const adminEmail = env.ADMIN_EMAIL;
    if (!adminName || !adminEmail) return fail('ADMIN_NAME and ADMIN_EMAIL env vars must be set.');

    const admin = {
      id: crypto.randomUUID(),
      name: adminName,
      email: adminEmail,
      passwordHash,
      salt,
      hashVersion: 2,
      role: 'admin',
      createdAt: new Date().toISOString(),
    };

    await Promise.all([
      putUser(env, admin),
      env.BWR_KV.put(`uemail:${admin.email}`, admin.id),
    ]);
    return json({ message: 'Admin created successfully' }, 201);
  }

  if (pathname === '/api/users' && request.method === 'GET') {
    const admin = await getUserFromToken(env, request);
    if (!admin || admin.role !== 'admin') return fail('Accès refusé.', 403);

    const allUsers = await listItems(env, 'user:');
    const safe = allUsers.map(u => ({
      id: u.id, name: u.name, email: u.email, role: u.role,
      plan: u.plan || 'free',
      planExpiresAt: u.planExpiresAt || null,
      planBase: u.planBase || null,
      createdAt: u.createdAt || null,
    }));
    return json(safe);
  }

  if (pathname.startsWith('/api/users/') && request.method === 'DELETE') {
    const admin = await getUserFromToken(env, request);
    if (!admin || admin.role !== 'admin') return fail('Accès refusé.', 403);
    const targetId = pathname.split('/')[3];
    const target = await getUser(env, targetId);
    if (!target) return fail('Utilisateur introuvable.', 404);
    if (target.role === 'admin') return fail('Impossible de supprimer un compte admin.', 403);
    const deletions = [
      env.BWR_KV.delete(`user:${targetId}`),
      env.BWR_KV.delete(`uemail:${target.email.toLowerCase()}`),
    ];
    const routeKeys  = await listKeys(env, `savedroute:${targetId}:`);
    const walkedKeys = await listKeys(env, `walkedpath:${targetId}:`);
    const aiKeys     = await listKeys(env, `aisugg:${targetId}:`);
    [...routeKeys, ...walkedKeys, ...aiKeys].forEach(k => deletions.push(env.BWR_KV.delete(k.name)));
    deletions.push(env.BWR_KV.delete('leaderboard:cache'));
    await Promise.all(deletions);
    return json({ success: true });
  }

  if (pathname === '/api/contacts' && request.method === 'GET') {
    const admin = await getUserFromToken(env, request);
    if (!admin || admin.role !== 'admin') return fail('Accès refusé.', 403);
    const messages = await listItems(env, 'contact:');
    messages.sort((a, b) => new Date(b.date) - new Date(a.date));
    return json(messages);
  }

  if (pathname.startsWith('/api/contacts/') && request.method === 'DELETE') {
    const admin = await getUserFromToken(env, request);
    if (!admin || admin.role !== 'admin') return fail('Accès refusé.', 403);
    const id = pathname.split('/')[3];
    await env.BWR_KV.delete(`contact:${id}`);
    return json({ success: true });
  }

  // ── Visit analytics ──────────────────────────────────────────────────────────
  if (pathname === '/api/analytics/visit' && request.method === 'POST') {
    // Public endpoint – no auth required (fire-and-forget from every page)
    try {
      const body = await request.json().catch(() => ({}));
      const user = await getUserFromToken(env, request).catch(() => null);
      // Never record admin visits
      if (user && user.role === 'admin') return json({ ok: true });

      const ip   = request.headers.get('CF-Connecting-IP') || 'unknown';
      const page = typeof body.page === 'string' ? body.page.slice(0, 200) : '/';
      const ts   = Date.now();

      // Rate-limit by visitorId: 1 visit per device per page per 30 min
      const rawVisitorIdEarly = typeof body.visitorId === 'string' ? body.visitorId.slice(0, 36) : null;
      if (rawVisitorIdEarly) {
        const deviceKey = `ratelimit:device:${rawVisitorIdEarly}:${page.replace(/\W/g, '_')}`;
        const lastTs = await env.BWR_KV.get(deviceKey);
        if (lastTs && ts - parseInt(lastTs, 10) < 30 * 60 * 1000) return json({ ok: true });
        await env.BWR_KV.put(deviceKey, String(ts), { expirationTtl: 3600 }); // 1h TTL
      }
      // Rate-limit by IP: max 1 visit per IP per page per hour (fallback for no-visitorId clients)
      const hourSlot    = Math.floor(ts / 3600000);
      const rateLimitKey = `ratelimit:visit:${ip}:${page.replace(/\W/g, '_')}:${hourSlot}`;
      const countRaw    = await env.BWR_KV.get(rateLimitKey);
      const count       = countRaw ? parseInt(countRaw, 10) : 0;
      if (count >= 1) return json({ ok: true }); // silently drop excess
      await env.BWR_KV.put(rateLimitKey, String(count + 1), { expirationTtl: 7200 }); // 2h TTL

      // Assign a sequential visitor number for anonymous devices (persists forever)
      let visitorNum = null;
      const rawVisitorId = rawVisitorIdEarly;
      if (!user && rawVisitorId) {
        const numKey = `visitor:num:${rawVisitorId}`;
        const existing = await env.BWR_KV.get(numKey);
        if (existing) {
          visitorNum = parseInt(existing, 10);
        } else {
          const totalVisitorsRaw = await env.BWR_KV.get('analytics:visitor_count');
          visitorNum = (totalVisitorsRaw ? parseInt(totalVisitorsRaw, 10) : 0) + 1;
          await env.BWR_KV.put('analytics:visitor_count', String(visitorNum));
          await env.BWR_KV.put(numKey, String(visitorNum)); // permanent — no TTL
        }
      }

      // Increment permanent total-visit counter (never expires)
      const totalRaw = await env.BWR_KV.get('analytics:total_visits');
      await env.BWR_KV.put('analytics:total_visits', String((totalRaw ? parseInt(totalRaw, 10) : 0) + 1));

      const id    = crypto.randomUUID();
      const visit = {
        id,
        timestamp: new Date(ts).toISOString(),
        page,
        userId:     user ? user.id   : null,
        userName:   user ? user.name : null,
        visitorId:  rawVisitorId,
        visitorNum,
        userAgent: (request.headers.get('User-Agent') || '').slice(0, 300),
        ip,
      };
      const key = `visit:${String(ts).padStart(13, '0')}:${id}`;
      await env.BWR_KV.put(key, JSON.stringify(visit), { expirationTtl: 60 * 60 * 24 * 30 });
      return json({ ok: true });
    } catch {
      return json({ ok: false });
    }
  }

  /* ── AI Revenue Forecast — calls Claude with the forecast data ──────── */
  if (pathname === '/api/ai/revenue-forecast' && request.method === 'POST') {
    const admin = await getUserFromToken(env, request);
    if (!admin || admin.role !== 'admin') return fail('Accès refusé.', 403);

    let body;
    try { body = await request.json(); } catch { return fail('JSON invalide.'); }

    const { visitors = 0, rate = 0, mrr = 0, arr = 0,
            subs = 0, slope = 0, target = 200, prob = 0, history = [],
            silver = 0, gold = 0, totalUsers = 0, realConv = 0 } = body;

    const histStr = history.filter(v => v !== null).length > 0
      ? history.map((v, i) => v !== null ? `M-${4 - i}: ${v} vis.` : null).filter(Boolean).join(', ')
      : 'Aucun historique fourni';

    const trendStr = slope > 0 ? `+${Math.round(slope)} vis./mois (croissance)` :
                     slope < 0 ? `${Math.round(slope)} vis./mois (déclin)` : 'Stable';

    const ARPU = 0.65 * 4.99 + 0.35 * 6.99; // ~5.69€
    const pot1 = Math.round(visitors * 0.01 * ARPU);
    const pot2 = Math.round(visitors * 0.02 * ARPU);
    const pot3 = Math.round(visitors * 0.03 * ARPU);

    const prompt = `Tu es un expert en croissance SaaS et monétisation d'applications web françaises.

Analyse ces données de prévision de revenus pour BWR — une application de randonnée en forêt de Compiègne (France) avec deux plans payants : Argent (4,99 €/mois) et Or (6,99 €/mois).

Données réelles (tirées du tableau de bord admin) :
- Visiteurs ce mois : ${Math.round(visitors)}
- Historique trafic : ${histStr}
- Tendance trafic : ${trendStr}
- Membres total : ${totalUsers} (dont ${Math.round(totalUsers - silver - gold)} gratuits, ${silver} Argent, ${gold} Or)
- Abonnés payants actuels : ${Math.round(subs)} (${Number(realConv > 0 ? realConv : rate).toFixed(2)} % de conversion)
- MRR réel : ${Number(mrr).toFixed(2)} €/mois
- ARR annualisé : ${Math.round(arr)} €/an
- Potentiel des visiteurs actuels : à 1 % de conversion → ${pot1} €/mois, à 2 % → ${pot2} €/mois, à 3 % → ${pot3} €/mois
- Objectif MRR visé : ${target} €
- Probabilité d'atteindre l'objectif : ${prob} %

Donne une analyse directe en 3-4 phrases, en français, qui couvre :
1. Ce que les ${Math.round(visitors)} visiteurs représentent comme potentiel de revenus réaliste
2. Le levier le plus impactant pour convertir ces visiteurs en abonnés payants maintenant
3. Un objectif chiffré atteignable à 3 mois compte tenu du trafic actuel

Sois concis et actionnable. Pas d'intro comme "Bien sûr" ou "Voici mon analyse".`;

    /* Try Cloudflare Workers AI first (free), fall back to Anthropic if key set */
    try {
      let analysis = '';

      if (env.AI) {
        const cfRes = await env.AI.run('@cf/meta/llama-3.1-8b-instruct', {
          messages: [
            { role: 'system', content: 'Tu es un expert SaaS. Réponds uniquement en français, de façon concise et directe.' },
            { role: 'user', content: prompt },
          ],
          max_tokens: 350,
        });
        analysis = cfRes.response?.trim() || '';
      }

      if (!analysis && env.ANTHROPIC_API_KEY) {
        const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': env.ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 300,
            messages: [{ role: 'user', content: prompt }],
          }),
        });
        if (aiRes.ok) {
          const d = await aiRes.json();
          analysis = d.content?.[0]?.text?.trim() || '';
        }
      }

      if (!analysis) return fail('Aucun modèle IA disponible. Déployez le worker avec la liaison AI activée.', 503);
      return json({ analysis });
    } catch (e) {
      return fail('Erreur lors de l\'appel à l\'IA : ' + (e?.message || e), 502);
    }
  }

  // ── Debug diagnostic (admin only) ───────────────────────────────────────────
  if (pathname === '/api/debug' && request.method === 'GET') {
    const admin = await getUserFromToken(env, request);
    if (!admin || admin.role !== 'admin') return fail('Accès refusé.', 403);

    const prefixes = ['user:', 'uemail:', 'session:', 'path:', 'report:', 'contact:',
                      'visit:', 'savedroute:', 'routeshare:', 'osm:', 'pending:', 'pemail:',
                      'photo:', 'aisugg:', 'walkedpath:', 'pathgrade:', 'leaderboard:'];

    const counts = {};
    let totalKeys = 0;
    for (const prefix of prefixes) {
      const keys = await listKeys(env, prefix);
      counts[prefix] = keys.length;
      totalKeys += keys.length;
    }

    // Sample last 3 visit keys for integrity check
    const visitKeys = await listKeys(env, 'visit:');
    const sampleVisits = [];
    for (const k of visitKeys.slice(-3).reverse()) {
      const raw = await env.BWR_KV.get(k.name);
      if (raw) {
        const v = JSON.parse(raw);
        sampleVisits.push({ key: k.name, page: v.page, timestamp: v.timestamp, userId: v.userId ?? null });
      }
    }

    // Detect duplicate visits (same timestamp minute + same page → likely test data)
    const minuteBuckets = {};
    for (const k of visitKeys) {
      const raw = await env.BWR_KV.get(k.name).catch(() => null);
      if (!raw) continue;
      const v = JSON.parse(raw);
      const bucket = v.timestamp?.slice(0, 16) + '|' + (v.page || '/');
      minuteBuckets[bucket] = (minuteBuckets[bucket] || 0) + 1;
    }
    const suspiciousBuckets = Object.entries(minuteBuckets)
      .filter(([, n]) => n > 10)
      .map(([bucket, n]) => ({ bucket, count: n }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);

    return json({
      ok: true,
      totalKeys,
      counts,
      visitSample: sampleVisits,
      suspiciousBuckets,
      workerVersion: '2.0',
      timestamp: new Date().toISOString(),
    });
  }

  // ── Cleanup duplicate visits (admin only) ───────────────────────────────────
  if (pathname === '/api/debug/cleanup-visits' && request.method === 'POST') {
    const admin = await getUserFromToken(env, request);
    if (!admin || admin.role !== 'admin') return fail('Accès refusé.', 403);

    const allKeys = await listKeys(env, 'visit:');
    // Group keys by minute+page bucket
    const buckets = {}; // bucket -> [{ key, ts }]
    for (const k of allKeys) {
      const raw = await env.BWR_KV.get(k.name).catch(() => null);
      if (!raw) continue;
      const v = JSON.parse(raw);
      const bucket = (v.timestamp?.slice(0, 16) ?? '') + '|' + (v.page || '/');
      if (!buckets[bucket]) buckets[bucket] = [];
      buckets[bucket].push({ key: k.name, ts: v.timestamp });
    }
    // Delete all keys in buckets with more than 5 identical entries (keep 0 — all fake)
    const keysToDelete = [];
    for (const entries of Object.values(buckets)) {
      if (entries.length > 5) keysToDelete.push(...entries.map(e => e.key));
    }
    await Promise.all(keysToDelete.map(k => env.BWR_KV.delete(k)));
    return json({ ok: true, deleted: keysToDelete.length, totalBefore: allKeys.length });
  }

  // ── Reset all analytics data (admin only) ────────────────────────────────────
  if (pathname === '/api/analytics/reset' && request.method === 'POST') {
    const admin = await getUserFromToken(env, request);
    if (!admin || admin.role !== 'admin') return fail('Accès refusé.', 403);

    const prefixes = ['visit:', 'ratelimit:visit:', 'ratelimit:device:', 'visitor:num:'];
    let deleted = 0;
    for (const prefix of prefixes) {
      const keys = await listKeys(env, prefix);
      await Promise.all(keys.map(k => env.BWR_KV.delete(k.name)));
      deleted += keys.length;
    }
    await env.BWR_KV.put('analytics:total_visits', '0');
    await env.BWR_KV.put('analytics:visitor_count', '0');
    return json({ ok: true, deleted });
  }

  if (pathname === '/api/analytics/visits' && request.method === 'GET') {
    const admin = await getUserFromToken(env, request);
    if (!admin || admin.role !== 'admin') return fail('Accès refusé.', 403);
    const [allKeys, totalRaw, visitorCountRaw] = await Promise.all([
      listKeys(env, 'visit:'),
      env.BWR_KV.get('analytics:total_visits'),
      env.BWR_KV.get('analytics:visitor_count'),
    ]);
    // Most recent first – keys are already chronological, so reverse
    const recentKeys = allKeys.slice(-500).reverse();
    const values = await Promise.all(recentKeys.map(k => env.BWR_KV.get(k.name)));
    // Filter out any visits recorded by admin users (userId matches admin)
    const visits = values.filter(Boolean).map(v => JSON.parse(v))
      .filter(v => v.userId !== admin.id);
    return json({
      visits,
      totalVisits: totalRaw ? parseInt(totalRaw, 10) : allKeys.length,
      totalVisitors: visitorCountRaw ? parseInt(visitorCountRaw, 10) : 0,
    });
  }

  // ── Monthly challenges (public read, admin write) ─────────────────────────────
  if (pathname === '/api/challenge' && request.method === 'GET') {
    const month = new Date().getUTCMonth();
    const raw   = await env.BWR_KV.get(`challenge:${month}`);
    return json(raw ? JSON.parse(raw) : null);
  }

  if (pathname === '/api/admin/challenges' && request.method === 'GET') {
    const admin = await getUserFromToken(env, request);
    if (!admin || admin.role !== 'admin') return fail('Accès refusé.', 403);
    const challenges = {};
    for (let m = 0; m < 12; m++) {
      const raw = await env.BWR_KV.get(`challenge:${m}`);
      if (raw) challenges[m] = JSON.parse(raw);
    }
    return json(challenges);
  }

  if (pathname === '/api/admin/challenge' && request.method === 'POST') {
    const admin = await getUserFromToken(env, request);
    if (!admin || admin.role !== 'admin') return fail('Accès refusé.', 403);
    let body;
    try { body = await request.json(); } catch { return fail('JSON invalide.'); }
    const month = parseInt(body.month, 10);
    if (isNaN(month) || month < 0 || month > 11) return fail('Mois invalide.');
    const name   = String(body.name  || '').trim().slice(0, 80);
    const icon   = String(body.icon  || '').trim().slice(0, 8);
    const target = parseFloat(body.target);
    if (!name || !icon)             return fail('Nom et icône requis.');
    if (!target || target < 1 || target > 9999) return fail('Objectif invalide.');
    const description = String(body.description || '').trim().slice(0, 2000);
    await env.BWR_KV.put(`challenge:${month}`, JSON.stringify({ month, icon, name, target, description, setAt: new Date().toISOString() }));
    return json({ ok: true });
  }

  if (pathname.startsWith('/api/admin/challenge/') && request.method === 'DELETE') {
    const admin = await getUserFromToken(env, request);
    if (!admin || admin.role !== 'admin') return fail('Accès refusé.', 403);
    const month = parseInt(pathname.split('/')[4], 10);
    if (isNaN(month) || month < 0 || month > 11) return fail('Mois invalide.', 400);
    await env.BWR_KV.delete(`challenge:${month}`);
    return json({ ok: true });
  }

  return null;
}
