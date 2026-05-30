// ── KV key schema ─────────────────────────────────────────────────────────────
// user:{id}          → JSON user object
// uemail:{email}     → userId string  (email index for fast lookup)
// pending:{token}    → JSON pending registration  (24-hour TTL, deleted on verify)
// pemail:{email}     → token string  (index so login can detect unverified accounts)
// path:{id}          → JSON path object
// report:{id}        → JSON report object
// photo:{reportId}   → data-URI string, 90-day TTL
// contact:{id}       → JSON contact message
// session:{token}    → JSON { userId, expiresAt }  (unchanged)
// osm:{bbox}         → JSON OSM data  (unchanged)
// savedroute:{userId}:{id} → JSON saved route (coords, stats, metadata)
// routeshare:{token}       → JSON { userId, routeId }  (180-day TTL)
// news:{id}                → JSON news item { id, title, content, url, urlLabel, createdAt, updatedAt }
// pathgrade:{pathId}:{userId} → JSON { walkedWhenGraded: bool } (legacy '1' = unwalked)
// walkedpath:{userId}:{pathId} → ISO timestamp string (legacy '1' = walked, unknown time)
// aisugg:{userId}:{date}   → JSON AI suggestion { icon, advice, dist, mode, startLat, startLng }  (48h TTL)
// leaderboard:cache        → JSON sorted entries array  (5-min TTL)

async function listKeys(env, prefix) {
  const keys = [];
  let cursor;
  do {
    const opts = { prefix, limit: 1000 };
    if (cursor) opts.cursor = cursor;
    const page = await env.BWR_KV.list(opts);
    keys.push(...page.keys);
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor !== undefined);
  return keys;
}

