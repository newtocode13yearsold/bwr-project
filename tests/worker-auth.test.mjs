// Worker auth integration tests — Node 18+ required (Web Crypto, fetch, Request/Response).
//
// KV SCHEMA (granular, post-migration):
//   user:{id}        → JSON user object
//   uemail:{email}   → userId string  (email lookup index)
//   session:{token}  → JSON { userId, expiresAt }
//
// ISOLATION: In Node v22+, top-level describe() blocks run concurrently. Every test
// creates its own env via freshEnv() so they never share state.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker.js';

// ── Mock KV store ─────────────────────────────────────────────────────────────
// Mirrors the Cloudflare KV API used by worker.js: get / put / delete / list.

function makeMockKV() {
  const store = new Map();
  return {
    store,                                             // direct Map access for seeding
    async get(key)        { return store.get(key) ?? null; },
    async put(key, value) { store.set(key, value); },
    async delete(key)     { store.delete(key); },
    async list({ prefix = '', limit = 1000 } = {}) {
      const keys = [];
      for (const k of store.keys()) {
        if (k.startsWith(prefix)) keys.push({ name: k });
      }
      const page = keys.slice(0, limit);
      return { keys: page, list_complete: page.length === keys.length };
    },
  };
}

// ── Per-test isolation factory ────────────────────────────────────────────────

function freshEnv() {
  const kv  = makeMockKV();
  const env = { BWR_KV: kv };

  return {
    kv,
    env,

    // Seed a user using the granular schema the worker expects.
    seedUser(user) {
      kv.store.set(`user:${user.id}`,            JSON.stringify(user));
      kv.store.set(`uemail:${user.email.toLowerCase()}`, user.id);
    },

    // Seed a session directly (bypasses login).
    seedSession(token, userId, expiresAt) {
      kv.store.set(`session:${token}`, JSON.stringify({ userId, expiresAt }));
    },

    // Read the stored user object back by id.
    getStoredUser(id) {
      const raw = kv.store.get(`user:${id}`);
      return raw ? JSON.parse(raw) : null;
    },

    // All users stored in the KV (by iterating user: keys).
    getAllUsers() {
      const users = [];
      for (const [k, v] of kv.store.entries()) {
        if (k.startsWith('user:')) users.push(JSON.parse(v));
      }
      return users;
    },

    // Register + login in one shot; returns the login JSON { token, user }.
    async registerAndLogin(email = 'test@bwr.fr', password = 'secret123', name = 'Test') {
      await worker.fetch(r('POST', '/api/auth/register', { name, email, password }), env);
      const res = await worker.fetch(r('POST', '/api/auth/login', { email, password }), env);
      return res.json();
    },
  };
}

// ── Request helpers ───────────────────────────────────────────────────────────

const r = (method, path, body, extraHeaders = {}) => new Request(
  `https://bwr.test${path}`,
  {
    method,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
    ...(body != null ? { body: JSON.stringify(body) } : {}),
  }
);

const authed = (method, path, token, body) =>
  r(method, path, body, { Authorization: `Bearer ${token}` });

// Legacy SHA-256 hash — mirrors hashPasswordLegacy() in worker.js.
async function legacyHash(password, salt) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(password + salt));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// ── POST /api/auth/register ───────────────────────────────────────────────────

