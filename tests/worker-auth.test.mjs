// Worker auth integration tests — Node 18+ required (Web Crypto, fetch, Request/Response).
//
// KV SCHEMA (granular, post-migration):
//   user:{id}        → JSON user object
//   uemail:{email}   → userId string  (email lookup index)
//   pending:{token}  → JSON pending registration (24h TTL)
//   pemail:{email}   → token string  (pending email index)
//   session:{token}  → JSON { userId, expiresAt }
//
// ISOLATION: In Node v22+, top-level describe() blocks run concurrently. Every test
// creates its own env via freshEnv() so they never share state.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker.js';

// ── Mock KV store ─────────────────────────────────────────────────────────────
// Mirrors the Cloudflare KV API used by worker.js: get / put / delete / list.
// expirationTtl option is accepted but ignored (tests don't need TTL expiry).

function makeMockKV() {
  const store = new Map();
  return {
    store,                                             // direct Map access for seeding
    async get(key)                   { return store.get(key) ?? null; },
    async put(key, value /*, opts*/) { store.set(key, value); },
    async delete(key)                { store.delete(key); },
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

    // Register + verify (no login). Email sending is skipped (no RESEND_API_KEY);
    // we read the pending token directly from the mock KV.
    async registerAndVerify(email = 'test@bwr.fr', password = 'secret123', name = 'Test') {
      await worker.fetch(r('POST', '/api/auth/register', { name, email, password }), env);
      const verifyToken = kv.store.get(`pemail:${email.toLowerCase()}`);
      if (verifyToken) {
        await worker.fetch(r('GET', `/api/auth/verify?token=${verifyToken}`), env);
      }
    },

    // Register + verify + login in one shot; returns the login JSON { token, user }.
    async registerAndLogin(email = 'test@bwr.fr', password = 'secret123', name = 'Test') {
      await worker.fetch(r('POST', '/api/auth/register', { name, email, password }), env);
      const verifyToken = kv.store.get(`pemail:${email.toLowerCase()}`);
      if (verifyToken) {
        await worker.fetch(r('GET', `/api/auth/verify?token=${verifyToken}`), env);
      }
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
    const res = await worker.fetch(r('POST', '/api/auth/register', { email: 'a@b.fr', password: 'abc12345' }), env);
    assert.equal(res.status, 400);
  });

  test('missing email → 400', async () => {
    const { env } = freshEnv();
    const res = await worker.fetch(r('POST', '/api/auth/register', { name: 'X', password: 'abc12345' }), env);
    assert.equal(res.status, 400);
  });

  test('password shorter than 8 chars → 400', async () => {
    const { env } = freshEnv();
    const res = await worker.fetch(r('POST', '/api/auth/register', { name: 'X', email: 'x@y.fr', password: '1234567' }), env);
    assert.equal(res.status, 400);
  });

  test('valid registration → 201', async () => {
    const { env } = freshEnv();
    const res = await worker.fetch(r('POST', '/api/auth/register', { name: 'Alice', email: 'alice@bwr.fr', password: 'hunter2x' }), env);
    assert.equal(res.status, 201);
  });

  test('user stored with free plan, hashVersion 2 and initial stats', async () => {
    // Registration now creates a pending entry; verification promotes it to user:
    const { kv, env, getAllUsers } = freshEnv();
    await worker.fetch(r('POST', '/api/auth/register', { name: 'Bob', email: 'bob@bwr.fr', password: 'password123' }), env);
    const verifyToken = kv.store.get('pemail:bob@bwr.fr');
    await worker.fetch(r('GET', `/api/auth/verify?token=${verifyToken}`), env);
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
    const { kv, env, getAllUsers } = freshEnv();
    await worker.fetch(r('POST', '/api/auth/register', { name: 'Bob', email: 'BOB@BWR.FR', password: 'password123' }), env);
    const verifyToken = kv.store.get('pemail:bob@bwr.fr');
    await worker.fetch(r('GET', `/api/auth/verify?token=${verifyToken}`), env);
    const users = getAllUsers();
    assert.equal(users[0].email, 'bob@bwr.fr');
    // uemail index must also exist under the lowercase key
    assert.ok(kv.store.has('uemail:bob@bwr.fr'), 'uemail index must use lowercase key');
  });

  test('duplicate email → 400', async () => {
    const { env } = freshEnv();
    await worker.fetch(r('POST', '/api/auth/register', { name: 'A', email: 'dup@bwr.fr', password: 'abcdef12' }), env);
    const res = await worker.fetch(r('POST', '/api/auth/register', { name: 'B', email: 'dup@bwr.fr', password: 'abcdef12' }), env);
    assert.equal(res.status, 400);
  });

  test('duplicate email check is case-insensitive', async () => {
    const { env } = freshEnv();
    await worker.fetch(r('POST', '/api/auth/register', { name: 'A', email: 'case@bwr.fr',   password: 'abcdef12' }), env);
    const res = await worker.fetch(r('POST', '/api/auth/register', { name: 'B', email: 'CASE@BWR.FR', password: 'abcdef12' }), env);
    assert.equal(res.status, 400);
  });

  test('registration creates pending entry in KV, not a real user yet', async () => {
    const { env, kv, getAllUsers } = freshEnv();
    await worker.fetch(r('POST', '/api/auth/register', { name: 'P', email: 'pending@bwr.fr', password: 'abcdef12' }), env);
    // No real user yet
    assert.equal(getAllUsers().length, 0, 'user: key must not exist before verification');
    // But pending entries must exist
    const token = kv.store.get('pemail:pending@bwr.fr');
    assert.ok(token, 'pemail: index must be set');
    assert.ok(kv.store.has(`pending:${token}`), 'pending: entry must exist');
  });
});

