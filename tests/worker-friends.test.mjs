// Social / friends layer integration tests.
// Covers: follow/unfollow (+ reverse index + inbox notify), following/followers
// lists, directory search, mini-profile, shared-activity feed, kudos toggle,
// shared-activity visibility guard, and the account-deletion social purge.

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
      const start = cursor ? Number(cursor) : 0;
      const page = all.slice(start, start + limit);
      const end = start + limit;
      const complete = end >= all.length;
      return { keys: page, list_complete: complete, cursor: complete ? undefined : String(end) };
    },
  };
}

function addUser(kv, id, over = {}) {
  const user = { id, name: over.name || id, username: over.username || id, email: `${id}@bwr.fr`, role: 'user', plan: 'free', stats: over.stats || {}, ...over };
  kv.store.set(`user:${id}`, JSON.stringify(user));
  kv.store.set(`uemail:${user.email}`, id);
  const token = `tok-${id}`;
  kv.store.set(`session:${token}`, JSON.stringify({ userId: id, expiresAt: new Date(Date.now() + 86400000).toISOString() }));
  return token;
}

function freshEnv() {
  const kv = makeMockKV();
  const env = { BWR_KV: kv };
  const alice = addUser(kv, 'alice', { name: 'Alice', username: 'alice_forest', stats: { walkedPathsCount: 5, reports: 2 } });
  const bob   = addUser(kv, 'bob',   { name: 'Bob',   username: 'bobby' });
  return { kv, env, tokens: { alice, bob } };
}

const r = (method, path, body, headers = {}) => new Request(`https://bwr.test${path}`, {
  method,
  headers: { 'Content-Type': 'application/json', ...headers },
  ...(body != null ? { body: JSON.stringify(body) } : {}),
});
const authed = (method, path, token, body) => r(method, path, body, { Authorization: `Bearer ${token}` });

// Seed a shared + a private activity for a user.
function addActivity(kv, ownerId, id, shared, over = {}) {
  const a = {
    id, userId: ownerId, name: over.name || `Sortie ${id}`,
    coords: [[49.35, 2.90], [49.36, 2.91]], elevations: null, times: null,
    meters: over.meters || 3000, seconds: 1800, movingSeconds: 1700, ascent: 20, descent: 20,
    shared, startedAt: over.startedAt || '2026-09-01T09:00:00.000Z', savedAt: '2026-09-01T10:00:00.000Z',
  };
  kv.store.set(`activity:${ownerId}:${id}`, JSON.stringify(a));
}

describe('follow / unfollow', () => {
  test('requires auth', async () => {
    const { env } = freshEnv();
    const res = await worker.fetch(r('POST', '/api/social/follow/bob'), env);
    assert.equal(res.status, 401);
  });

  test('cannot follow yourself', async () => {
    const { env, tokens } = freshEnv();
    const res = await worker.fetch(authed('POST', '/api/social/follow/alice', tokens.alice), env);
    assert.equal(res.status, 400);
  });

  test('404 on unknown target', async () => {
    const { env, tokens } = freshEnv();
    const res = await worker.fetch(authed('POST', '/api/social/follow/ghost', tokens.alice), env);
    assert.equal(res.status, 404);
  });

  test('creates both directions + an inbox notification', async () => {
    const { env, kv, tokens } = freshEnv();
    const res = await worker.fetch(authed('POST', '/api/social/follow/bob', tokens.alice), env);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).following, true);
    assert.ok(kv.store.has('follow:alice:bob'));
    assert.ok(kv.store.has('follower:bob:alice'));
    const inbox = [...kv.store.keys()].filter(k => k.startsWith('inboxmsg:'));
    assert.equal(inbox.length, 1);
    const msg = JSON.parse(kv.store.get(inbox[0]));
    assert.equal(msg.target, 'bob');
  });

  test('unfollow removes both directions', async () => {
    const { env, kv, tokens } = freshEnv();
    await worker.fetch(authed('POST', '/api/social/follow/bob', tokens.alice), env);
    const res = await worker.fetch(authed('DELETE', '/api/social/follow/bob', tokens.alice), env);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).following, false);
    assert.ok(!kv.store.has('follow:alice:bob'));
    assert.ok(!kv.store.has('follower:bob:alice'));
  });
});