describe('register', () => {
  test('missing name → 400', async () => {
    const { env } = freshEnv();
    const res = await worker.fetch(r('POST', '/api/auth/register', { email: 'a@b.fr', password: 'abc123' }), env);
    assert.equal(res.status, 400);
  });

  test('missing email → 400', async () => {
    const { env } = freshEnv();
    const res = await worker.fetch(r('POST', '/api/auth/register', { name: 'X', password: 'abc123' }), env);
    assert.equal(res.status, 400);
  });

  test('password shorter than 6 chars → 400', async () => {
    const { env } = freshEnv();
    const res = await worker.fetch(r('POST', '/api/auth/register', { name: 'X', email: 'x@y.fr', password: '12345' }), env);
    assert.equal(res.status, 400);
  });

  test('valid registration → 201', async () => {
    const { env } = freshEnv();
    const res = await worker.fetch(r('POST', '/api/auth/register', { name: 'Alice', email: 'alice@bwr.fr', password: 'hunter2' }), env);
    assert.equal(res.status, 201);
  });

  test('user stored with free plan, hashVersion 2 and initial stats', async () => {
    const { env, getAllUsers } = freshEnv();
    await worker.fetch(r('POST', '/api/auth/register', { name: 'Bob', email: 'bob@bwr.fr', password: 'password123' }), env);
    const users = getAllUsers();
    assert.equal(users.length, 1);
    const u = users[0];
    assert.equal(u.plan,        'free');
    assert.equal(u.role,        'free');
    assert.equal(u.hashVersion, 2);
    assert.ok(u.salt,          'salt must be set');
    assert.ok(u.passwordHash,  'passwordHash must be set');
    assert.deepEqual(u.stats,  { routes: 0, km: 0 });
  });

  test('email is stored lowercase in both user: and uemail: keys', async () => {
    const { env, kv, getAllUsers } = freshEnv();
    await worker.fetch(r('POST', '/api/auth/register', { name: 'Bob', email: 'BOB@BWR.FR', password: 'password123' }), env);
    const users = getAllUsers();
    assert.equal(users[0].email, 'bob@bwr.fr');
    // uemail index must also exist under the lowercase key
    assert.ok(kv.store.has('uemail:bob@bwr.fr'), 'uemail index must use lowercase key');
  });

  test('duplicate email → 400', async () => {
    const { env } = freshEnv();
    await worker.fetch(r('POST', '/api/auth/register', { name: 'A', email: 'dup@bwr.fr', password: 'abcdef' }), env);
    const res = await worker.fetch(r('POST', '/api/auth/register', { name: 'B', email: 'dup@bwr.fr', password: 'abcdef' }), env);
    assert.equal(res.status, 400);
  });

  test('duplicate email check is case-insensitive', async () => {
    const { env } = freshEnv();
    await worker.fetch(r('POST', '/api/auth/register', { name: 'A', email: 'case@bwr.fr',   password: 'abcdef' }), env);
    const res = await worker.fetch(r('POST', '/api/auth/register', { name: 'B', email: 'CASE@BWR.FR', password: 'abcdef' }), env);
    assert.equal(res.status, 400);
  });
});

// ── POST /api/auth/login ──────────────────────────────────────────────────────

describe('login', () => {
  test('missing credentials → 400', async () => {
    const { env } = freshEnv();
    const res = await worker.fetch(r('POST', '/api/auth/login', {}), env);
    assert.equal(res.status, 400);
  });

  test('unknown email → 401', async () => {
    const { env } = freshEnv();
    const res = await worker.fetch(r('POST', '/api/auth/login', { email: 'nobody@bwr.fr', password: 'abc' }), env);
    assert.equal(res.status, 401);
  });

  test('wrong password → 401', async () => {
    const { env } = freshEnv();
    await worker.fetch(r('POST', '/api/auth/register', { name: 'C', email: 'c@bwr.fr', password: 'correct' }), env);
    const res = await worker.fetch(r('POST', '/api/auth/login', { email: 'c@bwr.fr', password: 'wrong' }), env);
    assert.equal(res.status, 401);
  });

  test('correct PBKDF2 password → 200 with token and user', async () => {
    const { registerAndLogin } = freshEnv();
    const data = await registerAndLogin('d@bwr.fr', 'mypassword');
    assert.ok(data.token,       'token must be present');
    assert.ok(data.user,        'user must be present');
    assert.equal(data.user.email, 'd@bwr.fr');
    assert.equal(data.user.plan,  'free');
  });

  test('successful login creates a session in KV', async () => {
    const { kv, registerAndLogin } = freshEnv();
    const data = await registerAndLogin('e@bwr.fr', 'pass123');
    const raw = kv.store.get(`session:${data.token}`);
    assert.ok(raw, 'session entry must exist in KV');
    const session = JSON.parse(raw);
    assert.ok(new Date(session.expiresAt) > new Date(), 'session must not be expired');
  });

  test('legacy SHA-256 account is accepted and migrated to PBKDF2 on login', async () => {
    const { env, kv, getStoredUser } = freshEnv();
    const salt = 'legacy-salt-uuid';
    const hash = await legacyHash('legacypass', salt);
    const userId = 'user-legacy-1';

    // Seed using the granular schema
    kv.store.set(`user:${userId}`, JSON.stringify({
      id: userId, name: 'Legacy', email: 'legacy@bwr.fr',
      passwordHash: hash, salt, hashVersion: 1,
      role: 'free', plan: 'free',
    }));
    kv.store.set('uemail:legacy@bwr.fr', userId);

    const res = await worker.fetch(r('POST', '/api/auth/login', { email: 'legacy@bwr.fr', password: 'legacypass' }), env);
    assert.equal(res.status, 200, 'legacy login should succeed');

    const migrated = getStoredUser(userId);
    assert.equal(migrated.hashVersion, 2,    'user must be upgraded to PBKDF2');
    assert.notEqual(migrated.salt, salt,     'salt must be rotated after migration');
  });
});

