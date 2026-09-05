// Forum handler integration tests.
// Covers: topic create (silver+ only), free-tier read limit (5 visible),
// reply create + gating, locked detail, author/admin deletion.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker.js';

function makeMockKV() {
  const store = new Map();
  return {
    store,
    async get(key)        { return store.get(key) ?? null; },
    async put(key, value) { store.set(key, value); },
    async delete(key)     { store.delete(key); },
    async list({ prefix = '', limit = 1000, cursor } = {}) {
      const all = [];
      for (const k of store.keys()) if (k.startsWith(prefix)) all.push({ name: k });
      const start = cursor ? parseInt(cursor, 10) : 0;
      const page = all.slice(start, start + limit);
      const end = start + page.length;
      const complete = end >= all.length;
      return { keys: page, list_complete: complete, cursor: complete ? undefined : String(end) };
    },
  };
}

function seedUser(kv, { id, plan = 'free', role = 'user', token }) {
  const user = { id, name: id, email: `${id}@bwr.fr`, role, plan };
  kv.store.set(`user:${id}`, JSON.stringify(user));
  kv.store.set(`uemail:${id}@bwr.fr`, id);
  kv.store.set(`session:${token}`, JSON.stringify({ userId: id, expiresAt: new Date(Date.now() + 86400000).toISOString() }));
}

function freshEnv() {
  const kv = makeMockKV();
  const env = { BWR_KV: kv };
  seedUser(kv, { id: 'silver1', plan: 'silver', token: 'tok-silver' });
  seedUser(kv, { id: 'gold1',   plan: 'gold',   token: 'tok-gold' });
  seedUser(kv, { id: 'free1',   plan: 'free',   token: 'tok-free' });
  seedUser(kv, { id: 'admin1',  plan: 'free', role: 'admin', token: 'tok-admin' });
  return { kv, env };
}

const r = (method, path, body, headers = {}) => new Request(
  `https://bwr.test${path}`,
  { method, headers: { 'Content-Type': 'application/json', ...headers }, ...(body != null ? { body: JSON.stringify(body) } : {}) }
);
const authed = (method, path, token, body) => r(method, path, body, { Authorization: `Bearer ${token}` });

async function createTopic(env, token, title, body = 'Contenu du message.') {
  const res = await worker.fetch(authed('POST', '/api/forum/topics', token, { title, body }), env);
  return res;
}

// ── Create topic ──────────────────────────────────────────────────────────────

describe('POST /api/forum/topics', () => {
  test('rejects unauthenticated', async () => {
    const { env } = freshEnv();
    const res = await worker.fetch(r('POST', '/api/forum/topics', { title: 'Salut', body: 'x' }), env);
    assert.equal(res.status, 401);
  });

  test('rejects free plan', async () => {
    const { env } = freshEnv();
    const res = await createTopic(env, 'tok-free', 'Mon sujet');
    assert.equal(res.status, 403);
    const data = await res.json();
    assert.match(data.error, /Argent/);
  });

  test('rejects too-short title', async () => {
    const { env } = freshEnv();
    const res = await createTopic(env, 'tok-silver', 'ab');
    assert.equal(res.status, 400);
  });

  test('creates topic for silver and stores it', async () => {
    const { env, kv } = freshEnv();
    const res = await createTopic(env, 'tok-silver', 'Mon premier sujet');
    assert.equal(res.status, 201);
    const data = await res.json();
    assert.ok(data.id);
    assert.equal(data.replyCount, 0);
    assert.equal(data.authorName, 'silver1');
    assert.ok(kv.store.has(`forum:topic:${data.id}`));
  });
});

// ── Topic list + free-tier read limit ────────────────────────────────────────

describe('GET /api/forum/topics free-tier limit', () => {
  test('free user sees only 5 unlocked topics, rest locked', async () => {
    const { env } = freshEnv();
    // Create 7 topics (spaced timestamps via sequential awaits).
    for (let i = 0; i < 7; i++) await createTopic(env, 'tok-silver', `Sujet numero ${i}`);

    const res = await worker.fetch(authed('GET', '/api/forum/topics', 'tok-free'), env);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.canPost, false);
    assert.equal(data.topics.length, 7);
    assert.equal(data.lockedCount, 2);
    const unlocked = data.topics.filter(t => !t.locked);
    const locked   = data.topics.filter(t => t.locked);
    assert.equal(unlocked.length, 5);
    assert.equal(locked.length, 2);
    // Locked topics expose no preview body.
    assert.ok(locked.every(t => t.preview === ''));
  });

  test('silver user sees all topics unlocked and can post', async () => {
    const { env } = freshEnv();
    for (let i = 0; i < 7; i++) await createTopic(env, 'tok-silver', `Sujet numero ${i}`);
    const res = await worker.fetch(authed('GET', '/api/forum/topics', 'tok-silver'), env);
    const data = await res.json();
    assert.equal(data.canPost, true);
    assert.equal(data.lockedCount, 0);
    assert.ok(data.topics.every(t => !t.locked));
  });
});

