import { listItems, getPath, putPath, putUser, getUser, effectivePlan, patchLeaderboardCache } from '../kv.js';
import { getUserFromToken } from '../auth-utils.js';

const STATUS_LABELS = {
  easy: 'Facile', medium: 'Moyen', hard: 'Difficile',
  not_passable: 'Impraticable', no_bike: 'Vélo interdit',
};

/** @param {string} channel @param {string} pathName @param {string} oldStatus @param {string} newStatus */
async function notifyStatusChange(channel, pathName, oldStatus, newStatus) {
  try {
    await fetch(`https://ntfy.sh/${channel}`, {
      method: 'POST',
      headers: { 'Title': 'BWR — Chemin mis à jour', 'Tags': 'forest,warning', 'Content-Type': 'text/plain; charset=utf-8' },
      body: `"${pathName}" : ${STATUS_LABELS[oldStatus] || oldStatus} → ${STATUS_LABELS[newStatus] || newStatus}`,
    });
  } catch {}
}

/**
 * Path CRUD endpoints for admin/silver+ users.
 * @param {Request} request
 * @param {import('../kv.js').Env} env
 * @param {{ pathname: string, json: Function, fail: Function }} ctx
 * @returns {Promise<Response|null>}
 */
export async function handlePaths(request, env, { pathname, json, fail }) {
  if (pathname === '/api/paths' && request.method === 'GET') {
    return json(await listItems(env, 'path:'));
  }

  if (pathname === '/api/paths' && request.method === 'POST') {
    const user = await getUserFromToken(env, request);
    if (!user) return fail('Connexion requise.', 401);
    const plan = effectivePlan(user);
    if (plan !== 'gold' && plan !== 'silver') return fail('Abonnement Argent requis.', 403);

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

    if (body.status && body.status !== oldStatus) {
      const allUsers = await listItems(env, 'user:');
      for (const u of allUsers.filter(u => u.alertsEnabled && u.alertsChannel)) {
        await notifyStatusChange(u.alertsChannel, updated.name || 'Chemin', oldStatus, body.status);
      }
    }

    return json(updated);
  }

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
      const allUsers = await listItems(env, 'user:');
      for (const u of allUsers.filter(u => u.alertsEnabled && u.alertsChannel)) {
        await notifyStatusChange(u.alertsChannel, updated.name || 'Chemin', oldStatus, body.status);
      }
    }

    return json(updated);
  }

  if (pathname.startsWith('/api/paths/') && request.method === 'DELETE') {
    const user = await getUserFromToken(env, request);
    if (!user) return fail('Connexion requise.', 401);
    const plan = effectivePlan(user);
    if (plan !== 'gold' && plan !== 'silver') return fail('Abonnement Argent requis.', 403);

    const id = pathname.split('/')[3];
    await env.BWR_KV.delete(`path:${id}`);

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

  return null;
}