// ── GET /api/auth/me ──────────────────────────────────────────────────────────

describe('/api/auth/me', () => {
  test('no token → 401', async () => {
    const { env } = freshEnv();
    const res = await worker.fetch(r('GET', '/api/auth/me'), env);
    assert.equal(res.status, 401);
  });

  test('invalid/unknown token → 401', async () => {
    const { env } = freshEnv();
    const res = await worker.fetch(authed('GET', '/api/auth/me', 'bad-token'), env);
    assert.equal(res.status, 401);
  });

  test('expired session → 401 and session key deleted from KV', async () => {
    const { env, kv, seedUser, seedSession } = freshEnv();
    const user = { id: 'u1', name: 'X', email: 'x@bwr.fr', role: 'free', plan: 'free', passwordHash: 'x', salt: 'y', hashVersion: 2 };
    seedUser(user);
    seedSession('expired-tok', 'u1', new Date(Date.now() - 1000).toISOString());

    const res = await worker.fetch(authed('GET', '/api/auth/me', 'expired-tok'), env);
    assert.equal(res.status, 401);
    assert.ok(!kv.store.has('session:expired-tok'), 'expired session must be cleaned up');
  });

  test('valid session returns 200 with user data', async () => {
    const { env, registerAndLogin } = freshEnv();
    const { token } = await registerAndLogin('me@bwr.fr', 'pass123');
    const res = await worker.fetch(authed('GET', '/api/auth/me', token), env);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.email, 'me@bwr.fr');
    assert.equal(data.plan,  'free');
  });

  test('admin is auto-upgraded to gold plan', async () => {
    const { env, seedUser, seedSession } = freshEnv();
    const admin = { id: 'adm-1', name: 'Admin', email: 'admin@bwr.fr', role: 'admin', plan: 'free', passwordHash: 'x', salt: 'y', hashVersion: 2 };
    seedUser(admin);
    seedSession('admin-tok', 'adm-1', new Date(Date.now() + 86400000).toISOString());

    const res  = await worker.fetch(authed('GET', '/api/auth/me', 'admin-tok'), env);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.plan, 'gold', 'admin must always see gold plan');
  });

  test('expired planExpiresAt reverts plan to planBase', async () => {
    const { env, seedUser, seedSession } = freshEnv();
    seedUser({
      id: 'u2', name: 'Bob', email: 'bob@bwr.fr', role: 'free',
      plan: 'silver', planBase: 'free',
      planExpiresAt: new Date(Date.now() - 1000).toISOString(),
      passwordHash: 'x', salt: 'y', hashVersion: 2,
    });
    seedSession('tok-u2', 'u2', new Date(Date.now() + 86400000).toISOString());

    const res  = await worker.fetch(authed('GET', '/api/auth/me', 'tok-u2'), env);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.plan,          'free', 'plan must revert to planBase');
    assert.equal(data.planExpiresAt, null);
  });

  test('non-expired plan upgrade is preserved', async () => {
    const { env, seedUser, seedSession } = freshEnv();
    seedUser({
      id: 'u3', name: 'Carol', email: 'carol@bwr.fr', role: 'free',
      plan: 'silver', planBase: 'free',
      planExpiresAt: new Date(Date.now() + 86400000).toISOString(),
      passwordHash: 'x', salt: 'y', hashVersion: 2,
    });
    seedSession('tok-u3', 'u3', new Date(Date.now() + 86400000).toISOString());

    const res  = await worker.fetch(authed('GET', '/api/auth/me', 'tok-u3'), env);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).plan, 'silver', 'non-expired upgrade must not be reverted');
  });
});