// ── Search (?q=) ──────────────────────────────────────────────────────────────

describe('GET /api/forum/topics?q=', () => {
  test('matches title case- and accent-insensitively', async () => {
    const { env } = freshEnv();
    await createTopic(env, 'tok-silver', 'Boucle en forêt de Compiègne', 'un corps');
    await createTopic(env, 'tok-silver', 'Réparation de vélo', 'autre corps');

    const res = await worker.fetch(authed('GET', '/api/forum/topics?q=compiegne', 'tok-silver'), env);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.query, 'compiegne');
    assert.equal(data.topics.length, 1);
    assert.match(data.topics[0].title, /Compiègne/);
  });

  test('matches on body text', async () => {
    const { env } = freshEnv();
    await createTopic(env, 'tok-silver', 'Sujet un', 'Attention arbre tombé au carrefour');
    await createTopic(env, 'tok-silver', 'Sujet deux', 'rien à signaler');

    const data = await (await worker.fetch(authed('GET', '/api/forum/topics?q=arbre%20tombe', 'tok-silver'), env)).json();
    assert.equal(data.topics.length, 1);
    assert.equal(data.topics[0].title, 'Sujet un');
  });

  test('empty query returns the full list unchanged', async () => {
    const { env } = freshEnv();
    for (let i = 0; i < 3; i++) await createTopic(env, 'tok-silver', `Sujet ${i}`);
    const data = await (await worker.fetch(authed('GET', '/api/forum/topics?q=', 'tok-silver'), env)).json();
    assert.equal(data.topics.length, 3);
    assert.equal(data.query, undefined);
  });

  test('free user can find a locked topic by title but not by its gated body', async () => {
    const { env } = freshEnv();
    // 6 topics: the oldest (created first) is locked for free users (beyond top 5).
    await createTopic(env, 'tok-silver', 'Vieux sujet secret', 'mot-cle-cache dans le corps');
    for (let i = 0; i < 5; i++) await createTopic(env, 'tok-silver', `Récent ${i}`, 'blabla');

    // Title match on a locked topic → returned, but locked (no preview body).
    const byTitle = await (await worker.fetch(authed('GET', '/api/forum/topics?q=secret', 'tok-free'), env)).json();
    assert.equal(byTitle.topics.length, 1);
    assert.equal(byTitle.topics[0].locked, true);
    assert.equal(byTitle.topics[0].preview, '');

    // Body-only match on that locked topic → not revealed to the free user.
    const byBody = await (await worker.fetch(authed('GET', '/api/forum/topics?q=mot-cle-cache', 'tok-free'), env)).json();
    assert.equal(byBody.topics.length, 0);

    // Silver sees it via the body match.
    const silver = await (await worker.fetch(authed('GET', '/api/forum/topics?q=mot-cle-cache', 'tok-silver'), env)).json();
    assert.equal(silver.topics.length, 1);
  });
});

// ── Topic detail gating ───────────────────────────────────────────────────────

describe('GET /api/forum/topics/:id', () => {
  test('free user blocked on a locked topic, allowed on an unlocked one', async () => {
    const { env } = freshEnv();
    for (let i = 0; i < 7; i++) await createTopic(env, 'tok-silver', `Sujet numero ${i}`);

    // Derive locked/unlocked ids from the list the free user actually sees,
    // so the assertion doesn't depend on millisecond-tie ordering.
    const list = await (await worker.fetch(authed('GET', '/api/forum/topics', 'tok-free'), env)).json();
    const lockedId   = list.topics.find(t => t.locked).id;
    const unlockedId = list.topics.find(t => !t.locked).id;

    const blocked = await worker.fetch(authed('GET', `/api/forum/topics/${lockedId}`, 'tok-free'), env);
    assert.equal(blocked.status, 403);

    const ok = await worker.fetch(authed('GET', `/api/forum/topics/${unlockedId}`, 'tok-free'), env);
    assert.equal(ok.status, 200);
    const data = await ok.json();
    assert.equal(data.topic.id, unlockedId);
    assert.equal(data.canPost, false);
  });

  test('404 for unknown topic', async () => {
    const { env } = freshEnv();
    const res = await worker.fetch(authed('GET', '/api/forum/topics/nope', 'tok-silver'), env);
    assert.equal(res.status, 404);
  });
});

