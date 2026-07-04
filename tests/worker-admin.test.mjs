// Admin workflow integration tests — Node 18+ required.
//
// Covers (previously manual-only):
//   • Path CRUD with plan-gating (POST/PUT/PATCH/DELETE /api/paths)
//   • Report submission + admin dismissal (/api/reports)
//   • Contact messages (/api/contact, /api/contacts)
//   • User listing + plan changes (/api/users, /api/auth/plan/:id)
//   • Saved routes with share tokens (/api/savedroutes)
//   • News management (/api/news)
//   • Photo upload via report (mobile workflow)
//   • OSM cache flush (/api/osm/cache)
//   • Migration endpoint (/api/migrate)

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker.js';

// ── Mock KV ──────────────────────────────────────────────────────────────────

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

// ── Per-test isolation factory ────────────────────────────────────────────────

function freshEnv() {
  const kv  = makeMockKV();
  const env = { BWR_KV: kv };

  function seedUser(user) {
    kv.store.set(`user:${user.id}`, JSON.stringify(user));
    kv.store.set(`uemail:${user.email.toLowerCase()}`, user.id);
  }

  function seedSession(token, userId) {
    const expiresAt = new Date(Date.now() + 86_400_000).toISOString();
    kv.store.set(`session:${token}`, JSON.stringify({ userId, expiresAt }));
  }

  function seedPath(path) {
    kv.store.set(`path:${path.id}`, JSON.stringify(path));
  }

  function seedReport(report) {
    kv.store.set(`report:${report.id}`, JSON.stringify(report));
  }

  function getStoredUser(id) {
    const raw = kv.store.get(`user:${id}`);
    return raw ? JSON.parse(raw) : null;
  }

  function seedAdmin(id = 'admin-1') {
    const admin = { id, name: 'Admin', email: `admin-${id}@bwr.fr`, role: 'admin', plan: 'gold', passwordHash: 'x', salt: 'x', stats: { routes: 0, km: 0 } };
    seedUser(admin);
    seedSession(`tok-${id}`, id);
    return { admin, token: `tok-${id}` };
  }

  function seedSilver(id = 'silver-1') {
    const user = { id, name: 'Silver', email: `silver-${id}@bwr.fr`, role: 'silver', plan: 'silver', passwordHash: 'x', salt: 'x', stats: { routes: 0, km: 0 } };
    seedUser(user);
    seedSession(`tok-${id}`, id);
    return { user, token: `tok-${id}` };
  }

  function seedFree(id = 'free-1') {
    const user = { id, name: 'Free', email: `free-${id}@bwr.fr`, role: 'free', plan: 'free', passwordHash: 'x', salt: 'x', stats: { routes: 0, km: 0 } };
    seedUser(user);
    seedSession(`tok-${id}`, id);
    return { user, token: `tok-${id}` };
  }

  return { kv, env, seedUser, seedSession, seedPath, seedReport, getStoredUser, seedAdmin, seedSilver, seedFree };
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

const samplePath = () => ({
  name: 'Sentier du Roi',
  pathType: 'foot',
  status: 'easy',
  notes: '',
  conditions: [],
  coordinates: [[2.90, 49.35], [2.91, 49.36]],
});

// ── GET /api/paths — public ───────────────────────────────────────────────────

describe('GET /api/paths', () => {
  test('returns empty array when no paths', async () => {
    const { env } = freshEnv();
    const res = await worker.fetch(r('GET', '/api/paths'), env);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), []);
  });

  test('returns seeded paths without auth', async () => {
    const { env, seedPath } = freshEnv();
    seedPath({ id: 'p1', name: 'Piste Verte', status: 'easy' });
    const res = await worker.fetch(r('GET', '/api/paths'), env);
    const paths = await res.json();
    assert.equal(paths.length, 1);
    assert.equal(paths[0].id, 'p1');
  });
});

// ── POST /api/paths — silver+ ─────────────────────────────────────────────────

describe('POST /api/paths', () => {
  test('free user → 403', async () => {
    const { env, seedFree } = freshEnv();
    const { token } = seedFree();
    const res = await worker.fetch(authed('POST', '/api/paths', token, samplePath()), env);
    assert.equal(res.status, 403);
  });

  test('unauthenticated → 401', async () => {
    const { env } = freshEnv();
    const res = await worker.fetch(r('POST', '/api/paths', samplePath()), env);
    assert.equal(res.status, 401);
  });

  test('silver user creates path → 201', async () => {
    const { env, seedSilver } = freshEnv();
    const { token } = seedSilver();
    const res = await worker.fetch(authed('POST', '/api/paths', token, samplePath()), env);
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.name, 'Sentier du Roi');
    assert.ok(body.id, 'id must be assigned');
  });

  test('admin creates path → 201', async () => {
    const { env, seedAdmin } = freshEnv();
    const { token } = seedAdmin();
    const res = await worker.fetch(authed('POST', '/api/paths', token, samplePath()), env);
    assert.equal(res.status, 201);
  });
});