// ── PUT /api/auth/plan/:userId ────────────────────────────────────────────────

describe('plan change (admin only)', () => {
  function setupAdminAndUser({ seedUser, seedSession }) {
    seedUser({ id: 'adm', name: 'Admin', email: 'adm@bwr.fr', role: 'admin', plan: 'gold',  passwordHash: 'x', salt: 'y', hashVersion: 2 });
    seedUser({ id: 'usr', name: 'User',  email: 'usr@bwr.fr', role: 'free',  plan: 'free',  passwordHash: 'x', salt: 'y', hashVersion: 2 });
    seedSession('admin-tok', 'adm', new Date(Date.now() + 86400000).toISOString());
  }

  test('non-admin token → 403', async () => {
    const ctx = freshEnv();
    ctx.seedUser({ id: 'plain', name: 'X', email: 'x@bwr.fr', role: 'free', plan: 'free', passwordHash: 'x', salt: 'y', hashVersion: 2 });
    ctx.seedSession('plain-tok', 'plain', new Date(Date.now() + 86400000).toISOString());
    const res = await worker.fetch(authed('PUT', '/api/auth/plan/plain', 'plain-tok', { plan: 'silver' }), ctx.env);
    assert.equal(res.status, 403);
  });

  test('invalid plan value → 400', async () => {
    const ctx = freshEnv();
    setupAdminAndUser(ctx);
    const res = await worker.fetch(authed('PUT', '/api/auth/plan/usr', 'admin-tok', { plan: 'platinum' }), ctx.env);
    assert.equal(res.status, 400);
  });

  test('unknown userId → 404', async () => {
    const ctx = freshEnv();
    setupAdminAndUser(ctx);
    const res = await worker.fetch(authed('PUT', '/api/auth/plan/nobody', 'admin-tok', { plan: 'silver' }), ctx.env);
    assert.equal(res.status, 404);
  });

  test('valid admin plan change → 200 and KV updated', async () => {
    const ctx = freshEnv();
    setupAdminAndUser(ctx);
    const res = await worker.fetch(authed('PUT', '/api/auth/plan/usr', 'admin-tok', { plan: 'silver' }), ctx.env);
    assert.equal(res.status, 200);
    assert.equal(ctx.getStoredUser('usr').plan, 'silver');
  });
});

// ── POST /api/auth/logout ─────────────────────────────────────────────────────

describe('logout', () => {
  test('logout deletes the session from KV', async () => {
    const { env, kv, registerAndLogin } = freshEnv();
    const { token } = await registerAndLogin('logout@bwr.fr', 'pass123');
    assert.ok(kv.store.has(`session:${token}`), 'session must exist before logout');
    await worker.fetch(authed('POST', '/api/auth/logout', token), env);
    assert.ok(!kv.store.has(`session:${token}`), 'session must be gone after logout');
  });

  test('logout without any token still returns 200', async () => {
    const { env } = freshEnv();
    const res = await worker.fetch(r('POST', '/api/auth/logout'), env);
    assert.equal(res.status, 200);
  });
});

