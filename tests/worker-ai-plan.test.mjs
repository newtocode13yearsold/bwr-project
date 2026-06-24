// AI route-planner endpoint tests (POST /api/ai-plan) — Node 18+ (ESM).
//
// The endpoint asks Claude (via the Anthropic Messages API) to turn a free-text
// request into structured planner controls. We stub global fetch so no real
// network call is made, and assert auth, validation, quota and parsing.

import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker.js';

// ── Mock KV (mirrors the subset of the Cloudflare KV API the worker uses) ──────
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

// Optional Workers AI mock: env.AI.run returns the given structured object.
function makeAi(responseObj) {
  return { run: async () => ({ response: responseObj }) };
}

function freshEnv({ plan = 'free', apiKey = 'test-key', ai = undefined } = {}) {
  const kv = makeMockKV();
  const env = { BWR_KV: kv, ...(apiKey ? { ANTHROPIC_API_KEY: apiKey } : {}), ...(ai ? { AI: ai } : {}) };
  const userId = 'u1';
  const token = 'sess-token-1';
  kv.store.set(`user:${userId}`, JSON.stringify({
    id: userId, name: 'Tester', email: 't@bwr.fr', plan, role: plan, stats: { routes: 0, km: 0 },
  }));
  kv.store.set(`uemail:t@bwr.fr`, userId);
  kv.store.set(`session:${token}`, JSON.stringify({ userId, expiresAt: new Date(Date.now() + 1e9).toISOString() }));
  return { env, kv, token };
}

const aiReq = (token, text) => new Request('https://bwr.test/api/ai-plan', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  body: JSON.stringify({ text }),
});