// ── PUT /api/paths/:id — admin only ──────────────────────────────────────────

describe('PUT /api/paths/:id', () => {
  test('non-admin → 403', async () => {
    const { env, seedSilver, seedPath } = freshEnv();
    const { token } = seedSilver();
    seedPath({ id: 'p1', name: 'Old Name', status: 'easy' });
    const res = await worker.fetch(authed('PUT', '/api/paths/p1', token, { name: 'New Name' }), env);
    assert.equal(res.status, 403);
  });

  test('unknown path → 404', async () => {
    const { env, seedAdmin } = freshEnv();
    const { token } = seedAdmin();
    const res = await worker.fetch(authed('PUT', '/api/paths/ghost', token, { name: 'X' }), env);
    assert.equal(res.status, 404);
  });

  test('admin updates path → 200 with new data', async () => {
    const { env, kv, seedAdmin, seedPath } = freshEnv();
    const { token } = seedAdmin();
    seedPath({ id: 'p1', name: 'Old', status: 'easy', pathType: 'foot', coordinates: [] });
    const res = await worker.fetch(authed('PUT', '/api/paths/p1', token, { name: 'New Name', status: 'hard' }), env);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.name, 'New Name');
    assert.equal(body.status, 'hard');
    const stored = JSON.parse(kv.store.get('path:p1'));
    assert.equal(stored.name, 'New Name');
  });
});

// ── PATCH /api/paths/:id — plan-gated status update ──────────────────────────

describe('PATCH /api/paths/:id', () => {
  test('unauthenticated → 401', async () => {
    const { env, seedPath } = freshEnv();
    seedPath({ id: 'p1', name: 'X', status: 'easy' });
    const res = await worker.fetch(r('PATCH', '/api/paths/p1', { status: 'medium' }), env);
    assert.equal(res.status, 401);
  });

  test('invalid status → 400', async () => {
    const { env, seedFree, seedPath } = freshEnv();
    const { token } = seedFree();
    seedPath({ id: 'p1', name: 'X', status: 'easy' });
    const res = await worker.fetch(authed('PATCH', '/api/paths/p1', token, { status: 'banana' }), env);
    assert.equal(res.status, 400);
  });

  test('free user cannot set status to hard → 403', async () => {
    const { env, seedFree, seedPath } = freshEnv();
    const { token } = seedFree();
    seedPath({ id: 'p1', name: 'X', status: 'easy' });
    const res = await worker.fetch(authed('PATCH', '/api/paths/p1', token, { status: 'hard' }), env);
    assert.equal(res.status, 403);
  });

  test('free user can set status to medium → 200', async () => {
    const { env, seedFree, seedPath } = freshEnv();
    const { token } = seedFree();
    seedPath({ id: 'p1', name: 'X', status: 'easy' });
    const res = await worker.fetch(authed('PATCH', '/api/paths/p1', token, { status: 'medium' }), env);
    assert.equal(res.status, 200);
  });

  test('silver user can set status to hard → 200', async () => {
    const { env, seedSilver, seedPath } = freshEnv();
    const { token } = seedSilver();
    seedPath({ id: 'p1', name: 'X', status: 'easy' });
    const res = await worker.fetch(authed('PATCH', '/api/paths/p1', token, { status: 'hard' }), env);
    assert.equal(res.status, 200);
  });

  test('grading same path twice does not double-count pathGrades', async () => {
    const { env, seedFree, seedPath, getStoredUser } = freshEnv();
    const { user, token } = seedFree('free-grade');
    seedPath({ id: 'p1', name: 'X', status: 'easy' });
    await worker.fetch(authed('PATCH', '/api/paths/p1', token, { status: 'medium' }), env);
    await worker.fetch(authed('PATCH', '/api/paths/p1', token, { status: 'easy' }), env);
    const updated = getStoredUser(user.id);
    assert.equal(updated.stats.pathGrades, 1, 'second grade on same path must not increment');
  });
});

// ── DELETE /api/paths/:id — silver+ ──────────────────────────────────────────

