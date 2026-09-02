// Quest-reward handler integration tests.
// Covers: auth guard, unknown/unachieved quests, real plan grant + inbox
// notification, claimed-once idempotency, badge grant, no-downgrade safety,
// and the GET /api/quests/claims read.

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

function seedUser(kv, { id, plan = 'free', role = 'user', token, stats = {}, extra = {} }) {
  const user = { id, name: id, email: `${id}@bwr.fr`, role, plan, stats, ...extra };
  kv.store.set(`user:${id}`, JSON.stringify(user));
  kv.store.set(`session:${token}`, JSON.stringify({ userId: id, expiresAt: new Date(Date.now() + 86400000).toISOString() }));
}

const r = (method, path, body, headers = {}) => new Request(
  `https://bwr.test${path}`,
  { method, headers: { 'Content-Type': 'application/json', ...headers }, ...(body != null ? { body: JSON.stringify(body) } : {}) }
);
const authed = (method, path, token, body) => r(method, path, body, { Authorization: `Bearer ${token}` });

const inboxKeys = (kv) => [...kv.store.keys()].filter(k => k.startsWith('inboxmsg:'));
const readUser = (kv, id) => JSON.parse(kv.store.get(`user:${id}`));

describe('POST /api/quests/claim', () => {
  test('rejects unauthenticated', async () => {
    const kv = makeMockKV();
    const res = await worker.fetch(r('POST', '/api/quests/claim', { questId: 'o1' }), { BWR_KV: kv });
    assert.equal(res.status, 401);
  });

  test('unknown quest id → 404', async () => {
    const kv = makeMockKV();
    seedUser(kv, { id: 'u1', token: 't1', stats: { pathGrades: 999 } });
    const res = await worker.fetch(authed('POST', '/api/quests/claim', 't1', { questId: 'nope' }), { BWR_KV: kv });
    assert.equal(res.status, 404);
  });

  test('not achieved → 400 ok:false, nothing granted', async () => {
    const kv = makeMockKV();
    seedUser(kv, { id: 'u1', token: 't1', stats: { pathGrades: 10 } });
    const res = await worker.fetch(authed('POST', '/api/quests/claim', 't1', { questId: 'o1' }), { BWR_KV: kv });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.equal(readUser(kv, 'u1').questClaims, undefined);
    assert.equal(inboxKeys(kv).length, 0);
  });

  test('achieved plan reward: grants Gold + sends inbox message + records claim', async () => {
    const kv = makeMockKV();
    seedUser(kv, { id: 'u1', token: 't1', plan: 'free', stats: { pathGrades: 200 } });
    const res = await worker.fetch(authed('POST', '/api/quests/claim', 't1', { questId: 'o1' }), { BWR_KV: kv });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.plan, 'gold');
    assert.ok(body.planExpiresAt);

    const u = readUser(kv, 'u1');
    assert.equal(u.plan, 'gold');
    assert.equal(u.planBase, 'free');
    assert.ok(u.questClaims.o1);
    // ~30 days out
    const days = (new Date(u.planExpiresAt) - Date.now()) / 86400000;
    assert.ok(days > 29 && days < 31, `expected ~30 days, got ${days}`);

    const msgs = inboxKeys(kv);
    assert.equal(msgs.length, 1);
    const msg = JSON.parse(kv.store.get(msgs[0]));
    assert.equal(msg.target, 'u1');
    assert.match(msg.subject, /Récompense/);
  });

  test('claimed-once: second claim is a no-op (no new inbox, no re-grant)', async () => {
    const kv = makeMockKV();
    seedUser(kv, { id: 'u1', token: 't1', plan: 'free', stats: { pathGrades: 200 } });
    await worker.fetch(authed('POST', '/api/quests/claim', 't1', { questId: 'o1' }), { BWR_KV: kv });
    const res2 = await worker.fetch(authed('POST', '/api/quests/claim', 't1', { questId: 'o1' }), { BWR_KV: kv });
    assert.equal(res2.status, 200);
    const body2 = await res2.json();
    assert.equal(body2.alreadyClaimed, true);
    assert.equal(inboxKeys(kv).length, 1); // still just the first message
  });

  test('badge reward: appends an exclusive badge to the user', async () => {
    const kv = makeMockKV();
    seedUser(kv, { id: 'u1', token: 't1', plan: 'silver', stats: { km: 500 } });
    const res = await worker.fetch(authed('POST', '/api/quests/claim', 't1', { questId: 'o3' }), { BWR_KV: kv });
    assert.equal(res.status, 200);
    const u = readUser(kv, 'u1');
    assert.ok(Array.isArray(u.questBadges));
    assert.equal(u.questBadges[0].id, 'quest_walker');
    assert.ok(u.questClaims.o3);
  });

  test('no downgrade: a Gold user claiming a Silver reward keeps Gold', async () => {
    const kv = makeMockKV();
    seedUser(kv, { id: 'u1', token: 't1', plan: 'gold', stats: { reports: 100 } });
    const res = await worker.fetch(authed('POST', '/api/quests/claim', 't1', { questId: 'o2' }), { BWR_KV: kv });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.plan, null);            // no plan change applied
    const u = readUser(kv, 'u1');
    assert.equal(u.plan, 'gold');
    assert.equal(u.planExpiresAt, undefined); // untouched
    assert.equal(u.questBadges[0].id, 'quest_guardian'); // badge still granted
    assert.equal(inboxKeys(kv).length, 1);    // still notified
  });
});

describe('GET /api/quests/claims', () => {
  test('returns the user claim + badge state', async () => {
    const kv = makeMockKV();
    seedUser(kv, { id: 'u1', token: 't1', stats: { pathGrades: 200 } });
    await worker.fetch(authed('POST', '/api/quests/claim', 't1', { questId: 'o1' }), { BWR_KV: kv });
    const res = await worker.fetch(authed('GET', '/api/quests/claims', 't1'), { BWR_KV: kv });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.claims.o1);
    assert.ok(Array.isArray(body.badges));
  });

  test('rejects unauthenticated', async () => {
    const kv = makeMockKV();
    const res = await worker.fetch(r('GET', '/api/quests/claims'), { BWR_KV: kv });
    assert.equal(res.status, 401);
  });
});