// ── Replies ───────────────────────────────────────────────────────────────────

describe('POST /api/forum/topics/:id/replies', () => {
  async function topicId(env) {
    const res = await createTopic(env, 'tok-silver', 'Sujet avec reponses');
    return (await res.json()).id;
  }

  test('free user cannot reply', async () => {
    const { env } = freshEnv();
    const id = await topicId(env);
    const res = await worker.fetch(authed('POST', `/api/forum/topics/${id}/replies`, 'tok-free', { body: 'coucou' }), env);
    assert.equal(res.status, 403);
  });

  test('silver user can reply and replyCount increments', async () => {
    const { env } = freshEnv();
    const id = await topicId(env);
    const res = await worker.fetch(authed('POST', `/api/forum/topics/${id}/replies`, 'tok-gold', { body: 'Bien vu !' }), env);
    assert.equal(res.status, 201);

    const detail = await (await worker.fetch(authed('GET', `/api/forum/topics/${id}`, 'tok-silver'), env)).json();
    assert.equal(detail.replies.length, 1);
    assert.equal(detail.topic.replyCount, 1);
    assert.equal(detail.replies[0].authorName, 'gold1');
  });

  test('empty reply rejected', async () => {
    const { env } = freshEnv();
    const id = await topicId(env);
    const res = await worker.fetch(authed('POST', `/api/forum/topics/${id}/replies`, 'tok-silver', { body: '   ' }), env);
    assert.equal(res.status, 400);
  });
});

// ── Editing ───────────────────────────────────────────────────────────────────

describe('PUT /api/forum/topics/:id', () => {
  test('author can edit own topic title + body', async () => {
    const { env, kv } = freshEnv();
    const id = (await (await createTopic(env, 'tok-silver', 'Titre original', 'Corps original')).json()).id;

    const res = await worker.fetch(
      authed('PUT', `/api/forum/topics/${id}`, 'tok-silver', { title: 'Titre corrigé', body: 'Corps corrigé' }), env);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.title, 'Titre corrigé');
    assert.equal(data.body, 'Corps corrigé');
    assert.ok(data.editedAt);

    const stored = JSON.parse(kv.store.get(`forum:topic:${id}`));
    assert.equal(stored.title, 'Titre corrigé');
    assert.equal(stored.replyCount, 0);          // untouched fields preserved
  });

  test('admin can edit any topic', async () => {
    const { env } = freshEnv();
    const id = (await (await createTopic(env, 'tok-silver', 'Titre original')).json()).id;
    const res = await worker.fetch(
      authed('PUT', `/api/forum/topics/${id}`, 'tok-admin', { title: 'Corrigé admin', body: 'ok' }), env);
    assert.equal(res.status, 200);
  });

  test('non-author cannot edit someone else topic', async () => {
    const { env } = freshEnv();
    const id = (await (await createTopic(env, 'tok-silver', 'Pas touche')).json()).id;
    const res = await worker.fetch(
      authed('PUT', `/api/forum/topics/${id}`, 'tok-gold', { title: 'Pirate', body: 'x' }), env);
    assert.equal(res.status, 403);
  });

  test('rejects too-short title', async () => {
    const { env } = freshEnv();
    const id = (await (await createTopic(env, 'tok-silver', 'Titre original')).json()).id;
    const res = await worker.fetch(
      authed('PUT', `/api/forum/topics/${id}`, 'tok-silver', { title: 'ab', body: 'x' }), env);
    assert.equal(res.status, 400);
  });

  test('404 for unknown topic', async () => {
    const { env } = freshEnv();
    const res = await worker.fetch(
      authed('PUT', '/api/forum/topics/nope', 'tok-silver', { title: 'Titre', body: 'x' }), env);
    assert.equal(res.status, 404);
  });
});