describe('following / followers lists', () => {
  test('following lists who I follow; followers flags back-follow', async () => {
    const { env, tokens } = freshEnv();
    await worker.fetch(authed('POST', '/api/social/follow/bob', tokens.alice), env);

    const following = await (await worker.fetch(authed('GET', '/api/social/following', tokens.alice), env)).json();
    assert.equal(following.users.length, 1);
    assert.equal(following.users[0].id, 'bob');

    const followers = await (await worker.fetch(authed('GET', '/api/social/followers', tokens.bob), env)).json();
    assert.equal(followers.users.length, 1);
    assert.equal(followers.users[0].id, 'alice');
    assert.equal(followers.users[0].iFollow, false); // bob doesn't follow alice back
  });
});

describe('directory search', () => {
  test('excludes self, never leaks email, flags isFollowing', async () => {
    const { env, tokens } = freshEnv();
    await worker.fetch(authed('POST', '/api/social/follow/bob', tokens.alice), env);
    const res = await (await worker.fetch(authed('GET', '/api/social/users', tokens.alice), env)).json();
    assert.equal(res.users.length, 1);
    assert.equal(res.users[0].id, 'bob');
    assert.equal(res.users[0].isFollowing, true);
    assert.ok(!('email' in res.users[0]));
  });

  test('q filters by name and username', async () => {
    const { env, tokens } = freshEnv();
    const byName = await (await worker.fetch(authed('GET', '/api/social/users?q=bob', tokens.alice), env)).json();
    assert.equal(byName.users.length, 1);
    const byUser = await (await worker.fetch(authed('GET', '/api/social/users?q=bobby', tokens.alice), env)).json();
    assert.equal(byUser.users.length, 1);
    const none = await (await worker.fetch(authed('GET', '/api/social/users?q=zzz', tokens.alice), env)).json();
    assert.equal(none.users.length, 0);
  });
});

describe('mini-profile', () => {
  test('returns counts + only shared activities', async () => {
    const { env, kv, tokens } = freshEnv();
    addActivity(kv, 'bob', 'b1', true);
    addActivity(kv, 'bob', 'b2', false);
    await worker.fetch(authed('POST', '/api/social/follow/bob', tokens.alice), env);

    const p = await (await worker.fetch(authed('GET', '/api/social/profile/bob', tokens.alice), env)).json();
    assert.equal(p.id, 'bob');
    assert.equal(p.isFollowing, true);
    assert.equal(p.followerCount, 1);
    assert.equal(p.sharedActivities.length, 1);
    assert.equal(p.sharedActivities[0].id, 'b1');
    assert.ok(!('coords' in p.sharedActivities[0]));
  });
});

describe('feed', () => {
  test('shows shared walks from followees + my own, newest first, no coords', async () => {
    const { env, kv, tokens } = freshEnv();
    addActivity(kv, 'bob', 'b1', true, { startedAt: '2026-09-02T09:00:00.000Z' });
    addActivity(kv, 'bob', 'b2', false);
    addActivity(kv, 'alice', 'a1', true, { startedAt: '2026-09-03T09:00:00.000Z' });
    await worker.fetch(authed('POST', '/api/social/follow/bob', tokens.alice), env);

    const res = await (await worker.fetch(authed('GET', '/api/social/feed', tokens.alice), env)).json();
    assert.equal(res.feed.length, 2);
    assert.equal(res.feed[0].id, 'a1'); // newest
    assert.equal(res.feed[1].id, 'b1');
    assert.ok(!('coords' in res.feed[0]));
    assert.equal(res.feed[0].kudos, 0);
    assert.equal(res.feed[0].iKudosed, false);
    assert.equal(res.feed[1].ownerName, 'Bob');
  });
});

