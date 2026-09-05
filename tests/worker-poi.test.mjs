// Points-of-interest handler integration tests.
// Covers: public list, Silver+ create gate, type/coord validation, author/admin
// edit + delete, and 404s.

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
  seedUser(kv, { id: 'free1', name: 'Freddy', plan: 'free', token: 'tok-free' });
  seedUser(kv, { id: 'silver1', name: 'Sylvie', plan: 'silver', token: 'tok-silver' });
  seedUser(kv, { id: 'silver2', name: 'Simon', plan: 'silver', token: 'tok-silver2' });
  seedUser(kv, { id: 'admin1', name: 'Admin', role: 'admin', token: 'tok-admin' });
  return { kv, env };
}

const r = (method, path, body, headers = {}) => new Request(
  `https://bwr.test${path}`,
  { method, headers: { 'Content-Type': 'application/json', ...headers }, ...(body != null ? { body: JSON.stringify(body) } : {}) }
);
const authed = (method, path, token, body) => r(method, path, body, { Authorization: `Bearer ${token}` });

const validPoi = { type: 'parking', name: 'Parking des Beaux Monts', lat: 49.4, lon: 2.9, note: 'Grand parking' };

async function createPoi(env, token = 'tok-silver', body = validPoi) {
  const res = await worker.fetch(authed('POST', '/api/pois', token, body), env);
  return { res, poi: res.ok ? await res.json() : null };
}

describe('GET /api/pois (public)', () => {
  test('empty array when none', async () => {
    const { env } = freshEnv();
    const res = await worker.fetch(r('GET', '/api/pois'), env);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), []);
  });

  test('lists created POIs to anyone', async () => {
    const { env } = freshEnv();
    await createPoi(env);
    const res = await worker.fetch(r('GET', '/api/pois'), env);
    const d = await res.json();
    assert.equal(d.length, 1);
    assert.equal(d[0].type, 'parking');
    assert.equal(d[0].createdByName, 'Sylvie');
  });
});

describe('POST /api/pois', () => {
  test('rejects unauthenticated', async () => {
    const { env } = freshEnv();
    const res = await worker.fetch(r('POST', '/api/pois', validPoi), env);
    assert.equal(res.status, 401);
  });

  test('free tier is blocked (Silver+ only)', async () => {
    const { env } = freshEnv();
    const { res } = await createPoi(env, 'tok-free');
    assert.equal(res.status, 403);
  });

  test('silver can create', async () => {
    const { env } = freshEnv();
    const { res, poi } = await createPoi(env, 'tok-silver');
    assert.equal(res.status, 201);
    assert.equal(poi.createdBy, 'silver1');
    assert.ok(poi.id);
  });

  test('admin can create', async () => {
    const { env } = freshEnv();
    const { res } = await createPoi(env, 'tok-admin');
    assert.equal(res.status, 201);
  });

  test('rejects invalid type', async () => {
    const { env } = freshEnv();
    const { res } = await createPoi(env, 'tok-silver', { ...validPoi, type: 'bogus' });
    assert.equal(res.status, 400);
  });

  test('rejects invalid coordinates', async () => {
    const { env } = freshEnv();
    const { res } = await createPoi(env, 'tok-silver', { ...validPoi, lat: 999, lon: 2.9 });
    assert.equal(res.status, 400);
  });
});

describe('PUT /api/pois/:id', () => {
  test('author can edit', async () => {
    const { env } = freshEnv();
    const { poi } = await createPoi(env);
    const res = await worker.fetch(authed('PUT', `/api/pois/${poi.id}`, 'tok-silver', { name: 'Renommé', type: 'water' }), env);
    assert.equal(res.status, 200);
    const d = await res.json();
    assert.equal(d.name, 'Renommé');
    assert.equal(d.type, 'water');
  });

  test('non-author non-admin is refused', async () => {
    const { env } = freshEnv();
    const { poi } = await createPoi(env);
    const res = await worker.fetch(authed('PUT', `/api/pois/${poi.id}`, 'tok-silver2', { name: 'Pirate' }), env);
    assert.equal(res.status, 403);
  });

  test('404 for unknown id', async () => {
    const { env } = freshEnv();
    const res = await worker.fetch(authed('PUT', '/api/pois/nope', 'tok-admin', { name: 'x' }), env);
    assert.equal(res.status, 404);
  });
});

describe('DELETE /api/pois/:id', () => {
  test('author can delete', async () => {
    const { env, kv } = freshEnv();
    const { poi } = await createPoi(env);
    const res = await worker.fetch(authed('DELETE', `/api/pois/${poi.id}`, 'tok-silver'), env);
    assert.equal(res.status, 200);
    assert.equal(kv.store.get(`poi:${poi.id}`), undefined);
  });

  test('admin can delete any POI', async () => {
    const { env, kv } = freshEnv();
    const { poi } = await createPoi(env);
    const res = await worker.fetch(authed('DELETE', `/api/pois/${poi.id}`, 'tok-admin'), env);
    assert.equal(res.status, 200);
    assert.equal(kv.store.get(`poi:${poi.id}`), undefined);
  });

  test('other user cannot delete', async () => {
    const { env } = freshEnv();
    const { poi } = await createPoi(env);
    const res = await worker.fetch(authed('DELETE', `/api/pois/${poi.id}`, 'tok-silver2'), env);
    assert.equal(res.status, 403);
  });
});
