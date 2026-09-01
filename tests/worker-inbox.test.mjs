// In-app inbox handler integration tests.
// Covers: admin-only sending, broadcast vs direct delivery, per-user read
// state, mark-read / mark-all, unread count, admin sent list + delete,
// account-deletion purge of read markers.

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
  seedUser(kv, { id: 'u1', name: 'Alice', token: 'tok-u1' });
  seedUser(kv, { id: 'u2', name: 'Bob', token: 'tok-u2' });
  seedUser(kv, { id: 'admin1', name: 'Admin', role: 'admin', token: 'tok-admin' });
  return { kv, env };
}

const r = (method, path, body, headers = {}) => new Request(
  `https://bwr.test${path}`,
  { method, headers: { 'Content-Type': 'application/json', ...headers }, ...(body != null ? { body: JSON.stringify(body) } : {}) }
);
const authed = (method, path, token, body) => r(method, path, body, { Authorization: `Bearer ${token}` });

describe('POST /api/inbox (send)', () => {
  test('rejects non-admin senders', async () => {
    const { env } = freshEnv();
    const res = await worker.fetch(authed('POST', '/api/inbox', 'tok-u1', { subject: 'Hi', body: 'x' }), env);
    assert.equal(res.status, 403);
  });

  test('rejects unauthenticated', async () => {
    const { env } = freshEnv();
    const res = await worker.fetch(r('POST', '/api/inbox', { subject: 'Hi', body: 'x' }), env);
    assert.equal(res.status, 403);
  });

  test('rejects empty subject or body', async () => {
    const { env } = freshEnv();
    assert.equal((await worker.fetch(authed('POST', '/api/inbox', 'tok-admin', { subject: '', body: 'x' }), env)).status, 400);
    assert.equal((await worker.fetch(authed('POST', '/api/inbox', 'tok-admin', { subject: 'x', body: '' }), env)).status, 400);
  });

  test('rejects a direct message to an unknown recipient', async () => {
    const { env } = freshEnv();
    const res = await worker.fetch(authed('POST', '/api/inbox', 'tok-admin', { subject: 'x', body: 'y', target: 'ghost' }), env);
    assert.equal(res.status, 404);
  });

  test('admin broadcast succeeds', async () => {
    const { env, kv } = freshEnv();
    const res = await worker.fetch(authed('POST', '/api/inbox', 'tok-admin', { subject: 'News', body: 'Hello all' }), env);
    assert.equal(res.status, 201);
    const stored = [...kv.store.keys()].filter(k => k.startsWith('inboxmsg:'));
    assert.equal(stored.length, 1);
  });
});

describe('GET /api/inbox (read)', () => {
  test('broadcast reaches every user, unread by default', async () => {
    const { env } = freshEnv();
    await worker.fetch(authed('POST', '/api/inbox', 'tok-admin', { subject: 'News', body: 'Hello all' }), env);

    const res = await worker.fetch(authed('GET', '/api/inbox', 'tok-u1'), env);
    const d = await res.json();
    assert.equal(d.messages.length, 1);
    assert.equal(d.messages[0].read, false);
    assert.equal(d.messages[0].direct, false);
    assert.equal(d.unread, 1);
    assert.equal(d.isAdmin, false);
  });

  test('direct message reaches only its recipient', async () => {
    const { env } = freshEnv();
    await worker.fetch(authed('POST', '/api/inbox', 'tok-admin', { subject: 'Just you', body: 'hey', target: 'u1' }), env);

    const forU1 = await (await worker.fetch(authed('GET', '/api/inbox', 'tok-u1'), env)).json();
    const forU2 = await (await worker.fetch(authed('GET', '/api/inbox', 'tok-u2'), env)).json();
    assert.equal(forU1.messages.length, 1);
    assert.equal(forU1.messages[0].direct, true);
    assert.equal(forU2.messages.length, 0);
  });

  test('requires auth', async () => {
    const { env } = freshEnv();
    assert.equal((await worker.fetch(r('GET', '/api/inbox'), env)).status, 401);
  });
});