// Stub the Anthropic Messages API response (tool_use block with given input).
function stubAnthropic(input) {
  globalThis.fetch = async () => new Response(JSON.stringify({
    content: [{ type: 'tool_use', name: 'set_route_plan', input }],
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

describe('POST /api/ai-plan', () => {
  test('no auth → 401', async () => {
    const { env } = freshEnv();
    const res = await worker.fetch(aiReq(null, 'boucle de 10 km'), env);
    assert.equal(res.status, 401);
  });

  test('text too short → 400', async () => {
    const { env, token } = freshEnv();
    const res = await worker.fetch(aiReq(token, 'a'), env);
    assert.equal(res.status, 400);
  });

  test('no AI engine at all (no key, no Workers AI) → 503', async () => {
    const { env, token } = freshEnv({ apiKey: null });
    const res = await worker.fetch(aiReq(token, 'boucle de 10 km'), env);
    assert.equal(res.status, 503);
  });

  test('Workers AI is used first — no Anthropic key needed', async () => {
    // Fail the test if any outbound fetch happens (Anthropic must NOT be called).
    globalThis.fetch = async () => { throw new Error('fetch should not be called'); };
    const { env, token } = freshEnv({
      apiKey: null,
      ai: makeAi({
        understood: true, mode: 'loop', distanceKm: 12, transport: 'foot',
        pathType: 'foot', difficulty: 'easy', startPlace: null, endPlace: null,
        summary: 'Boucle facile de 12 km', reply: 'Je te prépare une boucle de 12 km 🌲',
      }),
    });
    const res = await worker.fetch(aiReq(token, 'une boucle de 12 km'), env);
    assert.equal(res.status, 200);
    const { plan, understood, reply } = await res.json();
    assert.equal(plan.distanceKm, 12);
    assert.equal(understood, true);
    assert.match(reply, /12 km/);
  });

  test('Workers AI returning a JSON string is parsed', async () => {
    globalThis.fetch = async () => { throw new Error('fetch should not be called'); };
    const { env, token } = freshEnv({
      apiKey: null,
      ai: { run: async () => ({ response: JSON.stringify({
        understood: true, mode: 'loop', transport: 'bike', pathType: 'bike',
        difficulty: 'hard', distanceKm: 40, summary: 'Grande sortie vélo', reply: 'En selle ! 🚴',
      }) }) },
    });
    const res = await worker.fetch(aiReq(token, 'un gros tour en vélo'), env);
    assert.equal(res.status, 200);
    const { plan } = await res.json();
    assert.equal(plan.transport, 'bike');
    assert.equal(plan.distanceKm, 40);
  });

  test('falls back to Anthropic when Workers AI throws', async () => {
    const { env, token } = freshEnv({
      apiKey: 'test-key',
      ai: { run: async () => { throw new Error('Workers AI down'); } },
    });
    stubAnthropic({ understood: true, mode: 'loop', distanceKm: 10, transport: 'foot', pathType: 'foot', difficulty: 'easy', summary: 'x', reply: 'ok' });
    const res = await worker.fetch(aiReq(token, 'boucle de 10 km'), env);
    assert.equal(res.status, 200);
    const { plan } = await res.json();
    assert.equal(plan.distanceKm, 10);
  });

  test('valid request → 200 with sanitized plan + conversational reply', async () => {
    const { env, token } = freshEnv();
    stubAnthropic({
      understood: true, mode: 'loop', distanceKm: 23, transport: 'foot', pathType: 'foot',
      difficulty: 'medium', startPlace: 'les étangs Saint-Pierre', endPlace: null,
      summary: 'Boucle de 23 km par les étangs Saint-Pierre',
      reply: 'C\'est parti pour une boucle de 23 km par les étangs Saint-Pierre !',
    });
    const res = await worker.fetch(aiReq(token, 'une boucle de 23 km par les étangs saint pierre'), env);
    assert.equal(res.status, 200);
    const { plan, understood, reply } = await res.json();
    assert.equal(plan.mode, 'loop');
    assert.equal(plan.distanceKm, 23);
    assert.equal(plan.startPlace, 'les étangs Saint-Pierre');
    assert.equal(plan.transport, 'foot');
    assert.equal(understood, true);
    assert.match(reply, /étangs Saint-Pierre/);
  });

  test('vague request still yields a usable plan (no hard fail)', async () => {
    const { env, token } = freshEnv();
    stubAnthropic({
      understood: true, mode: 'loop', distanceKm: 8, transport: 'foot', pathType: 'foot',
      difficulty: 'easy', summary: 'Petite boucle facile de 8 km',
      reply: 'Je te prépare une petite boucle tranquille 🌲',
    });
    const res = await worker.fetch(aiReq(token, 'envie de marcher un peu'), env);
    assert.equal(res.status, 200);
    const { plan, understood } = await res.json();
    assert.equal(understood, true);
    assert.equal(plan.distanceKm, 8);
    assert.equal(plan.difficulty, 'easy');
  });

  test('off-topic request → understood:false with a friendly reply', async () => {
    const { env, token } = freshEnv();
    stubAnthropic({
      understood: false, mode: 'loop', transport: 'foot', pathType: 'foot',
      difficulty: 'easy', summary: 'Hors-sujet',
      reply: 'Je m\'occupe surtout de tes balades en forêt ! Dis-moi la distance que tu cherches 🌲',
    });
    const res = await worker.fetch(aiReq(token, 'quelle est la météo demain ?'), env);
    assert.equal(res.status, 200);
    const { understood, reply } = await res.json();
    assert.equal(understood, false);
    assert.match(reply, /balades/);
  });

  test('out-of-range distance is clamped to 1–100', async () => {
    const { env, token } = freshEnv();
    stubAnthropic({ mode: 'loop', distanceKm: 999, transport: 'foot', pathType: 'foot', difficulty: 'easy', summary: 'x' });
    const res = await worker.fetch(aiReq(token, 'une boucle gigantesque'), env);
    const { plan } = await res.json();
    assert.equal(plan.distanceKm, 100);
  });

  test('bad enum values fall back to safe defaults', async () => {
    const { env, token } = freshEnv();
    stubAnthropic({ mode: 'spiral', transport: 'rocket', pathType: 'lava', difficulty: 'extreme', summary: 'x' });
    const res = await worker.fetch(aiReq(token, 'quelque chose de bizarre'), env);
    const { plan } = await res.json();
    assert.equal(plan.mode, 'loop');
    assert.equal(plan.transport, 'foot');
    assert.equal(plan.pathType, 'foot');
    assert.equal(plan.difficulty, 'easy');
  });

  test('Anthropic API error → 502', async () => {
    const { env, token } = freshEnv();
    globalThis.fetch = async () => new Response('nope', { status: 500 });
    const res = await worker.fetch(aiReq(token, 'boucle de 10 km'), env);
    assert.equal(res.status, 502);
  });

  test('free plan: third request in the window → 429 (2 free uses)', async () => {
    const { env, token } = freshEnv({ plan: 'free' });
    stubAnthropic({ mode: 'loop', distanceKm: 10, transport: 'foot', pathType: 'foot', difficulty: 'easy', summary: 'x' });
    assert.equal((await worker.fetch(aiReq(token, 'boucle 1'), env)).status, 200);
    assert.equal((await worker.fetch(aiReq(token, 'boucle 2'), env)).status, 200);
    assert.equal((await worker.fetch(aiReq(token, 'boucle 3'), env)).status, 429);
  });

  test('silver plan: more than 2 requests still allowed', async () => {
    const { env, token } = freshEnv({ plan: 'silver' });
    stubAnthropic({ mode: 'loop', distanceKm: 10, transport: 'foot', pathType: 'foot', difficulty: 'easy', summary: 'x' });
    for (let i = 0; i < 5; i++) {
      assert.equal((await worker.fetch(aiReq(token, `boucle ${i}`), env)).status, 200);
    }
  });
});
