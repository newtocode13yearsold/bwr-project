// Notification-email wiring tests.
// Covers: notifyForumReply / notifyRouteHazardEmail guard logic (opt-out, self-skip),
// the /api/auth/notifications toggle + /me reflection, and the one-click
// /api/notify/unsubscribe endpoint (valid + forged token).

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker.js';
import { notifyForumReply, notifyRouteHazardEmail, unsubscribeToken } from '../worker/notify.js';

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

function seedUser(kv, { id, plan = 'silver', role = 'user', token, emailNotifications }) {
  const user = { id, name: id, email: `${id}@bwr.fr`, role, plan, salt: `salt-${id}` };
  if (emailNotifications !== undefined) user.emailNotifications = emailNotifications;
  kv.store.set(`user:${id}`, JSON.stringify(user));
  kv.store.set(`uemail:${id}@bwr.fr`, id);
  if (token) kv.store.set(`session:${token}`, JSON.stringify({ userId: id, expiresAt: new Date(Date.now() + 86400000).toISOString() }));
  return user;
}

// Capture every Resend send. sendEmail only fires when RESEND_API_KEY is set.
let sent;
const realFetch = globalThis.fetch;
beforeEach(() => {
  sent = [];
  globalThis.fetch = async (url, opts = {}) => {
    if (String(url).includes('api.resend.com')) {
      sent.push(JSON.parse(opts.body));
      return new Response('{}', { status: 200 });
    }
    return new Response('{}', { status: 200 }); // swallow ntfy etc.
  };
});
afterEach(() => { globalThis.fetch = realFetch; });

const envWithKey = kv => ({ BWR_KV: kv, RESEND_API_KEY: 'test', RESEND_FROM: 'BWR <t@bwr.fr>' });

const r = (method, path, body, headers = {}) => new Request(
  `https://bwr.test${path}`,
  { method, headers: { 'Content-Type': 'application/json', ...headers }, ...(body != null ? { body: JSON.stringify(body) } : {}) }
);
const authed = (method, path, token, body) => r(method, path, body, { Authorization: `Bearer ${token}` });

// ── notifyForumReply ───────────────────────────────────────────────────────────

describe('notifyForumReply', () => {
  test('emails the topic author', async () => {
    const kv = makeMockKV();
    seedUser(kv, { id: 'author' });
    const topic = { id: 't1', userId: 'author', title: 'Mon sujet' };
    await notifyForumReply(envWithKey(kv), { topic, reply: { userId: 'other', authorName: 'Bob', body: 'Salut !' } });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, 'author@bwr.fr');
    assert.match(sent[0].subject, /Mon sujet/);
    assert.match(sent[0].html, /Bob/);
    // One-click unsubscribe header present.
    assert.ok(sent[0].headers['List-Unsubscribe']);
  });

  test('does not email when the replier is the author', async () => {
    const kv = makeMockKV();
    seedUser(kv, { id: 'author' });
    await notifyForumReply(envWithKey(kv), { topic: { id: 't1', userId: 'author', title: 'S' }, reply: { userId: 'author', body: 'x' } });
    assert.equal(sent.length, 0);
  });

  test('respects the opt-out flag', async () => {
    const kv = makeMockKV();
    seedUser(kv, { id: 'author', emailNotifications: false });
    await notifyForumReply(envWithKey(kv), { topic: { id: 't1', userId: 'author', title: 'S' }, reply: { userId: 'other', body: 'x' } });
    assert.equal(sent.length, 0);
  });

  test('escapes HTML in the reply body and title', async () => {
    const kv = makeMockKV();
    seedUser(kv, { id: 'author' });
    await notifyForumReply(envWithKey(kv), {
      topic: { id: 't1', userId: 'author', title: '<b>x</b>' },
      reply: { userId: 'other', authorName: 'Bob', body: '<script>alert(1)</script>' },
    });
    assert.ok(!sent[0].html.includes('<script>'));
    assert.ok(sent[0].html.includes('&lt;script&gt;'));
  });
});