describe('DELETE /api/paths/:id', () => {
  test('free user → 403', async () => {
    const { env, seedFree, seedPath } = freshEnv();
    const { token } = seedFree();
    seedPath({ id: 'p1', name: 'X', status: 'easy' });
    const res = await worker.fetch(authed('DELETE', '/api/paths/p1', token), env);
    assert.equal(res.status, 403);
  });

  test('silver user deletes path → 200, KV entry removed', async () => {
    const { env, kv, seedSilver, seedPath } = freshEnv();
    const { token } = seedSilver();
    seedPath({ id: 'p1', name: 'X', status: 'easy' });
    const res = await worker.fetch(authed('DELETE', '/api/paths/p1', token), env);
    assert.equal(res.status, 200);
    assert.equal(kv.store.has('path:p1'), false);
  });

  test('deleting path reverses grader pathGrades count', async () => {
    const { env, kv, seedAdmin, seedFree, seedPath, getStoredUser } = freshEnv();
    const { user: freeUser, token: freeToken } = seedFree('free-del');
    const { token: adminToken } = seedAdmin('admin-del');
    seedPath({ id: 'pdel', name: 'X', status: 'easy' });

    // Free user grades the path
    await worker.fetch(authed('PATCH', '/api/paths/pdel', freeToken, { status: 'medium' }), env);
    const before = getStoredUser(freeUser.id);
    assert.equal(before.stats.pathGrades, 1);

    // Admin deletes the path
    await worker.fetch(authed('DELETE', '/api/paths/pdel', adminToken), env);
    const after = getStoredUser(freeUser.id);
    assert.equal(after.stats.pathGrades, 0, 'grade XP must be reversed on path deletion');
  });
});

// ── GET/POST /api/reports ─────────────────────────────────────────────────────

describe('GET /api/reports', () => {
  test('returns empty array without auth', async () => {
    const { env } = freshEnv();
    const res = await worker.fetch(r('GET', '/api/reports'), env);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), []);
  });
});

describe('POST /api/reports', () => {
  test('unauthenticated → 401', async () => {
    const { env } = freshEnv();
    const res = await worker.fetch(r('POST', '/api/reports', { type: 'other', lat: 49.35, lon: 2.90 }), env);
    assert.equal(res.status, 401);
  });

  test('free user creates report → 201 (reporting is free for all plans)', async () => {
    const { env, seedFree } = freshEnv();
    const { token } = seedFree();
    const res = await worker.fetch(authed('POST', '/api/reports', token, { type: 'other', lat: 49.35, lon: 2.90 }), env);
    assert.equal(res.status, 201);
  });

  test('silver user creates report → 201, stats.reports incremented', async () => {
    const { env, seedSilver, getStoredUser } = freshEnv();
    const { user, token } = seedSilver('silver-rep');
    const res = await worker.fetch(authed('POST', '/api/reports', token, {
      type: 'fallen_tree', lat: 49.35, lon: 2.90, note: 'Gros chêne',
    }), env);
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.type, 'fallen_tree');
    assert.ok(body.id);
    const updated = getStoredUser(user.id);
    assert.equal(updated.stats.reports, 1);
  });

  test('report with photo stored in photo: KV key', async () => {
    const { env, kv, seedSilver } = freshEnv();
    const { token } = seedSilver('silver-photo');
    const fakePhoto = 'data:image/jpeg;base64,/9j/abc123';
    const res = await worker.fetch(authed('POST', '/api/reports', token, {
      type: 'flooded', lat: 49.35, lon: 2.90, photo: fakePhoto,
    }), env);
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.ok(kv.store.has(`photo:${body.id}`), 'photo must be stored in KV');
    assert.equal(body.hasPhoto, true);
  });
});

// ── DELETE /api/reports/:id — admin only ─────────────────────────────────────

describe('DELETE /api/reports/:id', () => {
  test('non-admin → 403', async () => {
    const { env, seedSilver, seedReport } = freshEnv();
    const { token } = seedSilver();
    seedReport({ id: 'r1', type: 'other' });
    const res = await worker.fetch(authed('DELETE', '/api/reports/r1', token), env);
    assert.equal(res.status, 403);
  });

  test('admin deletes report → 200, KV entries removed', async () => {
    const { env, kv, seedAdmin, seedReport } = freshEnv();
    const { token } = seedAdmin();
    seedReport({ id: 'r1', type: 'other' });
    kv.store.set('photo:r1', 'data:image/jpeg;base64,abc');
    const res = await worker.fetch(authed('DELETE', '/api/reports/r1', token), env);
    assert.equal(res.status, 200);
    assert.equal(kv.store.has('report:r1'), false);
    assert.equal(kv.store.has('photo:r1'), false, 'photo must also be deleted');
  });
});

