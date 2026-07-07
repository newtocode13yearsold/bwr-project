import { listItems, listKeys, effectivePlan } from '../kv.js';
import { getUserFromToken, checkRateLimit } from '../auth-utils.js';

// Free accounts may read only the most recent N discussion topics; the rest are
// locked behind an upsell. Silver/Gold (and admins) see everything and can post.
const FREE_VISIBLE_TOPICS = 5;

const TITLE_MAX = 140;
const BODY_MAX  = 8000;
const REPLY_MAX = 4000;

/** A short plain-text preview of a topic body for the list view. */
function preview(body) {
  const oneLine = String(body || '').replace(/\s+/g, ' ').trim();
  return oneLine.length > 180 ? oneLine.slice(0, 180) + '…' : oneLine;
}

/** Loads every topic, newest activity first. */
async function loadTopicsSorted(env) {
  const topics = await listItems(env, 'forum:topic:');
  topics.sort((a, b) =>
    (b.lastActivityAt || b.createdAt || '').localeCompare(a.lastActivityAt || a.createdAt || ''));
  return topics;
}

/** True if a free-tier user may read the topic at `index` in the sorted list. */
function isUnlockedForFree(index) {
  return index < FREE_VISIBLE_TOPICS;
}

/**
 * Community forum: discussion topics + replies.
 * - Reading is public, but free accounts only see the {@link FREE_VISIBLE_TOPICS}
 *   most recent topics; older ones are returned locked (no body, no replies).
 * - Creating topics and posting replies requires Silver or Gold (or admin).
 * - A topic/reply can be deleted by its author or by an admin.
 *
 * @param {Request} request
 * @param {import('../kv.js').Env} env
 * @param {{ pathname: string, url: URL, json: Function, fail: Function }} ctx
 * @returns {Promise<Response|null>}
 */