// ── notifyRouteHazardEmail ─────────────────────────────────────────────────────

describe('notifyRouteHazardEmail', () => {
  test('emails a matched route owner', async () => {
    const kv = makeMockKV();
    const user = seedUser(kv, { id: 'owner' });
    await notifyRouteHazardEmail(envWithKey(kv), user, 'Boucle du matin', { id: 'rep1', type: 'fallen_tree', note: 'gros arbre' });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, 'owner@bwr.fr');
    assert.match(sent[0].subject, /Boucle du matin/);
    assert.match(sent[0].html, /Arbre tombé/);
  });

  test('respects the opt-out flag', async () => {
    const kv = makeMockKV();
    const user = seedUser(kv, { id: 'owner', emailNotifications: false });
    await notifyRouteHazardEmail(envWithKey(kv), user, 'Trajet', { id: 'rep1', type: 'flooded' });
    assert.equal(sent.length, 0);
  });
});

// ── /api/auth/notifications toggle ─────────────────────────────────────────────

describe('PUT /api/auth/notifications', () => {
  test('toggles the flag and /me reflects it', async () => {
    const kv = makeMockKV();
    seedUser(kv, { id: 'u1', token: 'tok1' });
    const env = { BWR_KV: kv };

    // default on
    let me = await (await worker.fetch(authed('GET', '/api/auth/me', 'tok1'), env)).json();
    assert.equal(me.emailNotifications, true);

    // turn off
    const off = await worker.fetch(authed('PUT', '/api/auth/notifications', 'tok1', { emailNotifications: false }), env);
    assert.equal(off.status, 200);
    assert.equal((await off.json()).emailNotifications, false);

    me = await (await worker.fetch(authed('GET', '/api/auth/me', 'tok1'), env)).json();
    assert.equal(me.emailNotifications, false);

    // back on
    await worker.fetch(authed('PUT', '/api/auth/notifications', 'tok1', { emailNotifications: true }), env);
    me = await (await worker.fetch(authed('GET', '/api/auth/me', 'tok1'), env)).json();
    assert.equal(me.emailNotifications, true);
  });

  test('rejects unauthenticated', async () => {
    const kv = makeMockKV();
    const res = await worker.fetch(r('PUT', '/api/auth/notifications', { emailNotifications: false }), { BWR_KV: kv });
    assert.equal(res.status, 401);
  });
});

// ── /api/notify/unsubscribe (one-click) ────────────────────────────────────────

describe('GET /api/notify/unsubscribe', () => {
  test('valid token turns emails off', async () => {
    const kv = makeMockKV();
    const user = seedUser(kv, { id: 'u1' });
    const env = { BWR_KV: kv };
    const token = await unsubscribeToken(user);

    const res = await worker.fetch(r('GET', `/api/notify/unsubscribe?uid=u1&token=${token}`), env);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /Désabonnement confirmé/);
    assert.equal(JSON.parse(kv.store.get('user:u1')).emailNotifications, false);
  });

  test('forged token does not change the flag', async () => {
    const kv = makeMockKV();
    seedUser(kv, { id: 'u1' });
    const env = { BWR_KV: kv };

    const res = await worker.fetch(r('GET', '/api/notify/unsubscribe?uid=u1&token=deadbeef'), env);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /invalide/);
    assert.equal(JSON.parse(kv.store.get('user:u1')).emailNotifications, undefined);
  });

  test('POST (RFC 8058 one-click) also unsubscribes', async () => {
    const kv = makeMockKV();
    const user = seedUser(kv, { id: 'u1' });
    const env = { BWR_KV: kv };
    const token = await unsubscribeToken(user);

    const res = await worker.fetch(r('POST', `/api/notify/unsubscribe?uid=u1&token=${token}`), env);
    assert.equal(res.status, 200);
    assert.equal(JSON.parse(kv.store.get('user:u1')).emailNotifications, false);
  });
});
