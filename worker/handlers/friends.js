import { listItems, listKeys, getUser } from '../kv.js';
import { getUserFromToken } from '../auth-utils.js';

// ── Social / friends layer ────────────────────────────────────────────────────
// A lightweight follow graph + a shared-activity feed, turning the solo hike
// journal (worker/handlers/activities.js) into a retention loop: follow someone,
// see the walks they choose to share, and give them a "kudos".
//
// KV keys (two per follow edge, so both directions are an O(1) prefix scan):
//   follow:{followerId}:{followeeId}   → ISO ts  (prefix follow:{me}:   = who I follow)
//   follower:{followeeId}:{followerId} → ISO ts  (prefix follower:{me}: = who follows me)
//   kudos:{ownerId}:{activityId}:{userId} → ISO ts (a kudos on a shared activity)
//
// A shared activity is a normal activity:{ownerId}:{id} record with `shared:true`
// (the flag is written by worker/handlers/activities.js on POST / PATCH). The feed
// fans out over the people I follow (+ my own shared walks), so nothing about an
// activity is visible to anyone until its owner explicitly shares it.
//
// Follows are between real accounts only; the directory + feed require auth and
// never expose an email address — only id / name / username.

const FEED_LIMIT = 40;   // shared activities returned in one feed page
const DIR_LIMIT  = 30;   // directory search results

/** Strip the heavy geometry from an activity, keeping the feed-card summary. */
function toFeedSummary(a, owner, kudos, iKudosed) {
  const { coords, elevations: _e, times: _t, ...rest } = a;
  return {
    ...rest,
    points: Array.isArray(coords) ? coords.length : 0,
    ownerId: owner.id,
    ownerName: owner.name || 'Randonneur',
    ownerUsername: owner.username || null,
    kudos,
    iKudosed,
  };
}

/**
 * @param {Request} request
 * @param {import('../kv.js').Env} env
 * @param {{ pathname: string, json: Function, fail: Function, waitUntil?: Function }} ctx
 * @returns {Promise<Response|null>}
 */