async function listItems(env, prefix) {
  const keys = await listKeys(env, prefix);
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

async function patchLeaderboardCache(env, updatedUser) {
  const raw = await env.BWR_KV.get('leaderboard:cache');
  if (!raw) return; // cache absent, sera reconstruit à la prochaine lecture GET /api/leaderboard
  const entries = JSON.parse(raw);
  const totalPaths = (await listKeys(env, 'path:')).length;
  const s = updatedUser.stats || {};
  const reports = s.reports || 0;
  const pathGrades = s.pathGrades || 0;
  const points = reports * 2 + pathGrades;
  const forestCoverage = totalPaths > 0
    ? Math.round((s.walkedPathsCount || 0) / totalPaths * 100) : 0;
  const entry = { id: updatedUser.id, name: updatedUser.name, reports, pathGrades, points, forestCoverage };
  const idx = entries.findIndex(e => e.id === updatedUser.id);
  if (idx >= 0) entries[idx] = entry; else entries.push(entry);
  entries.sort((a, b) => b.points - a.points || b.reports - a.reports);
  await env.BWR_KV.put('leaderboard:cache', JSON.stringify(entries));
}

// Returns the effective plan for a user, treating admin role as gold.
function effectivePlan(user) {
  if (user.role === 'admin') return 'gold';
  return user.plan || 'free';
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

// ── Generic fixed-window rate limiter ────────────────────────────────────────
// KV key: ratelimit:{scope}:{key} → { count }  TTL = windowSeconds
// Returns true when the request is allowed, false when the limit is exceeded.
async function checkRateLimit(env, scope, key, maxCount, windowSeconds) {
  const kvKey = `ratelimit:${scope}:${key}`;
  const raw = await env.BWR_KV.get(kvKey);
  const count = raw ? parseInt(raw, 10) : 0;
  if (count >= maxCount) return false;
  // Increment; reset TTL only on first write so the window is fixed from first hit.
  await env.BWR_KV.put(kvKey, String(count + 1), {
    expirationTtl: raw ? undefined : windowSeconds,
  });
  return true;
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

const PENDING_TTL = 86400; // 24 hours
const RESEND_COOLDOWN = 300; // 5 minutes between resend requests

async function sendVerificationEmail(env, origin, email, name, token) {
  if (!env.RESEND_API_KEY) return; // skip in dev if key not set
  const verifyUrl = `${origin}/verify.html?token=${token}`;
  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: env.RESEND_FROM || 'BWR <noreply@bwr.ciril8596.workers.dev>',
      to: email,
      subject: 'Vérifiez votre adresse email — BWR',
      html: `<p>Bonjour ${name},</p>
<p>Cliquez sur le lien ci-dessous pour activer votre compte BWR. Ce lien expire dans 24 heures.</p>
<p><a href="${verifyUrl}">${verifyUrl}</a></p>
<p>Si vous n'avez pas créé de compte, ignorez cet email.</p>`,
    }),
  });
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

      const emailKey = email.toLowerCase();
      const [existingUser, existingPending] = await Promise.all([
        env.BWR_KV.get(`uemail:${emailKey}`),
        env.BWR_KV.get(`pemail:${emailKey}`),
      ]);
      if (existingUser) return fail('Un compte existe déjà avec cet email.');
      if (existingPending) return fail("Un email de vérification a déjà été envoyé à cette adresse. Vérifiez votre boîte mail ou attendez 24 heures.");

      const salt = crypto.randomUUID();
      const passwordHash = await hashPassword(password, salt);
      const token = crypto.randomUUID();

      const pending = {
        id: crypto.randomUUID(),
        name,
        email: emailKey,
        passwordHash,
        salt,
        hashVersion: 2,
        createdAt: new Date().toISOString(),
        resendAfter: new Date(Date.now() + RESEND_COOLDOWN * 1000).toISOString(),
      };

      await Promise.all([
        env.BWR_KV.put(`pending:${token}`, JSON.stringify(pending), { expirationTtl: PENDING_TTL }),
        env.BWR_KV.put(`pemail:${emailKey}`, token, { expirationTtl: PENDING_TTL }),
      ]);

      const origin = new URL(request.url).origin;
      await sendVerificationEmail(env, origin, emailKey, name, token);

      return json({ message: "Un email de vérification a été envoyé. Cliquez sur le lien dans l'email pour activer votre compte." }, 201);
    }

    // ── GET /api/auth/verify ──────────────────────────────────────────────────
    if (pathname === '/api/auth/verify' && request.method === 'GET') {
      const token = url.searchParams.get('token');
      if (!token) return fail('Token manquant.', 400);

      const raw = await env.BWR_KV.get(`pending:${token}`);
      if (!raw) return fail('Lien invalide ou expiré.', 400);

      const pending = JSON.parse(raw);

      const alreadyRegistered = await env.BWR_KV.get(`uemail:${pending.email}`);
      if (alreadyRegistered) {
        await Promise.all([
          env.BWR_KV.delete(`pending:${token}`),
          env.BWR_KV.delete(`pemail:${pending.email}`),
        ]);
        return json({ message: 'Adresse email déjà vérifiée. Vous pouvez vous connecter.' });
      }

      const newUser = {
        id: pending.id,
        name: pending.name,
        email: pending.email,
        passwordHash: pending.passwordHash,
        salt: pending.salt,
        hashVersion: pending.hashVersion,
        role: 'free',
        plan: 'free',
        stats: { routes: 0, km: 0 },
        createdAt: pending.createdAt,
      };

      await Promise.all([
        putUser(env, newUser),
        env.BWR_KV.put(`uemail:${newUser.email}`, newUser.id),
        env.BWR_KV.delete(`pending:${token}`),
        env.BWR_KV.delete(`pemail:${newUser.email}`),
      ]);

      return json({ message: 'Email vérifié ! Vous pouvez maintenant vous connecter.' });
    }

    // ── POST /api/auth/resend-verification ────────────────────────────────────
    if (pathname === '/api/auth/resend-verification' && request.method === 'POST') {
      const body = await request.json();
      const emailKey = (body.email || '').toLowerCase();
      if (!emailKey) return fail('Email requis.');

      const currentToken = await env.BWR_KV.get(`pemail:${emailKey}`);
      if (!currentToken) {
        return json({ message: "Si un compte en attente existe, un nouvel email a été envoyé." });
      }

      const raw = await env.BWR_KV.get(`pending:${currentToken}`);
      if (!raw) return json({ message: "Si un compte en attente existe, un nouvel email a été envoyé." });

      const pending = JSON.parse(raw);
      if (new Date(pending.resendAfter) > new Date()) {
        return fail("Veuillez attendre quelques minutes avant de renvoyer l'email.", 429);
      }

      const newToken = crypto.randomUUID();
      pending.resendAfter = new Date(Date.now() + RESEND_COOLDOWN * 1000).toISOString();

      await Promise.all([
        env.BWR_KV.delete(`pending:${currentToken}`),
        env.BWR_KV.put(`pending:${newToken}`, JSON.stringify(pending), { expirationTtl: PENDING_TTL }),
        env.BWR_KV.put(`pemail:${emailKey}`, newToken, { expirationTtl: PENDING_TTL }),
      ]);

      const origin = new URL(request.url).origin;
      await sendVerificationEmail(env, origin, emailKey, pending.name, newToken);

      return json({ message: 'Un nouvel email de vérification a été envoyé.' });
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
        // Check if the account exists but hasn't been verified yet
        const pendingToken = await env.BWR_KV.get(`pemail:${emailKey}`);
        if (pendingToken) {
          return json({ error: 'Votre email n\'est pas encore vérifié. Vérifiez votre boîte mail.', unverified: true }, 403);
        }
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

      // daily_wheel is silver+ only
      if (effectivePlan(user) === 'free') return fail('La roue est disponible avec le plan Argent.', 403);

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

    // ── GET /api/osm — proxy + cache via Overpass API ───────────────────────
    // Overpass has no strict bbox size limit (unlike OSM main API's 0.25°×0.25° cap).
    // Cache key uses "osmv2:" prefix so old OSM-API cached entries are bypassed.
    if (pathname === '/api/osm' && request.method === 'GET') {
      const bbox = url.searchParams.get('bbox');
      if (!bbox) return fail('bbox parameter required');

      const cacheKey = `osmv2:${bbox}`;
      const cached = await env.BWR_KV.get(cacheKey);
      if (cached) return json(JSON.parse(cached));

      const [s, w, n, e] = bbox.split(',');
      try {
        // Overpass QL: fetch forest/foot path ways and their nodes in one shot.
        const query = `[out:json][timeout:25];(way["highway"~"^(path|track|footway|bridleway|cycleway)$"](${s},${w},${n},${e});>;);out body;`;
        const res = await fetch('https://overpass-api.de/api/interpreter', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: `data=${encodeURIComponent(query)}`,
        });
        if (!res.ok) return fail('Overpass API error', 502);
        const raw = await res.json();

        // Secondary filter for safety (Overpass already filtered, just keep consistent shape)
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
        return fail('Overpass API unavailable', 502);
      }
    }

    // ── DELETE /api/osm/cache — admin: flush one bbox or all osmv2 entries ───
    if (pathname === '/api/osm/cache' && request.method === 'DELETE') {
      const user = await getUserFromToken(env, request);
      if (!user || user.role !== 'admin') return fail('Accès refusé.', 403);

      const bbox = url.searchParams.get('bbox');
      if (bbox) {
        await env.BWR_KV.delete(`osmv2:${bbox}`);
        return json({ deleted: 1, bbox });
      }

      // No bbox → flush all osmv2:* keys
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

    // ── POST /api/route — proxy to OpenRouteService ──────────────────────────
    if (pathname === '/api/route' && request.method === 'POST') {
      const user = await getUserFromToken(env, request);
      if (!user) return fail('Non authentifié.', 401);

      if (!env.ORS_KEY) return fail('Clé ORS manquante — configure ORS_KEY dans les variables du Worker.', 503);

      try {
        const { profile, coordinates, round_trip } = await request.json();

        // loop_mode is silver+
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
        return fail('Service de routage indisponible: ' + e.message, 503);
      }
    }

    // ── PUT /api/auth/profile — update name / email / home address ───────────
    if (pathname === '/api/auth/profile' && request.method === 'PUT') {
      const user = await getUserFromToken(env, request);
      if (!user) return fail('Non authentifié.', 401);

      const { name, email, homeAddress, homeCoords } = await request.json();
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

      const updated = {
        ...user,
        name,
        email: newEmail,
        homeAddress: homeAddress || user.homeAddress || null,
        homeCoords: homeCoords || user.homeCoords || null,
      };
      await putUser(env, updated);
      return json({ id: updated.id, name: updated.name, email: updated.email, role: updated.role, homeAddress: updated.homeAddress, homeCoords: updated.homeCoords });
    }

    // ── POST /api/auth/stats — increment route/km stats ─────────────────────────
    if (pathname === '/api/auth/stats' && request.method === 'POST') {
      const user = await getUserFromToken(env, request);
      if (!user) return fail('Non authentifié.', 401);

      const body = await request.json();
      const deltaRoutes = Math.max(0, parseInt(body.routes) || 0);
      const deltaKm     = Math.max(0, parseFloat(body.km) || 0);

      const prev = user.stats || { routes: 0, km: 0 };
      const today = new Date().toISOString().slice(0, 10);
      const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
      const lastDate = prev.lastRouteDate;
      let streak = prev.streak || 0;
      let lastRouteDate = lastDate;
      if (deltaRoutes > 0) {
        if (lastDate === today) {
          // already counted today — keep streak as-is
        } else if (lastDate === yesterday) {
          streak += 1;
          lastRouteDate = today;
        } else {
          streak = 1;
          lastRouteDate = today;
        }
      }
      const updatedStats = {
        ...prev,
        routes: (prev.routes || 0) + deltaRoutes,
        km: parseFloat(((prev.km || 0) + deltaKm).toFixed(2)),
        streak,
        lastRouteDate,
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
        return json({ ok: false, used: weeklyRoutes, limit: LIMIT }, 429);
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

    // ── POST /api/paths — admin or silver+ ───────────────────────────────────
    if (pathname === '/api/paths' && request.method === 'POST') {
      const user = await getUserFromToken(env, request);
      if (!user) return fail('Connexion requise.', 401);
      const plan = effectivePlan(user);
      const allowed = plan === 'gold' || plan === 'silver';
      if (!allowed) return fail('Abonnement Argent requis.', 403);

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

    // ── PATCH /api/paths/:id — authenticated users; 'hard' requires silver+ ──
    if (pathname.startsWith('/api/paths/') && request.method === 'PATCH') {
      const user = await getUserFromToken(env, request);
      if (!user) return fail('Connexion requise.', 401);
      const plan = effectivePlan(user);

      const id = pathname.split('/')[3];
      const body = await request.json();
      const existing = await getPath(env, id);
      if (!existing) return fail('Chemin introuvable.', 404);

      const validStatuses = ['easy', 'medium', 'hard', 'not_passable', 'no_bike'];
      if (!body.status || !validStatuses.includes(body.status)) {
        return fail('Statut invalide.', 400);
      }

      if (body.status === 'hard' && plan === 'free') {
        return fail('Abonnement Argent requis pour marquer Difficile.', 403);
      }

      const oldStatus = existing.status;
      const updated = { ...existing, status: body.status };
      await putPath(env, updated);

      const gradeKey = `pathgrade:${id}:${user.id}`;
      const [alreadyGraded, walkedRaw] = await Promise.all([
        env.BWR_KV.get(gradeKey),
        env.BWR_KV.get(`walkedpath:${user.id}:${id}`),
      ]);

      // Check if user walked this specific path in the last 24 h
      let walkedRecently = false;
      if (walkedRaw && walkedRaw !== '1') {
        const walkedAt = new Date(walkedRaw);
        if (!isNaN(walkedAt) && Date.now() - walkedAt.getTime() < 86_400_000) {
          walkedRecently = true;
        }
      }

      if (!alreadyGraded) {
        if (!walkedRecently) {
          const unwalkedGrades = user.stats?.unwalkedGrades || 0;
          if (unwalkedGrades >= 5) {
            return fail('Limite de 5 notations libres atteinte. Parcourez ce chemin pour le noter sans limite.', 403);
          }
        }
        const gStats = user.stats || { routes: 0, km: 0 };
        const newStats = { ...gStats, pathGrades: (gStats.pathGrades || 0) + 1 };
        if (!walkedRecently) newStats.unwalkedGrades = (gStats.unwalkedGrades || 0) + 1;
        const gradedUser = { ...user, stats: newStats };
        await Promise.all([
          env.BWR_KV.put(gradeKey, JSON.stringify({ walkedWhenGraded: walkedRecently })),
          putUser(env, gradedUser),
        ]);
        patchLeaderboardCache(env, gradedUser);
      }

      if (body.status !== oldStatus) {
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

    // ── DELETE /api/paths/:id — admin or silver+ ─────────────────────────────
    if (pathname.startsWith('/api/paths/') && request.method === 'DELETE') {
      const user = await getUserFromToken(env, request);
      if (!user) return fail('Connexion requise.', 401);
      const plan = effectivePlan(user);
      const allowed = plan === 'gold' || plan === 'silver';
      if (!allowed) return fail('Abonnement Argent requis.', 403);

      const id = pathname.split('/')[3];
      await env.BWR_KV.delete(`path:${id}`);

      // Reverse XP for every user who graded this path
      const gradePrefix = `pathgrade:${id}:`;
      const gradePage = await env.BWR_KV.list({ prefix: gradePrefix, limit: 1000 });
      if (gradePage.keys.length > 0) {
        await Promise.all(gradePage.keys.map(async k => {
          const graderId = k.name.slice(gradePrefix.length);
          const gradeRaw = await env.BWR_KV.get(k.name);
          let walkedWhenGraded = false;
          if (gradeRaw && gradeRaw !== '1') {
            try { walkedWhenGraded = JSON.parse(gradeRaw).walkedWhenGraded; } catch {}
          }
          const grader = await getUser(env, graderId);
          if (grader) {
            const gs = grader.stats || {};
            const newStats = { ...gs, pathGrades: Math.max(0, (gs.pathGrades || 0) - 1) };
            if (!walkedWhenGraded) newStats.unwalkedGrades = Math.max(0, (gs.unwalkedGrades || 0) - 1);
            await putUser(env, { ...grader, stats: newStats });
          }
          await env.BWR_KV.delete(k.name);
        }));
      }

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
      const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
      return new Response(bytes, {
        headers: { ...cors, 'Content-Type': mime, 'Cache-Control': 'public, max-age=2592000' },
      });
    }

    // ── POST /api/reports — silver+ ──────────────────────────────────────────
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
        const MAX_PHOTO_BYTES = 1_048_576; // 1 MB base64 string (~750 KB decoded)
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

      const typeLabels = { fallen_tree: 'Arbre tombé', flooded: 'Chemin inondé', muddy: 'Boueux', rutted: 'Ornières', broken_sign: 'Carrefour cassé', closed: 'Chemin fermé', danger: 'Danger', other: 'Autre' };
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

    // ── GET /api/contacts — admin only, list all contact messages ───────────
    if (pathname === '/api/contacts' && request.method === 'GET') {
      const admin = await getUserFromToken(env, request);
      if (!admin || admin.role !== 'admin') return fail('Accès refusé.', 403);
      const messages = await listItems(env, 'contact:');
      messages.sort((a, b) => new Date(b.date) - new Date(a.date));
      return json(messages);
    }

    // ── DELETE /api/contacts/:id — admin only ────────────────────────────────
    if (pathname.startsWith('/api/contacts/') && request.method === 'DELETE') {
      const admin = await getUserFromToken(env, request);
      if (!admin || admin.role !== 'admin') return fail('Accès refusé.', 403);
      const id = pathname.split('/')[3];
      await env.BWR_KV.delete(`contact:${id}`);
      return json({ success: true });
    }

    // ── POST /api/contact — send a contact message ──────────────────────────
    if (pathname === '/api/contact' && request.method === 'POST') {
      const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
      if (!await checkRateLimit(env, 'contact', ip, 2, 3600))
        return fail('Trop de messages. Réessayez dans une heure.', 429);
      const { name, email, message } = await request.json();
      if (!name || !email || !message) return fail('Tous les champs sont obligatoires.');

      const id = crypto.randomUUID();
      await env.BWR_KV.put(`contact:${id}`, JSON.stringify({
        id, name, email, message: message.slice(0, 2000), date: new Date().toISOString(),
      }));

      const adminEmail = env.ADMIN_EMAIL || 'ciril8596@gmail.com';
      try {
        await fetch('https://ntfy.sh/bwr-ciril8596', {
          method: 'POST',
          headers: { 'Title': `BWR — Message de ${name}`, 'Tags': 'envelope', 'Content-Type': 'text/plain; charset=utf-8' },
          body: `${email}\n\n${message}`,
        });
      } catch {}
      if (env.RESEND_API_KEY) {
        try {
          await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              from: env.RESEND_FROM || 'BWR <noreply@bwr.ciril8596.workers.dev>',
              to: adminEmail,
              subject: `BWR — Nouveau message de ${name}`,
              html: `<p><strong>De :</strong> ${name} &lt;${email}&gt;</p>
<p><strong>Date :</strong> ${new Date().toLocaleString('fr-FR')}</p>
<hr/>
<p>${message.replace(/\n/g, '<br/>')}</p>`,
            }),
          });
        } catch {}
      }

      return json({ success: true });
    }

    // ── POST /api/savedroutes — save a route (Silver+) ───────────────────────
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

    // ── GET /api/savedroutes — list user's saved routes (Silver+) ────────────
    if (pathname === '/api/savedroutes' && request.method === 'GET') {
      const user = await getUserFromToken(env, request);
      if (!user) return fail('Non authentifié.', 401);
      if (effectivePlan(user) === 'free') return fail('Abonnement Argent requis.', 403);

      const routes = await listItems(env, `savedroute:${user.id}:`);
      // Sort by savedAt descending, strip coords from list response to keep it light
      routes.sort((a, b) => (b.savedAt || '').localeCompare(a.savedAt || ''));
      const summary = routes.map(({ coords: _c, ...rest }) => rest);
      return json(summary);
    }

    // ── GET /api/savedroutes/:id — get a single saved route (owner only) ─────
    if (pathname.startsWith('/api/savedroutes/') && !pathname.includes('/share/') && request.method === 'GET') {
      const user = await getUserFromToken(env, request);
      if (!user) return fail('Non authentifié.', 401);

      const id = pathname.split('/')[3];
      const raw = await env.BWR_KV.get(`savedroute:${user.id}:${id}`);
      if (!raw) return fail('Trajet introuvable.', 404);
      return json(JSON.parse(raw));
    }

    // ── DELETE /api/savedroutes/:id — delete own saved route ─────────────────
    if (pathname.startsWith('/api/savedroutes/') && !pathname.includes('/share/') && request.method === 'DELETE') {
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

    // ── GET /api/savedroutes/share/:token — public share endpoint ────────────
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

    // ── GET /api/news — public news feed ─────────────────────────────────────
    if (pathname === '/api/news' && request.method === 'GET') {
      const items = await listItems(env, 'news:');
      items.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
      return json(items);
    }

    // ── POST /api/news — create news item (admin only) ────────────────────────
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
        imageUrl: (body.imageUrl || '').trim().slice(0, 1000),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await env.BWR_KV.put(`news:${id}`, JSON.stringify(item));
      return json(item, 201);
    }

    // ── PUT /api/news/:id — edit news item (admin only) ───────────────────────
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
        imageUrl: (body.imageUrl || '').trim().slice(0, 1000),
        updatedAt: new Date().toISOString(),
      };
      await env.BWR_KV.put(`news:${id}`, JSON.stringify(updated));
      return json(updated);
    }

    // ── DELETE /api/news/:id — delete news item (admin only) ─────────────────
    if (pathname.startsWith('/api/news/') && request.method === 'DELETE') {
      const user = await getUserFromToken(env, request);
      if (!user || user.role !== 'admin') return fail('Accès refusé.', 403);

      const id = pathname.split('/')[3];
      await env.BWR_KV.delete(`news:${id}`);
      return json({ success: true });
    }

    // ── POST /api/push/subscribe — enable path alerts (gold only) ─────────────
    if (pathname === '/api/push/subscribe' && request.method === 'POST') {
      const user = await getUserFromToken(env, request);
      if (!user) return fail('Non authentifié.', 401);
      if (effectivePlan(user) !== 'gold') return fail('Les alertes push sont disponibles avec le plan Or.', 403);

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

    // ── POST /api/walkedpaths — mark admin paths as walked ─────────────────────
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

      // Always update timestamp so the 24 h grading window stays fresh on revisit
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

    // ── GET /api/walkedpaths — get walked path info for current user ────────────
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

    // ── GET /api/leaderboard — public ──────────────────────────────────────────
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

    // ── GET /api/ai-suggestion — personalized AI hike suggestion (Silver/Gold) ─
    if (pathname === '/api/ai-suggestion' && request.method === 'GET') {
      const user = await getUserFromToken(env, request);
      if (!user) return fail('Non authentifié.', 401);
      const plan = effectivePlan(user);
      if (plan === 'free') return fail('Réservé aux membres Argent et Or.', 403);

      const today = new Date().toLocaleDateString('fr-CA', { timeZone: 'Europe/Paris' }); // YYYY-MM-DD Paris
      const cacheKey = `aisugg:${user.id}:${today}`;
      const cached = await env.BWR_KV.get(cacheKey);
      if (cached) return json(JSON.parse(cached));

      // Not pre-generated yet — generate on-demand and cache
      const suggestion = await generateAISuggestionForUser(env, user, today);
      await env.BWR_KV.put(cacheKey, JSON.stringify(suggestion), { expirationTtl: 172800 }); // 48h
      return json(suggestion);
    }

    // ── POST /api/ai-tip — personalized AI hiking tip ────────────────────────
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

    return new Response('Not found', { status: 404, headers: cors });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      generateDailySuggestions(env).catch(err =>
        fetch('https://ntfy.sh/bwr-ciril8596', {
          method: 'POST',
          headers: { Title: 'BWR cron FAILED', Priority: 'high', Tags: 'rotating_light' },
          body: `generateDailySuggestions crash: ${err?.message ?? err}`,
        }).catch(() => {})
      )
    );
  },
};