// ── POST /api/contact ─────────────────────────────────────────────────────────

describe('POST /api/contact', () => {
  test('missing fields → 400', async () => {
    const { env } = freshEnv();
    const res = await worker.fetch(r('POST', '/api/contact', { name: 'Alice' }), env);
    assert.equal(res.status, 400);
  });

  test('valid message → 200, stored in contact: KV', async () => {
    const { env, kv } = freshEnv();
    const res = await worker.fetch(r('POST', '/api/contact', {
      name: 'Alice', email: 'alice@example.com', message: 'Bonjour !',
    }), env);
    assert.equal(res.status, 200);
    const contactKeys = [...kv.store.keys()].filter(k => k.startsWith('contact:'));
    assert.equal(contactKeys.length, 1);
  });

  test('rate limit: 3rd message from same IP → 429', async () => {
    const { env } = freshEnv();
    const msg = { name: 'A', email: 'a@b.fr', message: 'test' };
    const headers = { 'CF-Connecting-IP': '1.2.3.4' };
    await worker.fetch(r('POST', '/api/contact', msg, headers), env);
    await worker.fetch(r('POST', '/api/contact', msg, headers), env);
    const res = await worker.fetch(r('POST', '/api/contact', msg, headers), env);
    assert.equal(res.status, 429);
  });
});

// ── GET /api/contacts — admin only ───────────────────────────────────────────

describe('GET /api/contacts', () => {
  test('non-admin → 403', async () => {
    const { env, seedSilver } = freshEnv();
    const { token } = seedSilver();
    const res = await worker.fetch(authed('GET', '/api/contacts', token), env);
    assert.equal(res.status, 403);
  });

  test('admin gets contact list sorted by date descending', async () => {
    const { env, kv, seedAdmin } = freshEnv();
    const { token } = seedAdmin();
    kv.store.set('contact:c1', JSON.stringify({ id: 'c1', date: '2024-01-01T00:00:00Z', name: 'A', email: 'a@b.fr', message: 'x' }));
    kv.store.set('contact:c2', JSON.stringify({ id: 'c2', date: '2024-06-01T00:00:00Z', name: 'B', email: 'b@b.fr', message: 'y' }));
    const res = await worker.fetch(authed('GET', '/api/contacts', token), env);
    assert.equal(res.status, 200);
    const list = await res.json();
    assert.equal(list.length, 2);
    assert.equal(list[0].id, 'c2', 'most recent first');
  });
});

// ── DELETE /api/contacts/:id — admin only ────────────────────────────────────

describe('DELETE /api/contacts/:id', () => {
  test('admin deletes contact → 200, KV entry removed', async () => {
    const { env, kv, seedAdmin } = freshEnv();
    const { token } = seedAdmin();
    kv.store.set('contact:c1', JSON.stringify({ id: 'c1', date: '2024-01-01T00:00:00Z' }));
    const res = await worker.fetch(authed('DELETE', '/api/contacts/c1', token), env);
    assert.equal(res.status, 200);
    assert.equal(kv.store.has('contact:c1'), false);
  });

  test('non-admin → 403', async () => {
    const { env, kv, seedFree } = freshEnv();
    const { token } = seedFree();
    kv.store.set('contact:c1', JSON.stringify({ id: 'c1' }));
    const res = await worker.fetch(authed('DELETE', '/api/contacts/c1', token), env);
    assert.equal(res.status, 403);
  });
});

// ── GET /api/users — admin only ───────────────────────────────────────────────

describe('GET /api/users', () => {
  test('non-admin → 403', async () => {
    const { env, seedFree } = freshEnv();
    const { token } = seedFree();
    const res = await worker.fetch(authed('GET', '/api/users', token), env);
    assert.equal(res.status, 403);
  });

  test('admin gets user list without sensitive fields', async () => {
    const { env, seedAdmin, seedFree } = freshEnv();
    const { token } = seedAdmin('admin-list');
    seedFree('free-list');
    const res = await worker.fetch(authed('GET', '/api/users', token), env);
    assert.equal(res.status, 200);
    const list = await res.json();
    assert.ok(list.length >= 1);
    for (const u of list) {
      assert.equal(u.passwordHash, undefined, 'passwordHash must not be exposed');
      assert.equal(u.salt, undefined, 'salt must not be exposed');
    }
  });
});

// ── PUT /api/auth/plan/:userId — admin only ───────────────────────────────────

