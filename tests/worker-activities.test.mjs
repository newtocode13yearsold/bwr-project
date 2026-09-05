// Recorded activities (hike journal) handler integration tests.
// Covers: save (auth + validation + sanitisation), list (summary shape),
// get-by-id, rename (PATCH), delete, and the 404/401 guards.

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

function freshEnv(plan = 'free') {
  const kv  = makeMockKV();
  const env = { BWR_KV: kv };
  const userId = 'user-act-test';

  const user = { id: userId, name: 'Test', email: 'act@bwr.fr', role: 'user', plan };
  kv.store.set(`user:${userId}`, JSON.stringify(user));
  kv.store.set(`uemail:act@bwr.fr`, userId);

  const token = 'act-token';
  kv.store.set(`session:${token}`, JSON.stringify({ userId, expiresAt: new Date(Date.now() + 86400000).toISOString() }));

  return { kv, env, token, userId };
}

const r = (method, path, body, headers = {}) => new Request(
  `https://bwr.test${path}`,
  {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    ...(body != null ? { body: JSON.stringify(body) } : {}),
  },
);
const authed = (method, path, token, body) =>
  r(method, path, body, { Authorization: `Bearer ${token}` });

const sampleCoords = [[49.35, 2.90], [49.36, 2.91], [49.37, 2.92]];
const sampleBody = {
  name: 'Balade du dimanche',
  coords: sampleCoords,
  elevations: [80, 92, 85],
  times: [1000, 5000, 9000],
  meters: 2500,
  seconds: 1800,
  movingSeconds: 1600,
  ascent: 30,
  descent: 25,
  startedAt: '2026-09-01T09:00:00.000Z',
};

// ── POST /api/activities ──────────────────────────────────────────────────────

describe('POST /api/activities', () => {
  test('rejects unauthenticated requests', async () => {
    const { env } = freshEnv();
    const res = await worker.fetch(r('POST', '/api/activities', sampleBody), env);
    assert.equal(res.status, 401);
  });

  test('is available to free-plan users (retention hook, not gated)', async () => {
    const { env, token, kv, userId } = freshEnv('free');
    const res = await worker.fetch(authed('POST', '/api/activities', token, sampleBody), env);
    assert.equal(res.status, 201);
    const { id } = await res.json();
    assert.ok(kv.store.has(`activity:${userId}:${id}`));
  });

  test('rejects a track with fewer than 2 points', async () => {
    const { env, token } = freshEnv();
    const res = await worker.fetch(authed('POST', '/api/activities', token, { coords: [[49.35, 2.90]], meters: 100 }), env);
    assert.equal(res.status, 400);
  });

  test('stores coords, parallel arrays and rounded stats', async () => {
    const { env, token, kv, userId } = freshEnv();
    const res = await worker.fetch(authed('POST', '/api/activities', token, sampleBody), env);
    const { id } = await res.json();
    const stored = JSON.parse(kv.store.get(`activity:${userId}:${id}`));
    assert.equal(stored.coords.length, 3);
    assert.equal(stored.elevations.length, 3);
    assert.equal(stored.times.length, 3);
    assert.equal(stored.meters, 2500);
    assert.equal(stored.ascent, 30);
    assert.equal(stored.name, 'Balade du dimanche');
    assert.ok(stored.savedAt);
  });

  test('drops parallel arrays whose length does not match the track', async () => {
    const { env, token, kv, userId } = freshEnv();
    const res = await worker.fetch(authed('POST', '/api/activities', token, {
      coords: sampleCoords, elevations: [1, 2], times: [1], meters: 500,
    }), env);
    const { id } = await res.json();
    const stored = JSON.parse(kv.store.get(`activity:${userId}:${id}`));
    assert.equal(stored.elevations, null);
    assert.equal(stored.times, null);
  });

  test('filters out non-finite / out-of-range coordinates', async () => {
    const { env, token, kv, userId } = freshEnv();
    const res = await worker.fetch(authed('POST', '/api/activities', token, {
      coords: [[49.35, 2.90], ['x', 2.91], [999, 2.92], [49.37, 2.93]], meters: 100,
    }), env);
    assert.equal(res.status, 201);
    const { id } = await res.json();
    const stored = JSON.parse(kv.store.get(`activity:${userId}:${id}`));
    assert.equal(stored.coords.length, 2);
  });

  test('falls back to a default name and clamps negative stats', async () => {
    const { env, token, kv, userId } = freshEnv();
    const res = await worker.fetch(authed('POST', '/api/activities', token, {
      coords: sampleCoords, meters: -50, seconds: -10,
    }), env);
    const { id } = await res.json();
    const stored = JSON.parse(kv.store.get(`activity:${userId}:${id}`));
    assert.equal(stored.name, 'Sortie sans nom');
    assert.equal(stored.meters, 0);
    assert.equal(stored.seconds, 0);
  });
});