export async function handleFriends(request, env, { pathname, url, json, fail, waitUntil }) {
  // Every social endpoint is authenticated.
  if (!pathname.startsWith('/api/social/')) return null;

  // ── Follow / unfollow a user ────────────────────────────────────────────────
  if (pathname.startsWith('/api/social/follow/')) {
    const me = await getUserFromToken(env, request);
    if (!me) return fail('Non authentifié.', 401);
    const targetId = decodeURIComponent(pathname.split('/')[4] || '');
    if (!targetId) return fail('Utilisateur manquant.');
    if (targetId === me.id) return fail('Vous ne pouvez pas vous suivre vous-même.');

    if (request.method === 'POST') {
      const target = await getUser(env, targetId);
      if (!target) return fail('Utilisateur introuvable.', 404);

      const already = await env.BWR_KV.get(`follow:${me.id}:${targetId}`);
      const now = new Date().toISOString();
      await Promise.all([
        env.BWR_KV.put(`follow:${me.id}:${targetId}`, now),
        env.BWR_KV.put(`follower:${targetId}:${me.id}`, now),
      ]);

      // First-time follow → drop a friendly heads-up in the followee's inbox.
      if (!already && waitUntil) {
        waitUntil(notifyNewFollower(env, me, target).catch(() => {}));
      }
      return json({ following: true });
    }

    if (request.method === 'DELETE') {
      await Promise.all([
        env.BWR_KV.delete(`follow:${me.id}:${targetId}`),
        env.BWR_KV.delete(`follower:${targetId}:${me.id}`),
      ]);
      return json({ following: false });
    }
    return null;
  }

  // ── Who I follow ────────────────────────────────────────────────────────────
  if (pathname === '/api/social/following' && request.method === 'GET') {
    const me = await getUserFromToken(env, request);
    if (!me) return fail('Non authentifié.', 401);
    const keys = await listKeys(env, `follow:${me.id}:`);
    const list = await hydrateRelationList(env, keys, `follow:${me.id}:`);
    return json({ users: list });
  }

  // ── Who follows me ──────────────────────────────────────────────────────────
  if (pathname === '/api/social/followers' && request.method === 'GET') {
    const me = await getUserFromToken(env, request);
    if (!me) return fail('Non authentifié.', 401);
    const keys = await listKeys(env, `follower:${me.id}:`);
    const list = await hydrateRelationList(env, keys, `follower:${me.id}:`);
    // Flag whether I already follow each follower back (for a "suivre en retour" button).
    const backChecks = await Promise.all(
      list.map(u => env.BWR_KV.get(`follow:${me.id}:${u.id}`)),
    );
    list.forEach((u, i) => { u.iFollow = !!backChecks[i]; });
    return json({ users: list });
  }

  // ── Directory: find people to follow ────────────────────────────────────────
  if (pathname === '/api/social/users' && request.method === 'GET') {
    const me = await getUserFromToken(env, request);
    if (!me) return fail('Non authentifié.', 401);
    const q = (url.searchParams.get('q') || '').trim().toLowerCase();

    const all = await listItems(env, 'user:');
    const followingKeys = await listKeys(env, `follow:${me.id}:`);
    const followingIds = new Set(followingKeys.map(k => k.name.slice(`follow:${me.id}:`.length)));

    let people = all
      .filter(u => u.id && u.name && u.id !== me.id)
      .map(u => ({
        id: u.id,
        name: u.name,
        username: u.username || null,
        isFollowing: followingIds.has(u.id),
        walkedPathsCount: u.stats?.walkedPathsCount || 0,
      }));

    if (q) {
      people = people.filter(u =>
        u.name.toLowerCase().includes(q) ||
        (u.username && u.username.toLowerCase().includes(q)));
    }

    // Suggested first (not yet followed), then by contribution; cap the payload.
    people.sort((a, b) =>
      (a.isFollowing === b.isFollowing ? 0 : a.isFollowing ? 1 : -1) ||
      b.walkedPathsCount - a.walkedPathsCount ||
      a.name.localeCompare(b.name));
    return json({ users: people.slice(0, DIR_LIMIT) });
  }

  // ── Public mini-profile of a user ───────────────────────────────────────────
  if (pathname.startsWith('/api/social/profile/') && request.method === 'GET') {
    const me = await getUserFromToken(env, request);
    if (!me) return fail('Non authentifié.', 401);
    const targetId = decodeURIComponent(pathname.split('/')[4] || '');
    const target = await getUser(env, targetId);
    if (!target) return fail('Utilisateur introuvable.', 404);

    const [followingKeys, followerKeys, iFollow, activities] = await Promise.all([
      listKeys(env, `follow:${targetId}:`),
      listKeys(env, `follower:${targetId}:`),
      env.BWR_KV.get(`follow:${me.id}:${targetId}`),
      listItems(env, `activity:${targetId}:`),
    ]);
    const s = target.stats || {};
    const shared = activities
      .filter(a => a.shared)
      .sort((a, b) => (b.startedAt || b.savedAt || '').localeCompare(a.startedAt || a.savedAt || ''))
      .slice(0, 10)
      .map(({ coords, elevations: _e, times: _t, ...rest }) => ({ ...rest, points: Array.isArray(coords) ? coords.length : 0 }));

    return json({
      id: target.id,
      name: target.name,
      username: target.username || null,
      isFollowing: !!iFollow,
      isMe: targetId === me.id,
      followingCount: followingKeys.length,
      followerCount: followerKeys.length,
      stats: {
        reports: s.reports || 0,
        pathGrades: s.pathGrades || 0,
        walkedPathsCount: s.walkedPathsCount || 0,
        km: s.km || 0,
        routes: s.routes || 0,
      },
      sharedActivities: shared,
    });
  }

  // ── The feed: shared walks from people I follow (+ my own) ──────────────────
  if (pathname === '/api/social/feed' && request.method === 'GET') {
    const me = await getUserFromToken(env, request);
    if (!me) return fail('Non authentifié.', 401);

    const followKeys = await listKeys(env, `follow:${me.id}:`);
    const ownerIds = followKeys.map(k => k.name.slice(`follow:${me.id}:`.length));
    ownerIds.push(me.id); // my own shared walks appear in my feed too

    // Fetch each owner's record + their shared activities in parallel. This
    // parses full activity JSON (coords included) to read the `shared` flag —
    // fine at the current scale; a hot feed would want a per-user shared index.
    const perOwner = await Promise.all(ownerIds.map(async (oid) => {
      const [owner, acts] = await Promise.all([
        getUser(env, oid),
        listItems(env, `activity:${oid}:`),
      ]);
      if (!owner) return [];
      return acts.filter(a => a.shared).map(a => ({ a, owner }));
    }));

    const flat = perOwner.flat()
      .sort((x, y) => (y.a.startedAt || y.a.savedAt || '').localeCompare(x.a.startedAt || x.a.savedAt || ''))
      .slice(0, FEED_LIMIT);

    // Kudos count + whether I've kudos'd, per feed item.
    const enriched = await Promise.all(flat.map(async ({ a, owner }) => {
      const [kudosKeys, mine] = await Promise.all([
        listKeys(env, `kudos:${owner.id}:${a.id}:`),
        env.BWR_KV.get(`kudos:${owner.id}:${a.id}:${me.id}`),
      ]);
      return toFeedSummary(a, owner, kudosKeys.length, !!mine);
    }));

    return json({ feed: enriched });
  }

  // ── Full track of a shared activity (for the feed replay) ───────────────────
  if (pathname.startsWith('/api/social/activity/') && request.method === 'GET') {
    const me = await getUserFromToken(env, request);
    if (!me) return fail('Non authentifié.', 401);
    const parts = pathname.split('/'); // /api/social/activity/:ownerId/:activityId
    const ownerId = decodeURIComponent(parts[4] || '');
    const activityId = decodeURIComponent(parts[5] || '');
    const raw = await env.BWR_KV.get(`activity:${ownerId}:${activityId}`);
    if (!raw) return fail('Sortie introuvable.', 404);
    const activity = JSON.parse(raw);
    // Only the owner's *shared* walks are visible to others (owner sees own always).
    if (!activity.shared && ownerId !== me.id) return fail('Sortie privée.', 403);
    const owner = await getUser(env, ownerId);
    return json({ ...activity, ownerName: owner?.name || 'Randonneur' });
  }

  // ── Toggle a kudos on a shared activity ─────────────────────────────────────
  if (pathname.startsWith('/api/social/kudos/') && request.method === 'POST') {
    const me = await getUserFromToken(env, request);
    if (!me) return fail('Non authentifié.', 401);
    const parts = pathname.split('/'); // /api/social/kudos/:ownerId/:activityId
    const ownerId = decodeURIComponent(parts[4] || '');
    const activityId = decodeURIComponent(parts[5] || '');
    if (!ownerId || !activityId) return fail('Sortie manquante.');

    const raw = await env.BWR_KV.get(`activity:${ownerId}:${activityId}`);
    if (!raw) return fail('Sortie introuvable.', 404);
    const activity = JSON.parse(raw);
    if (!activity.shared) return fail('Sortie privée.', 403);

    const key = `kudos:${ownerId}:${activityId}:${me.id}`;
    const existing = await env.BWR_KV.get(key);
    if (existing) {
      await env.BWR_KV.delete(key);
    } else {
      await env.BWR_KV.put(key, new Date().toISOString());
      // Notify the owner (best-effort) that someone applauded their walk.
      if (ownerId !== me.id && waitUntil) {
        waitUntil(notifyKudos(env, me, ownerId, activity).catch(() => {}));
      }
    }
    const kudosKeys = await listKeys(env, `kudos:${ownerId}:${activityId}:`);
    return json({ kudos: kudosKeys.length, mine: !existing });
  }

  return null;
}

