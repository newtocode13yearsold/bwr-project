import { listItems, effectivePlan } from '../kv.js';
import { getUserFromToken, checkRateLimit } from '../auth-utils.js';

// Escape untrusted text before interpolating it into an HTML email body.
const escapeHtml = (str) => String(str ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

/**
 * OSM proxy, ORS routing proxy, news CRUD, and contact form.
 * @param {Request} request
 * @param {import('../kv.js').Env} env
 * @param {{ pathname: string, url: URL, json: Function, fail: Function }} ctx
 * @returns {Promise<Response|null>}
 */
export async function handleContent(request, env, { pathname, url, json, fail }) {
  // ── OSM proxy ──────────────────────────────────────────────────────────────
  if (pathname === '/api/osm' && request.method === 'GET') {
    const bbox = url.searchParams.get('bbox');
    if (!bbox) return fail('bbox parameter required');

    const cacheKey = `osmv2:${bbox}`;
    const cached = await env.BWR_KV.get(cacheKey);
    if (cached) return json(JSON.parse(cached));

    const [s, w, n, e] = bbox.split(',');
    const query = `[out:json][timeout:25];(way["highway"~"^(path|track|footway|bridleway|cycleway)$"](${s},${w},${n},${e});>;);out body;`;
    // The public Overpass instances are flaky: any single one intermittently returns
    // 406/429/502/504. We try several mirrors in turn (each with a meaningful
    // User-Agent — required now — and a per-mirror timeout) and use the first that
    // succeeds, so OSM path data keeps flowing even when one instance is overloaded.
    // overpass-api.de is the fastest when up but fails intermittently (fast 502s), so we
    // give it two attempts before falling back to a mirror. Even if the client has already
    // timed out, a late success here still gets cached for the next request.
    const ATTEMPTS = [
      'https://overpass-api.de/api/interpreter',
      'https://overpass-api.de/api/interpreter',
      'https://overpass.private.coffee/api/interpreter',
    ];
    const headers = {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'BWR-Oise/1.0 (https://bwrmaps.com; ciril8596@gmail.com)',
    };

    for (const endpoint of ATTEMPTS) {
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 24000);
        let res;
        try {
          res = await fetch(endpoint, { method: 'POST', headers, body: `data=${encodeURIComponent(query)}`, signal: ctrl.signal });
        } finally {
          clearTimeout(timer);
        }
        if (!res.ok) continue; // try next mirror

        const raw = await res.json();
        if (!Array.isArray(raw?.elements)) continue;

        const pathTypes = /^(path|track|footway|bridleway|cycleway)$/;
        const ways = raw.elements.filter(el =>
          el.type === 'way' && el.tags?.highway && pathTypes.test(el.tags.highway)
        );
        const usedNodeIds = new Set(ways.flatMap(w => w.nodes));
        const nodes = raw.elements.filter(el => el.type === 'node' && usedNodeIds.has(el.id));
        const data = { elements: [...nodes, ...ways] };

        await env.BWR_KV.put(cacheKey, JSON.stringify(data), { expirationTtl: 604800 });
        return json(data);
      } catch {
        // network error / abort / parse error → fall through to the next mirror
      }
    }
    return fail('Overpass API unavailable', 502);
  }

  if (pathname === '/api/osm/cache' && request.method === 'DELETE') {
    const user = await getUserFromToken(env, request);
    if (!user || user.role !== 'admin') return fail('Accès refusé.', 403);

    const bbox = url.searchParams.get('bbox');
    if (bbox) {
      await env.BWR_KV.delete(`osmv2:${bbox}`);
      return json({ deleted: 1, bbox });
    }

    let deleted = 0;
    let cursor;
    do {
      const page = await env.BWR_KV.list({ prefix: 'osmv2:', limit: 1000, cursor });
      await Promise.all(page.keys.map(k => env.BWR_KV.delete(k.name)));
      deleted += page.keys.length;
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);

    return json({ deleted });
  }

  // ── Elevation proxy (opentopodata.org has no CORS headers) ────────────────
  if (pathname === '/api/elevation' && request.method === 'POST') {
    const user = await getUserFromToken(env, request);
    if (!user) return fail('Non authentifié.', 401);

    let body;
    try { body = await request.json(); } catch { return fail('Corps JSON invalide.'); }
    if (!Array.isArray(body?.locations) || body.locations.length === 0)
      return fail('locations requis.');

    const locations = body.locations.slice(0, 100); // honour same 100-point cap as client

    try {
      const res = await fetch('https://api.opentopodata.org/v1/srtm30m', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ locations }),
      });
      if (!res.ok) return fail('Elevation API error', 502);
      const data = await res.json();
      return json(data);
    } catch {
      return fail('Elevation API indisponible.', 502);
    }
  }

  // ── ORS routing proxy ──────────────────────────────────────────────────────
  if (pathname === '/api/route' && request.method === 'POST') {
    const user = await getUserFromToken(env, request);
    if (!user) return fail('Non authentifié.', 401);

    if (!env.ORS_KEY) return fail('Clé ORS manquante — configure ORS_KEY dans les variables du Worker.', 503);

    try {
      const { profile, coordinates, round_trip } = await request.json();

      if (round_trip && effectivePlan(user) === 'free') {
        return fail('Le mode boucle est disponible avec le plan Argent.', 403);
      }

      const orsBody = { coordinates };
      if (round_trip) orsBody.options = { round_trip };

      const res = await fetch(
        `https://api.openrouteservice.org/v2/directions/${profile}/geojson`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': env.ORS_KEY },
          body: JSON.stringify(orsBody),
        }
      );

      const data = await res.json();
      if (!res.ok) return fail(data?.error?.message || 'ORS error', res.status);
      return json(data);
    } catch (e) {
      return fail('Service de routage indisponible.', 503);
    }
  }

  // ── News CRUD ──────────────────────────────────────────────────────────────
  if (pathname === '/api/news' && request.method === 'GET') {
    const items = await listItems(env, 'news:');
    items.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
    return json(items);
  }

  if (pathname === '/api/news' && request.method === 'POST') {
    const user = await getUserFromToken(env, request);
    if (!user || user.role !== 'admin') return fail('Accès refusé.', 403);

    const body = await request.json();
    if (!body.title?.trim()) return fail('Titre obligatoire.');

    const id = crypto.randomUUID();
    const imageDataUri = (body.imageDataUri || '').trim();
    if (imageDataUri && imageDataUri.length > 600000) return fail('Image trop grande (max ~450 Ko).');
    const item = {
      id,
      title: body.title.trim().slice(0, 200),
      content: (body.content || '').trim().slice(0, 5000),
      url: (body.url || '').trim().slice(0, 500),
      urlLabel: (body.urlLabel || '').trim().slice(0, 100),
      imageDataUri: imageDataUri || '',
      imageUrl: /^https?:\/\//.test((body.imageUrl || '').trim()) ? body.imageUrl.trim().slice(0, 1000) : '',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await env.BWR_KV.put(`news:${id}`, JSON.stringify(item));
    return json(item, 201);
  }

  if (pathname.startsWith('/api/news/') && request.method === 'PUT') {
    const user = await getUserFromToken(env, request);
    if (!user || user.role !== 'admin') return fail('Accès refusé.', 403);

    const id = pathname.split('/')[3];
    const raw = await env.BWR_KV.get(`news:${id}`);
    if (!raw) return fail('Article introuvable.', 404);

    const body = await request.json();
    if (!body.title?.trim()) return fail('Titre obligatoire.');

    const existing = JSON.parse(raw);
    const imageDataUri = (body.imageDataUri || '').trim();
    if (imageDataUri && imageDataUri.length > 600000) return fail('Image trop grande (max ~450 Ko).');
    const updated = {
      ...existing,
      title: body.title.trim().slice(0, 200),
      content: (body.content || '').trim().slice(0, 5000),
      url: (body.url || '').trim().slice(0, 500),
      urlLabel: (body.urlLabel || '').trim().slice(0, 100),
      imageDataUri: imageDataUri,
      imageUrl: /^https?:\/\//.test((body.imageUrl || '').trim()) ? body.imageUrl.trim().slice(0, 1000) : '',
      updatedAt: new Date().toISOString(),
    };
    await env.BWR_KV.put(`news:${id}`, JSON.stringify(updated));
    return json(updated);
  }

  if (pathname.startsWith('/api/news/') && request.method === 'DELETE') {
    const user = await getUserFromToken(env, request);
    if (!user || user.role !== 'admin') return fail('Accès refusé.', 403);

    const id = pathname.split('/')[3];
    await env.BWR_KV.delete(`news:${id}`);
    return json({ success: true });
  }

  // ── News reactions (public: like / dislike, one vote per user-or-IP) ─────────
  if (pathname.startsWith('/api/news/') && pathname.endsWith('/react') && request.method === 'POST') {
    const id = pathname.split('/')[3];
    const raw = await env.BWR_KV.get(`news:${id}`);
    if (!raw) return fail('Article introuvable.', 404);

    const { reaction } = await request.json();
    if (reaction !== 'like' && reaction !== 'dislike' && reaction !== null)
      return fail('Réaction invalide.');

    // One vote per logged-in user, or per IP for anonymous visitors.
    const user = await getUserFromToken(env, request);
    const voter = user ? `u:${user.id}` : `ip:${request.headers.get('CF-Connecting-IP') || 'unknown'}`;
    const reactKey = `newsreact:${id}:${voter}`;
    const prev = await env.BWR_KV.get(reactKey); // 'like' | 'dislike' | null

    const item = JSON.parse(raw);
    let likes = item.likes || 0;
    let dislikes = item.dislikes || 0;

    if (prev === 'like') likes--;
    else if (prev === 'dislike') dislikes--;
    if (reaction === 'like') likes++;
    else if (reaction === 'dislike') dislikes++;

    item.likes = Math.max(0, likes);
    item.dislikes = Math.max(0, dislikes);
    await env.BWR_KV.put(`news:${id}`, JSON.stringify(item));

    if (reaction) await env.BWR_KV.put(reactKey, reaction);
    else await env.BWR_KV.delete(reactKey);

    return json({ likes: item.likes, dislikes: item.dislikes, reaction: reaction || null });
  }

  // ── Best tours CRUD ───────────────────────────────────────────────────────
  if (pathname === '/api/besttours' && request.method === 'GET') {
    const items = await listItems(env, 'besttour:');
    items.sort((a, b) => {
      const ra = a.rank ?? 9999, rb = b.rank ?? 9999;
      if (ra !== rb) return ra - rb;
      return (b.createdAt || '').localeCompare(a.createdAt || '');
    });
    return json(items);
  }

  if (pathname === '/api/besttours' && request.method === 'POST') {
    const user = await getUserFromToken(env, request);
    if (!user || user.role !== 'admin') return fail('Accès refusé.', 403);

    const body = await request.json();
    if (!body.name?.trim()) return fail('Nom obligatoire.');

    const id = crypto.randomUUID();
    const imageDataUri = (body.imageDataUri || '').trim();
    if (imageDataUri && imageDataUri.length > 600000) return fail('Image trop grande (max ~450 Ko).');
    const item = {
      id,
      name: body.name.trim().slice(0, 200),
      description: (body.description || '').trim().slice(0, 2000),
      distance: parseFloat(body.distance) || null,
      difficulty: ['easy', 'medium', 'hard'].includes(body.difficulty) ? body.difficulty : 'easy',
      type: ['foot', 'bike', 'mix'].includes(body.type) ? body.type : 'foot',
      startAddress: (body.startAddress || '').trim().slice(0, 300),
      imageDataUri: imageDataUri || '',
      imageUrl: /^https?:\/\//.test((body.imageUrl || '').trim()) ? body.imageUrl.trim().slice(0, 1000) : '',
      externalUrl: /^https?:\/\//.test((body.externalUrl || '').trim()) ? body.externalUrl.trim().slice(0, 500) : '',
      rank: Number.isFinite(parseInt(body.rank)) ? parseInt(body.rank) : 9999,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await env.BWR_KV.put(`besttour:${id}`, JSON.stringify(item));
    return json(item, 201);
  }

  if (pathname.startsWith('/api/besttours/') && request.method === 'PUT') {
    const user = await getUserFromToken(env, request);
    if (!user || user.role !== 'admin') return fail('Accès refusé.', 403);

    const id = pathname.split('/')[3];
    const raw = await env.BWR_KV.get(`besttour:${id}`);
    if (!raw) return fail('Balade introuvable.', 404);

    const body = await request.json();
    if (!body.name?.trim()) return fail('Nom obligatoire.');

    const existing = JSON.parse(raw);
    const imageDataUri = (body.imageDataUri || '').trim();
    if (imageDataUri && imageDataUri.length > 600000) return fail('Image trop grande (max ~450 Ko).');
    const updated = {
      ...existing,
      name: body.name.trim().slice(0, 200),
      description: (body.description || '').trim().slice(0, 2000),
      distance: parseFloat(body.distance) || null,
      difficulty: ['easy', 'medium', 'hard'].includes(body.difficulty) ? body.difficulty : existing.difficulty,
      type: ['foot', 'bike', 'mix'].includes(body.type) ? body.type : existing.type,
      startAddress: (body.startAddress || '').trim().slice(0, 300),
      imageDataUri: imageDataUri,
      imageUrl: /^https?:\/\//.test((body.imageUrl || '').trim()) ? body.imageUrl.trim().slice(0, 1000) : '',
      externalUrl: /^https?:\/\//.test((body.externalUrl || '').trim()) ? body.externalUrl.trim().slice(0, 500) : '',
      rank: Number.isFinite(parseInt(body.rank)) ? parseInt(body.rank) : existing.rank,
      updatedAt: new Date().toISOString(),
    };
    await env.BWR_KV.put(`besttour:${id}`, JSON.stringify(updated));
    return json(updated);
  }

  if (pathname.startsWith('/api/besttours/') && request.method === 'DELETE') {
    const user = await getUserFromToken(env, request);
    if (!user || user.role !== 'admin') return fail('Accès refusé.', 403);

    const id = pathname.split('/')[3];
    await env.BWR_KV.delete(`besttour:${id}`);
    return json({ success: true });
  }

  // ── Contact form ───────────────────────────────────────────────────────────
  if (pathname === '/api/contact' && request.method === 'POST') {
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    if (!await checkRateLimit(env, 'contact', ip, 2, 3600))
      return fail('Trop de messages. Réessayez dans une heure.', 429);
    let { name, email, message } = await request.json();
    if (!name || !email || !message) return fail('Tous les champs sont obligatoires.');
    name = String(name).trim().slice(0, 200);
    email = String(email).trim().slice(0, 200);
    message = String(message).slice(0, 2000);

    const id = crypto.randomUUID();
    await env.BWR_KV.put(`contact:${id}`, JSON.stringify({
      id, name, email, message, date: new Date().toISOString(),
    }));

    const adminEmail = env.ADMIN_EMAIL;
    try {
      await fetch('https://ntfy.sh/bwr-ciril8596', {
        method: 'POST',
        headers: { 'Title': `BWR — Message de ${name}`, 'Tags': 'envelope', 'Content-Type': 'text/plain; charset=utf-8' },
        body: `${email}\n\n${message}`,
      });
    } catch {}
    if (env.RESEND_API_KEY && adminEmail) {
      try {
        await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from: env.RESEND_FROM || 'BWR <noreply@bwr.ciril8596.workers.dev>',
            to: adminEmail,
            subject: `BWR — Nouveau message de ${name}`,
            html: `<p><strong>De :</strong> ${escapeHtml(name)} &lt;${escapeHtml(email)}&gt;</p>
<p><strong>Date :</strong> ${new Date().toLocaleString('fr-FR')}</p>
<hr/>
<p>${escapeHtml(message).replace(/\n/g, '<br/>')}</p>`,
          }),
        });
      } catch {}
    }

    return json({ success: true });
  }

  return null;
}