describe('PUT /api/auth/plan/:userId', () => {
  test('non-admin → 403', async () => {
    const { env, seedFree } = freshEnv();
    const { user, token } = seedFree('free-plan');
    const res = await worker.fetch(authed('PUT', `/api/auth/plan/${user.id}`, token, { plan: 'silver' }), env);
    assert.equal(res.status, 403);
  });

  test('admin upgrades user plan → stored in KV', async () => {
    const { env, seedAdmin, seedFree, getStoredUser } = freshEnv();
    const { token } = seedAdmin('admin-plan');
    const { user } = seedFree('target-plan');
    const res = await worker.fetch(authed('PUT', `/api/auth/plan/${user.id}`, token, { plan: 'silver' }), env);
    assert.equal(res.status, 200);
    const updated = getStoredUser(user.id);
    assert.equal(updated.plan, 'silver');
  });
});

// ── Saved routes (Silver+) ────────────────────────────────────────────────────

const sampleRoute = () => ({
  name: 'Mon grand tour',
  coords: [[2.90, 49.35], [2.91, 49.36], [2.92, 49.37]],
  meters: 5000,
  seconds: 3600,
  difficulty: 'easy',
  pathType: 'foot',
  mode: 'loop',
});

describe('POST /api/savedroutes', () => {
  test('free user → 403', async () => {
    const { env, seedFree } = freshEnv();
    const { token } = seedFree();
    const res = await worker.fetch(authed('POST', '/api/savedroutes', token, sampleRoute()), env);
    assert.equal(res.status, 403);
  });

  test('silver user saves route → 201 with id + shareToken', async () => {
    const { env, seedSilver } = freshEnv();
    const { token } = seedSilver();
    const res = await worker.fetch(authed('POST', '/api/savedroutes', token, sampleRoute()), env);
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.ok(body.id);
    assert.ok(body.shareToken);
  });

  test('invalid coords (< 2 points) → 400', async () => {
    const { env, seedSilver } = freshEnv();
    const { token } = seedSilver();
    const res = await worker.fetch(authed('POST', '/api/savedroutes', token, { ...sampleRoute(), coords: [[2.90, 49.35]] }), env);
    assert.equal(res.status, 400);
  });
});

describe('GET /api/savedroutes', () => {
  test('free user → 403', async () => {
    const { env, seedFree } = freshEnv();
    const { token } = seedFree();
    const res = await worker.fetch(authed('GET', '/api/savedroutes', token), env);
    assert.equal(res.status, 403);
  });

  test('silver user lists own routes (coords stripped from list)', async () => {
    const { env, seedSilver } = freshEnv();
    const { token } = seedSilver('silver-list');
    await worker.fetch(authed('POST', '/api/savedroutes', token, sampleRoute()), env);
    const res = await worker.fetch(authed('GET', '/api/savedroutes', token), env);
    assert.equal(res.status, 200);
    const list = await res.json();
    assert.equal(list.length, 1);
    assert.equal(list[0].coords, undefined, 'coords must be stripped from list response');
  });
});

describe('DELETE /api/savedroutes/:id', () => {
  test('deletes route and share token from KV', async () => {
    const { env, kv, seedSilver } = freshEnv();
    const { token } = seedSilver('silver-del');
    const createRes = await worker.fetch(authed('POST', '/api/savedroutes', token, sampleRoute()), env);
    const { id, shareToken } = await createRes.json();

    const delRes = await worker.fetch(authed('DELETE', `/api/savedroutes/${id}`, token), env);
    assert.equal(delRes.status, 200);
    assert.equal(kv.store.has(`routeshare:${shareToken}`), false, 'share token must be deleted');
  });

  test('non-existent route → 404', async () => {
    const { env, seedSilver } = freshEnv();
    const { token } = seedSilver();
    const res = await worker.fetch(authed('DELETE', '/api/savedroutes/ghost', token), env);
    assert.equal(res.status, 404);
  });
});

describe('GET /api/savedroutes/share/:token', () => {
  test('public share token returns route without userId', async () => {
    const { env, seedSilver } = freshEnv();
    const { token } = seedSilver('silver-share');
    const createRes = await worker.fetch(authed('POST', '/api/savedroutes', token, sampleRoute()), env);
    const { shareToken } = await createRes.json();

    const shareRes = await worker.fetch(r('GET', `/api/savedroutes/share/${shareToken}`), env);
    assert.equal(shareRes.status, 200);
    const route = await shareRes.json();
    assert.equal(route.userId, undefined, 'userId must be stripped from public share response');
    assert.ok(route.coords);
  });

  test('unknown share token → 404', async () => {
    const { env } = freshEnv();
    const res = await worker.fetch(r('GET', '/api/savedroutes/share/doesnotexist'), env);
    assert.equal(res.status, 404);
  });
});

