async function hashPassword(password, salt) {
  const encoder = new TextEncoder();
  const data = encoder.encode(password + salt);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function getUserFromToken(env, request) {
  const auth = request.headers.get('Authorization');
  if (!auth || !auth.startsWith('Bearer ')) return null;
  const token = auth.slice(7);
  const raw = await env.BWR_KV.get(`session:${token}`);
  if (!raw) return null;
  const session = JSON.parse(raw);
  if (new Date(session.expiresAt) < new Date()) {
    await env.BWR_KV.delete(`session:${token}`);
    return null;
  }
  const users = JSON.parse((await env.BWR_KV.get('users')) || '[]');
  return users.find(u => u.id === session.userId) || null;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const pathname = url.pathname;

    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Admin-Password',
    };

    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });

    const json = (data, status = 200) =>
      new Response(JSON.stringify(data), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

    const fail = (msg, status = 400) =>
      new Response(JSON.stringify({ error: msg }), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

    // ── /api/setup — seeds the admin account (one-time) ──────────────────────
    if (pathname === '/api/setup' && request.method === 'POST') {
      const users = JSON.parse((await env.BWR_KV.get('users')) || '[]');
      return fail('Setup already completed.', 403);

      const body = await request.json();
      if (!body.password) return fail('Password required.');

      const salt = crypto.randomUUID();
      const passwordHash = await hashPassword(body.password, salt);

      const admin = {
        id: crypto.randomUUID(),
        name: 'Thomas Legros',
        email: 'ciril8596@gmail.com',
        passwordHash,
        salt,
        role: 'admin',
        createdAt: new Date().toISOString(),
      };

      users.push(admin);
      await env.BWR_KV.put('users', JSON.stringify(users));
      return json({ message: 'Admin created successfully' }, 201);
    }

    // ── POST /api/auth/register ───────────────────────────────────────────────
    if (pathname === '/api/auth/register' && request.method === 'POST') {
      const body = await request.json();
      const { name, email, password } = body;

      if (!name || !email || !password) return fail('Tous les champs sont obligatoires.');
      if (password.length < 6) return fail('Le mot de passe doit faire au moins 6 caractères.');

      const users = JSON.parse((await env.BWR_KV.get('users')) || '[]');
      if (users.find(u => u.email.toLowerCase() === email.toLowerCase())) {
        return fail('Un compte existe déjà avec cet email.');
      }

      const salt = crypto.randomUUID();
      const passwordHash = await hashPassword(password, salt);

      const newUser = {
        id: crypto.randomUUID(),
        name,
        email: email.toLowerCase(),
        passwordHash,
        salt,
        role: 'free',
        createdAt: new Date().toISOString(),
      };

      users.push(newUser);
      await env.BWR_KV.put('users', JSON.stringify(users));

      return json({ message: 'Compte créé avec succès.' }, 201);
    }

    // ── POST /api/auth/login ──────────────────────────────────────────────────
    if (pathname === '/api/auth/login' && request.method === 'POST') {
      const body = await request.json();
      const { email, password } = body;

      if (!email || !password) return fail('Email et mot de passe requis.');

      const users = JSON.parse((await env.BWR_KV.get('users')) || '[]');
      const user = users.find(u => u.email.toLowerCase() === email.toLowerCase());

      if (!user) return fail('Email ou mot de passe incorrect.', 401);

      const hash = await hashPassword(password, user.salt);
      if (hash !== user.passwordHash) return fail('Email ou mot de passe incorrect.', 401);

      const token = crypto.randomUUID();
      const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(); // 30 days
      await env.BWR_KV.put(`session:${token}`, JSON.stringify({ userId: user.id, expiresAt }), { expirationTtl: 2592000 });

      return json({
        token,
        user: { id: user.id, name: user.name, email: user.email, role: user.role },
      });
    }

    // ── GET /api/auth/me ──────────────────────────────────────────────────────
    if (pathname === '/api/auth/me' && request.method === 'GET') {
      const user = await getUserFromToken(env, request);
      if (!user) return fail('Non authentifié.', 401);
      return json({ id: user.id, name: user.name, email: user.email, role: user.role });
    }

    // ── POST /api/auth/logout ─────────────────────────────────────────────────
    if (pathname === '/api/auth/logout' && request.method === 'POST') {
      const auth = request.headers.get('Authorization');
      if (auth && auth.startsWith('Bearer ')) {
        await env.BWR_KV.delete(`session:${auth.slice(7)}`);
      }
      return json({ message: 'Déconnecté.' });
    }

    // ── GET /api/osm — proxy + cache for Overpass API ────────────────────────
    if (pathname === '/api/osm' && request.method === 'GET') {
      const bbox = url.searchParams.get('bbox');
      if (!bbox) return fail('bbox parameter required');

      const cacheKey = `osm:${bbox}`;
      const cached = await env.BWR_KV.get(cacheKey);
      if (cached) return json(JSON.parse(cached));

      // bbox from client is south,west,north,east — OSM API needs west,south,east,north
      const [s, w, n, e] = bbox.split(',');
      try {
        const res = await fetch(
          `https://api.openstreetmap.org/api/0.6/map.json?bbox=${w},${s},${e},${n}`,
          { headers: { 'Accept': 'application/json' } }
        );
        if (!res.ok) return fail('OSM API error', 502);
        const raw = await res.json();

        // Keep only path/track nodes and ways
        const pathTypes = /^(path|track|footway|bridleway|cycleway)$/;
        const ways = raw.elements.filter(el =>
          el.type === 'way' && el.tags?.highway && pathTypes.test(el.tags.highway)
        );
        const usedNodeIds = new Set(ways.flatMap(w => w.nodes));
        const nodes = raw.elements.filter(el => el.type === 'node' && usedNodeIds.has(el.id));
        const data = { elements: [...nodes, ...ways] };

        await env.BWR_KV.put(cacheKey, JSON.stringify(data), { expirationTtl: 604800 });
        return json(data);
      } catch (e) {
        return fail('OSM API unavailable', 502);
      }
    }

    // ── POST /api/route — proxy to OpenRouteService ──────────────────────────
    if (pathname === '/api/route' && request.method === 'POST') {
      const user = await getUserFromToken(env, request);
      if (!user) return fail('Non authentifié.', 401);

      if (!env.ORS_KEY) return fail('Clé ORS manquante — configure ORS_KEY dans les variables du Worker.', 503);

      try {
        const { profile, coordinates, round_trip } = await request.json();

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
        return fail('Service de routage indisponible: ' + e.message, 503);
      }
    }

    // ── PUT /api/auth/profile — update name / email ──────────────────────────
    if (pathname === '/api/auth/profile' && request.method === 'PUT') {
      const user = await getUserFromToken(env, request);
      if (!user) return fail('Non authentifié.', 401);

      const { name, email } = await request.json();
      if (!name || !email) return fail('Nom et email obligatoires.');

      const users = JSON.parse((await env.BWR_KV.get('users')) || '[]');
      const conflict = users.find(u => u.email.toLowerCase() === email.toLowerCase() && u.id !== user.id);
      if (conflict) return fail('Cette adresse email est déjà utilisée.');

      const idx = users.findIndex(u => u.id === user.id);
      users[idx] = { ...users[idx], name, email: email.toLowerCase() };
      await env.BWR_KV.put('users', JSON.stringify(users));
      return json({ id: users[idx].id, name: users[idx].name, email: users[idx].email, role: users[idx].role });
    }

    // ── PUT /api/auth/password — change password ──────────────────────────────
    if (pathname === '/api/auth/password' && request.method === 'PUT') {
      const user = await getUserFromToken(env, request);
      if (!user) return fail('Non authentifié.', 401);

      const { oldPassword, newPassword } = await request.json();
      if (!oldPassword || !newPassword) return fail('Champs obligatoires.');
      if (newPassword.length < 6) return fail('Le nouveau mot de passe doit faire au moins 6 caractères.');

      const hash = await hashPassword(oldPassword, user.salt);
      if (hash !== user.passwordHash) return fail('Mot de passe actuel incorrect.', 401);

      const newSalt = crypto.randomUUID();
      const newHash = await hashPassword(newPassword, newSalt);
      const users = JSON.parse((await env.BWR_KV.get('users')) || '[]');
      const idx = users.findIndex(u => u.id === user.id);
      users[idx] = { ...users[idx], passwordHash: newHash, salt: newSalt };
      await env.BWR_KV.put('users', JSON.stringify(users));
      return json({ message: 'Mot de passe modifié avec succès.' });
    }

    // ── DELETE /api/auth/account — delete own account ─────────────────────────
    if (pathname === '/api/auth/account' && request.method === 'DELETE') {
      const user = await getUserFromToken(env, request);
      if (!user) return fail('Non authentifié.', 401);
      if (user.role === 'admin') return fail('Le compte administrateur ne peut pas être supprimé.', 403);

      const users = JSON.parse((await env.BWR_KV.get('users')) || '[]');
      await env.BWR_KV.put('users', JSON.stringify(users.filter(u => u.id !== user.id)));

      const auth = request.headers.get('Authorization');
      if (auth?.startsWith('Bearer ')) await env.BWR_KV.delete(`session:${auth.slice(7)}`);
      return json({ message: 'Compte supprimé.' });
    }

    // ── GET /api/paths — public ───────────────────────────────────────────────
    if (pathname === '/api/paths' && request.method === 'GET') {
      const raw = await env.BWR_KV.get('paths');
      return json(raw ? JSON.parse(raw) : []);
    }

    // ── POST /api/paths — admin only ──────────────────────────────────────────
    if (pathname === '/api/paths' && request.method === 'POST') {
      const user = await getUserFromToken(env, request);
      if (!user || user.role !== 'admin') return fail('Accès refusé.', 403);

      const body = await request.json();
      const paths = JSON.parse((await env.BWR_KV.get('paths')) || '[]');

      const newPath = {
        id: crypto.randomUUID(),
        name: body.name || 'Chemin sans nom',
        pathType: body.pathType || 'foot',
        status: body.status || 'easy',
        notes: body.notes || '',
        conditions: Array.isArray(body.conditions) ? body.conditions : [],
        coordinates: body.coordinates,
        createdAt: new Date().toISOString(),
      };

      paths.push(newPath);
      await env.BWR_KV.put('paths', JSON.stringify(paths));
      return json(newPath, 201);
    }

    // ── PUT /api/paths/:id — admin only ───────────────────────────────────────
    if (pathname.startsWith('/api/paths/') && request.method === 'PUT') {
      const user = await getUserFromToken(env, request);
      if (!user || user.role !== 'admin') return fail('Accès refusé.', 403);

      const id = pathname.split('/')[3];
      const body = await request.json();
      const paths = JSON.parse((await env.BWR_KV.get('paths')) || '[]');
      const idx = paths.findIndex(p => p.id === id);
      if (idx === -1) return fail('Chemin introuvable.', 404);

      paths[idx] = { ...paths[idx], ...body, id };
      await env.BWR_KV.put('paths', JSON.stringify(paths));
      return json(paths[idx]);
    }

    // ── DELETE /api/paths/:id — admin only ────────────────────────────────────
    if (pathname.startsWith('/api/paths/') && request.method === 'DELETE') {
      const user = await getUserFromToken(env, request);
      if (!user || user.role !== 'admin') return fail('Accès refusé.', 403);

      const id = pathname.split('/')[3];
      const paths = JSON.parse((await env.BWR_KV.get('paths')) || '[]');
      await env.BWR_KV.put('paths', JSON.stringify(paths.filter(p => p.id !== id)));
      return json({ success: true });
    }

    return new Response('Not found', { status: 404, headers: cors });
  },
};
