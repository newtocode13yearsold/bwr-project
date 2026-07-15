// Site-rating handler integration tests.
// Covers: public aggregate, submit + one-per-account overwrite, validation,
// admin-only review list + delete, cache invalidation on write.

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

function seedUser(kv, { id, name, plan = 'free', role = 'user', token }) {
  const user = { id, name: name || id, email: `${id}@bwr.fr`, role, plan };
  kv.store.set(`user:${id}`, JSON.stringify(user));
  kv.store.set(`session:${token}`, JSON.stringify({ userId: id, expiresAt: new Date(Date.now() + 86400000).toISOString() }));
}

function freshEnv() {
  const kv = makeMockKV();
  const env = { BWR_KV: kv };
  seedUser(kv, { id: 'u1', name: 'Alice', token: 'tok-u1' });
  seedUser(kv, { id: 'u2', name: 'Bob', token: 'tok-u2' });
  seedUser(kv, { id: 'admin1', name: 'Admin', role: 'admin', token: 'tok-admin' });
  return { kv, env };
}

const r = (method, path, body, headers = {}) => new Request(
  `https://bwr.test${path}`,
  { method, headers: { 'Content-Type': 'application/json', ...headers }, ...(body != null ? { body: JSON.stringify(body) } : {}) }
);
const authed = (method, path, token, body) => r(method, path, body, { Authorization: `Bearer ${token}` });

describe('GET /api/rating (public aggregate)', () => {
  test('returns zeroed summary when no reviews', async () => {
    const { env } = freshEnv();
    const res = await worker.fetch(r('GET', '/api/rating'), env);
    assert.equal(res.status, 200);
    const d = await res.json();
    assert.equal(d.count, 0);
    assert.equal(d.avg, 0);
    assert.equal(d.mine, null);
  });

  test('computes average + distribution from stored reviews', async () => {
    const { env } = freshEnv();
    await worker.fetch(authed('POST', '/api/rating', 'tok-u1', { stars: 5 }), env);
    await worker.fetch(authed('POST', '/api/rating', 'tok-u2', { stars: 3 }), env);
    const res = await worker.fetch(r('GET', '/api/rating'), env);
    const d = await res.json();
    assert.equal(d.count, 2);
    assert.equal(d.avg, 4); // (5+3)/2
    assert.equal(d.dist['5'], 1);
    assert.equal(d.dist['3'], 1);
  });

  test('includes caller own review when authenticated', async () => {
    const { env } = freshEnv();
    await worker.fetch(authed('POST', '/api/rating', 'tok-u1', { stars: 4, comment: 'Super' }), env);
    const res = await worker.fetch(authed('GET', '/api/rating', 'tok-u1'), env);
    const d = await res.json();
    assert.deepEqual(d.mine, { stars: 4, comment: 'Super' });
  });
});

describe('POST /api/rating', () => {
  test('rejects unauthenticated', async () => {
    const { env } = freshEnv();
    const res = await worker.fetch(r('POST', '/api/rating', { stars: 5 }), env);
    assert.equal(res.status, 401);
  });

  test('rejects out-of-range stars', async () => {
    const { env } = freshEnv();
    for (const stars of [0, 6, 2.5, 'x']) {
      const res = await worker.fetch(authed('POST', '/api/rating', 'tok-u1', { stars }), env);
      assert.equal(res.status, 400, `stars=${stars}`);
    }
  });

  test('one review per account — re-post overwrites, does not duplicate', async () => {
    const { env, kv } = freshEnv();
    await worker.fetch(authed('POST', '/api/rating', 'tok-u1', { stars: 2, comment: 'Bof' }), env);
    await worker.fetch(authed('POST', '/api/rating', 'tok-u1', { stars: 5, comment: 'Finalement top' }), env);
    const reviewKeys = [...kv.store.keys()].filter(k => k.startsWith('review:'));
    assert.equal(reviewKeys.length, 1);
    const stored = JSON.parse(kv.store.get('review:u1'));
    assert.equal(stored.stars, 5);
    assert.equal(stored.comment, 'Finalement top');
    // createdAt preserved, updatedAt refreshed
    assert.ok(stored.createdAt);
    assert.ok(stored.updatedAt);
  });

  test('response carries fresh aggregate + mine', async () => {
    const { env } = freshEnv();
    const res = await worker.fetch(authed('POST', '/api/rating', 'tok-u1', { stars: 4 }), env);
    const d = await res.json();
    assert.equal(d.ok, true);
    assert.equal(d.count, 1);
    assert.equal(d.avg, 4);
    assert.equal(d.mine.stars, 4);
  });
});

describe('admin review moderation', () => {
  test('GET /api/ratings rejects non-admin', async () => {
    const { env } = freshEnv();
    const res = await worker.fetch(authed('GET', '/api/ratings', 'tok-u1'), env);
    assert.equal(res.status, 403);
  });

  test('GET /api/ratings returns comments for admin', async () => {
    const { env } = freshEnv();
    await worker.fetch(authed('POST', '/api/rating', 'tok-u1', { stars: 5, comment: 'Génial' }), env);
    const res = await worker.fetch(authed('GET', '/api/ratings', 'tok-admin'), env);
    assert.equal(res.status, 200);
    const d = await res.json();
    assert.equal(d.reviews.length, 1);
    assert.equal(d.reviews[0].comment, 'Génial');
    assert.equal(d.reviews[0].name, 'Alice');
  });

  test('DELETE /api/ratings/:id removes a review (admin only)', async () => {
    const { env, kv } = freshEnv();
    await worker.fetch(authed('POST', '/api/rating', 'tok-u1', { stars: 5 }), env);

    const denied = await worker.fetch(authed('DELETE', '/api/ratings/u1', 'tok-u2'), env);
    assert.equal(denied.status, 403);
    assert.ok(kv.store.get('review:u1'));

    const ok = await worker.fetch(authed('DELETE', '/api/ratings/u1', 'tok-admin'), env);
    assert.equal(ok.status, 200);
    assert.equal(kv.store.get('review:u1'), undefined);
    const d = await ok.json();
    assert.equal(d.count, 0);
  });
});