// ── GET /api/auth/verify ──────────────────────────────────────────────────────

describe('/api/auth/verify', () => {
  test('valid token promotes pending → real user and cleans up KV', async () => {
    const { env, kv, getAllUsers } = freshEnv();
    await worker.fetch(r('POST', '/api/auth/register', { name: 'V', email: 'v@bwr.fr', password: 'abcdef12' }), env);
    const token = kv.store.get('pemail:v@bwr.fr');
    const res = await worker.fetch(r('GET', `/api/auth/verify?token=${token}`), env);
    assert.equal(res.status, 200);
    assert.equal(getAllUsers().length, 1, 'user must exist after verification');
    assert.ok(!kv.store.has(`pending:${token}`), 'pending: entry must be deleted');
    assert.ok(!kv.store.has('pemail:v@bwr.fr'), 'pemail: index must be deleted');
    assert.ok(kv.store.has('uemail:v@bwr.fr'), 'uemail: index must now exist');
  });

  test('invalid/unknown token → 400', async () => {
    const { env } = freshEnv();
    const res = await worker.fetch(r('GET', '/api/auth/verify?token=not-a-real-token'), env);
    assert.equal(res.status, 400);
  });

  test('missing token → 400', async () => {
    const { env } = freshEnv();
    const res = await worker.fetch(r('GET', '/api/auth/verify'), env);
    assert.equal(res.status, 400);
  });

  test('login succeeds after verification', async () => {
    const { env, kv } = freshEnv();
    await worker.fetch(r('POST', '/api/auth/register', { name: 'LV', email: 'lv@bwr.fr', password: 'pass4567' }), env);
    const token = kv.store.get('pemail:lv@bwr.fr');
    await worker.fetch(r('GET', `/api/auth/verify?token=${token}`), env);
    const res = await worker.fetch(r('POST', '/api/auth/login', { email: 'lv@bwr.fr', password: 'pass4567' }), env);
    assert.equal(res.status, 200);
  });
});

// ── POST /api/auth/resend-verification ───────────────────────────────────────