// ── AI suggestion helpers ─────────────────────────────────────────────────────

async function geocodeAddress(address) {
  try {
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(address)}&format=json&limit=1&countrycodes=fr`;
    const res = await fetch(url, { headers: { 'User-Agent': 'BWR-App/1.0' } });
    const data = await res.json();
    if (data && data[0]) return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) };
  } catch {}
  return null;
}

async function fetchWeatherForCoords(lat, lng) {
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}&current=temperature_2m,weather_code,wind_speed_10m,apparent_temperature&timezone=Europe%2FParis`;
    const res = await fetch(url);
    const data = await res.json();
    return {
      temp: data.current?.temperature_2m ?? 15,
      feels: data.current?.apparent_temperature ?? 15,
      code: data.current?.weather_code ?? 0,
      wind: data.current?.wind_speed_10m ?? 10,
    };
  } catch {
    return { temp: 15, feels: 15, code: 0, wind: 10 };
  }
}

async function generateAISuggestionForUser(env, user, date) {
  const stats = user.stats || {};
  const km = stats.km || 0;
  const routes = stats.routes || 0;

  // Determine typical distance from user stats
  const typicalKm = km < 5 ? 4 : km < 25 ? 7 : km < 50 ? 12 : km < 100 ? 15 : 18;

  // Starting coords: user's home address geocoded, fallback to forest center
  let startLat = 49.35, startLng = 2.90, fromHome = false;
  if (user.homeCoords) {
    startLat = user.homeCoords.lat;
    startLng = user.homeCoords.lng;
    fromHome = true;
  } else if (user.homeAddress && env.ANTHROPIC_API_KEY) {
    const coords = await geocodeAddress(user.homeAddress);
    if (coords) { startLat = coords.lat; startLng = coords.lng; fromHome = true; }
  }

  const weather = await fetchWeatherForCoords(startLat, startLng);
  const month = new Date().getMonth();
  const season = month <= 1 || month === 11 ? 'hiver' : month <= 4 ? 'printemps' : month <= 7 ? 'été' : 'automne';
  const plan = effectivePlan(user);
  const level = plan === 'gold' ? 'expert' : 'intermédiaire';

  // Hot weather flag → suggest lake/river paths
  const isHot = weather.temp >= 25;
  const isStormy = weather.code >= 95;
  const isRainy = weather.code >= 61 && weather.code <= 82;
  const isWindy = weather.wind > 30;

  if (!env.ANTHROPIC_API_KEY) {
    return buildFallbackSuggestion(weather, typicalKm, isHot, isStormy, isRainy, isWindy, startLat, startLng, fromHome);
  }

  const weatherDesc = isStormy ? 'orages signalés' : isRainy ? `pluie (code ${weather.code})` : isWindy ? `vent fort ${Math.round(weather.wind)} km/h` : isHot ? `chaleur ${Math.round(weather.temp)}°C` : `agréable ${Math.round(weather.temp)}°C`;
  const homeHint = user.homeAddress ? `L'utilisateur habite "${user.homeAddress}".` : 'Départ depuis la forêt de Compiègne.';

  const prompt = `Tu es un guide expert de la Forêt de Compiègne (France).
Génère UNE suggestion de balade personnalisée en français (2-3 phrases max, 40-60 mots).
Profil randonneur : ${km.toFixed(0)} km total, ${routes} sorties, niveau ${level}, saison ${season}.
Météo aujourd'hui : ${weatherDesc}.
${homeHint}
${isHot ? 'Comme il fait chaud, suggère un sentier ombragé au bord d\'un lac ou d\'un cours d\'eau dans la forêt.' : ''}
${isStormy ? 'Déconseille la sortie et propose une alternative.' : ''}
Distance suggérée : environ ${typicalKm} km.
Inclus le nom d'un lieu réel de la forêt de Compiègne. Réponds uniquement avec la suggestion, sans guillemets.`;

  let icon = isStormy ? '⛈️' : isRainy ? '🌧️' : isWindy ? '💨' : isHot ? '🏖️' : '✅';
  let advice = '';
  let dist = isStormy ? 0 : isRainy ? Math.max(3, typicalKm - 3) : typicalKm;
  const mode = 'loop';

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
        max_tokens: 180,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (aiRes.ok) {
      const d = await aiRes.json();
      advice = d.content?.[0]?.text?.trim() || '';
    }
  } catch {}

  if (!advice) return buildFallbackSuggestion(weather, typicalKm, isHot, isStormy, isRainy, isWindy, startLat, startLng, fromHome);

  return { icon, advice, dist, mode, startLat, startLng, fromHome, temp: Math.round(weather.temp), wind: Math.round(weather.wind) };
}

