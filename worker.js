async function hashPasswordLegacy(password, salt) {
  const encoder = new TextEncoder();
  const data = encoder.encode(password + salt);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// PBKDF2-SHA-256 avec 100 000 itérations — résistant au bruteforce (Web Crypto natif, sans dépendances)
async function hashPassword(password, salt) {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    { name: 'PBKDF2' },
    false,
    ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: encoder.encode(salt), iterations: 100_000 },
    keyMaterial,
    256
  );
  return Array.from(new Uint8Array(bits)).map(b => b.toString(16).padStart(2, '0')).join('');
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
        hashVersion: 2,
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
        hashVersion: 2,
        role: 'free',
        plan: 'free',
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

      let passwordOk = false;
      let needsMigration = false;

      if (user.hashVersion === 2) {
        passwordOk = (await hashPassword(password, user.salt)) === user.passwordHash;
      } else {
        // Ancien compte SHA-256 : vérifier avec l'ancienne méthode puis migrer vers PBKDF2
        passwordOk = (await hashPasswordLegacy(password, user.salt)) === user.passwordHash;
        if (passwordOk) needsMigration = true;
      }

      if (!passwordOk) return fail('Email ou mot de passe incorrect.', 401);

      if (needsMigration) {
        const newSalt = crypto.randomUUID();
        const newHash = await hashPassword(password, newSalt);
        const allUsers = JSON.parse((await env.BWR_KV.get('users')) || '[]');
        const idx = allUsers.findIndex(u => u.id === user.id);
        allUsers[idx] = { ...allUsers[idx], passwordHash: newHash, salt: newSalt, hashVersion: 2 };
        await env.BWR_KV.put('users', JSON.stringify(allUsers));
      }

      const token = crypto.randomUUID();
      const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(); // 30 days
      await env.BWR_KV.put(`session:${token}`, JSON.stringify({ userId: user.id, expiresAt }), { expirationTtl: 2592000 });

      return json({
        token,
        user: { id: user.id, name: user.name, email: user.email, role: user.role, plan: user.plan || 'free' },
      });
    }

    // ── GET /api/auth/me ──────────────────────────────────────────────────────
    if (pathname === '/api/auth/me' && request.method === 'GET') {
      let user = await getUserFromToken(env, request);
      if (!user) return fail('Non authentifié.', 401);

      const users = JSON.parse((await env.BWR_KV.get('users')) || '[]');
      let idx = users.findIndex(u => u.id === user.id);
      let dirty = false;

      // Auto-expire temporary plan upgrades
      if (user.planExpiresAt && new Date(user.planExpiresAt) < new Date()) {
        const revertTo = user.planBase || 'free';
        users[idx] = { ...users[idx], plan: revertTo, planExpiresAt: null, planBase: null };
        user = users[idx];
        dirty = true;
      }

      // Admins always get gold automatically
      if (user.role === 'admin' && user.plan !== 'gold') {
        users[idx] = { ...users[idx], plan: 'gold' };
        user = users[idx];
        dirty = true;
      }

      if (dirty) await env.BWR_KV.put('users', JSON.stringify(users));

      return json({
        id: user.id, name: user.name, email: user.email, role: user.role,
        plan: user.plan || 'free',
        planExpiresAt: user.planExpiresAt || null,
        planBase: user.planBase || null,
      });
    }

    // ── PUT /api/auth/plan/:userId — admin only, change a user's plan ────────
    if (pathname.startsWith('/api/auth/plan/') && request.method === 'PUT') {
      const admin = await getUserFromToken(env, request);
      if (!admin || admin.role !== 'admin') return fail('Accès refusé.', 403);
      const targetId = pathname.split('/')[4];
      const { plan, planExpiresAt, planBase } = await request.json();
      if (!['free','silver','gold'].includes(plan)) return fail('Plan invalide.');
      const users = JSON.parse((await env.BWR_KV.get('users')) || '[]');
      const idx = users.findIndex(u => u.id === targetId);
      if (idx === -1) return fail('Utilisateur introuvable.', 404);
      const update = { ...users[idx], plan };
      if (planExpiresAt !== undefined) update.planExpiresAt = planExpiresAt || null;
      if (planBase !== undefined) update.planBase = planBase || null;
      users[idx] = update;
      await env.BWR_KV.put('users', JSON.stringify(users));
      return json({ success: true, plan, planExpiresAt: update.planExpiresAt || null });
    }

    // ── POST /api/auth/wheel-prize — claim a plan upgrade won on the wheel ───
    if (pathname === '/api/auth/wheel-prize' && request.method === 'POST') {
      const user = await getUserFromToken(env, request);
      if (!user) return fail('Non authentifié.', 401);

      const { prizeType, plan: prizePlan, days } = await request.json();
      if (prizeType !== 'plan') return json({ success: true });

      const validUpgrades = { free: ['silver'], silver: ['gold'] };
      const currentPlan = user.plan || 'free';
      if (!validUpgrades[currentPlan]?.includes(prizePlan)) {
        return fail('Mise à niveau invalide pour ton abonnement actuel.', 400);
      }

      // Max one plan prize per 30 days
      if (user.lastWheelPrizeClaim) {
        const daysSince = (Date.now() - new Date(user.lastWheelPrizeClaim).getTime()) / 86400000;
        if (daysSince < 30) return fail('Tu as déjà gagné un abonnement récemment — réessaie dans quelques semaines !', 429);
      }

      const users = JSON.parse((await env.BWR_KV.get('users')) || '[]');
      const idx = users.findIndex(u => u.id === user.id);
      if (idx === -1) return fail('Utilisateur introuvable.', 404);

      const expiresAt = new Date(Date.now() + days * 86400000).toISOString();
      users[idx] = {
        ...users[idx],
        plan: prizePlan,
        planExpiresAt: expiresAt,
        planBase: currentPlan,
        lastWheelPrizeClaim: new Date().toISOString(),
      };
      await env.BWR_KV.put('users', JSON.stringify(users));

      return json({ success: true, plan: prizePlan, expiresAt });
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

      const verifyHash = user.hashVersion === 2
        ? await hashPassword(oldPassword, user.salt)
        : await hashPasswordLegacy(oldPassword, user.salt);
      if (verifyHash !== user.passwordHash) return fail('Mot de passe actuel incorrect.', 401);

      const newSalt = crypto.randomUUID();
      const newHash = await hashPassword(newPassword, newSalt);
      const users = JSON.parse((await env.BWR_KV.get('users')) || '[]');
      const idx = users.findIndex(u => u.id === user.id);
      users[idx] = { ...users[idx], passwordHash: newHash, salt: newSalt, hashVersion: 2 };
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

      const oldStatus = paths[idx].status;
      paths[idx] = { ...paths[idx], ...body, id };
      await env.BWR_KV.put('paths', JSON.stringify(paths));

      // Notify subscribed gold users when path status changes
      if (body.status && body.status !== oldStatus) {
        const statusLabels = { easy: 'Facile', medium: 'Moyen', hard: 'Difficile', not_passable: 'Impraticable', no_bike: 'Vélo interdit' };
        const allUsers = JSON.parse((await env.BWR_KV.get('users')) || '[]');
        const alertUsers = allUsers.filter(u => u.alertsEnabled && u.alertsChannel);
        for (const u of alertUsers) {
          try {
            await fetch(`https://ntfy.sh/${u.alertsChannel}`, {
              method: 'POST',
              headers: { 'Title': 'BWR — Chemin mis à jour', 'Tags': 'forest,warning', 'Content-Type': 'text/plain; charset=utf-8' },
              body: `"${paths[idx].name || 'Chemin'}" : ${statusLabels[oldStatus] || oldStatus} → ${statusLabels[body.status] || body.status}`,
            });
          } catch {}
        }
      }

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

    // ── GET /api/reports — public ─────────────────────────────────────────────
    if (pathname === '/api/reports' && request.method === 'GET') {
      const raw = await env.BWR_KV.get('reports');
      return json(raw ? JSON.parse(raw) : []);
    }

    // ── GET /api/users — admin only, list all users ──────────────────────────
    if (pathname === '/api/users' && request.method === 'GET') {
      const admin = await getUserFromToken(env, request);
      if (!admin || admin.role !== 'admin') return fail('Accès refusé.', 403);
      const users = JSON.parse((await env.BWR_KV.get('users')) || '[]');
      // Strip sensitive fields
      const safe = users.map(u => ({
        id: u.id, name: u.name, email: u.email, role: u.role,
        plan: u.plan || 'free',
        planExpiresAt: u.planExpiresAt || null,
        planBase: u.planBase || null,
        createdAt: u.createdAt || null,
      }));
      return json(safe);
    }

    // ── POST /api/reports — any user ─────────────────────────────────────────
    if (pathname === '/api/reports' && request.method === 'POST') {
      const body = await request.json();
      const reports = JSON.parse((await env.BWR_KV.get('reports')) || '[]');

      // Look up path name for the notification
      let pathName = 'Chemin inconnu';
      if (body.pathId) {
        const paths = JSON.parse((await env.BWR_KV.get('paths')) || '[]');
        const found = paths.find(p => p.id === body.pathId);
        if (found) pathName = found.name || 'Chemin sans nom';
      }

      const report = {
        id: crypto.randomUUID(),
        pathId: body.pathId || null,
        type: body.type || 'other',
        note: (body.note || '').slice(0, 300),
        photo: body.photo || null,
        lat: body.lat || null,
        lon: body.lon || null,
        date: new Date().toISOString(),
        status: 'open',
      };
      reports.push(report);
      await env.BWR_KV.put('reports', JSON.stringify(reports));

      // Push notification via ntfy.sh (install ntfy app → subscribe to bwr-ciril8596)
      const typeLabels = { fallen_tree:'Arbre tombé', flooded:'Chemin inondé', closed:'Chemin fermé', danger:'Danger', other:'Autre' };
      try {
        await fetch('https://ntfy.sh/bwr-ciril8596', {
          method: 'POST',
          headers: { 'Title': 'BWR — Nouveau signalement', 'Tags': 'warning', 'Content-Type': 'text/plain; charset=utf-8' },
          body: `${typeLabels[report.type] || report.type} sur "${pathName}"${report.note ? '\n' + report.note : ''}`,
        });
      } catch {}

      return json(report, 201);
    }

    // ── DELETE /api/reports/:id — admin only ──────────────────────────────────
    if (pathname.startsWith('/api/reports/') && request.method === 'DELETE') {
      const user = await getUserFromToken(env, request);
      if (!user || user.role !== 'admin') return fail('Accès refusé.', 403);
      const id = pathname.split('/')[3];
      const reports = JSON.parse((await env.BWR_KV.get('reports')) || '[]');
      await env.BWR_KV.put('reports', JSON.stringify(reports.filter(r => r.id !== id)));
      return json({ success: true });
    }

    // ── POST /api/contact — send a contact message ──────────────────────────
    if (pathname === '/api/contact' && request.method === 'POST') {
      const { name, email, message } = await request.json();
      if (!name || !email || !message) return fail('Tous les champs sont obligatoires.');

      // Save in KV (so messages aren't lost)
      const messages = JSON.parse((await env.BWR_KV.get('contact_messages')) || '[]');
      messages.push({ id: crypto.randomUUID(), name, email, message: message.slice(0, 2000), date: new Date().toISOString() });
      await env.BWR_KV.put('contact_messages', JSON.stringify(messages));

      // Push notification to admin via ntfy.sh
      try {
        await fetch('https://ntfy.sh/bwr-ciril8596', {
          method: 'POST',
          headers: { 'Title': `BWR — Message de ${name}`, 'Tags': 'envelope', 'Content-Type': 'text/plain; charset=utf-8' },
          body: `${email}\n\n${message}`,
        });
      } catch {}

      return json({ success: true });
    }

    // ── POST /api/push/subscribe — enable path alerts (gold users) ───────────
    if (pathname === '/api/push/subscribe' && request.method === 'POST') {
      const user = await getUserFromToken(env, request);
      if (!user) return fail('Non authentifié.', 401);
      const plan = user.plan || 'free';
      if (plan === 'free') return fail('Les alertes push sont disponibles avec le plan Or.', 403);

      const channel = `bwr-u-${user.id.slice(0, 8)}`;
      const users = JSON.parse((await env.BWR_KV.get('users')) || '[]');
      const idx = users.findIndex(u => u.id === user.id);
      if (idx === -1) return fail('Utilisateur introuvable.', 404);
      users[idx] = { ...users[idx], alertsEnabled: true, alertsChannel: channel };
      await env.BWR_KV.put('users', JSON.stringify(users));
      return json({ channel });
    }

    // ── POST /api/push/unsubscribe — disable path alerts ─────────────────────
    if (pathname === '/api/push/unsubscribe' && request.method === 'POST') {
      const user = await getUserFromToken(env, request);
      if (!user) return fail('Non authentifié.', 401);

      const users = JSON.parse((await env.BWR_KV.get('users')) || '[]');
      const idx = users.findIndex(u => u.id === user.id);
      if (idx === -1) return fail('Utilisateur introuvable.', 404);
      users[idx] = { ...users[idx], alertsEnabled: false };
      await env.BWR_KV.put('users', JSON.stringify(users));
      return json({ success: true });
    }

    return new Response('Not found', { status: 404, headers: cors });
  },
};