/** Turn a list of relation keys (follow:/follower:) into hydrated user cards. */
async function hydrateRelationList(env, keys, prefix) {
  const items = await Promise.all(keys.map(async (k) => {
    const id = k.name.slice(prefix.length);
    const u = await getUser(env, id);
    if (!u) return null;
    return {
      id: u.id,
      name: u.name,
      username: u.username || null,
      walkedPathsCount: u.stats?.walkedPathsCount || 0,
      since: await env.BWR_KV.get(k.name),
    };
  }));
  return items.filter(Boolean).sort((a, b) => (b.since || '').localeCompare(a.since || ''));
}

/** Direct inbox message telling `target` that `follower` started following them. */
async function notifyNewFollower(env, follower, target) {
  const id = crypto.randomUUID();
  const message = {
    id,
    createdAt: new Date().toISOString(),
    subject: '👋 Un nouvel abonné',
    body: `${follower.name || 'Un randonneur'} suit désormais vos sorties sur BWR. Partagez vos balades pour qu'il/elle les retrouve dans son fil d'actu !`,
    target: target.id,
    targetName: target.name || '',
    senderName: 'Communauté BWR',
  };
  await env.BWR_KV.put(`inboxmsg:${String(Date.now()).padStart(13, '0')}:${id}`, JSON.stringify(message));
}

/** Direct inbox message telling the owner someone applauded one of their walks. */
async function notifyKudos(env, fan, ownerId, activity) {
  const owner = await getUser(env, ownerId);
  if (!owner) return;
  const id = crypto.randomUUID();
  const message = {
    id,
    createdAt: new Date().toISOString(),
    subject: '👏 Bravo pour votre sortie',
    body: `${fan.name || 'Un randonneur'} a applaudi votre sortie « ${activity.name || 'Sortie'} ».`,
    target: owner.id,
    targetName: owner.name || '',
    senderName: 'Communauté BWR',
  };
  await env.BWR_KV.put(`inboxmsg:${String(Date.now()).padStart(13, '0')}:${id}`, JSON.stringify(message));
}
