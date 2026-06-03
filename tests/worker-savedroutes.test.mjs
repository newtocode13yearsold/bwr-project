// Saved routes handler integration tests.
// Covers: save (silver+ only), list, get by id, share link, delete.

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

function freshEnv(plan = 'silver') {
  const kv  = makeMockKV();
  const env = { BWR_KV: kv };
  const userId = 'user-sr-test';

  const user = { id: userId, name: 'Test', email: 'sr@bwr.fr', role: 'user', plan };
  kv.store.set(`user:${userId}`, JSON.stringify(user));
  kv.store.set(`uemail:sr@bwr.fr`, userId);

  const token = 'sr-token';
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

const sampleCoords = [[49.35, 2.90], [49.36, 2.91], [49.37, 2.92]];

// ── POST /api/savedroutes ─────────────────────────────────────────────────────

describe('POST /api/savedroutes', () => {
  test('rejects unauthenticated requests', async () => {
    const { env } = freshEnv();
    const res = await worker.fetch(r('POST', '/api/savedroutes', { coords: sampleCoords, meters: 1000 }), env);
    assert.equal(res.status, 401);
  });

  test('rejects free-plan users', async () => {
    const { env, token } = freshEnv('free');
    const res = await worker.fetch(authed('POST', '/api/savedroutes', token, { coords: sampleCoords, meters: 1000 }), env);
    assert.equal(res.status, 403);
    const data = await res.json();
    assert.ok(data.error.includes('Argent'));
  });

  test('rejects body with fewer than 2 coords', async () => {
    const { env, token } = freshEnv();
    const res = await worker.fetch(authed('POST', '/api/savedroutes', token, { coords: [[49.35, 2.90]], meters: 500 }), env);
    assert.equal(res.status, 400);
  });

  test('saves route and returns id + shareToken for silver user', async () => {
    const { env, token, kv } = freshEnv('silver');
    const res = await worker.fetch(authed('POST', '/api/savedroutes', token, {
      name: 'Boucle test',
      coords: sampleCoords,
      meters: 3200,
      seconds: 2400,
      difficulty: 'easy',
      pathType: 'foot',
      mode: 'loop',
    }), env);
    assert.equal(res.status, 201);
    const data = await res.json();
    assert.ok(data.id);
    assert.ok(data.shareToken);
    assert.ok(kv.store.has(`savedroute:user-sr-test:${data.id}`));
    assert.ok(kv.store.has(`routeshare:${data.shareToken}`));
  });

  test('sanitises invalid difficulty/pathType/mode to defaults', async () => {
    const { env, token, kv, userId } = freshEnv('gold');
    const res = await worker.fetch(authed('POST', '/api/savedroutes', token, {
      coords: sampleCoords,
      meters: 1000,
      difficulty: 'extreme',
      pathType: 'unicycle',
      mode: 'teleport',
    }), env);
    assert.equal(res.status, 201);
    const { id } = await res.json();
    const stored = JSON.parse(kv.store.get(`savedroute:${userId}:${id}`));
    assert.equal(stored.difficulty, 'easy');
    assert.equal(stored.pathType, 'foot');
    assert.equal(stored.mode, 'atob');
  });
});

// ── GET /api/savedroutes ──────────────────────────────────────────────────────

describe('GET /api/savedroutes', () => {
  test('returns empty list when no routes saved', async () => {
    const { env, token } = freshEnv();
    const res = await worker.fetch(authed('GET', '/api/savedroutes', token), env);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.deepEqual(data, []);
  });

  test('lists saved routes without coords field', async () => {
    const { env, token } = freshEnv('silver');
    await worker.fetch(authed('POST', '/api/savedroutes', token, { name: 'R1', coords: sampleCoords, meters: 1000 }), env);
    await worker.fetch(authed('POST', '/api/savedroutes', token, { name: 'R2', coords: sampleCoords, meters: 2000 }), env);

    const res = await worker.fetch(authed('GET', '/api/savedroutes', token), env);
    const data = await res.json();
    assert.equal(data.length, 2);
    for (const route of data) {
      assert.ok(!('coords' in route), 'coords should be stripped from list');
    }
  });
});

// ── GET /api/savedroutes/share/:token ─────────────────────────────────────────

describe('GET /api/savedroutes/share/:token', () => {
  test('returns route publicly (no auth required)', async () => {
    const { env, token } = freshEnv('gold');
    const saveRes = await worker.fetch(authed('POST', '/api/savedroutes', token, { name: 'Shared', coords: sampleCoords, meters: 1500 }), env);
    const { shareToken } = await saveRes.json();

    const shareRes = await worker.fetch(r('GET', `/api/savedroutes/share/${shareToken}`), env);
    assert.equal(shareRes.status, 200);
    const data = await shareRes.json();
    assert.equal(data.name, 'Shared');
    assert.ok(!('userId' in data), 'userId must not be exposed in share response');
  });

  test('returns 404 for unknown share token', async () => {
    const { env } = freshEnv();
    const res = await worker.fetch(r('GET', '/api/savedroutes/share/doesnotexist'), env);
    assert.equal(res.status, 404);
  });
});

// ── DELETE /api/savedroutes/:id ───────────────────────────────────────────────

describe('DELETE /api/savedroutes/:id', () => {
  test('deletes route and its share token', async () => {
    const { env, token, kv, userId } = freshEnv('silver');
    const saveRes = await worker.fetch(authed('POST', '/api/savedroutes', token, { coords: sampleCoords, meters: 1000 }), env);
    const { id, shareToken } = await saveRes.json();

    const delRes = await worker.fetch(authed('DELETE', `/api/savedroutes/${id}`, token), env);
    assert.equal(delRes.status, 200);
    assert.ok(!kv.store.has(`savedroute:${userId}:${id}`));
    assert.ok(!kv.store.has(`routeshare:${shareToken}`));
  });

  test('returns 404 when route not found', async () => {
    const { env, token } = freshEnv('silver');
    const res = await worker.fetch(authed('DELETE', '/api/savedroutes/nonexistent', token), env);
    assert.equal(res.status, 404);
  });
});
