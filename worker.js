// ── KV key schema ─────────────────────────────────────────────────────────────
// user:{id}          → JSON user object
// uemail:{email}     → userId string  (email index for fast lookup)
// path:{id}          → JSON path object
// report:{id}        → JSON report object
// photo:{reportId}   → data-URI string  (unchanged — already granular)
// contact:{id}       → JSON contact message
// session:{token}    → JSON { userId, expiresAt }  (unchanged)
// osm:{bbox}         → JSON OSM data  (unchanged)

async function listItems(env, prefix) {
  const keys = [];
  let cursor = undefined;
  do {
    const page = await env.BWR_KV.list({ prefix, limit: 1000, cursor });
    keys.push(...page.keys);
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor !== undefined);

  if (keys.length === 0) return [];
  const values = await Promise.all(keys.map(k => env.BWR_KV.get(k.name)));
  return values.filter(Boolean).map(v => JSON.parse(v));
}

async function getUser(env, id) {
  const raw = await env.BWR_KV.get(`user:${id}`);
  return raw ? JSON.parse(raw) : null;
}

async function putUser(env, user) {
  await env.BWR_KV.put(`user:${user.id}`, JSON.stringify(user));
}

async function getUserByEmail(env, email) {
  const userId = await env.BWR_KV.get(`uemail:${email.toLowerCase()}`);
  if (!userId) return null;
  return getUser(env, userId);
}

async function getPath(env, id) {
  const raw = await env.BWR_KV.get(`path:${id}`);
  return raw ? JSON.parse(raw) : null;
}

async function putPath(env, path) {
  await env.BWR_KV.put(`path:${path.id}`, JSON.stringify(path));
}

async function putReport(env, report) {
  await env.BWR_KV.put(`report:${report.id}`, JSON.stringify(report));
}

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
  return getUser(env, session.userId);
}

// ── Date helpers ──────────────────────────────────────────────────────────────

function isoMonday(d = new Date()) {
  const day = (d.getDay() + 6) % 7; // 0 = Monday
  const monday = new Date(d);
  monday.setDate(d.getDate() - day);
  monday.setHours(0, 0, 0, 0);
  return monday.toISOString().slice(0, 10);
}

// ── Brute-force / login rate-limit helpers ────────────────────────────────────
// KV key: loginattempts:{email} → { count, lockedUntil }
// TTL: 600 s (10 min) — auto-expires so successful accounts eventually reset.

const LOGIN_MAX_ATTEMPTS = 10;
const LOGIN_LOCKOUT_SECONDS = 600; // 10 minutes

async function getLoginAttempts(env, email) {
  const raw = await env.BWR_KV.get(`loginattempts:${email}`);
  return raw ? JSON.parse(raw) : { count: 0, lockedUntil: null };
}

