// Leaderboard integration tests — Node 18+.
//
// Covers the three classement scopes added alongside XP-based progression:
//   • GET /api/leaderboard            → all-time board from user.stats
//   • GET /api/leaderboard?period=week  → current ISO-week board from xp: buckets
//   • GET /api/leaderboard?period=month → current-month board from xp: buckets
// and that creating a report feeds the periodic buckets.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker.js';
import { isoWeekKey, monthKey } from '../worker/kv.js';

function makeMockKV() {
  const store = new Map();
  return {
    store,
    async get(key) { return store.get(key) ?? null; },
    async put(key, value) { store.set(key, value); },
    async delete(key) { store.delete(key); },
    async list({ prefix = '', limit = 1000 } = {}) {
      const keys = [];
      for (const k of store.keys()) if (k.startsWith(prefix)) keys.push({ name: k });
      const page = keys.slice(0, limit);
      return { keys: page, list_complete: page.length === keys.length };
    },
  };
}

function freshEnv() {
  const kv = makeMockKV();
  const env = { BWR_KV: kv };
  const seedUser = (u) => {
    kv.store.set(`user:${u.id}`, JSON.stringify(u));
    kv.store.set(`uemail:${u.email.toLowerCase()}`, u.id);
  };
  const seedWithPlan = (id, plan) => {
    const user = { id, name: id, email: `${id}@bwr.fr`, role: plan, plan, stats: { routes: 0, km: 0 } };
    seedUser(user);
    const token = `tok-${id}`;
    kv.store.set(`session:${token}`, JSON.stringify({ userId: id, expiresAt: new Date(Date.now() + 86_400_000).toISOString() }));
    return { user, token };
  };
  const seedSilver = (id) => seedWithPlan(id, 'silver');
  const seedFree   = (id) => seedWithPlan(id, 'free');
  return { kv, env, seedUser, seedSilver, seedFree };
}

const r = (method, path, body, headers = {}) => new Request(`https://bwr.test${path}`, {
  method,
  headers: { 'Content-Type': 'application/json', ...headers },
  ...(body != null ? { body: JSON.stringify(body) } : {}),
});
const authed = (method, path, token, body) => r(method, path, body, { Authorization: `Bearer ${token}` });

describe('GET /api/leaderboard (all-time)', () => {
  test('sorts members by points = reports*2 + pathGrades', async () => {
    const { env, seedUser } = freshEnv();
    seedUser({ id: 'a', name: 'Alpha', email: 'a@bwr.fr', stats: { reports: 1, pathGrades: 0 } });   // 2 pts
    seedUser({ id: 'b', name: 'Bravo', email: 'b@bwr.fr', stats: { reports: 2, pathGrades: 3 } });   // 7 pts
    const res = await worker.fetch(r('GET', '/api/leaderboard'), env);
    assert.equal(res.status, 200);
    const board = await res.json();
    assert.deepEqual(board.map(e => e.id), ['b', 'a']);
    assert.equal(board[0].points, 7);
    assert.equal(typeof board[0].forestCoverage, 'number');
  });
});

describe('GET /api/leaderboard?period=…', () => {
  test('empty when no XP earned this period', async () => {
    const { env, seedUser } = freshEnv();
    seedUser({ id: 'a', name: 'Alpha', email: 'a@bwr.fr', stats: { reports: 5, pathGrades: 0 } });
    const res = await worker.fetch(r('GET', '/api/leaderboard?period=week'), env);
    assert.deepEqual(await res.json(), []);
  });

  test('creating a report feeds week + month boards', async () => {
    const { env, seedSilver } = freshEnv();
    const { token } = seedSilver('silver-x');
    const create = await worker.fetch(authed('POST', '/api/reports', token, { type: 'other', lat: 49.35, lon: 2.90 }), env);
    assert.equal(create.status, 201);

    for (const period of ['week', 'month']) {
      const res = await worker.fetch(r('GET', `/api/leaderboard?period=${period}`), env);
      const board = await res.json();
      assert.equal(board.length, 1, `${period} board has the reporter`);
      assert.equal(board[0].id, 'silver-x');
      assert.equal(board[0].points, 2);            // one report = 2 pts
      assert.equal(board[0].forestCoverage, null); // coverage is omitted on periodic boards
    }
  });

  test('free-tier users can create a report (reporting is free for all plans)', async () => {
    const { env, seedFree } = freshEnv();
    const { token } = seedFree('free-z');
    const res = await worker.fetch(authed('POST', '/api/reports', token, { type: 'other', lat: 49.35, lon: 2.90 }), env);
    assert.equal(res.status, 201);
  });

  test('xp buckets are keyed by the current week and month', async () => {
    const { env, kv, seedSilver } = freshEnv();
    const { token } = seedSilver('silver-y');
    await worker.fetch(authed('POST', '/api/reports', token, { type: 'other', lat: 49.35, lon: 2.90 }), env);
    assert.ok(kv.store.has(`xp:${isoWeekKey()}:silver-y`));
    assert.ok(kv.store.has(`xp:${monthKey()}:silver-y`));
  });
});
