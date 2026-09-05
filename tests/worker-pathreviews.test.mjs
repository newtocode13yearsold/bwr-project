// Per-trail review handler integration tests.
// Covers: public aggregate + comment list, auth guard, one-per-account overwrite,
// star validation, missing-path 404, author/admin delete, dispatch ordering
// (a review DELETE isn't swallowed by the generic path DELETE).

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

function seedPath(kv, id = 'p1') {
  kv.store.set(`path:${id}`, JSON.stringify({ id, name: 'Sentier test', status: 'easy', coordinates: [[49.3, 2.9], [49.31, 2.91]] }));
}

function freshEnv() {
  const kv = makeMockKV();
  const env = { BWR_KV: kv };
  seedUser(kv, { id: 'u1', name: 'Alice', token: 'tok-u1' });
  seedUser(kv, { id: 'u2', name: 'Bob', token: 'tok-u2' });
  seedUser(kv, { id: 'admin1', name: 'Admin', role: 'admin', token: 'tok-admin' });
  seedPath(kv, 'p1');
  return { kv, env };
}

const r = (method, path, body, headers = {}) => new Request(
  `https://bwr.test${path}`,
  { method, headers: { 'Content-Type': 'application/json', ...headers }, ...(body != null ? { body: JSON.stringify(body) } : {}) }
);
const authed = (method, path, token, body) => r(method, path, body, { Authorization: `Bearer ${token}` });

describe('GET /api/paths/:id/reviews (public)', () => {
  test('returns zeroed summary + empty list when no reviews', async () => {
    const { env } = freshEnv();
    const res = await worker.fetch(r('GET', '/api/paths/p1/reviews'), env);
    assert.equal(res.status, 200);
    const d = await res.json();
    assert.equal(d.count, 0);
    assert.equal(d.avg, 0);
    assert.deepEqual(d.reviews, []);
    assert.equal(d.mine, null);
  });

  test('computes average + exposes public comments', async () => {
    const { env } = freshEnv();
    await worker.fetch(authed('POST', '/api/paths/p1/reviews', 'tok-u1', { stars: 5, comment: 'Magnifique' }), env);
    await worker.fetch(authed('POST', '/api/paths/p1/reviews', 'tok-u2', { stars: 3 }), env);
    const res = await worker.fetch(r('GET', '/api/paths/p1/reviews'), env);
    const d = await res.json();
    assert.equal(d.count, 2);
    assert.equal(d.avg, 4);
    assert.equal(d.reviews.length, 2);
    const alice = d.reviews.find(rv => rv.name === 'Alice');
    assert.equal(alice.comment, 'Magnifique');
  });

  test('includes caller own review when authenticated', async () => {
    const { env } = freshEnv();
    await worker.fetch(authed('POST', '/api/paths/p1/reviews', 'tok-u1', { stars: 4, comment: 'Bien' }), env);
    const res = await worker.fetch(authed('GET', '/api/paths/p1/reviews', 'tok-u1'), env);
    const d = await res.json();
    assert.deepEqual(d.mine, { stars: 4, comment: 'Bien' });
  });
});

describe('POST /api/paths/:id/reviews', () => {
  test('rejects unauthenticated', async () => {
    const { env } = freshEnv();
    const res = await worker.fetch(r('POST', '/api/paths/p1/reviews', { stars: 5 }), env);
    assert.equal(res.status, 401);
  });

  test('404 when the path does not exist', async () => {
    const { env } = freshEnv();
    const res = await worker.fetch(authed('POST', '/api/paths/nope/reviews', 'tok-u1', { stars: 5 }), env);
    assert.equal(res.status, 404);
  });

  test('rejects out-of-range stars', async () => {
    const { env } = freshEnv();
    for (const stars of [0, 6, 2.5, 'x']) {
      const res = await worker.fetch(authed('POST', '/api/paths/p1/reviews', 'tok-u1', { stars }), env);
      assert.equal(res.status, 400, `stars=${stars}`);
    }
  });

  test('one review per account per path — re-post overwrites', async () => {
    const { env, kv } = freshEnv();
    await worker.fetch(authed('POST', '/api/paths/p1/reviews', 'tok-u1', { stars: 2, comment: 'Bof' }), env);
    await worker.fetch(authed('POST', '/api/paths/p1/reviews', 'tok-u1', { stars: 5, comment: 'Finalement top' }), env);
    const keys = [...kv.store.keys()].filter(k => k.startsWith('pathreview:p1:'));
    assert.equal(keys.length, 1);
    const stored = JSON.parse(kv.store.get('pathreview:p1:u1'));
    assert.equal(stored.stars, 5);
    assert.equal(stored.comment, 'Finalement top');
    assert.ok(stored.createdAt);
  });
});

describe('DELETE /api/paths/:id/reviews/:userId', () => {
  test('author can delete own review', async () => {
    const { env, kv } = freshEnv();
    await worker.fetch(authed('POST', '/api/paths/p1/reviews', 'tok-u1', { stars: 5 }), env);
    const res = await worker.fetch(authed('DELETE', '/api/paths/p1/reviews/u1', 'tok-u1'), env);
    assert.equal(res.status, 200);
    assert.equal(kv.store.get('pathreview:p1:u1'), undefined);
  });

  test('another user cannot delete someone else review', async () => {
    const { env, kv } = freshEnv();
    await worker.fetch(authed('POST', '/api/paths/p1/reviews', 'tok-u1', { stars: 5 }), env);
    const res = await worker.fetch(authed('DELETE', '/api/paths/p1/reviews/u1', 'tok-u2'), env);
    assert.equal(res.status, 403);
    assert.ok(kv.store.get('pathreview:p1:u1'));
  });

  test('admin can delete any review', async () => {
    const { env, kv } = freshEnv();
    await worker.fetch(authed('POST', '/api/paths/p1/reviews', 'tok-u1', { stars: 5 }), env);
    const res = await worker.fetch(authed('DELETE', '/api/paths/p1/reviews/u1', 'tok-admin'), env);
    assert.equal(res.status, 200);
    assert.equal(kv.store.get('pathreview:p1:u1'), undefined);
  });

  test('review DELETE does NOT delete the path (dispatch ordering)', async () => {
    const { env, kv } = freshEnv();
    await worker.fetch(authed('POST', '/api/paths/p1/reviews', 'tok-u1', { stars: 5 }), env);
    await worker.fetch(authed('DELETE', '/api/paths/p1/reviews/u1', 'tok-admin'), env);
    assert.ok(kv.store.get('path:p1'), 'the path itself must survive a review deletion');
  });
});