function buildFallbackSuggestion(weather, typicalKm, isHot, isStormy, isRainy, isWindy, startLat, startLng, fromHome = false) {
  let icon, advice, dist;
  if (isStormy) {
    icon = '⛈️'; dist = 0;
    advice = 'Orages signalés aujourd\'hui — restez en sécurité, ne partez pas en forêt.';
  } else if (isRainy) {
    icon = '🌧️'; dist = Math.max(3, typicalKm - 3);
    advice = `Pluie prévue — sortie courte de ${dist} km conseillée avec un imperméable.`;
  } else if (isWindy) {
    icon = '💨'; dist = Math.max(4, typicalKm - 2);
    advice = `Vent fort (${Math.round(weather.wind)} km/h) — évitez les zones boisées denses, boucle de ${dist} km recommandée.`;
  } else if (isHot) {
    icon = '🏖️'; dist = typicalKm;
    advice = `Chaleur ${Math.round(weather.temp)}°C — partez tôt et privilégiez les sentiers ombragés au bord des étangs de la forêt.`;
  } else {
    icon = '✅'; dist = typicalKm;
    advice = `Conditions idéales — profitez d'une boucle de ${dist} km à travers les beaux sentiers de la forêt de Compiègne.`;
  }
  return { icon, advice, dist, mode: 'loop', startLat, startLng, fromHome, temp: Math.round(weather.temp), wind: Math.round(weather.wind) };
}

