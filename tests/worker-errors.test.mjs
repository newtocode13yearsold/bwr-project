// Client-side error-monitoring handler integration tests.
// Covers: public ingest, signature grouping + occurrence count, bot/empty drop,
// throttled ntfy alerting, and the admin-only list / delete / clear endpoints.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker.js';

// The handler fires a best-effort ntfy.sh push via global fetch. Stub it so the
// suite stays offline/deterministic and we can assert when an alert was sent.
const CHROME_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/120 Mobile Safari/604.1';
let ntfyCalls = [];
let emailCalls = [];
const realFetch = globalThis.fetch;
beforeEach(() => {
  ntfyCalls = [];
  emailCalls = [];
  globalThis.fetch = async (url, opts) => {
    if (typeof url === 'string' && url.includes('ntfy.sh')) {
      ntfyCalls.push({ url, opts });
      return new Response('ok', { status: 200 });
    }
    if (typeof url === 'string' && url.includes('api.resend.com')) {
      emailCalls.push({ url, body: opts && opts.body ? JSON.parse(opts.body) : null });
      return new Response(JSON.stringify({ id: 'email_1' }), { status: 200 });
    }
    return new Response('{}', { status: 200 });
  };
});
afterEach(() => { globalThis.fetch = realFetch; });

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

function seedUser(kv, { id, role = 'user', token }) {
  kv.store.set(`user:${id}`, JSON.stringify({ id, name: id, email: `${id}@bwr.fr`, role, plan: 'free' }));
  kv.store.set(`session:${token}`, JSON.stringify({ userId: id, expiresAt: new Date(Date.now() + 86400000).toISOString() }));
}

function freshEnv() {
  const kv = makeMockKV();
  const env = { BWR_KV: kv };
  seedUser(kv, { id: 'user1', token: 'tok-user' });
  seedUser(kv, { id: 'admin1', role: 'admin', token: 'tok-admin' });
  return { kv, env };
}

const errKeys = kv => [...kv.store.keys()].filter(k => k.startsWith('errlog:'));

// A client error beacon. Sends a real UA (a missing UA is treated as a bot).
function postError(body, ua = CHROME_UA) {
  return new Request('https://bwr.test/api/track/error', {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain', 'User-Agent': ua },
    body: JSON.stringify(body),
  });
}
const authed = (method, path, token) => new Request(`https://bwr.test${path}`, {
  method, headers: { Authorization: `Bearer ${token}` },
});

const sampleError = {
  kind: 'error', message: 'TypeError: x is undefined',
  stack: 'TypeError: x is undefined\n    at f (js/map.js:42:10)',
  source: 'https://bwrmaps.com/js/map.js', line: 42, col: 10, page: '/map.html',
};

describe('POST /api/track/error (public ingest)', () => {
  test('stores an error and returns ok without auth', async () => {
    const { env, kv } = freshEnv();
    const res = await worker.fetch(postError(sampleError), env);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
    assert.equal(errKeys(kv).length, 1);
    const rec = JSON.parse(kv.store.get(errKeys(kv)[0]));
    assert.equal(rec.message, 'TypeError: x is undefined');
    assert.equal(rec.count, 1);
    assert.equal(rec.page, '/map.html');
  });

  test('identical errors are grouped and counted, not duplicated', async () => {
    const { env, kv } = freshEnv();
    await worker.fetch(postError(sampleError), env);
    await worker.fetch(postError(sampleError), env);
    await worker.fetch(postError(sampleError), env);
    const keys = errKeys(kv);
    assert.equal(keys.length, 1, 'same signature must collapse to one record');
    assert.equal(JSON.parse(kv.store.get(keys[0])).count, 3);
  });

  test('different messages get separate records', async () => {
    const { env, kv } = freshEnv();
    await worker.fetch(postError(sampleError), env);
    await worker.fetch(postError({ ...sampleError, message: 'ReferenceError: y' }), env);
    assert.equal(errKeys(kv).length, 2);
  });

  test('bot User-Agent is dropped (no record)', async () => {
    const { env, kv } = freshEnv();
    const res = await worker.fetch(postError(sampleError, 'python-requests/2.31'), env);
    assert.equal(res.status, 200);
    assert.equal(errKeys(kv).length, 0);
  });

  test('missing User-Agent is treated as a bot and dropped', async () => {
    const { env, kv } = freshEnv();
    // Build a request with no UA header at all.
    const req = new Request('https://bwr.test/api/track/error', {
      method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify(sampleError),
    });
    await worker.fetch(req, env);
    assert.equal(errKeys(kv).length, 0);
  });

  test('empty message is ignored', async () => {
    const { env, kv } = freshEnv();
    await worker.fetch(postError({ ...sampleError, message: '' }), env);
    assert.equal(errKeys(kv).length, 0);
  });

  test('unhandledrejection kind is preserved', async () => {
    const { env, kv } = freshEnv();
    await worker.fetch(postError({ kind: 'unhandledrejection', message: 'Promise blew up', page: '/routes.html' }), env);
    const rec = JSON.parse(kv.store.get(errKeys(kv)[0]));
    assert.equal(rec.kind, 'unhandledrejection');
  });

  test('oversized message is truncated', async () => {
    const { env, kv } = freshEnv();
    await worker.fetch(postError({ ...sampleError, message: 'E'.repeat(2000) }), env);
    const rec = JSON.parse(kv.store.get(errKeys(kv)[0]));
    assert.ok(rec.message.length <= 500);
  });
});