describe('read state', () => {
  test('marking one message read is per-user', async () => {
    const { env } = freshEnv();
    await worker.fetch(authed('POST', '/api/inbox', 'tok-admin', { subject: 'News', body: 'x' }), env);
    const before = await (await worker.fetch(authed('GET', '/api/inbox', 'tok-u1'), env)).json();
    const msgId = before.messages[0].id;

    const mark = await worker.fetch(authed('POST', `/api/inbox/${msgId}/read`, 'tok-u1'), env);
    assert.equal(mark.status, 200);

    const afterU1 = await (await worker.fetch(authed('GET', '/api/inbox', 'tok-u1'), env)).json();
    const afterU2 = await (await worker.fetch(authed('GET', '/api/inbox', 'tok-u2'), env)).json();
    assert.equal(afterU1.messages[0].read, true);
    assert.equal(afterU1.unread, 0);
    assert.equal(afterU2.messages[0].read, false); // Bob's copy is still unread
    assert.equal(afterU2.unread, 1);
  });

  test('cannot mark read a message not addressed to you', async () => {
    const { env } = freshEnv();
    await worker.fetch(authed('POST', '/api/inbox', 'tok-admin', { subject: 'x', body: 'y', target: 'u1' }), env);
    const list = await (await worker.fetch(authed('GET', '/api/inbox', 'tok-u1'), env)).json();
    const msgId = list.messages[0].id;
    const res = await worker.fetch(authed('POST', `/api/inbox/${msgId}/read`, 'tok-u2'), env);
    assert.equal(res.status, 404);
  });

  test('read-all clears the unread count', async () => {
    const { env } = freshEnv();
    await worker.fetch(authed('POST', '/api/inbox', 'tok-admin', { subject: 'a', body: '1' }), env);
    await worker.fetch(authed('POST', '/api/inbox', 'tok-admin', { subject: 'b', body: '2' }), env);
    await worker.fetch(authed('POST', '/api/inbox/read-all', 'tok-u1'), env);
    const d = await (await worker.fetch(authed('GET', '/api/inbox', 'tok-u1'), env)).json();
    assert.equal(d.unread, 0);
  });

  test('unread endpoint returns the count', async () => {
    const { env } = freshEnv();
    await worker.fetch(authed('POST', '/api/inbox', 'tok-admin', { subject: 'a', body: '1' }), env);
    const d = await (await worker.fetch(authed('GET', '/api/inbox/unread', 'tok-u1'), env)).json();
    assert.equal(d.unread, 1);
  });
});

describe('admin sent list + delete', () => {
  test('sent list is admin-only', async () => {
    const { env } = freshEnv();
    assert.equal((await worker.fetch(authed('GET', '/api/inbox/sent', 'tok-u1'), env)).status, 403);
  });

  test('sent list shows recipient info', async () => {
    const { env } = freshEnv();
    await worker.fetch(authed('POST', '/api/inbox', 'tok-admin', { subject: 'to bob', body: 'hey', target: 'u2' }), env);
    const d = await (await worker.fetch(authed('GET', '/api/inbox/sent', 'tok-admin'), env)).json();
    assert.equal(d.sent.length, 1);
    assert.equal(d.sent[0].target, 'u2');
    assert.equal(d.sent[0].targetName, 'Bob');
  });

  test('delete removes the message and its read markers', async () => {
    const { env, kv } = freshEnv();
    await worker.fetch(authed('POST', '/api/inbox', 'tok-admin', { subject: 'x', body: 'y' }), env);
    const list = await (await worker.fetch(authed('GET', '/api/inbox', 'tok-u1'), env)).json();
    const msgId = list.messages[0].id;
    await worker.fetch(authed('POST', `/api/inbox/${msgId}/read`, 'tok-u1'), env); // create a read marker

    const del = await worker.fetch(authed('DELETE', `/api/inbox/${msgId}`, 'tok-admin'), env);
    assert.equal(del.status, 200);
    assert.equal([...kv.store.keys()].filter(k => k.startsWith('inboxmsg:')).length, 0);
    assert.equal([...kv.store.keys()].filter(k => k.startsWith('inboxread:')).length, 0);

    const after = await (await worker.fetch(authed('GET', '/api/inbox', 'tok-u1'), env)).json();
    assert.equal(after.messages.length, 0);
  });

  test('delete is admin-only', async () => {
    const { env } = freshEnv();
    await worker.fetch(authed('POST', '/api/inbox', 'tok-admin', { subject: 'x', body: 'y' }), env);
    const list = await (await worker.fetch(authed('GET', '/api/inbox', 'tok-u1'), env)).json();
    const res = await worker.fetch(authed('DELETE', `/api/inbox/${list.messages[0].id}`, 'tok-u1'), env);
    assert.equal(res.status, 403);
  });
});

describe('account deletion purges inbox read markers', () => {
  test('deleting an account removes its inboxread markers', async () => {
    const { env, kv } = freshEnv();
    await worker.fetch(authed('POST', '/api/inbox', 'tok-admin', { subject: 'x', body: 'y' }), env);
    const list = await (await worker.fetch(authed('GET', '/api/inbox', 'tok-u1'), env)).json();
    await worker.fetch(authed('POST', `/api/inbox/${list.messages[0].id}/read`, 'tok-u1'), env);
    assert.ok([...kv.store.keys()].some(k => k.startsWith('inboxread:u1:')));

    await worker.fetch(authed('DELETE', '/api/auth/account', 'tok-u1'), env);
    assert.ok(![...kv.store.keys()].some(k => k.startsWith('inboxread:u1:')));
  });
});