async function generateDailySuggestions(env) {
  const today = new Date().toLocaleDateString('fr-CA', { timeZone: 'Europe/Paris' });

  const keys = [];
  let cursor;
  do {
    const page = await env.BWR_KV.list({ prefix: 'user:', limit: 1000, cursor });
    keys.push(...page.keys);
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  let ok = 0, skipped = 0;
  const errors = [];

  for (const key of keys) {
    try {
      const raw = await env.BWR_KV.get(key.name);
      if (!raw) { skipped++; continue; }
      const user = JSON.parse(raw);
      const plan = effectivePlan(user);
      if (plan === 'free') { skipped++; continue; }

      const cacheKey = `aisugg:${user.id}:${today}`;
      const existing = await env.BWR_KV.get(cacheKey);
      if (existing) { skipped++; continue; }

      const suggestion = await generateAISuggestionForUser(env, user, today);
      await env.BWR_KV.put(cacheKey, JSON.stringify(suggestion), { expirationTtl: 172800 });
      ok++;

      await new Promise(r => setTimeout(r, 300));
    } catch (err) {
      errors.push(`${key.name}: ${err?.message ?? err}`);
    }
  }

  if (errors.length > 0) {
    await fetch('https://ntfy.sh/bwr-ciril8596', {
      method: 'POST',
      headers: { Title: `BWR cron: ${errors.length} erreur(s)`, Priority: 'default', Tags: 'warning' },
      body: `OK: ${ok} | Ignorés: ${skipped} | Erreurs: ${errors.length}\n\n${errors.slice(0, 10).join('\n')}`,
    }).catch(() => {});
  }
}