describe('ntfy alerting is throttled', () => {
  test('first occurrence alerts; an immediate repeat does not (cooldown)', async () => {
    const { env } = freshEnv();
    await worker.fetch(postError(sampleError), env);
    await worker.fetch(postError(sampleError), env);
    // Give the detached waitUntil alert a tick to run.
    await new Promise(r => setTimeout(r, 10));
    assert.equal(ntfyCalls.length, 1, 'only the first sighting of a signature should push');
    assert.match(ntfyCalls[0].opts.body, /TypeError: x is undefined/);
  });
});

describe('email alerting (Resend)', () => {
  test('a new error emails the admin when Resend + ADMIN_EMAIL are configured', async () => {
    const { env } = freshEnv();
    env.RESEND_API_KEY = 're_test';
    env.ADMIN_EMAIL = 'admin@bwr.fr';
    await worker.fetch(postError(sampleError), env);
    await new Promise(r => setTimeout(r, 10));
    assert.equal(emailCalls.length, 1);
    assert.equal(emailCalls[0].body.to, 'admin@bwr.fr');
    assert.match(emailCalls[0].body.subject, /Erreur JS/);
    assert.match(emailCalls[0].body.html, /TypeError: x is undefined/);
  });

  test('no email when ADMIN_EMAIL is unset', async () => {
    const { env } = freshEnv();
    env.RESEND_API_KEY = 're_test'; // key present but no recipient
    await worker.fetch(postError(sampleError), env);
    await new Promise(r => setTimeout(r, 10));
    assert.equal(emailCalls.length, 0);
  });
});

describe('GET /api/errors/count (admin only)', () => {
  test('non-admin is refused', async () => {
    const { env } = freshEnv();
    const res = await worker.fetch(authed('GET', '/api/errors/count', 'tok-user'), env);
    assert.equal(res.status, 403);
  });

  test('admin gets the distinct unresolved count', async () => {
    const { env } = freshEnv();
    await worker.fetch(postError(sampleError), env);
    await worker.fetch(postError(sampleError), env); // same signature → still 1 distinct
    await worker.fetch(postError({ ...sampleError, message: 'Other' }), env);
    const res = await worker.fetch(authed('GET', '/api/errors/count', 'tok-admin'), env);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { count: 2 });
  });
});

describe('GET /api/errors (admin only)', () => {
  test('anonymous is refused', async () => {
    const { env } = freshEnv();
    const res = await worker.fetch(new Request('https://bwr.test/api/errors'), env);
    assert.equal(res.status, 403);
  });

  test('non-admin is refused', async () => {
    const { env } = freshEnv();
    const res = await worker.fetch(authed('GET', '/api/errors', 'tok-user'), env);
    assert.equal(res.status, 403);
  });

  test('admin gets the list with distinct + total counts, newest first', async () => {
    const { env } = freshEnv();
    await worker.fetch(postError(sampleError), env);
    await worker.fetch(postError(sampleError), env);
    await worker.fetch(postError({ ...sampleError, message: 'ReferenceError: y', page: '/routes.html' }), env);
    const res = await worker.fetch(authed('GET', '/api/errors', 'tok-admin'), env);
    assert.equal(res.status, 200);
    const d = await res.json();
    assert.equal(d.distinct, 2);
    assert.equal(d.total, 3);
    assert.equal(d.errors.length, 2);
    // Sorted by lastSeen desc — the ReferenceError was reported last.
    assert.equal(d.errors[0].message, 'ReferenceError: y');
  });
});

describe('DELETE /api/errors', () => {
  test('admin deletes one error by signature', async () => {
    const { env, kv } = freshEnv();
    await worker.fetch(postError(sampleError), env);
    const sig = JSON.parse(kv.store.get(errKeys(kv)[0])).sig;
    const res = await worker.fetch(authed('DELETE', `/api/errors/${sig}`, 'tok-admin'), env);
    assert.equal(res.status, 200);
    assert.equal(errKeys(kv).length, 0);
  });

  test('non-admin cannot delete', async () => {
    const { env, kv } = freshEnv();
    await worker.fetch(postError(sampleError), env);
    const sig = JSON.parse(kv.store.get(errKeys(kv)[0])).sig;
    const res = await worker.fetch(authed('DELETE', `/api/errors/${sig}`, 'tok-user'), env);
    assert.equal(res.status, 403);
    assert.equal(errKeys(kv).length, 1);
  });

  test('admin clears all errors', async () => {
    const { env, kv } = freshEnv();
    await worker.fetch(postError(sampleError), env);
    await worker.fetch(postError({ ...sampleError, message: 'Another' }), env);
    const res = await worker.fetch(authed('DELETE', '/api/errors', 'tok-admin'), env);
    assert.equal(res.status, 200);
    const d = await res.json();
    assert.equal(d.cleared, 2);
    assert.equal(errKeys(kv).length, 0);
  });
});