describe('kudos', () => {
  test('toggles on/off, guards private walks, counts', async () => {
    const { env, kv, tokens } = freshEnv();
    addActivity(kv, 'bob', 'b1', true);
    addActivity(kv, 'bob', 'b2', false);
    await worker.fetch(authed('POST', '/api/social/follow/bob', tokens.alice), env);

    // private → 403
    const priv = await worker.fetch(authed('POST', '/api/social/kudos/bob/b2', tokens.alice), env);
    assert.equal(priv.status, 403);

    // add kudos
    const on = await (await worker.fetch(authed('POST', '/api/social/kudos/bob/b1', tokens.alice), env)).json();
    assert.equal(on.kudos, 1);
    assert.equal(on.mine, true);
    assert.ok(kv.store.has('kudos:bob:b1:alice'));

    // toggle off
    const off = await (await worker.fetch(authed('POST', '/api/social/kudos/bob/b1', tokens.alice), env)).json();
    assert.equal(off.kudos, 0);
    assert.equal(off.mine, false);
  });
});

describe('shared activity fetch (replay)', () => {
  test('owner sees private; others blocked; shared visible to all', async () => {
    const { env, kv, tokens } = freshEnv();
    addActivity(kv, 'bob', 'b1', true);
    addActivity(kv, 'bob', 'b2', false);

    const shared = await worker.fetch(authed('GET', '/api/social/activity/bob/b1', tokens.alice), env);
    assert.equal(shared.status, 200);
    const privOther = await worker.fetch(authed('GET', '/api/social/activity/bob/b2', tokens.alice), env);
    assert.equal(privOther.status, 403);
    const privOwner = await worker.fetch(authed('GET', '/api/social/activity/bob/b2', tokens.bob), env);
    assert.equal(privOwner.status, 200);
  });
});

describe('activity sharing via activities API', () => {
  test('POST accepts shared flag; PATCH toggles it', async () => {
    const { env, kv, tokens } = freshEnv();
    const created = await (await worker.fetch(authed('POST', '/api/activities', tokens.bob, {
      name: 'Test', coords: [[49.35, 2.90], [49.36, 2.91]], meters: 1000, seconds: 600, shared: true,
    }), env)).json();
    const id = created.id;
    assert.equal(JSON.parse(kv.store.get(`activity:bob:${id}`)).shared, true);

    const patched = await (await worker.fetch(authed('PATCH', `/api/activities/${id}`, tokens.bob, { shared: false }), env)).json();
    assert.equal(patched.shared, false);
    assert.equal(JSON.parse(kv.store.get(`activity:bob:${id}`)).shared, false);
  });
});

describe('account deletion purges the social graph', () => {
  test('follow/follower/kudos keys for the user are removed both ways', async () => {
    const { env, kv, tokens } = freshEnv();
    addActivity(kv, 'alice', 'a1', true);
    addActivity(kv, 'bob', 'b1', true);
    // alice follows bob, bob follows alice
    await worker.fetch(authed('POST', '/api/social/follow/bob', tokens.alice), env);
    await worker.fetch(authed('POST', '/api/social/follow/alice', tokens.bob), env);
    // alice kudos bob; bob kudos alice
    await worker.fetch(authed('POST', '/api/social/kudos/bob/b1', tokens.alice), env);
    await worker.fetch(authed('POST', '/api/social/kudos/alice/a1', tokens.bob), env);

    const del = await worker.fetch(authed('DELETE', '/api/auth/account', tokens.alice), env);
    assert.equal(del.status, 200);

    const leftover = [...kv.store.keys()].filter(k =>
      k.startsWith('follow:') || k.startsWith('follower:') || k.startsWith('kudos:'));
    // Every remaining social key must be unrelated to alice.
    for (const k of leftover) assert.ok(!k.includes('alice'), `leftover key ${k}`);
  });
});