// ── POST /api/auth/stats ──────────────────────────────────────────────────────

describe('stats endpoint', () => {
  test('increments routes and km correctly across two calls', async () => {
    const { env, registerAndLogin } = freshEnv();
    const { token } = await registerAndLogin('stats@bwr.fr', 'pass123');
    await worker.fetch(authed('POST', '/api/auth/stats', token, { routes: 1, km: 5.3 }), env);
    const res = await worker.fetch(authed('POST', '/api/auth/stats', token, { routes: 2, km: 3.1 }), env);
    const { stats } = await res.json();
    assert.equal(stats.routes, 3);
    assert.ok(Math.abs(stats.km - 8.4) < 0.01, `expected ~8.40 km, got ${stats.km}`);
  });

  test('negative values are clamped to 0', async () => {
    const { env, registerAndLogin } = freshEnv();
    const { token } = await registerAndLogin('stats2@bwr.fr', 'pass123');
    const res = await worker.fetch(authed('POST', '/api/auth/stats', token, { routes: -5, km: -10 }), env);
    const { stats } = await res.json();
    assert.equal(stats.routes, 0, 'negative routes must be clamped to 0');
    assert.equal(stats.km,     0, 'negative km must be clamped to 0');
  });

  test('unauthenticated stats request → 401', async () => {
    const { env } = freshEnv();
    const res = await worker.fetch(r('POST', '/api/auth/stats', { routes: 1, km: 1 }), env);
    assert.equal(res.status, 401);
  });
});

// ── POST /api/auth/wheel-prize ────────────────────────────────────────────────

describe('wheel prize', () => {
  test('non-plan prize type returns 200 immediately', async () => {
    const { env, registerAndLogin } = freshEnv();
    const { token } = await registerAndLogin('wheel@bwr.fr', 'pass123');
    const res = await worker.fetch(authed('POST', '/api/auth/wheel-prize', token, { prizeType: 'badge', plan: null, days: 0 }), env);
    assert.equal(res.status, 200);
  });

  test('free user can win a silver upgrade', async () => {
    const { env, registerAndLogin } = freshEnv();
    const { token } = await registerAndLogin('wfree@bwr.fr', 'pass123');
    const res = await worker.fetch(authed('POST', '/api/auth/wheel-prize', token, { prizeType: 'plan', plan: 'silver', days: 7 }), env);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.plan, 'silver');
    assert.ok(data.expiresAt, 'expiresAt must be set');
  });

  test('free user cannot jump directly to gold → 400', async () => {
    const { env, registerAndLogin } = freshEnv();
    const { token } = await registerAndLogin('wfree2@bwr.fr', 'pass123');
    const res = await worker.fetch(authed('POST', '/api/auth/wheel-prize', token, { prizeType: 'plan', plan: 'gold', days: 7 }), env);
    assert.equal(res.status, 400);
  });

  test('30-day cooldown blocks a second prize claim → 429', async () => {
    const { env, kv, registerAndLogin } = freshEnv();
    const { token, user } = await registerAndLogin('wcool@bwr.fr', 'pass123');

    // First claim succeeds
    await worker.fetch(authed('POST', '/api/auth/wheel-prize', token, { prizeType: 'plan', plan: 'silver', days: 7 }), env);

    // Manually reset plan back to free but keep lastWheelPrizeClaim
    const stored = JSON.parse(kv.store.get(`user:${user.id}`));
    kv.store.set(`user:${user.id}`, JSON.stringify({
      ...stored,
      plan: 'free', planBase: null, planExpiresAt: null,
      // lastWheelPrizeClaim stays as-is → cooldown still active
    }));

    const res = await worker.fetch(authed('POST', '/api/auth/wheel-prize', token, { prizeType: 'plan', plan: 'silver', days: 7 }), env);
    assert.equal(res.status, 429);
  });
});