async function recordFailedLogin(env, email) {
  const attempts = await getLoginAttempts(env, email);
  attempts.count += 1;
  if (attempts.count >= LOGIN_MAX_ATTEMPTS) {
    attempts.lockedUntil = new Date(Date.now() + LOGIN_LOCKOUT_SECONDS * 1000).toISOString();
  }
  await env.BWR_KV.put(`loginattempts:${email}`, JSON.stringify(attempts), { expirationTtl: LOGIN_LOCKOUT_SECONDS });
  return attempts;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const pathname = url.pathname;

    const ALLOWED_ORIGINS = new Set([
      'https://bwr-worker.ciril8596.workers.dev',
      'http://localhost:8787',
    ]);
    const origin = request.headers.get('Origin') ?? '';
    const allowedOrigin = ALLOWED_ORIGINS.has(origin) ? origin : 'https://bwr-worker.ciril8596.workers.dev';

    const cors = {
      'Access-Control-Allow-Origin': allowedOrigin,
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Admin-Password',
      'Vary': 'Origin',
    };

    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });

    const json = (data, status = 200) =>
      new Response(JSON.stringify(data), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

    const fail = (msg, status = 400) =>
      new Response(JSON.stringify({ error: msg }), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

    // ── POST /api/migrate — one-time migration from array keys to granular keys ─
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

    // ── /api/setup — seeds the admin account (one-time) ──────────────────────
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

    // ── POST /api/auth/register ───────────────────────────────────────────────
    if (pathname === '/api/auth/register' && request.method === 'POST') {
      const body = await request.json();
      const { name, email, password } = body;

      if (!name || !email || !password) return fail('Tous les champs sont obligatoires.');
      if (password.length < 6) return fail('Le mot de passe doit faire au moins 6 caractères.');

      const existing = await env.BWR_KV.get(`uemail:${email.toLowerCase()}`);
      if (existing) return fail('Un compte existe déjà avec cet email.');

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
        stats: { routes: 0, km: 0 },
        createdAt: new Date().toISOString(),
      };

      await Promise.all([
        putUser(env, newUser),
        env.BWR_KV.put(`uemail:${newUser.email}`, newUser.id),
      ]);
      return json({ message: 'Compte créé avec succès.' }, 201);
    }

    // ── POST /api/auth/login ──────────────────────────────────────────────────
    if (pathname === '/api/auth/login' && request.method === 'POST') {
      const body = await request.json();
      const { email, password } = body;

      if (!email || !password) return fail('Email et mot de passe requis.');

      const emailKey = email.toLowerCase();

      // Brute-force protection: reject immediately if account is locked.
      const attempts = await getLoginAttempts(env, emailKey);
      if (attempts.lockedUntil && new Date(attempts.lockedUntil) > new Date()) {
        return json({ error: 'Compte temporairement verrouillé après trop de tentatives. Réessayez dans 10 minutes.' }, 429);
      }

      const user = await getUserByEmail(env, email);
      if (!user) {
        await recordFailedLogin(env, emailKey);
        return fail('Email ou mot de passe incorrect.', 401);
      }

      let passwordOk = false;
      let needsMigration = false;

      if (user.hashVersion === 2) {
        passwordOk = (await hashPassword(password, user.salt)) === user.passwordHash;
      } else {
        // Ancien compte SHA-256 : vérifier avec l'ancienne méthode puis migrer vers PBKDF2
        passwordOk = (await hashPasswordLegacy(password, user.salt)) === user.passwordHash;
        if (passwordOk) needsMigration = true;
      }

      if (!passwordOk) {
        await recordFailedLogin(env, emailKey);
        return fail('Email ou mot de passe incorrect.', 401);
      }

      if (needsMigration) {
        const newSalt = crypto.randomUUID();
        const newHash = await hashPassword(password, newSalt);
        await putUser(env, { ...user, passwordHash: newHash, salt: newSalt, hashVersion: 2 });
      }

      // Clear failed-attempt counter on successful login.
      await env.BWR_KV.delete(`loginattempts:${emailKey}`);

      const token = crypto.randomUUID();
      const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
      await env.BWR_KV.put(`session:${token}`, JSON.stringify({ userId: user.id, expiresAt }), { expirationTtl: 2592000 });

      return json({
        token,
        user: { id: user.id, name: user.name, email: user.email, role: user.role, plan: user.plan || 'free', stats: user.stats || { routes: 0, km: 0 } },
      });
    }

    // ── GET /api/auth/me ──────────────────────────────────────────────────────
    if (pathname === '/api/auth/me' && request.method === 'GET') {
      let user = await getUserFromToken(env, request);
      if (!user) return fail('Non authentifié.', 401);

      let dirty = false;
      let updated = { ...user };

      // Auto-expire temporary plan upgrades
      if (updated.planExpiresAt && new Date(updated.planExpiresAt) < new Date()) {
        const revertTo = updated.planBase || 'free';
        updated = { ...updated, plan: revertTo, planExpiresAt: null, planBase: null };
        dirty = true;
      }

      // Admins always get gold automatically
      if (updated.role === 'admin' && updated.plan !== 'gold') {
        updated = { ...updated, plan: 'gold' };
        dirty = true;
      }

      if (dirty) await putUser(env, updated);

      return json({
        id: updated.id, name: updated.name, email: updated.email, role: updated.role,
        plan: updated.plan || 'free',
        planExpiresAt: updated.planExpiresAt || null,
        planBase: updated.planBase || null,
        stats: updated.stats || { routes: 0, km: 0, weeklyRoutes: 0, weekStart: isoMonday() },
      });
    }

    // ── PUT /api/auth/plan/:userId — admin only, change a user's plan ────────
    if (pathname.startsWith('/api/auth/plan/') && request.method === 'PUT') {
      const admin = await getUserFromToken(env, request);
      if (!admin || admin.role !== 'admin') return fail('Accès refusé.', 403);

      const targetId = pathname.split('/')[4];
      const { plan, planExpiresAt, planBase } = await request.json();
      if (!['free', 'silver', 'gold'].includes(plan)) return fail('Plan invalide.');

      const target = await getUser(env, targetId);
      if (!target) return fail('Utilisateur introuvable.', 404);

      const updated = { ...target, plan };
      if (planExpiresAt !== undefined) updated.planExpiresAt = planExpiresAt || null;
      if (planBase !== undefined) updated.planBase = planBase || null;
      await putUser(env, updated);

      return json({ success: true, plan, planExpiresAt: updated.planExpiresAt || null });
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

      const expiresAt = new Date(Date.now() + days * 86400000).toISOString();
      await putUser(env, {
        ...user,
        plan: prizePlan,
        planExpiresAt: expiresAt,
        planBase: currentPlan,
        lastWheelPrizeClaim: new Date().toISOString(),
      });

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

      const newEmail = email.toLowerCase();
      if (newEmail !== user.email) {
        const conflict = await env.BWR_KV.get(`uemail:${newEmail}`);
        if (conflict && conflict !== user.id) return fail('Cette adresse email est déjà utilisée.');
        await Promise.all([
          env.BWR_KV.delete(`uemail:${user.email}`),
          env.BWR_KV.put(`uemail:${newEmail}`, user.id),
        ]);
      }

      const updated = { ...user, name, email: newEmail };
      await putUser(env, updated);
      return json({ id: updated.id, name: updated.name, email: updated.email, role: updated.role });
    }

    // ── POST /api/auth/stats — increment route/km stats ─────────────────────────
    if (pathname === '/api/auth/stats' && request.method === 'POST') {
      const user = await getUserFromToken(env, request);
      if (!user) return fail('Non authentifié.', 401);

      const body = await request.json();
      const deltaRoutes = Math.max(0, parseInt(body.routes) || 0);
      const deltaKm     = Math.max(0, parseFloat(body.km) || 0);

      const prev = user.stats || { routes: 0, km: 0 };
      const updatedStats = {
        routes: (prev.routes || 0) + deltaRoutes,
        km: parseFloat(((prev.km || 0) + deltaKm).toFixed(2)),
      };
      await putUser(env, { ...user, stats: updatedStats });
      return json({ stats: updatedStats });
    }

    // ── POST /api/auth/consume-route — server-side weekly quota enforcement ───
    if (pathname === '/api/auth/consume-route' && request.method === 'POST') {
      const user = await getUserFromToken(env, request);
      if (!user) return fail('Non authentifié.', 401);

      const plan = user.plan || 'free';
      if (plan !== 'free') return json({ ok: true, unlimited: true });

      const weekStart = isoMonday();
      const stats = user.stats || { routes: 0, km: 0 };
      const weeklyRoutes = stats.weekStart === weekStart ? (stats.weeklyRoutes || 0) : 0;

      const LIMIT = 3;
      if (weeklyRoutes >= LIMIT) {
        return fail(JSON.stringify({ ok: false, used: weeklyRoutes, limit: LIMIT }), 429);
      }

      const newCount = weeklyRoutes + 1;
      await putUser(env, { ...user, stats: { ...stats, weeklyRoutes: newCount, weekStart } });
      return json({ ok: true, used: newCount, limit: LIMIT });
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
      await putUser(env, { ...user, passwordHash: newHash, salt: newSalt, hashVersion: 2 });
      return json({ message: 'Mot de passe modifié avec succès.' });
    }

    // ── DELETE /api/auth/account — delete own account ─────────────────────────
    if (pathname === '/api/auth/account' && request.method === 'DELETE') {
      const user = await getUserFromToken(env, request);
      if (!user) return fail('Non authentifié.', 401);
      if (user.role === 'admin') return fail('Le compte administrateur ne peut pas être supprimé.', 403);

      await Promise.all([
        env.BWR_KV.delete(`user:${user.id}`),
        env.BWR_KV.delete(`uemail:${user.email}`),
      ]);

      const auth = request.headers.get('Authorization');
      if (auth?.startsWith('Bearer ')) await env.BWR_KV.delete(`session:${auth.slice(7)}`);
      return json({ message: 'Compte supprimé.' });
    }

    // ── GET /api/paths — public ───────────────────────────────────────────────
    if (pathname === '/api/paths' && request.method === 'GET') {
      return json(await listItems(env, 'path:'));
    }

    // ── POST /api/paths — admin only ──────────────────────────────────────────
    if (pathname === '/api/paths' && request.method === 'POST') {
      const user = await getUserFromToken(env, request);
      if (!user || user.role !== 'admin') return fail('Accès refusé.', 403);

      const body = await request.json();
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

      await putPath(env, newPath);
      return json(newPath, 201);
    }

    // ── PUT /api/paths/:id — admin only ───────────────────────────────────────
    if (pathname.startsWith('/api/paths/') && request.method === 'PUT') {
      const user = await getUserFromToken(env, request);
      if (!user || user.role !== 'admin') return fail('Accès refusé.', 403);

      const id = pathname.split('/')[3];
      const body = await request.json();
      const existing = await getPath(env, id);
      if (!existing) return fail('Chemin introuvable.', 404);

      const oldStatus = existing.status;
      const updated = { ...existing, ...body, id };
      await putPath(env, updated);

      // Notify subscribed users when path status changes
      if (body.status && body.status !== oldStatus) {
        const statusLabels = { easy: 'Facile', medium: 'Moyen', hard: 'Difficile', not_passable: 'Impraticable', no_bike: 'Vélo interdit' };
        const allUsers = await listItems(env, 'user:');
        const alertUsers = allUsers.filter(u => u.alertsEnabled && u.alertsChannel);
        for (const u of alertUsers) {
          try {
            await fetch(`https://ntfy.sh/${u.alertsChannel}`, {
              method: 'POST',
              headers: { 'Title': 'BWR — Chemin mis à jour', 'Tags': 'forest,warning', 'Content-Type': 'text/plain; charset=utf-8' },
              body: `"${updated.name || 'Chemin'}" : ${statusLabels[oldStatus] || oldStatus} → ${statusLabels[body.status] || body.status}`,
            });
          } catch {}
        }
      }

      return json(updated);
    }

    // ── DELETE /api/paths/:id — admin only ────────────────────────────────────
    if (pathname.startsWith('/api/paths/') && request.method === 'DELETE') {
      const user = await getUserFromToken(env, request);
      if (!user || user.role !== 'admin') return fail('Accès refusé.', 403);

      const id = pathname.split('/')[3];
      await env.BWR_KV.delete(`path:${id}`);
      return json({ success: true });
    }

    // ── GET /api/reports — public ─────────────────────────────────────────────
    if (pathname === '/api/reports' && request.method === 'GET') {
      return json(await listItems(env, 'report:'));
    }

    // ── GET /api/users — admin only, list all users ──────────────────────────
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

    // ── GET /api/photos/:reportId — public, serves photo binary ─────────────
    if (pathname.startsWith('/api/photos/') && request.method === 'GET') {
      const reportId = pathname.split('/')[3];
      const dataUri = await env.BWR_KV.get(`photo:${reportId}`);
      if (!dataUri) return new Response('Not found', { status: 404, headers: cors });
      const [header, b64] = dataUri.split(',');
      const mime = header.match(/data:([^;]+)/)?.[1] || 'image/jpeg';
      const binary = atob(b64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return new Response(bytes, {
        headers: { ...cors, 'Content-Type': mime, 'Cache-Control': 'public, max-age=2592000' },
      });
    }

    // ── POST /api/reports — any user ─────────────────────────────────────────
    if (pathname === '/api/reports' && request.method === 'POST') {
      const body = await request.json();

      let pathName = 'Chemin inconnu';
      if (body.pathId) {
        const found = await getPath(env, body.pathId);
        if (found) pathName = found.name || 'Chemin sans nom';
      }

      const report = {
        id: crypto.randomUUID(),
        pathId: body.pathId || null,
        type: body.type || 'other',
        note: (body.note || '').slice(0, 300),
        hasPhoto: !!body.photo,
        lat: body.lat || null,
        lon: body.lon || null,
        date: new Date().toISOString(),
        status: 'open',
      };

      // Store photo separately to keep report objects lean
      if (body.photo) {
        await env.BWR_KV.put(`photo:${report.id}`, body.photo, { expirationTtl: 7776000 }); // 90 days
      }

      await putReport(env, report);

      const typeLabels = { fallen_tree: 'Arbre tombé', flooded: 'Chemin inondé', closed: 'Chemin fermé', danger: 'Danger', other: 'Autre' };
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
      await Promise.all([
        env.BWR_KV.delete(`report:${id}`),
        env.BWR_KV.delete(`photo:${id}`),
      ]);
      return json({ success: true });
    }

    // ── POST /api/contact — send a contact message ──────────────────────────
    if (pathname === '/api/contact' && request.method === 'POST') {
      const { name, email, message } = await request.json();
      if (!name || !email || !message) return fail('Tous les champs sont obligatoires.');

      const id = crypto.randomUUID();
      await env.BWR_KV.put(`contact:${id}`, JSON.stringify({
        id, name, email, message: message.slice(0, 2000), date: new Date().toISOString(),
      }));

      try {
        await fetch('https://ntfy.sh/bwr-ciril8596', {
          method: 'POST',
          headers: { 'Title': `BWR — Message de ${name}`, 'Tags': 'envelope', 'Content-Type': 'text/plain; charset=utf-8' },
          body: `${email}\n\n${message}`,
        });
      } catch {}

      return json({ success: true });
    }

    // ── POST /api/push/subscribe — enable path alerts (silver/gold users) ─────
    if (pathname === '/api/push/subscribe' && request.method === 'POST') {
      const user = await getUserFromToken(env, request);
      if (!user) return fail('Non authentifié.', 401);
      const plan = user.plan || 'free';
      if (plan === 'free') return fail('Les alertes push sont disponibles avec le plan Or.', 403);

      const channel = `bwr-u-${user.id.slice(0, 8)}`;
      await putUser(env, { ...user, alertsEnabled: true, alertsChannel: channel });
      return json({ channel });
    }

    // ── POST /api/push/unsubscribe — disable path alerts ─────────────────────
    if (pathname === '/api/push/unsubscribe' && request.method === 'POST') {
      const user = await getUserFromToken(env, request);
      if (!user) return fail('Non authentifié.', 401);

      await putUser(env, { ...user, alertsEnabled: false });
      return json({ success: true });
    }

    return new Response('Not found', { status: 404, headers: cors });
  },
};