describe('/api/auth/resend-verification', () => {
  test('unknown email returns 200 (no enumeration)', async () => {
    const { env } = freshEnv();
    const res = await worker.fetch(r('POST', '/api/auth/resend-verification', { email: 'ghost@bwr.fr' }), env);
    assert.equal(res.status, 200);
  });

  test('within cooldown → 429', async () => {
    const { env, kv } = freshEnv();
    await worker.fetch(r('POST', '/api/auth/register', { name: 'RS', email: 'rs@bwr.fr', password: 'abcdef12' }), env);
    // resendAfter is 5 min in the future — immediate resend must be throttled
    const res = await worker.fetch(r('POST', '/api/auth/resend-verification', { email: 'rs@bwr.fr' }), env);
    assert.equal(res.status, 429);
  });

  test('after cooldown → 200 and new token replaces old', async () => {
    const { env, kv } = freshEnv();
    await worker.fetch(r('POST', '/api/auth/register', { name: 'RS2', email: 'rs2@bwr.fr', password: 'abcdef12' }), env);
    const oldToken = kv.store.get('pemail:rs2@bwr.fr');
    // Wind back resendAfter so cooldown has passed
    const pendingRaw = kv.store.get(`pending:${oldToken}`);
    const pending = JSON.parse(pendingRaw);
    pending.resendAfter = new Date(Date.now() - 1000).toISOString();
    kv.store.set(`pending:${oldToken}`, JSON.stringify(pending));

    const res = await worker.fetch(r('POST', '/api/auth/resend-verification', { email: 'rs2@bwr.fr' }), env);
    assert.equal(res.status, 200);
    const newToken = kv.store.get('pemail:rs2@bwr.fr');
    assert.notEqual(newToken, oldToken, 'resend must issue a new token');
    assert.ok(!kv.store.has(`pending:${oldToken}`), 'old pending entry must be deleted');
    assert.ok(kv.store.has(`pending:${newToken}`), 'new pending entry must exist');
  });
});

// ── Unverified email login behaviour ─────────────────────────────────────────