// ── News management (admin) ───────────────────────────────────────────────────

describe('GET /api/news', () => {
  test('public endpoint returns items sorted by createdAt desc', async () => {
    const { env, kv } = freshEnv();
    kv.store.set('news:n1', JSON.stringify({ id: 'n1', title: 'Old', createdAt: '2024-01-01T00:00:00Z' }));
    kv.store.set('news:n2', JSON.stringify({ id: 'n2', title: 'New', createdAt: '2024-06-01T00:00:00Z' }));
    const res = await worker.fetch(r('GET', '/api/news'), env);
    assert.equal(res.status, 200);
    const list = await res.json();
    assert.equal(list[0].id, 'n2', 'most recent first');
  });
});

describe('POST /api/news', () => {
  test('non-admin → 403', async () => {
    const { env, seedSilver } = freshEnv();
    const { token } = seedSilver();
    const res = await worker.fetch(authed('POST', '/api/news', token, { title: 'Test' }), env);
    assert.equal(res.status, 403);
  });

  test('missing title → 400', async () => {
    const { env, seedAdmin } = freshEnv();
    const { token } = seedAdmin();
    const res = await worker.fetch(authed('POST', '/api/news', token, { content: 'No title' }), env);
    assert.equal(res.status, 400);
  });

  test('admin creates news item → 201', async () => {
    const { env, seedAdmin } = freshEnv();
    const { token } = seedAdmin();
    const res = await worker.fetch(authed('POST', '/api/news', token, { title: 'Grande nouvelle', content: 'Contenu.' }), env);
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.ok(body.id);
    assert.equal(body.title, 'Grande nouvelle');
  });
});

describe('POST /api/news/:id/react', () => {
  test('unknown article → 404', async () => {
    const { env } = freshEnv();
    const res = await worker.fetch(r('POST', '/api/news/nope/react', { reaction: 'like' }), env);
    assert.equal(res.status, 404);
  });

  test('invalid reaction → 400', async () => {
    const { env, kv } = freshEnv();
    kv.store.set('news:n1', JSON.stringify({ id: 'n1', title: 'T', createdAt: '2024-01-01T00:00:00Z' }));
    const res = await worker.fetch(r('POST', '/api/news/n1/react', { reaction: 'love' }), env);
    assert.equal(res.status, 400);
  });

  test('anonymous like increments count', async () => {
    const { env, kv } = freshEnv();
    kv.store.set('news:n1', JSON.stringify({ id: 'n1', title: 'T', createdAt: '2024-01-01T00:00:00Z' }));
    const res = await worker.fetch(r('POST', '/api/news/n1/react', { reaction: 'like' }, { 'CF-Connecting-IP': '1.2.3.4' }), env);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { likes: 1, dislikes: 0, reaction: 'like' });
  });

  test('same voter switching like → dislike moves the count', async () => {
    const { env, kv } = freshEnv();
    kv.store.set('news:n1', JSON.stringify({ id: 'n1', title: 'T', createdAt: '2024-01-01T00:00:00Z' }));
    const ip = { 'CF-Connecting-IP': '1.2.3.4' };
    await worker.fetch(r('POST', '/api/news/n1/react', { reaction: 'like' }, ip), env);
    const res = await worker.fetch(r('POST', '/api/news/n1/react', { reaction: 'dislike' }, ip), env);
    assert.deepEqual(await res.json(), { likes: 0, dislikes: 1, reaction: 'dislike' });
  });

  test('re-clicking the same reaction toggles it off (null)', async () => {
    const { env, kv } = freshEnv();
    kv.store.set('news:n1', JSON.stringify({ id: 'n1', title: 'T', createdAt: '2024-01-01T00:00:00Z' }));
    const ip = { 'CF-Connecting-IP': '1.2.3.4' };
    await worker.fetch(r('POST', '/api/news/n1/react', { reaction: 'like' }, ip), env);
    const res = await worker.fetch(r('POST', '/api/news/n1/react', { reaction: null }, ip), env);
    assert.deepEqual(await res.json(), { likes: 0, dislikes: 0, reaction: null });
  });

  test('two different IPs both count', async () => {
    const { env, kv } = freshEnv();
    kv.store.set('news:n1', JSON.stringify({ id: 'n1', title: 'T', createdAt: '2024-01-01T00:00:00Z' }));
    await worker.fetch(r('POST', '/api/news/n1/react', { reaction: 'like' }, { 'CF-Connecting-IP': '1.1.1.1' }), env);
    const res = await worker.fetch(r('POST', '/api/news/n1/react', { reaction: 'like' }, { 'CF-Connecting-IP': '2.2.2.2' }), env);
    assert.deepEqual(await res.json(), { likes: 2, dislikes: 0, reaction: 'like' });
  });
});

