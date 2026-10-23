// Bank-transfer payment tests (worker/handlers/payments.js).
// Covers: auth guard, 503 when no IBAN configured, request creation with a
// unique reference, one-open-request reuse (+ period switch), admin-only list,
// "Payé" activating Pro for the paid period + inbox message, stacking on an
// active Pro period, cancel, and no double payment.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker.js';

// Never let the ntfy alert hit the real network from a test run.
globalThis.fetch = async () => new Response('ok');

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

function seedUser(kv, { id, plan = 'free', role = 'user', token, extra = {} }) {
  const user = { id, name: id, email: `${id}@bwr.fr`, role, plan, stats: {}, ...extra };
  kv.store.set(`user:${id}`, JSON.stringify(user));
  kv.store.set(`session:${token}`, JSON.stringify({ userId: id, expiresAt: new Date(Date.now() + 86400000).toISOString() }));
}

const r = (method, path, body, headers = {}) => new Request(
  `https://bwr.test${path}`,
  { method, headers: { 'Content-Type': 'application/json', ...headers }, ...(body != null ? { body: JSON.stringify(body) } : {}) }
);
const authed = (method, path, token, body) => r(method, path, body, { Authorization: `Bearer ${token}` });
const readUser = (kv, id) => JSON.parse(kv.store.get(`user:${id}`));
const DAY = 86400000;

function setup() {
  const kv = makeMockKV();
  const env = { BWR_KV: kv, BANK_IBAN: 'FR76 1234 5678 9012 3456 7890 123', BANK_BIC: 'TESTFRPP', BANK_HOLDER: 'Test EI' };
  seedUser(kv, { id: 'u1', token: 't1' });
  seedUser(kv, { id: 'adm', token: 'ta', role: 'admin', plan: 'pro' });
  return { kv, env };
}

describe('POST /api/payments/request', () => {
  test('rejects unauthenticated', async () => {
    const { env } = setup();
    const res = await worker.fetch(r('POST', '/api/payments/request', { period: 'monthly' }), env);
    assert.equal(res.status, 401);
  });

  test('503 when no IBAN is configured', async () => {
    const { kv } = setup();
    const res = await worker.fetch(authed('POST', '/api/payments/request', 't1', { period: 'monthly' }), { BWR_KV: kv });
    assert.equal(res.status, 503);
  });

  test('creates a pending request with bank details + unique reference', async () => {
    const { kv, env } = setup();
    const res = await worker.fetch(authed('POST', '/api/payments/request', 't1', { period: 'monthly' }), env);
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.match(body.ref, /^BWR-[A-HJ-NP-Z2-9]{6}$/);
    assert.equal(body.amountCents, 299);
    assert.equal(body.iban, env.BANK_IBAN);
    assert.equal(body.holder, 'Test EI');
    const stored = JSON.parse(kv.store.get(`payreq:${body.ref}`));
    assert.equal(stored.userId, 'u1');
    assert.equal(stored.status, 'pending');
  });

  test('re-asking reuses the same reference and switches the period', async () => {
    const { kv, env } = setup();
    const a = await (await worker.fetch(authed('POST', '/api/payments/request', 't1', { period: 'monthly' }), env)).json();
    const res = await worker.fetch(authed('POST', '/api/payments/request', 't1', { period: 'annual' }), env);
    assert.equal(res.status, 200);
    const b = await res.json();
    assert.equal(b.ref, a.ref);
    assert.equal(b.amountCents, 2691);
    assert.equal([...kv.store.keys()].filter(k => k.startsWith('payreq:')).length, 1);
  });

  test('unknown period falls back to monthly', async () => {
    const { env } = setup();
    const body = await (await worker.fetch(authed('POST', '/api/payments/request', 't1', { period: 'forever' }), env)).json();
    assert.equal(body.period, 'monthly');
  });
});

describe('admin payment endpoints', () => {
  test('non-admin cannot list or mark paid', async () => {
    const { env } = setup();
    const { ref } = await (await worker.fetch(authed('POST', '/api/payments/request', 't1', {}), env)).json();
    assert.equal((await worker.fetch(authed('GET', '/api/payments', 't1'), env)).status, 403);
    assert.equal((await worker.fetch(authed('POST', `/api/payments/${ref}/paid`, 't1'), env)).status, 403);
    assert.equal(readUser(env.BWR_KV, 'u1').plan, 'free');
  });

  test('admin lists requests', async () => {
    const { env } = setup();
    await worker.fetch(authed('POST', '/api/payments/request', 't1', {}), env);
    const body = await (await worker.fetch(authed('GET', '/api/payments', 'ta'), env)).json();
    assert.equal(body.payments.length, 1);
    assert.equal(body.payments[0].amount, '2,99 €');
  });

  test('"Payé" activates Pro for ~a month, notifies, and frees a new request', async () => {
    const { kv, env } = setup();
    const { ref } = await (await worker.fetch(authed('POST', '/api/payments/request', 't1', { period: 'monthly' }), env)).json();
    const res = await worker.fetch(authed('POST', `/api/payments/${ref}/paid`, 'ta'), env);
    assert.equal(res.status, 200);
    const u = readUser(kv, 'u1');
    assert.equal(u.plan, 'pro');
    assert.equal(u.planBase, 'free');
    const left = new Date(u.planExpiresAt).getTime() - Date.now();
    assert.ok(left > 30 * DAY && left <= 31 * DAY);
    assert.equal(JSON.parse(kv.store.get(`payreq:${ref}`)).status, 'paid');
    assert.equal([...kv.store.keys()].filter(k => k.startsWith('inboxmsg:')).length, 1);
    // Can't be paid twice
    assert.equal((await worker.fetch(authed('POST', `/api/payments/${ref}/paid`, 'ta'), env)).status, 409);
    // Next renewal gets a fresh reference
    const next = await (await worker.fetch(authed('POST', '/api/payments/request', 't1', {}), env)).json();
    assert.notEqual(next.ref, ref);
  });

  test('annual payment stacks on an active Pro period', async () => {
    const { kv, env } = setup();
    const exp = new Date(Date.now() + 10 * DAY).toISOString();
    seedUser(kv, { id: 'u2', token: 't2', plan: 'pro', extra: { planExpiresAt: exp, planBase: 'free' } });
    const { ref } = await (await worker.fetch(authed('POST', '/api/payments/request', 't2', { period: 'annual' }), env)).json();
    await worker.fetch(authed('POST', `/api/payments/${ref}/paid`, 'ta'), env);
    const u = readUser(kv, 'u2');
    assert.equal(new Date(u.planExpiresAt).getTime(), new Date(exp).getTime() + 365 * DAY);
    assert.equal(u.planBase, 'free');
  });

  test('cancel marks the request cancelled and leaves the plan alone', async () => {
    const { kv, env } = setup();
    const { ref } = await (await worker.fetch(authed('POST', '/api/payments/request', 't1', {}), env)).json();
    assert.equal((await worker.fetch(authed('DELETE', `/api/payments/${ref}`, 'ta'), env)).status, 200);
    assert.equal(JSON.parse(kv.store.get(`payreq:${ref}`)).status, 'cancelled');
    assert.equal(readUser(kv, 'u1').plan, 'free');
    assert.equal((await worker.fetch(authed('POST', `/api/payments/${ref}/paid`, 'ta'), env)).status, 409);
  });

  test('unknown reference → 404', async () => {
    const { env } = setup();
    assert.equal((await worker.fetch(authed('POST', '/api/payments/BWR-ZZZZZZ/paid', 'ta'), env)).status, 404);
  });
});
