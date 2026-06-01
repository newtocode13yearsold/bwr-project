// Paths handler integration tests.
// Covers: list, create (silver+), update (admin), patch status, delete.

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
    async list({ prefix = '', limit = 1000 } = {}) {
      const keys = [];
      for (const k of store.keys()) if (k.startsWith(prefix)) keys.push({ name: k });
      const page = keys.slice(0, limit);
      return { keys: page, list_complete: page.length === keys.length };
    },
  };
}

function freshEnv(role = 'user', plan = 'silver') {
  const kv  = makeMockKV();
  const env = { BWR_KV: kv };
  const userId = 'user-path-test';
  const user = { id: userId, name: 'Test', email: 'path@bwr.fr', role, plan };
  kv.store.set(`user:${userId}`, JSON.stringify(user));
  kv.store.set(`uemail:path@bwr.fr`, userId);
  const token = 'path-token';
  kv.store.set(`session:${token}`, JSON.stringify({ userId, expiresAt: new Date(Date.now() + 86400000).toISOString() }));
  return { kv, env, token, userId };
}

const r = (method, path, body, headers = {}) => new Request(
  `https://bwr.test${path}`,
  {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    ...(body != null ? { body: JSON.stringify(body) } : {}),
  }
);
const authed = (method, path, token, body) =>
  r(method, path, body, { Authorization: `Bearer ${token}` });

const sampleCoords = [[49.35, 2.90], [49.36, 2.91]];

// ── GET /api/paths ────────────────────────────────────────────────────────────

describe('GET /api/paths', () => {
  test('returns empty array when no paths exist', async () => {
    const { env } = freshEnv();
    const res = await worker.fetch(r('GET', '/api/paths'), env);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), []);
  });

  test('returns all stored paths (public endpoint)', async () => {
    const { env, kv } = freshEnv();
    const path = { id: 'p1', name: 'Sentier test', status: 'easy', coordinates: sampleCoords };
    kv.store.set('path:p1', JSON.stringify(path));
    const res = await worker.fetch(r('GET', '/api/paths'), env);
    const data = await res.json();
    assert.equal(data.length, 1);
    assert.equal(data[0].id, 'p1');
  });
});

// ── POST /api/paths ───────────────────────────────────────────────────────────

describe('POST /api/paths', () => {
  test('rejects unauthenticated requests', async () => {
    const { env } = freshEnv();
    const res = await worker.fetch(r('POST', '/api/paths', { coordinates: sampleCoords }), env);
    assert.equal(res.status, 401);
  });

  test('rejects free-plan users', async () => {
    const { env, token } = freshEnv('user', 'free');
    const res = await worker.fetch(authed('POST', '/api/paths', token, { coordinates: sampleCoords }), env);
    assert.equal(res.status, 403);
  });

  test('creates path for silver user and stores it in KV', async () => {
    const { env, token, kv } = freshEnv('user', 'silver');
    const res = await worker.fetch(authed('POST', '/api/paths', token, {
      name: 'Nouveau sentier',
      pathType: 'foot',
      status: 'easy',
      coordinates: sampleCoords,
    }), env);
    assert.equal(res.status, 201);
    const data = await res.json();
    assert.ok(data.id);
    assert.equal(data.name, 'Nouveau sentier');
    assert.ok(kv.store.has(`path:${data.id}`));
  });

  test('sanitises invalid status and pathType to defaults', async () => {
    const { env, token } = freshEnv('user', 'gold');
    const res = await worker.fetch(authed('POST', '/api/paths', token, {
      coordinates: sampleCoords,
      status: 'invisible',
      pathType: 'hovercraft',
    }), env);
    assert.equal(res.status, 201);
    const data = await res.json();
    assert.equal(data.status, 'easy');
    assert.equal(data.pathType, 'foot');
  });
});

// ── PATCH /api/paths/:id ──────────────────────────────────────────────────────

describe('PATCH /api/paths/:id', () => {
  async function createPath(env, token) {
    const res = await worker.fetch(authed('POST', '/api/paths', token, {
      name: 'Chemin', coordinates: sampleCoords, status: 'easy',
    }), env);
    return (await res.json()).id;
  }

  test('rejects invalid status values', async () => {
    const { env, token } = freshEnv('user', 'silver');
    const id = await createPath(env, token);
    const res = await worker.fetch(authed('PATCH', `/api/paths/${id}`, token, { status: 'rainbow' }), env);
    assert.equal(res.status, 400);
  });

  test('rejects free user trying to mark Difficile', async () => {
    const { env, kv, token } = freshEnv('user', 'free');
    const pathId = 'p-free';
    kv.store.set(`path:${pathId}`, JSON.stringify({ id: pathId, name: 'X', status: 'easy', coordinates: sampleCoords }));
    const res = await worker.fetch(authed('PATCH', `/api/paths/${pathId}`, token, { status: 'hard' }), env);
    assert.equal(res.status, 403);
  });

  test('updates status and increments pathGrades stat', async () => {
    const { env, token, kv, userId } = freshEnv('user', 'silver');
    const id = await createPath(env, token);
    const res = await worker.fetch(authed('PATCH', `/api/paths/${id}`, token, { status: 'medium' }), env);
    assert.equal(res.status, 200);
    const updated = await res.json();
    assert.equal(updated.status, 'medium');
    const user = JSON.parse(kv.store.get(`user:${userId}`));
    assert.equal(user.stats.pathGrades, 1);
  });

  test('does not double-count if same user patches same path twice', async () => {
    const { env, token, kv, userId } = freshEnv('user', 'silver');
    const id = await createPath(env, token);
    await worker.fetch(authed('PATCH', `/api/paths/${id}`, token, { status: 'medium' }), env);
    await worker.fetch(authed('PATCH', `/api/paths/${id}`, token, { status: 'hard' }), env);
    const user = JSON.parse(kv.store.get(`user:${userId}`));
    assert.equal(user.stats.pathGrades, 1);
  });
});

// ── DELETE /api/paths/:id ─────────────────────────────────────────────────────

describe('DELETE /api/paths/:id', () => {
  test('rejects free-plan users', async () => {
    const { env, token, kv } = freshEnv('user', 'free');
    kv.store.set('path:p-del', JSON.stringify({ id: 'p-del', coordinates: sampleCoords }));
    const res = await worker.fetch(authed('DELETE', '/api/paths/p-del', token), env);
    assert.equal(res.status, 403);
  });

  test('removes path from KV for silver+ user', async () => {
    const { env, token, kv } = freshEnv('user', 'silver');
    kv.store.set('path:p-del', JSON.stringify({ id: 'p-del', coordinates: sampleCoords }));
    const res = await worker.fetch(authed('DELETE', '/api/paths/p-del', token), env);
    assert.equal(res.status, 200);
    assert.ok(!kv.store.has('path:p-del'));
  });
});