// ── DELETE /api/osm/cache — admin only ───────────────────────────────────────

describe('DELETE /api/osm/cache', () => {
  test('non-admin → 403', async () => {
    const { env, seedFree } = freshEnv();
    const { token } = seedFree();
    const res = await worker.fetch(authed('DELETE', '/api/osm/cache', token), env);
    assert.equal(res.status, 403);
  });

  test('admin flushes all osmv2 entries → 200', async () => {
    const { env, kv, seedAdmin } = freshEnv();
    const { token } = seedAdmin();
    kv.store.set('osmv2:49.35,2.90', '{"elements":[]}');
    kv.store.set('osmv2:49.40,2.95', '{"elements":[]}');
    const res = await worker.fetch(authed('DELETE', '/api/osm/cache', token), env);
    assert.equal(res.status, 200);
    const osmKeys = [...kv.store.keys()].filter(k => k.startsWith('osmv2:'));
    assert.equal(osmKeys.length, 0, 'all osmv2 keys must be deleted');
  });
});

// ── POST /api/migrate — admin only ───────────────────────────────────────────

describe('POST /api/migrate', () => {
  test('non-admin → 403', async () => {
    const { env, seedFree } = freshEnv();
    const { token } = seedFree();
    const res = await worker.fetch(authed('POST', '/api/migrate', token), env);
    assert.equal(res.status, 403);
  });

  test('migrates legacy array keys to granular keys', async () => {
    const { env, kv, seedAdmin } = freshEnv();
    const { token } = seedAdmin();
    const legacyUser = { id: 'lu1', name: 'Legacy', email: 'legacy@bwr.fr', role: 'free', plan: 'free', passwordHash: 'x', salt: 'x' };
    kv.store.set('users', JSON.stringify([legacyUser]));
    const legacyPath = { id: 'lp1', name: 'Old Path', status: 'easy', coordinates: [] };
    kv.store.set('paths', JSON.stringify([legacyPath]));

    const res = await worker.fetch(authed('POST', '/api/migrate', token), env);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.migrated.users, 1);
    assert.equal(body.migrated.paths, 1);
    assert.ok(kv.store.has('user:lu1'), 'granular user key must exist after migration');
    assert.ok(kv.store.has('path:lp1'), 'granular path key must exist after migration');
  });
});

// ── Activity analytics (logins + new accounts only — no page-view tracking) ────

describe('GET /api/analytics/events', () => {
  test('non-admin → 403', async () => {
    const { env, seedFree } = freshEnv();
    const { token } = seedFree();
    const res = await worker.fetch(authed('GET', '/api/analytics/events', token), env);
    assert.equal(res.status, 403);
  });

  test('returns recorded login/signup events and counters', async () => {
    const { env, kv, seedAdmin } = freshEnv();
    const { token } = seedAdmin();
    kv.store.set('event:0000000001000:e1', JSON.stringify({ id: 'e1', type: 'signup', timestamp: '2026-06-01T10:00:00.000Z', userId: 'u1', userName: 'Emilien' }));
    kv.store.set('event:0000000002000:e2', JSON.stringify({ id: 'e2', type: 'login',  timestamp: '2026-06-02T10:00:00.000Z', userId: 'u1', userName: 'Emilien' }));
    kv.store.set('analytics:total_logins', '5');
    kv.store.set('analytics:total_signups', '2');

    const res = await worker.fetch(authed('GET', '/api/analytics/events', token), env);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.events.length, 2);
    assert.equal(body.totalLogins, 5);
    assert.equal(body.totalSignups, 2);
  });

  test('the old page-view endpoint no longer exists (404, not tracked)', async () => {
    const { env } = freshEnv();
    const res = await worker.fetch(r('POST', '/api/analytics/visit', { page: '/map' }), env);
    assert.equal(res.status, 404);
  });
});