// ── GET /api/activities ───────────────────────────────────────────────────────

describe('GET /api/activities', () => {
  test('returns empty list when nothing recorded', async () => {
    const { env, token } = freshEnv();
    const res = await worker.fetch(authed('GET', '/api/activities', token), env);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), []);
  });

  test('lists summaries without heavy geometry, newest first', async () => {
    const { env, token } = freshEnv();
    await worker.fetch(authed('POST', '/api/activities', token, { ...sampleBody, name: 'Ancienne', startedAt: '2026-08-01T09:00:00.000Z' }), env);
    await worker.fetch(authed('POST', '/api/activities', token, { ...sampleBody, name: 'Récente', startedAt: '2026-09-01T09:00:00.000Z' }), env);

    const res = await worker.fetch(authed('GET', '/api/activities', token), env);
    const list = await res.json();
    assert.equal(list.length, 2);
    assert.equal(list[0].name, 'Récente'); // sorted newest first
    for (const a of list) {
      assert.ok(!('coords' in a), 'coords must be stripped from the list');
      assert.ok(!('elevations' in a), 'elevations must be stripped from the list');
      assert.equal(typeof a.points, 'number');
    }
  });
});

// ── GET /api/activities/:id ────────────────────────────────────────────────────

describe('GET /api/activities/:id', () => {
  test('returns the full activity with coords', async () => {
    const { env, token } = freshEnv();
    const { id } = await (await worker.fetch(authed('POST', '/api/activities', token, sampleBody), env)).json();
    const res = await worker.fetch(authed('GET', `/api/activities/${id}`, token), env);
    assert.equal(res.status, 200);
    const full = await res.json();
    assert.equal(full.coords.length, 3);
    assert.equal(full.name, 'Balade du dimanche');
  });

  test('404 for an unknown id', async () => {
    const { env, token } = freshEnv();
    const res = await worker.fetch(authed('GET', '/api/activities/nope', token), env);
    assert.equal(res.status, 404);
  });
});

// ── PATCH /api/activities/:id (rename) ─────────────────────────────────────────

describe('PATCH /api/activities/:id', () => {
  test('renames the activity', async () => {
    const { env, token, kv, userId } = freshEnv();
    const { id } = await (await worker.fetch(authed('POST', '/api/activities', token, sampleBody), env)).json();
    const res = await worker.fetch(authed('PATCH', `/api/activities/${id}`, token, { name: 'Nouveau nom' }), env);
    assert.equal(res.status, 200);
    const stored = JSON.parse(kv.store.get(`activity:${userId}:${id}`));
    assert.equal(stored.name, 'Nouveau nom');
  });

  test('rejects an empty name', async () => {
    const { env, token } = freshEnv();
    const { id } = await (await worker.fetch(authed('POST', '/api/activities', token, sampleBody), env)).json();
    const res = await worker.fetch(authed('PATCH', `/api/activities/${id}`, token, { name: '   ' }), env);
    assert.equal(res.status, 400);
  });
});

// ── DELETE /api/activities/:id ─────────────────────────────────────────────────

describe('DELETE /api/activities/:id', () => {
  test('deletes the activity', async () => {
    const { env, token, kv, userId } = freshEnv();
    const { id } = await (await worker.fetch(authed('POST', '/api/activities', token, sampleBody), env)).json();
    const res = await worker.fetch(authed('DELETE', `/api/activities/${id}`, token), env);
    assert.equal(res.status, 200);
    assert.ok(!kv.store.has(`activity:${userId}:${id}`));
  });

  test('404 when deleting an unknown id', async () => {
    const { env, token } = freshEnv();
    const res = await worker.fetch(authed('DELETE', '/api/activities/nope', token), env);
    assert.equal(res.status, 404);
  });

  test("a user cannot read another user's activity", async () => {
    const { env, token, kv } = freshEnv();
    const { id } = await (await worker.fetch(authed('POST', '/api/activities', token, sampleBody), env)).json();
    // Second user in the same store.
    kv.store.set('user:other', JSON.stringify({ id: 'other', name: 'Other', email: 'o@bwr.fr', role: 'user', plan: 'free' }));
    kv.store.set('session:other-token', JSON.stringify({ userId: 'other', expiresAt: new Date(Date.now() + 86400000).toISOString() }));
    const res = await worker.fetch(authed('GET', `/api/activities/${id}`, 'other-token'), env);
    assert.equal(res.status, 404); // scoped by activity:{userId}: prefix
  });
});