export async function handleForum(request, env, { pathname, json, fail }) {
  if (!pathname.startsWith('/api/forum/')) return null;

  // ── List topics ─────────────────────────────────────────────────────────────
  if (pathname === '/api/forum/topics' && request.method === 'GET') {
    const user = await getUserFromToken(env, request);
    const plan = user ? effectivePlan(user) : 'free';
    const canSeeAll = plan === 'silver' || plan === 'gold';

    const topics = await loadTopicsSorted(env);
    const list = topics.map((t, i) => {
      const base = {
        id: t.id,
        title: t.title,
        authorName: t.authorName,
        authorId: t.userId,
        createdAt: t.createdAt,
        lastActivityAt: t.lastActivityAt || t.createdAt,
        replyCount: t.replyCount || 0,
      };
      if (canSeeAll || isUnlockedForFree(i)) {
        return { ...base, preview: preview(t.body), locked: false };
      }
      return { ...base, preview: '', locked: true };
    });

    return json({
      topics: list,
      canPost: canSeeAll,
      freeVisible: FREE_VISIBLE_TOPICS,
      plan,
      lockedCount: canSeeAll ? 0 : Math.max(0, topics.length - FREE_VISIBLE_TOPICS),
    });
  }

  // ── Create topic ─────────────────────────────────────────────────────────────
  if (pathname === '/api/forum/topics' && request.method === 'POST') {
    const user = await getUserFromToken(env, request);
    if (!user) return fail('Non authentifié.', 401);
    if (effectivePlan(user) === 'free')
      return fail('La création de sujets est réservée aux membres Argent et Or.', 403);

    if (!await checkRateLimit(env, 'forumtopic', user.id, 10, 3600))
      return fail('Trop de sujets créés. Réessaie dans une heure.', 429);

    const body = await request.json().catch(() => ({}));
    const title = String(body.title || '').trim();
    const text  = String(body.body || '').trim();
    if (title.length < 3)  return fail('Le titre doit faire au moins 3 caractères.');
    if (text.length < 1)   return fail('Le message ne peut pas être vide.');

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const topic = {
      id,
      userId: user.id,
      authorName: user.name || 'Membre',
      title: title.slice(0, TITLE_MAX),
      body: text.slice(0, BODY_MAX),
      createdAt: now,
      lastActivityAt: now,
      replyCount: 0,
    };
    await env.BWR_KV.put(`forum:topic:${id}`, JSON.stringify(topic));
    return json(topic, 201);
  }

  // ── Single topic + its replies ───────────────────────────────────────────────
  // /api/forum/topics/:id
  const topicMatch = pathname.match(/^\/api\/forum\/topics\/([^/]+)$/);
  if (topicMatch && request.method === 'GET') {
    const id = topicMatch[1];
    const raw = await env.BWR_KV.get(`forum:topic:${id}`);
    if (!raw) return fail('Sujet introuvable.', 404);
    const topic = JSON.parse(raw);

    const user = await getUserFromToken(env, request);
    const plan = user ? effectivePlan(user) : 'free';
    const canSeeAll = plan === 'silver' || plan === 'gold';

    if (!canSeeAll) {
      const topics = await loadTopicsSorted(env);
      const index = topics.findIndex(t => t.id === id);
      if (index < 0 || !isUnlockedForFree(index))
        return fail('Ce sujet est réservé aux membres Argent et Or.', 403);
    }

    const replies = await listItems(env, `forum:reply:${id}:`);
    replies.sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));

    return json({
      topic,
      replies: replies.map(({ topicId: _t, ...rest }) => rest),
      canPost: canSeeAll,
      canModerate: !!(user && (user.role === 'admin')),
      currentUserId: user ? user.id : null,
    });
  }

  // ── Edit topic (author or admin) ─────────────────────────────────────────────
  if (topicMatch && request.method === 'PUT') {
    const id = topicMatch[1];
    const user = await getUserFromToken(env, request);
    if (!user) return fail('Non authentifié.', 401);

    const raw = await env.BWR_KV.get(`forum:topic:${id}`);
    if (!raw) return fail('Sujet introuvable.', 404);
    const topic = JSON.parse(raw);
    if (user.role !== 'admin' && topic.userId !== user.id)
      return fail('Tu ne peux modifier que tes propres sujets.', 403);

    const body = await request.json().catch(() => ({}));
    const title = String(body.title || '').trim();
    const text  = String(body.body || '').trim();
    if (title.length < 3) return fail('Le titre doit faire au moins 3 caractères.');
    if (text.length < 1)  return fail('Le message ne peut pas être vide.');

    topic.title = title.slice(0, TITLE_MAX);
    topic.body  = text.slice(0, BODY_MAX);
    topic.editedAt = new Date().toISOString();  // edits don't bump lastActivityAt (thread order stays put)
    await env.BWR_KV.put(`forum:topic:${id}`, JSON.stringify(topic));
    return json(topic);
  }

  if (topicMatch && request.method === 'DELETE') {
    const id = topicMatch[1];
    const user = await getUserFromToken(env, request);
    if (!user) return fail('Non authentifié.', 401);

    const raw = await env.BWR_KV.get(`forum:topic:${id}`);
    if (!raw) return fail('Sujet introuvable.', 404);
    const topic = JSON.parse(raw);
    if (user.role !== 'admin' && topic.userId !== user.id)
      return fail('Tu ne peux supprimer que tes propres sujets.', 403);

    const replyKeys = await listKeys(env, `forum:reply:${id}:`);
    await Promise.all([
      env.BWR_KV.delete(`forum:topic:${id}`),
      ...replyKeys.map(k => env.BWR_KV.delete(k.name)),
    ]);
    return json({ success: true });
  }

  // ── Replies ──────────────────────────────────────────────────────────────────
  // /api/forum/topics/:id/replies
  const repliesMatch = pathname.match(/^\/api\/forum\/topics\/([^/]+)\/replies$/);
  if (repliesMatch && request.method === 'POST') {
    const topicId = repliesMatch[1];
    const user = await getUserFromToken(env, request);
    if (!user) return fail('Non authentifié.', 401);
    if (effectivePlan(user) === 'free')
      return fail('Répondre est réservé aux membres Argent et Or.', 403);

    if (!await checkRateLimit(env, 'forumreply', user.id, 30, 3600))
      return fail('Trop de réponses. Réessaie dans un moment.', 429);

    const raw = await env.BWR_KV.get(`forum:topic:${topicId}`);
    if (!raw) return fail('Sujet introuvable.', 404);
    const topic = JSON.parse(raw);

    const body = await request.json().catch(() => ({}));
    const text = String(body.body || '').trim();
    if (text.length < 1) return fail('La réponse ne peut pas être vide.');

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const reply = {
      id,
      topicId,
      userId: user.id,
      authorName: user.name || 'Membre',
      body: text.slice(0, REPLY_MAX),
      createdAt: now,
    };

    topic.replyCount = (topic.replyCount || 0) + 1;
    topic.lastActivityAt = now;

    await Promise.all([
      // Timestamp in the key keeps replies naturally ordered within a topic.
      env.BWR_KV.put(`forum:reply:${topicId}:${String(Date.now()).padStart(13, '0')}:${id}`, JSON.stringify(reply)),
      env.BWR_KV.put(`forum:topic:${topicId}`, JSON.stringify(topic)),
    ]);

    return json(reply, 201);
  }

  // /api/forum/topics/:id/replies/:replyId
  const replyMatch = pathname.match(/^\/api\/forum\/topics\/([^/]+)\/replies\/([^/]+)$/);

  // ── Edit reply (author or admin) ─────────────────────────────────────────────
  if (replyMatch && request.method === 'PUT') {
    const [, topicId, replyId] = replyMatch;
    const user = await getUserFromToken(env, request);
    if (!user) return fail('Non authentifié.', 401);

    const replyKeys = await listKeys(env, `forum:reply:${topicId}:`);
    const key = replyKeys.find(k => k.name.endsWith(`:${replyId}`));
    if (!key) return fail('Réponse introuvable.', 404);

    const reply = JSON.parse(await env.BWR_KV.get(key.name));
    if (user.role !== 'admin' && reply.userId !== user.id)
      return fail('Tu ne peux modifier que tes propres réponses.', 403);

    const body = await request.json().catch(() => ({}));
    const text = String(body.body || '').trim();
    if (text.length < 1) return fail('La réponse ne peut pas être vide.');

    reply.body = text.slice(0, REPLY_MAX);
    reply.editedAt = new Date().toISOString();
    await env.BWR_KV.put(key.name, JSON.stringify(reply));  // same key → order preserved
    const { topicId: _t, ...rest } = reply;
    return json(rest);
  }

  if (replyMatch && request.method === 'DELETE') {
    const [, topicId, replyId] = replyMatch;
    const user = await getUserFromToken(env, request);
    if (!user) return fail('Non authentifié.', 401);

    const replyKeys = await listKeys(env, `forum:reply:${topicId}:`);
    const key = replyKeys.find(k => k.name.endsWith(`:${replyId}`));
    if (!key) return fail('Réponse introuvable.', 404);

    const reply = JSON.parse(await env.BWR_KV.get(key.name));
    if (user.role !== 'admin' && reply.userId !== user.id)
      return fail('Tu ne peux supprimer que tes propres réponses.', 403);

    await env.BWR_KV.delete(key.name);

    // Best-effort decrement of the cached reply count on the topic.
    const topicRaw = await env.BWR_KV.get(`forum:topic:${topicId}`);
    if (topicRaw) {
      const topic = JSON.parse(topicRaw);
      topic.replyCount = Math.max(0, (topic.replyCount || 0) - 1);
      await env.BWR_KV.put(`forum:topic:${topicId}`, JSON.stringify(topic));
    }

    return json({ success: true });
  }

  return null;
}