describe('POST /api/analytics/reset', () => {
  test('non-admin → 403', async () => {
    const { env, seedFree } = freshEnv();
    const { token } = seedFree();
    const res = await worker.fetch(authed('POST', '/api/analytics/reset', token, {}), env);
    assert.equal(res.status, 403);
  });

  test('keeps keepName activity, deletes everything else, and converts legacy visits', async () => {
    const { env, kv, seedAdmin } = freshEnv();
    const { token } = seedAdmin();
    // Two events: one for Emilien (keep), one for a bot-ish other user (drop).
    kv.store.set('event:0000000001000:e1', JSON.stringify({ id: 'e1', type: 'login', timestamp: '2026-06-01T10:00:00.000Z', userId: 'u1', userName: 'Emilien' }));
    kv.store.set('event:0000000002000:e2', JSON.stringify({ id: 'e2', type: 'login', timestamp: '2026-06-02T10:00:00.000Z', userId: 'u2', userName: 'Someone' }));
    // A legacy page-view for Emilien → should be converted into a login event.
    kv.store.set('visit:0000000003000:v1', JSON.stringify({ id: 'v1', timestamp: '2026-05-01T10:00:00.000Z', userId: 'u1', userName: 'Emilien', page: '/map' }));
    // A legacy page-view from an anonymous bot → should be deleted, not kept.
    kv.store.set('visit:0000000004000:v2', JSON.stringify({ id: 'v2', timestamp: '2026-05-02T10:00:00.000Z', userId: null, userName: null, page: '/' }));

    const res = await worker.fetch(authed('POST', '/api/analytics/reset', token, { keepName: 'Emilien' }), env);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.ok);

    // No visit: keys survive; the bot event is gone; Emilien's event remains.
    const surviving = [...kv.store.keys()];
    assert.ok(!surviving.some(k => k.startsWith('visit:')), 'all legacy visit: keys must be purged');
    assert.ok(surviving.includes('event:0000000001000:e1'), "Emilien's event is kept");
    assert.ok(!surviving.includes('event:0000000002000:e2'), "other user's event is deleted");
    // Emilien's legacy visit became a new login event → 2 surviving events total.
    const eventKeys = surviving.filter(k => k.startsWith('event:'));
    assert.equal(eventKeys.length, 2);
    assert.equal(kv.store.get('analytics:total_logins'), '2');
    assert.equal(kv.store.get('analytics:total_signups'), '0');
  });
});

// ── POST /api/track/visit — anonymous, dwell-gated visitor counter ────────────

describe('POST /api/track/visit', () => {
  const month = () => new Date().toISOString().slice(0, 7); // YYYY-MM (UTC)

  test('counts a visit without auth and increments the monthly counter', async () => {
    const { env, kv } = freshEnv();
    const res = await worker.fetch(r('POST', '/api/track/visit', { vid: 'visitor-a' }), env);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.counted, true);
    assert.equal(kv.store.get(`analytics:visits:${month()}`), '1');
  });

  test('same browser (vid) is counted at most once per month', async () => {
    const { env, kv } = freshEnv();
    await worker.fetch(r('POST', '/api/track/visit', { vid: 'dup' }), env);
    const res2 = await worker.fetch(r('POST', '/api/track/visit', { vid: 'dup' }), env);
    const body2 = await res2.json();
    assert.equal(body2.counted, false);
    assert.equal(kv.store.get(`analytics:visits:${month()}`), '1', 'counter must not double-count');
  });

  test('different browsers each add to the count', async () => {
    const { env, kv } = freshEnv();
    await worker.fetch(r('POST', '/api/track/visit', { vid: 'one' }), env);
    await worker.fetch(r('POST', '/api/track/visit', { vid: 'two' }), env);
    assert.equal(kv.store.get(`analytics:visits:${month()}`), '2');
  });

  test('missing vid still counts (best-effort, no dedup)', async () => {
    const { env, kv } = freshEnv();
    await worker.fetch(r('POST', '/api/track/visit', {}), env);
    assert.equal(kv.store.get(`analytics:visits:${month()}`), '1');
  });
});

// ── GET /api/analytics/events — exposes real monthly visitor counts ───────────

describe('GET /api/analytics/events monthlyVisits', () => {
  const month = () => new Date().toISOString().slice(0, 7);

  test('admin sees real visitor counts for the current month', async () => {
    const { env, kv, seedAdmin } = freshEnv();
    const { token } = seedAdmin();
    kv.store.set(`analytics:visits:${month()}`, '7');

    const res = await worker.fetch(authed('GET', '/api/analytics/events', token), env);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.visitsThisMonth, 7);
    assert.equal(body.monthlyVisits[month()], 7);
  });

  test('non-admin is refused', async () => {
    const { env, seedFree } = freshEnv();
    const { token } = seedFree();
    const res = await worker.fetch(authed('GET', '/api/analytics/events', token), env);
    assert.equal(res.status, 403);
  });
});
