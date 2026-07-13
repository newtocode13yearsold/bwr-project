import { putUser, getUserByEmail, getUser, effectivePlan, recordAuthEvent, listKeys, listItems } from '../kv.js';
import {
  hashPasswordLegacy, hashPassword, getUserFromToken,
  isoMonday, checkRateLimit,
  getLoginAttempts, recordFailedLogin,
  PENDING_TTL, RESEND_COOLDOWN, RESET_TTL, RESET_COOLDOWN,
  sendVerificationEmail, sendPasswordResetEmail,
} from '../auth-utils.js';

const REGISTER_RATE_LIMIT = { max: 5, window: 3600 };
const FORGOT_RATE_LIMIT = { max: 5, window: 3600 };

/**
 * Auth endpoints: register, verify, login, logout, me, profile, password,
 * account deletion, plan management, stats, weekly quota, wheel prize.
 * @param {Request} request
 * @param {import('../kv.js').Env} env
 * @param {{ pathname: string, url: URL, json: Function, fail: Function }} ctx
 * @returns {Promise<Response|null>}
 */
export async function handleAuth(request, env, { pathname, url, json, fail, cors }) {
  if (pathname === '/api/auth/register' && request.method === 'POST') {
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    if (!await checkRateLimit(env, 'register', ip, REGISTER_RATE_LIMIT.max, REGISTER_RATE_LIMIT.window))
      return fail('Trop de tentatives. Réessayez dans une heure.', 429);

    const body = await request.json();
    const { name, email, password } = body;

    if (!name || !email || !password) return fail('Tous les champs sont obligatoires.');
    if (password.length < 8) return fail('Le mot de passe doit faire au moins 8 caractères.');

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
    try {
      await sendVerificationEmail(env, origin, emailKey, name, token);
    } catch (e) {
      console.error('register: verification email failed:', e && e.message);
      return fail("Votre compte a été créé mais l'envoi de l'email de vérification a échoué. Utilisez le bouton « Renvoyer l'email » sur la page de connexion.", 500);
    }

    return json({ message: "Un email de vérification a été envoyé. Cliquez sur le lien dans l'email pour activer votre compte." }, 201);
  }

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

    // Count this as a new account in the admin activity panel.
    await recordAuthEvent(env, 'signup', newUser);

    return json({ message: 'Email vérifié ! Vous pouvez maintenant vous connecter.' });
  }

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

  if (pathname === '/api/auth/forgot-password' && request.method === 'POST') {
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    if (!await checkRateLimit(env, 'forgot', ip, FORGOT_RATE_LIMIT.max, FORGOT_RATE_LIMIT.window))
      return fail('Trop de demandes. Réessayez dans une heure.', 429);

    const body = await request.json();
    const emailKey = (body.email || '').toLowerCase();
    if (!emailKey) return fail('Email requis.');

    // Generic response in all cases below — never reveal whether an account exists.
    const generic = { message: "Si un compte existe pour cette adresse, un email de réinitialisation a été envoyé." };

    const user = await getUserByEmail(env, emailKey);
    if (!user) return json(generic);

    // Per-address cooldown so the same inbox can't be flooded with reset emails.
    if (!await checkRateLimit(env, 'forgotemail', emailKey, 1, RESET_COOLDOWN)) return json(generic);

    const token = crypto.randomUUID();
    await env.BWR_KV.put(
      `reset:${token}`,
      JSON.stringify({ userId: user.id, expiresAt: new Date(Date.now() + RESET_TTL * 1000).toISOString() }),
      { expirationTtl: RESET_TTL },
    );

    const origin = new URL(request.url).origin;
    try {
      await sendPasswordResetEmail(env, origin, user.email, user.name, token);
    } catch {
      // Don't leak the failure either — admin is notified via ntfy inside the helper.
    }

    return json(generic);
  }

  if (pathname === '/api/auth/reset-password' && request.method === 'POST') {
    const { token, password } = await request.json();
    if (!token || !password) return fail('Champs obligatoires.');
    if (password.length < 8) return fail('Le mot de passe doit faire au moins 8 caractères.');

    const raw = await env.BWR_KV.get(`reset:${token}`);
    if (!raw) return fail('Lien invalide ou expiré.', 400);

    const reset = JSON.parse(raw);
    if (new Date(reset.expiresAt) < new Date()) {
      await env.BWR_KV.delete(`reset:${token}`);
      return fail('Lien invalide ou expiré.', 400);
    }

    const user = await getUser(env, reset.userId);
    if (!user) {
      await env.BWR_KV.delete(`reset:${token}`);
      return fail('Lien invalide ou expiré.', 400);
    }

    const newSalt = crypto.randomUUID();
    const newHash = await hashPassword(password, newSalt);
    await putUser(env, {
      ...user,
      passwordHash: newHash,
      salt: newSalt,
      hashVersion: 2,
      sessionsInvalidatedAt: new Date().toISOString(),
    });

    // Single-use: burn the token, and clear any login lockout so the user can sign in immediately.
    await Promise.all([
      env.BWR_KV.delete(`reset:${token}`),
      env.BWR_KV.delete(`loginattempts:${user.email}`),
    ]);

    return json({ message: 'Mot de passe réinitialisé. Vous pouvez maintenant vous connecter.' });
  }

  if (pathname === '/api/auth/login' && request.method === 'POST') {
    const body = await request.json();
    const { email, password } = body;

    if (!email || !password) return fail('Email et mot de passe requis.');

    const emailKey = email.toLowerCase();

    const attempts = await getLoginAttempts(env, emailKey);
    if (attempts.lockedUntil && new Date(attempts.lockedUntil) > new Date()) {
      return json({ error: 'Compte temporairement verrouillé après trop de tentatives. Réessayez dans 10 minutes.' }, 429);
    }

    const user = await getUserByEmail(env, email);
    if (!user) {
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

    await env.BWR_KV.delete(`loginattempts:${emailKey}`);

    const token = crypto.randomUUID();
    const issuedAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    await env.BWR_KV.put(`session:${token}`, JSON.stringify({ userId: user.id, issuedAt, expiresAt }), { expirationTtl: 2592000 });

    // Count this login in the admin activity panel (admins are skipped inside the helper).
    await recordAuthEvent(env, 'login', user);

    return json({
      token,
      user: { id: user.id, name: user.name, email: user.email, role: user.role, plan: user.plan || 'free', stats: user.stats || { routes: 0, km: 0 } },
    });
  }

  if (pathname === '/api/auth/me' && request.method === 'GET') {
    let user = await getUserFromToken(env, request);
    if (!user) return fail('Non authentifié.', 401);

    let dirty = false;
    let updated = { ...user };

    if (updated.planExpiresAt && new Date(updated.planExpiresAt) < new Date()) {
      const revertTo = updated.planBase || 'free';
      updated = { ...updated, plan: revertTo, planExpiresAt: null, planBase: null };
      dirty = true;
    }

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
      visitorPlanCount: updated.visitorPlanCount || 0,
      silverTrialUsed: !!updated.silverTrialUsed,
      emailNotifications: updated.emailNotifications !== false, // default on
      stats: updated.stats || { routes: 0, km: 0, weeklyRoutes: 0, weekStart: isoMonday() },
    });
  }

  // Toggle notification emails (forum replies + route-hazard alerts). Absent flag
  // means opted-in; the email senders check `emailNotifications !== false`.
  if (pathname === '/api/auth/notifications' && request.method === 'PUT') {
    const user = await getUserFromToken(env, request);
    if (!user) return fail('Non authentifié.', 401);
    const { emailNotifications } = await request.json().catch(() => ({}));
    await putUser(env, { ...user, emailNotifications: emailNotifications !== false });
    return json({ emailNotifications: emailNotifications !== false });
  }

  if (pathname.startsWith('/api/auth/plan/') && request.method === 'PUT') {
    const admin = await getUserFromToken(env, request);
    if (!admin || admin.role !== 'admin') return fail('Accès refusé.', 403);

    const targetId = pathname.split('/')[4];
    const { plan, planExpiresAt, planBase, comped } = await request.json();
    if (!['free', 'silver', 'gold', 'visitor'].includes(plan)) return fail('Plan invalide.');

    const target = await getUser(env, targetId);
    if (!target) return fail('Utilisateur introuvable.', 404);

    if (plan === 'visitor') {
      const usedCount = target.visitorPlanCount || 0;
      if (usedCount >= 2) return fail('Cet utilisateur a déjà utilisé le passe Visiteur 2 fois (limite atteinte).', 400);
    }

    const updated = { ...target, plan };
    if (plan === 'visitor') updated.visitorPlanCount = (target.visitorPlanCount || 0) + 1;
    if (planExpiresAt !== undefined) updated.planExpiresAt = planExpiresAt || null;
    if (planBase !== undefined) updated.planBase = planBase || null;
    // `comped` = abonnement offert gratuitement : exclu du CA, mais visible dans l'analyse IA.
    // Un plan gratuit/visiteur ne peut pas être « offert » (rien à compter).
    if (comped !== undefined) updated.comped = (plan === 'silver' || plan === 'gold') ? !!comped : false;
    await putUser(env, updated);

    return json({ success: true, plan, planExpiresAt: updated.planExpiresAt || null, visitorPlanCount: updated.visitorPlanCount });
  }

  // Self-service free 7-day Silver trial. One per account, free accounts only.
  // Reuses the planExpiresAt/planBase expiry mechanism (see /api/auth/me): when
  // the 7 days elapse the plan reverts to 'free' automatically on the next read.
  if (pathname === '/api/auth/start-trial' && request.method === 'POST') {
    const user = await getUserFromToken(env, request);
    if (!user) return fail('Non authentifié.', 401);

    if (user.silverTrialUsed) return fail('Vous avez déjà utilisé votre essai gratuit Argent.', 409);
    if (user.role === 'admin' || (user.plan || 'free') !== 'free') {
      return fail("L'essai gratuit est réservé aux comptes Gratuit.", 400);
    }

    const TRIAL_DAYS = 7;
    const expiresAt = new Date(Date.now() + TRIAL_DAYS * 86400000).toISOString();
    await putUser(env, {
      ...user,
      plan: 'silver',
      planExpiresAt: expiresAt,
      planBase: 'free',
      silverTrialUsed: true,
      silverTrialStartedAt: new Date().toISOString(),
    });

    return json({ success: true, plan: 'silver', planExpiresAt: expiresAt });
  }

  if (pathname === '/api/auth/wheel-prize' && request.method === 'POST') {
    const user = await getUserFromToken(env, request);
    if (!user) return fail('Non authentifié.', 401);

    if (effectivePlan(user) === 'free') return fail('La roue est disponible avec le plan Argent.', 403);

    const { prizeType, plan: prizePlan, days } = await request.json();
    if (prizeType !== 'plan') return json({ success: true });

    const validUpgrades = { free: ['silver'], silver: ['gold'] };
    const currentPlan = user.plan || 'free';
    if (!validUpgrades[currentPlan]?.includes(prizePlan)) {
      return fail('Mise à niveau invalide pour ton abonnement actuel.', 400);
    }

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

  if (pathname === '/api/auth/logout' && request.method === 'POST') {
    const auth = request.headers.get('Authorization');
    if (auth && auth.startsWith('Bearer ')) {
      await env.BWR_KV.delete(`session:${auth.slice(7)}`);
    }
    return json({ message: 'Déconnecté.' });
  }

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

  if (pathname === '/api/auth/stats' && request.method === 'POST') {
    const user = await getUserFromToken(env, request);
    if (!user) return fail('Non authentifié.', 401);

    const body = await request.json();
    const deltaRoutes = Math.max(0, parseInt(body.routes) || 0);
    const deltaKm     = Math.max(0, parseFloat(body.km) || 0);
    const resetKm     = body.resetKm === true;

    const prev = user.stats || { routes: 0, km: 0 };

    // resetKm: wipe all distance data (used when switching from generated-route
    // km to GPS-only km so inflated historical values are cleared).
    if (resetKm) {
      const updatedStats = {
        ...prev,
        km: 0,
        dailyLog: {},
        longestRoute: 0,
      };
      await putUser(env, { ...user, stats: updatedStats });
      return json({ stats: updatedStats });
    }

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

    // Per-day distance log powering the activity heatmap & records.
    // Pruned to ~13 months so the stored object stays small.
    const dailyLog = { ...(prev.dailyLog || {}) };
    if (deltaKm > 0) {
      dailyLog[today] = parseFloat(((dailyLog[today] || 0) + deltaKm).toFixed(2));
      const cutoff = new Date(Date.now() - 400 * 86400000).toISOString().slice(0, 10);
      for (const day of Object.keys(dailyLog)) {
        if (day < cutoff) delete dailyLog[day];
      }
    }

    // Longest single outing — only a single-route post represents one outing
    // (multi-route syncs carry a summed distance, not one trip).
    let longestRoute = prev.longestRoute || 0;
    if (deltaRoutes === 1 && deltaKm > longestRoute) longestRoute = parseFloat(deltaKm.toFixed(2));

    const updatedStats = {
      ...prev,
      routes: (prev.routes || 0) + deltaRoutes,
      km: parseFloat(((prev.km || 0) + deltaKm).toFixed(2)),
      streak,
      bestStreak: Math.max(prev.bestStreak || 0, streak),
      lastRouteDate,
      dailyLog,
      longestRoute,
    };
    await putUser(env, { ...user, stats: updatedStats });
    return json({ stats: updatedStats });
  }

  if (pathname === '/api/auth/consume-route' && request.method === 'POST') {
    const user = await getUserFromToken(env, request);
    if (!user) return fail('Non authentifié.', 401);

    const plan = user.plan || 'free';
    if (plan !== 'free') return json({ ok: true, unlimited: true });

    const body = await request.json().catch(() => ({}));
    const isLoop = body.mode === 'loop';

    const weekStart = isoMonday();
    const stats = user.stats || { routes: 0, km: 0 };
    const sameWeek = stats.weekStart === weekStart;
    const weeklyRoutes = sameWeek ? (stats.weeklyRoutes || 0) : 0;
    const weeklyLoops  = sameWeek ? (stats.weeklyLoops  || 0) : 0;

    const LIMIT = 10;       // total routes / week (free)
    const LOOP_LIMIT = 3;   // loop routes / week (free) — see features.js loops_per_week

    // Loop sub-quota is checked first so its dedicated upsell wins.
    if (isLoop && weeklyLoops >= LOOP_LIMIT) {
      return json({ ok: false, reason: 'loop', used: weeklyLoops, limit: LOOP_LIMIT }, 429);
    }
    if (weeklyRoutes >= LIMIT) {
      return json({ ok: false, reason: 'route', used: weeklyRoutes, limit: LIMIT }, 429);
    }

    const newCount = weeklyRoutes + 1;
    const newLoops = weeklyLoops + (isLoop ? 1 : 0);
    await putUser(env, { ...user, stats: { ...stats, weeklyRoutes: newCount, weeklyLoops: newLoops, weekStart } });
    return json({ ok: true, used: newCount, limit: LIMIT, loopsUsed: newLoops, loopLimit: LOOP_LIMIT, isLoop });
  }

  if (pathname === '/api/auth/password' && request.method === 'PUT') {
    const user = await getUserFromToken(env, request);
    if (!user) return fail('Non authentifié.', 401);

    const { oldPassword, newPassword } = await request.json();
    if (!oldPassword || !newPassword) return fail('Champs obligatoires.');
    if (newPassword.length < 8) return fail('Le nouveau mot de passe doit faire au moins 8 caractères.');

    const verifyHash = user.hashVersion === 2
      ? await hashPassword(oldPassword, user.salt)
      : await hashPasswordLegacy(oldPassword, user.salt);
    if (verifyHash !== user.passwordHash) return fail('Mot de passe actuel incorrect.', 401);

    const newSalt = crypto.randomUUID();
    const newHash = await hashPassword(newPassword, newSalt);
    await putUser(env, {
      ...user,
      passwordHash: newHash,
      salt: newSalt,
      hashVersion: 2,
      sessionsInvalidatedAt: new Date().toISOString(),
    });
    return json({ message: 'Mot de passe modifié avec succès.' });
  }

  // GDPR right of access / portability (art. 15 & 20): the user downloads a
  // structured, machine-readable copy of every piece of personal data we hold
  // about them. Credentials (password hash, salt) are deliberately excluded —
  // they are not "personal data" the user needs and exposing them is a risk.
  if (pathname === '/api/auth/export' && request.method === 'GET') {
    const user = await getUserFromToken(env, request);
    if (!user) return fail('Non authentifié.', 401);

    const { passwordHash: _ph, salt: _s, hashVersion: _hv, ...profile } = user;

    const savedRoutes = await listItems(env, `savedroute:${user.id}:`);
    const walkedKeys = await listKeys(env, `walkedpath:${user.id}:`);
    const walkedPaths = await Promise.all(
      walkedKeys.map(async (k) => ({
        pathId: k.name.slice(`walkedpath:${user.id}:`.length),
        walkedAt: await env.BWR_KV.get(k.name),
      })),
    );

    const exportData = {
      exportedAt: new Date().toISOString(),
      format: 'BWR personal-data export (RGPD art. 15 & 20)',
      profile,
      savedRoutes,
      walkedPaths,
    };

    const filename = `bwr-mes-donnees-${new Date().toISOString().slice(0, 10)}.json`;
    return new Response(JSON.stringify(exportData, null, 2), {
      status: 200,
      headers: {
        ...cors,
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`,
      },
    });
  }

  if (pathname === '/api/auth/account' && request.method === 'DELETE') {
    const user = await getUserFromToken(env, request);
    if (!user) return fail('Non authentifié.', 401);
    if (user.role === 'admin') return fail('Le compte administrateur ne peut pas être supprimé.', 403);

    // GDPR right to erasure (art. 17): purge every key tied to this user, not
    // just the account record. Saved routes carry a public share token that
    // must die with the route, and walked-path markers are per-user.
    const savedRoutes = await listItems(env, `savedroute:${user.id}:`);
    const walkedKeys = await listKeys(env, `walkedpath:${user.id}:`);

    await Promise.all([
      env.BWR_KV.delete(`user:${user.id}`),
      env.BWR_KV.delete(`uemail:${user.email}`),
      ...savedRoutes.map(rt => env.BWR_KV.delete(`savedroute:${user.id}:${rt.id}`)),
      ...savedRoutes.filter(rt => rt.shareToken).map(rt => env.BWR_KV.delete(`routeshare:${rt.shareToken}`)),
      ...walkedKeys.map(k => env.BWR_KV.delete(k.name)),
    ]);

    const auth = request.headers.get('Authorization');
    if (auth?.startsWith('Bearer ')) await env.BWR_KV.delete(`session:${auth.slice(7)}`);
    return json({ message: 'Compte supprimé.' });
  }

  return null;
}