describe('login with unverified email', () => {
  test('returns 403 with unverified:true flag', async () => {
    const { env } = freshEnv();
    await worker.fetch(r('POST', '/api/auth/register', { name: 'UV', email: 'uv@bwr.fr', password: 'abc12345' }), env);
    const res = await worker.fetch(r('POST', '/api/auth/login', { email: 'uv@bwr.fr', password: 'abc12345' }), env);
    assert.equal(res.status, 403);
    const data = await res.json();
    assert.equal(data.unverified, true);
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
    const { env, registerAndVerify } = freshEnv();
    await registerAndVerify('c@bwr.fr', 'correct', 'C');
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
    const data = await registerAndLogin('e@bwr.fr', 'pass1234');
    const raw = kv.store.get(`session:${data.token}`);
    assert.ok(raw, 'session entry must exist in KV');
    const session = JSON.parse(raw);
    assert.ok(new Date(session.expiresAt) > new Date(), 'session must not be expired');
  });

  test('10 wrong passwords → 11th attempt returns 429', async () => {
    const { env, registerAndVerify } = freshEnv();
    await registerAndVerify('bf@bwr.fr', 'correct', 'BF');
    // 10 failed attempts
    for (let i = 0; i < 10; i++) {
      await worker.fetch(r('POST', '/api/auth/login', { email: 'bf@bwr.fr', password: 'wrong' }), env);
    }
    const res = await worker.fetch(r('POST', '/api/auth/login', { email: 'bf@bwr.fr', password: 'correct' }), env);
    assert.equal(res.status, 429, '11th attempt (even with correct password) must be locked');
  });

  test('wrong password against unknown email also tracks attempts → 429 after 10', async () => {
    const { env } = freshEnv();
    for (let i = 0; i < 10; i++) {
      await worker.fetch(r('POST', '/api/auth/login', { email: 'ghost@bwr.fr', password: 'x' }), env);
    }
    const res = await worker.fetch(r('POST', '/api/auth/login', { email: 'ghost@bwr.fr', password: 'x' }), env);
    assert.equal(res.status, 429);
  });

  test('successful login clears the attempt counter', async () => {
    const { env, registerAndVerify } = freshEnv();
    await registerAndVerify('rc@bwr.fr', 'correctpass', 'RC');
    // 9 failed attempts (one below lock threshold)
    for (let i = 0; i < 9; i++) {
      await worker.fetch(r('POST', '/api/auth/login', { email: 'rc@bwr.fr', password: 'wrong' }), env);
    }
    // Correct login clears counter
    const ok = await worker.fetch(r('POST', '/api/auth/login', { email: 'rc@bwr.fr', password: 'correctpass' }), env);
    assert.equal(ok.status, 200, 'correct password after 9 failures must succeed');
    // Now a wrong attempt should NOT be locked (counter was reset)
    const after = await worker.fetch(r('POST', '/api/auth/login', { email: 'rc@bwr.fr', password: 'wrong' }), env);
    assert.equal(after.status, 401, 'single wrong attempt after counter reset must be 401, not 429');
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
    const { token } = await registerAndLogin('me@bwr.fr', 'pass1234');
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
    const { token } = await registerAndLogin('logout@bwr.fr', 'pass1234');
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
    const { token } = await registerAndLogin('stats@bwr.fr', 'pass1234');
    await worker.fetch(authed('POST', '/api/auth/stats', token, { routes: 1, km: 5.3 }), env);
    const res = await worker.fetch(authed('POST', '/api/auth/stats', token, { routes: 2, km: 3.1 }), env);
    const { stats } = await res.json();
    assert.equal(stats.routes, 3);
    assert.ok(Math.abs(stats.km - 8.4) < 0.01, `expected ~8.40 km, got ${stats.km}`);
  });

  test('negative values are clamped to 0', async () => {
    const { env, registerAndLogin } = freshEnv();
    const { token } = await registerAndLogin('stats2@bwr.fr', 'pass1234');
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

// ── POST /api/auth/consume-route ─────────────────────────────────────────────

describe('consume-route (weekly quota)', () => {
  test('unauthenticated → 401', async () => {
    const { env } = freshEnv();
    const res = await worker.fetch(r('POST', '/api/auth/consume-route'), env);
    assert.equal(res.status, 401);
  });

  test('free user first route → ok, used=1, limit=3', async () => {
    const { env, registerAndLogin } = freshEnv();
    const { token } = await registerAndLogin();
    const res  = await worker.fetch(authed('POST', '/api/auth/consume-route', token), env);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok,    true);
    assert.equal(data.used,  1);
    assert.equal(data.limit, 3);
  });

  test('free user three consecutive calls → all ok', async () => {
    const { env, registerAndLogin } = freshEnv();
    const { token } = await registerAndLogin();
    for (let i = 1; i <= 3; i++) {
      const res = await worker.fetch(authed('POST', '/api/auth/consume-route', token), env);
      assert.equal(res.status, 200);
      assert.equal((await res.json()).used, i);
    }
  });

  test('free user fourth call → 429 with ok=false', async () => {
    const { env, registerAndLogin } = freshEnv();
    const { token } = await registerAndLogin();
    for (let i = 0; i < 3; i++) {
      await worker.fetch(authed('POST', '/api/auth/consume-route', token), env);
    }
    const res  = await worker.fetch(authed('POST', '/api/auth/consume-route', token), env);
    assert.equal(res.status, 429);
    const data = await res.json();
    assert.equal(data.ok,    false);
    assert.equal(data.used,  3);
    assert.equal(data.limit, 3);
  });

  test('silver user → always ok regardless of count (unlimited)', async () => {
    const { env, seedUser, seedSession } = freshEnv();
    seedUser({ id: 'sv1', name: 'Silver', email: 'sv@bwr.fr', role: 'free', plan: 'silver', passwordHash: 'x', salt: 'y', hashVersion: 2 });
    seedSession('sv-tok', 'sv1', new Date(Date.now() + 86400000).toISOString());
    for (let i = 0; i < 10; i++) {
      const res = await worker.fetch(authed('POST', '/api/auth/consume-route', 'sv-tok'), env);
      assert.equal(res.status, 200);
    }
  });

  test('gold user → always ok (unlimited)', async () => {
    const { env, seedUser, seedSession } = freshEnv();
    seedUser({ id: 'gd1', name: 'Gold', email: 'gd@bwr.fr', role: 'free', plan: 'gold', passwordHash: 'x', salt: 'y', hashVersion: 2 });
    seedSession('gd-tok', 'gd1', new Date(Date.now() + 86400000).toISOString());
    const res = await worker.fetch(authed('POST', '/api/auth/consume-route', 'gd-tok'), env);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).unlimited, true);
  });

  test('quota counter persists in KV, not just in-memory', async () => {
    const { env, registerAndLogin, getAllUsers } = freshEnv();
    const { token } = await registerAndLogin('persist@bwr.fr', 'pass1234');
    await worker.fetch(authed('POST', '/api/auth/consume-route', token), env);
    await worker.fetch(authed('POST', '/api/auth/consume-route', token), env);
    const [user] = getAllUsers();
    assert.equal(user.stats.weeklyRoutes, 2, 'count must be persisted in KV user object');
  });

  test('weekly counter resets when weekStart changes', async () => {
    const { env, kv, registerAndLogin, getAllUsers } = freshEnv();
    const { token } = await registerAndLogin('reset@bwr.fr', 'pass1234');
    for (let i = 0; i < 3; i++) await worker.fetch(authed('POST', '/api/auth/consume-route', token), env);
    // Backdate weekStart to simulate a new week
    const [user] = getAllUsers();
    kv.store.set(`user:${user.id}`, JSON.stringify({
      ...user,
      stats: { ...user.stats, weekStart: '2000-01-03' },
    }));
    const res = await worker.fetch(authed('POST', '/api/auth/consume-route', token), env);
    assert.equal(res.status, 200, 'should succeed after week resets');
    assert.equal((await res.json()).used, 1);
  });
});

// ── POST /api/auth/wheel-prize ────────────────────────────────────────────────

describe('wheel prize', () => {
  test('free user is rejected → 403', async () => {
    const { env, registerAndLogin } = freshEnv();
    const { token } = await registerAndLogin('wheel@bwr.fr', 'pass1234');
    const res = await worker.fetch(authed('POST', '/api/auth/wheel-prize', token, { prizeType: 'badge', plan: null, days: 0 }), env);
    assert.equal(res.status, 403);
  });

  test('silver user wins a gold upgrade → 200', async () => {
    const { env, kv, registerAndLogin } = freshEnv();
    const { token, user } = await registerAndLogin('wsilver@bwr.fr', 'pass1234');
    // Elevate to silver
    const stored = JSON.parse(kv.store.get(`user:${user.id}`));
    kv.store.set(`user:${user.id}`, JSON.stringify({ ...stored, plan: 'silver' }));

    const res = await worker.fetch(authed('POST', '/api/auth/wheel-prize', token, { prizeType: 'plan', plan: 'gold', days: 7 }), env);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.plan, 'gold');
    assert.ok(data.expiresAt, 'expiresAt must be set');
  });

  test('silver user cannot claim same-tier prize → 400', async () => {
    const { env, kv, registerAndLogin } = freshEnv();
    const { token, user } = await registerAndLogin('wsilver2@bwr.fr', 'pass1234');
    const stored = JSON.parse(kv.store.get(`user:${user.id}`));
    kv.store.set(`user:${user.id}`, JSON.stringify({ ...stored, plan: 'silver' }));

    const res = await worker.fetch(authed('POST', '/api/auth/wheel-prize', token, { prizeType: 'plan', plan: 'silver', days: 7 }), env);
    assert.equal(res.status, 400);
  });

  test('30-day cooldown blocks a second prize claim → 429', async () => {
    const { env, kv, registerAndLogin } = freshEnv();
    const { token, user } = await registerAndLogin('wcool@bwr.fr', 'pass1234');
    // Elevate to silver
    const stored = JSON.parse(kv.store.get(`user:${user.id}`));
    kv.store.set(`user:${user.id}`, JSON.stringify({ ...stored, plan: 'silver' }));

    // First claim succeeds (silver → gold)
    await worker.fetch(authed('POST', '/api/auth/wheel-prize', token, { prizeType: 'plan', plan: 'gold', days: 7 }), env);

    // Reset plan back to silver but keep lastWheelPrizeClaim → cooldown still active
    const afterClaim = JSON.parse(kv.store.get(`user:${user.id}`));
    kv.store.set(`user:${user.id}`, JSON.stringify({
      ...afterClaim,
      plan: 'silver', planBase: null, planExpiresAt: null,
    }));

    const res = await worker.fetch(authed('POST', '/api/auth/wheel-prize', token, { prizeType: 'plan', plan: 'gold', days: 7 }), env);
    assert.equal(res.status, 429);
  });
});