describe('PUT /api/forum/topics/:id/replies/:replyId', () => {
  async function seedReply(env, token = 'tok-gold') {
    const id = (await (await createTopic(env, 'tok-silver', 'Sujet avec reponse')).json()).id;
    const replyId = (await (await worker.fetch(
      authed('POST', `/api/forum/topics/${id}/replies`, token, { body: 'texte original' }), env)).json()).id;
    return { id, replyId };
  }

  test('author can edit own reply', async () => {
    const { env } = freshEnv();
    const { id, replyId } = await seedReply(env);
    const res = await worker.fetch(
      authed('PUT', `/api/forum/topics/${id}/replies/${replyId}`, 'tok-gold', { body: 'texte corrigé' }), env);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.body, 'texte corrigé');
    assert.ok(data.editedAt);

    const detail = await (await worker.fetch(authed('GET', `/api/forum/topics/${id}`, 'tok-silver'), env)).json();
    assert.equal(detail.replies[0].body, 'texte corrigé');
    assert.equal(detail.topic.replyCount, 1);    // still one reply, no dupes
  });

  test('non-author cannot edit someone else reply', async () => {
    const { env } = freshEnv();
    const { id, replyId } = await seedReply(env);
    const res = await worker.fetch(
      authed('PUT', `/api/forum/topics/${id}/replies/${replyId}`, 'tok-silver', { body: 'pirate' }), env);
    assert.equal(res.status, 403);
  });

  test('admin can edit any reply', async () => {
    const { env } = freshEnv();
    const { id, replyId } = await seedReply(env);
    const res = await worker.fetch(
      authed('PUT', `/api/forum/topics/${id}/replies/${replyId}`, 'tok-admin', { body: 'corrigé admin' }), env);
    assert.equal(res.status, 200);
  });

  test('empty reply rejected', async () => {
    const { env } = freshEnv();
    const { id, replyId } = await seedReply(env);
    const res = await worker.fetch(
      authed('PUT', `/api/forum/topics/${id}/replies/${replyId}`, 'tok-gold', { body: '   ' }), env);
    assert.equal(res.status, 400);
  });
});

// ── Deletion / moderation ─────────────────────────────────────────────────────

describe('DELETE forum content', () => {
  test('author can delete own topic; replies purged', async () => {
    const { env, kv } = freshEnv();
    const id = (await (await createTopic(env, 'tok-silver', 'A supprimer')).json()).id;
    await worker.fetch(authed('POST', `/api/forum/topics/${id}/replies`, 'tok-gold', { body: 'r1' }), env);

    const res = await worker.fetch(authed('DELETE', `/api/forum/topics/${id}`, 'tok-silver'), env);
    assert.equal(res.status, 200);
    assert.ok(!kv.store.has(`forum:topic:${id}`));
    const leftoverReplies = [...kv.store.keys()].filter(k => k.startsWith(`forum:reply:${id}:`));
    assert.equal(leftoverReplies.length, 0);
  });

  test('non-author cannot delete someone else topic', async () => {
    const { env } = freshEnv();
    const id = (await (await createTopic(env, 'tok-silver', 'Pas touche')).json()).id;
    const res = await worker.fetch(authed('DELETE', `/api/forum/topics/${id}`, 'tok-gold'), env);
    assert.equal(res.status, 403);
  });

  test('admin can delete any topic', async () => {
    const { env } = freshEnv();
    const id = (await (await createTopic(env, 'tok-silver', 'Moderation')).json()).id;
    const res = await worker.fetch(authed('DELETE', `/api/forum/topics/${id}`, 'tok-admin'), env);
    assert.equal(res.status, 200);
  });

  test('admin can delete any reply and count decrements', async () => {
    const { env } = freshEnv();
    const id = (await (await createTopic(env, 'tok-silver', 'Sujet')).json()).id;
    const replyId = (await (await worker.fetch(authed('POST', `/api/forum/topics/${id}/replies`, 'tok-gold', { body: 'spam' }), env)).json()).id;

    const res = await worker.fetch(authed('DELETE', `/api/forum/topics/${id}/replies/${replyId}`, 'tok-admin'), env);
    assert.equal(res.status, 200);

    const detail = await (await worker.fetch(authed('GET', `/api/forum/topics/${id}`, 'tok-silver'), env)).json();
    assert.equal(detail.replies.length, 0);
    assert.equal(detail.topic.replyCount, 0);
  });
});
