import { listItems, listKeys, putUser, getUser } from '../kv.js';
import { getUserFromToken, hashPassword } from '../auth-utils.js';

// ── Visitor-tracking helpers ───────────────────────────────────────────────────
// Server-side bot detection. The client reports real dwell time, and the server
// only counts a visitor past the 10 s bar, so this mainly catches a bot/script
// hitting /api/track/visit directly.
const BOT_UA_RE = /bot|crawl|spider|slurp|mediapartners|facebookexternalhit|embedly|quora link preview|whatsapp|telegrambot|discordbot|bingpreview|yandex|baidu|duckduckbot|semrush|ahrefs|mj12bot|petalbot|headless|phantomjs|python-requests|python-urllib|axios|node-fetch|okhttp|curl|wget|libwww|scrapy|go-http-client|httpclient|lighthouse|pingdom|uptimerobot|monitor/i;
export function isBotUA(ua) {
  if (!ua) return true; // real browsers always send a User-Agent
  return BOT_UA_RE.test(ua);
}

// Friendly, non-identifying device label parsed from the User-Agent
// (e.g. "Chrome · Windows", "Safari · iPhone"). No raw UA is ever stored.
export function describeDevice(ua) {
  if (!ua) return '';
  let os = '';
  if (/iphone/i.test(ua))            os = 'iPhone';
  else if (/ipad/i.test(ua))         os = 'iPad';
  else if (/android/i.test(ua))      os = 'Android';
  else if (/windows/i.test(ua))      os = 'Windows';
  else if (/mac os x|macintosh/i.test(ua)) os = 'Mac';
  else if (/cros/i.test(ua))         os = 'ChromeOS';
  else if (/linux/i.test(ua))        os = 'Linux';

  let browser = '';
  if (/edg\//i.test(ua))                       browser = 'Edge';
  else if (/opr\/|opera/i.test(ua))            browser = 'Opera';
  else if (/samsungbrowser/i.test(ua))         browser = 'Samsung Internet';
  else if (/firefox|fxios/i.test(ua))          browser = 'Firefox';
  else if (/chrome|crios/i.test(ua))           browser = 'Chrome';
  else if (/safari/i.test(ua))                 browser = 'Safari';

  return [browser, os].filter(Boolean).join(' · ');
}

// Fixed-window counter of unique visitors for a month (drives the stat cards).
async function bumpVisitCounter(env, month, ttl) {
  const counterKey = `analytics:visits:${month}`;
  const cur = await env.BWR_KV.get(counterKey);
  await env.BWR_KV.put(counterKey, String((cur ? parseInt(cur, 10) : 0) + 1),
    { expirationTtl: ttl });
}

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

  if (pathname === '/api/migrate/pathgrades' && request.method === 'POST') {
    const admin = await getUserFromToken(env, request);
    if (!admin || admin.role !== 'admin') return fail('Accès refusé.', 403);

    // 1. Attribute every currently-ungraded path to the admin, so a path that got
    //    its difficulty by being drawn/imported (rather than via the grade click)
    //    still counts as "graded". Lines up the breakdown table (total paths) with
    //    the leaderboard "chemins notés" stat.
    const pathKeys = await listKeys(env, 'path:');
    let backfilled = 0;
    for (const k of pathKeys) {
      const id = k.name.slice('path:'.length);
      const existing = await env.BWR_KV.list({ prefix: `pathgrade:${id}:`, limit: 1 });
      if (existing.keys.length === 0) {
        await env.BWR_KV.put(`pathgrade:${id}:${admin.id}`, JSON.stringify({ walkedWhenGraded: false }));
        backfilled++;
      }
    }

    // 2. Recompute every user's pathGrades authoritatively from their grade keys
    //    (pathgrade:{pathId}:{userId}), so the stat can never drift from reality.
    const gradeKeys = await listKeys(env, 'pathgrade:');
    const counts = {};
    for (const k of gradeKeys) {
      const uid = k.name.slice(k.name.lastIndexOf(':') + 1);
      counts[uid] = (counts[uid] || 0) + 1;
    }
    const users = await listItems(env, 'user:');
    await Promise.all(users.map(u =>
      putUser(env, { ...u, stats: { ...(u.stats || {}), pathGrades: counts[u.id] || 0 } })
    ));

    // Drop the leaderboard cache so the next GET rebuilds it from the new stats.
    await env.BWR_KV.delete('leaderboard:cache');

    return json({ success: true, backfilled, usersRecomputed: users.length });
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
      comped: u.comped || false,
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

  // ── Activity analytics ───────────────────────────────────────────────────────
  // NOTE: page-view tracking was removed on purpose — anonymous page views could be
  // search-engine bots and inflated the counts. We now only record real logins and
  // new accounts (see recordAuthEvent in worker/kv.js, called from auth.js).

  /* ── AI Revenue Forecast — calls Claude with the forecast data ──────── */
  if (pathname === '/api/ai/revenue-forecast' && request.method === 'POST') {
    const admin = await getUserFromToken(env, request);
    if (!admin || admin.role !== 'admin') return fail('Accès refusé.', 403);

    let body;
    try { body = await request.json(); } catch { return fail('JSON invalide.'); }

    const { visitors = 0, rate = 0, mrr = 0, arr = 0,
            subs = 0, slope = 0, target = 200, prob = 0, history = [],
            silver = 0, gold = 0, compedSilver = 0, compedGold = 0,
            totalUsers = 0, realConv = 0 } = body;

    const compedTotal = Math.round(compedSilver + compedGold);

    const histStr = history.filter(v => v !== null).length > 0
      ? history.map((v, i) => v !== null ? `M-${4 - i}: ${v} vis.` : null).filter(Boolean).join(', ')
      : 'Aucun historique fourni';

    const trendStr = slope > 0 ? `+${Math.round(slope)} vis./mois (croissance)` :
                     slope < 0 ? `${Math.round(slope)} vis./mois (déclin)` : 'Stable';

    const ARPU = 0.65 * 2.99 + 0.35 * 6.99; // ~4.39€
    const pot1 = Math.round(visitors * 0.01 * ARPU);
    const pot2 = Math.round(visitors * 0.02 * ARPU);
    const pot3 = Math.round(visitors * 0.03 * ARPU);

    const prompt = `Tu es un expert en croissance SaaS et monétisation d'applications web françaises.

Analyse ces données de prévision de revenus pour BWR — une application de randonnée dans les forêts de l'Oise (France) avec deux plans payants : Argent (2,99 €/mois) et Or (6,99 €/mois).

Données réelles (tirées du tableau de bord admin) :
- Visiteurs ce mois : ${Math.round(visitors)}
- Historique trafic : ${histStr}
- Tendance trafic : ${trendStr}
- Membres total : ${totalUsers} (dont ${Math.round(totalUsers - silver - gold)} gratuits, ${silver} Argent, ${gold} Or)
- Abonnements offerts gratuitement : ${compedTotal} (${Math.round(compedSilver)} Argent + ${Math.round(compedGold)} Or) — exclus du chiffre d'affaires mais bien des utilisateurs actifs à fidéliser
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
        const cfRes = await env.AI.run('@cf/meta/llama-3.1-8b-instruct-fp8', {
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
                      'event:', 'visitor:', 'savedroute:', 'routeshare:', 'osm:', 'pending:', 'pemail:',
                      'photo:', 'aisugg:', 'walkedpath:', 'pathgrade:', 'leaderboard:'];

    const counts = {};
    let totalKeys = 0;
    for (const prefix of prefixes) {
      const keys = await listKeys(env, prefix);
      counts[prefix] = keys.length;
      totalKeys += keys.length;
    }

    // Sample the last 3 activity events for an integrity check
    const eventKeys = await listKeys(env, 'event:');
    const sampleEvents = [];
    for (const k of eventKeys.slice(-3).reverse()) {
      const raw = await env.BWR_KV.get(k.name);
      if (raw) {
        const v = JSON.parse(raw);
        sampleEvents.push({ key: k.name, type: v.type, timestamp: v.timestamp, userName: v.userName ?? null });
      }
    }

    return json({
      ok: true,
      totalKeys,
      counts,
      eventSample: sampleEvents,
      workerVersion: '2.1',
      timestamp: new Date().toISOString(),
    });
  }

  // ── Reset activity data (admin only) ─────────────────────────────────────────
  // Clears recorded activity and purges all leftover legacy page-view keys from
  // the old tracking system. Pass { keepName } to preserve a person's activity
  // (case-insensitive substring match on the recorded name) — e.g. keep "Emilien".
  // Any legacy page view that belongs to keepName is converted into a login event
  // so it still shows in the new activity panel; everything else is deleted.
  if (pathname === '/api/analytics/reset' && request.method === 'POST') {
    const admin = await getUserFromToken(env, request);
    if (!admin || admin.role !== 'admin') return fail('Accès refusé.', 403);

    const body = await request.json().catch(() => ({}));
    const keepName = typeof body.keepName === 'string' ? body.keepName.trim().toLowerCase() : '';
    const matches  = name => !!keepName && (name || '').toLowerCase().includes(keepName);
    let deleted = 0;

    // 1. Existing activity events: keep keepName's, delete the rest.
    for (const k of await listKeys(env, 'event:')) {
      const raw = await env.BWR_KV.get(k.name).catch(() => null);
      const ev  = raw ? JSON.parse(raw) : null;
      if (matches(ev?.userName)) continue;
      await env.BWR_KV.delete(k.name);
      deleted++;
    }

    // 2. Legacy page-view keys: convert keepName's visits to login events, drop the rest.
    for (const k of await listKeys(env, 'visit:')) {
      const raw = await env.BWR_KV.get(k.name).catch(() => null);
      const v   = raw ? JSON.parse(raw) : null;
      if (matches(v?.userName)) {
        const ts = new Date(v.timestamp || Date.now()).getTime();
        const id = crypto.randomUUID();
        await env.BWR_KV.put(`event:${String(ts).padStart(13, '0')}:${id}`,
          JSON.stringify({ id, type: 'login', timestamp: new Date(ts).toISOString(),
            userId: v.userId || null, userName: v.userName || '', email: v.email || '' }),
          { expirationTtl: 60 * 60 * 24 * 90 });
      }
      await env.BWR_KV.delete(k.name);
      deleted++;
    }

    // 3. Purge the bot-prone rate-limit / visitor-number keys and old counters,
    //    plus the dwell-gated visitor counters (analytics:visits:* + vseen:* markers).
    for (const prefix of ['ratelimit:visit:', 'ratelimit:device:', 'visitor:num:',
                          'analytics:visits:', 'vseen:', 'visitor:']) {
      const keys = await listKeys(env, prefix);
      await Promise.all(keys.map(k => env.BWR_KV.delete(k.name)));
      deleted += keys.length;
    }
    await env.BWR_KV.delete('analytics:total_visits');
    await env.BWR_KV.delete('analytics:visitor_count');

    // 4. Recompute the running counters from the survivors.
    let kept = 0, logins = 0, signups = 0;
    for (const k of await listKeys(env, 'event:')) {
      const raw = await env.BWR_KV.get(k.name).catch(() => null);
      const ev  = raw ? JSON.parse(raw) : null;
      if (!ev) continue;
      kept++;
      if (ev.type === 'signup') signups++; else logins++;
    }
    await env.BWR_KV.put('analytics:total_logins',  String(logins));
    await env.BWR_KV.put('analytics:total_signups', String(signups));

    return json({ ok: true, deleted, kept });
  }

  // ── Anonymous visit tracking (PUBLIC — no auth) ──────────────────────────────
  // Logs one record per unique visitor per calendar month, so the admin panel can
  // list every real person who came (not just a count). The client
  // (public/js/track.js) only calls this after the visitor has stayed > 30 s, so
  // search-engine bots and instant bounces never reach here; a server-side
  // User-Agent bot filter is a second line of defence. No PII is stored — only an
  // anonymous per-browser `vid`, a coarse Cloudflare city/country, and a friendly
  // device label (never the IP or the raw User-Agent).
  if (pathname === '/api/track/visit' && request.method === 'POST') {
    try {
      const body  = await request.json().catch(() => ({}));
      const vid   = typeof body.vid === 'string' ? body.vid.slice(0, 64) : '';
      const month = new Date().toISOString().slice(0, 7); // YYYY-MM (UTC)
      const ua    = request.headers.get('user-agent') || '';

      // Server-side bot guard on top of the client dwell gate: a bot that hits this
      // endpoint directly is dropped before it can count or be listed.
      if (isBotUA(ua)) return json({ ok: true, counted: false, bot: true });

      // Which page + how long the visitor looked at it (seconds, to the second).
      // Both are sanitised/clamped; a page path must start with "/".
      let page = typeof body.page === 'string' ? body.page.toLowerCase().slice(0, 80) : '';
      if (!page || page[0] !== '/') page = '/';
      const secs = Math.max(0, Math.min(86400, Math.round(Number(body.seconds) || 0)));

      const TTL = 60 * 60 * 24 * 400; // keep ~13 months, same as the counter
      const THRESHOLD = 10; // a real visitor: >= 10 s on the site (bounces excluded)
      const cf  = request.cf || {};
      const now = new Date().toISOString();
      const geo = {
        country: typeof cf.country === 'string' ? cf.country : '',
        city:    typeof cf.city    === 'string' ? cf.city    : '',
        region:  typeof cf.region  === 'string' ? cf.region  : '',
      };
      const device = describeDevice(ua);

      // No vid (private mode / storage off): can't dedup or list — only count a
      // clearly-real (>= 10 s) hit so bounces don't inflate the number.
      if (!vid) {
        const ok = secs >= THRESHOLD;
        if (ok) await bumpVisitCounter(env, month, TTL);
        return json({ ok: true, counted: ok });
      }

      const key = `visitor:${month}:${vid}`;
      const existingRaw = await env.BWR_KV.get(key);
      const rec = existingRaw ? JSON.parse(existingRaw) : {
        vid, firstSeen: now, lastSeen: now,
        visits: 0, seconds: 0, pages: {}, device, ...geo, counted: false,
      };

      rec.lastSeen = now;
      rec.visits   = (rec.visits || 0) + 1;         // page views
      rec.seconds  = (rec.seconds || 0) + secs;     // total time on the site
      if (geo.country) { rec.country = geo.country; rec.city = geo.city; rec.region = geo.region; }
      if (device) rec.device = device;

      // Per-page breakdown (time + views). Bounded so one browser can't create
      // an unlimited number of distinct pages.
      rec.pages = rec.pages || {};
      if (rec.pages[page] || Object.keys(rec.pages).length < 40) {
        const p = rec.pages[page] || { seconds: 0, views: 0 };
        p.seconds += secs;
        p.views   += 1;
        rec.pages[page] = p;
      }

      // Count this browser once, the moment it first crosses the 10 s bar.
      let counted = false;
      if (!rec.counted && rec.seconds >= THRESHOLD) {
        rec.counted = true;
        counted = true;
        await bumpVisitCounter(env, month, TTL);
      }

      await env.BWR_KV.put(key, JSON.stringify(rec), { expirationTtl: TTL });
      return json({ ok: true, counted });
    } catch {
      // Analytics must never surface an error to a normal visitor.
      return json({ ok: true });
    }
  }

  // ── Activity events list (admin only) ────────────────────────────────────────
  if (pathname === '/api/analytics/events' && request.method === 'GET') {
    const admin = await getUserFromToken(env, request);
    if (!admin || admin.role !== 'admin') return fail('Accès refusé.', 403);
    // Real anonymous visitor counts (dwell-gated) for the last 13 calendar months
    // (enough to feed the "1 an" / "all" tabs of the activity chart; the revenue
    // forecast just picks the specific recent keys it needs out of the map).
    const now = new Date();
    const months = [];
    for (let i = 12; i >= 0; i--) {
      months.push(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1))
        .toISOString().slice(0, 7));
    }

    const [allKeys, loginsRaw, signupsRaw, ...visitRaw] = await Promise.all([
      listKeys(env, 'event:'),
      env.BWR_KV.get('analytics:total_logins'),
      env.BWR_KV.get('analytics:total_signups'),
      ...months.map(m => env.BWR_KV.get(`analytics:visits:${m}`)),
    ]);
    // Most recent first – keys are timestamp-prefixed, so reverse the tail.
    const recentKeys = allKeys.slice(-500).reverse();
    const values = await Promise.all(recentKeys.map(k => env.BWR_KV.get(k.name)));
    // Exclude the admin's own logins (the helper already skips admins, but be safe).
    const events = values.filter(Boolean).map(v => JSON.parse(v))
      .filter(v => v.userId !== admin.id);

    const monthlyVisits = {};
    months.forEach((m, i) => { monthlyVisits[m] = visitRaw[i] ? parseInt(visitRaw[i], 10) : 0; });

    // Per-visitor list for the current month — one entry per real person, most
    // recently active first. Capped so a busy month can't blow up the response.
    const thisMonth   = months[months.length - 1];
    const visitorKeys = await listKeys(env, `visitor:${thisMonth}:`);
    const visitorRaw  = await Promise.all(visitorKeys.slice(0, 500).map(k => env.BWR_KV.get(k.name)));
    const visitors = visitorRaw.filter(Boolean).map(v => JSON.parse(v))
      // Hide sub-10 s bounces (counted === false). Legacy records predate the
      // flag (undefined) and were already dwell-gated, so they stay visible.
      .filter(v => v.counted !== false)
      .sort((a, b) => new Date(b.lastSeen) - new Date(a.lastSeen));

    return json({
      events,
      totalLogins:  loginsRaw  ? parseInt(loginsRaw, 10)  : 0,
      totalSignups: signupsRaw ? parseInt(signupsRaw, 10) : 0,
      monthlyVisits,
      visitsThisMonth: monthlyVisits[thisMonth] || 0,
      visitors,
      visitorsTruncated: visitorKeys.length > 500,
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
