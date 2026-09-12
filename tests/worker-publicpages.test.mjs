// Public, SEO-indexable page tests (server-rendered HTML on the same Worker).
// Covers: curated trail pages (/balade/:slug), shared route pages (/r/:token),
// canonical-slug redirect, 404s, and the dynamic sitemap.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker.js';
import { slugify, trailPath } from '../worker/handlers/publicpages.js';

function makeMockKV() {
  const store = new Map();
  return {
    store,
    async get(key)        { return store.get(key) ?? null; },
    async put(key, value) { store.set(key, value); },
    async delete(key)     { store.delete(key); },
    async list({ prefix = '', limit = 1000 } = {}) {
      const keys = [];
      for (const k of store.keys()) if (k.startsWith(prefix)) keys.push({ name: k });
      const page = keys.slice(0, limit);
      return { keys: page, list_complete: page.length === keys.length };
    },
  };
}

// Minimal ASSETS stub returning a base sitemap so the injector has something to splice.
const BASE_SITEMAP = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://bwrmaps.com/</loc></url>
</urlset>`;

function freshEnv() {
  const kv = makeMockKV();
  const env = {
    BWR_KV: kv,
    ASSETS: { async fetch() { return new Response(BASE_SITEMAP, { headers: { 'Content-Type': 'application/xml' } }); } },
  };
  return { kv, env };
}

const get = (path) => new Request(`https://bwrmaps.com${path}`, { method: 'GET' });

// ── Trail pages ────────────────────────────────────────────────────────────

describe('GET /balade/:slug (curated trail)', () => {
  test('renders a crawlable page with content + canonical + JSON-LD', async () => {
    const { kv, env } = freshEnv();
    const tour = {
      id: 'a1b2c3d4-1111-2222-3333-444455556666',
      name: 'Boucle des Beaux Monts',
      description: 'Une superbe boucle en forêt.',
      distance: 11, difficulty: 'medium', type: 'foot',
      startAddress: 'Parking du Carrefour Royal',
      createdAt: '2026-01-01T00:00:00Z',
    };
    kv.store.set(`besttour:${tour.id}`, JSON.stringify(tour));

    const res = await worker.fetch(get(trailPath(tour)), env, {});
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /Boucle des Beaux Monts/);
    assert.match(html, /Une superbe boucle/);
    assert.match(html, /<link rel="canonical" href="https:\/\/bwrmaps\.com\/balade\/boucle-des-beaux-monts-a1b2c3d4"/);
    assert.match(html, /index, follow/);
    assert.match(html, /application\/ld\+json/);
    assert.match(html, /TouristTrip/);
    assert.match(res.headers.get('Content-Security-Policy') || '', /script-src 'self'/);
  });

  test('redirects a stale slug to the canonical URL (same id)', async () => {
    const { kv, env } = freshEnv();
    const tour = { id: 'deadbeef-0000-0000-0000-000000000000', name: 'Nouveau Nom', createdAt: '2026-01-01T00:00:00Z' };
    kv.store.set(`besttour:${tour.id}`, JSON.stringify(tour));

    const res = await worker.fetch(get('/balade/ancien-nom-deadbeef'), env, {});
    assert.equal(res.status, 301);
    assert.equal(res.headers.get('Location'), 'https://bwrmaps.com/balade/nouveau-nom-deadbeef');
  });

  test('404 for an unknown trail id', async () => {
    const { env } = freshEnv();
    const res = await worker.fetch(get('/balade/pas-de-balade-00000000'), env, {});
    assert.equal(res.status, 404);
  });

  test('404 for a slug with no id suffix', async () => {
    const { env } = freshEnv();
    const res = await worker.fetch(get('/balade/juste-un-slug'), env, {});
    assert.equal(res.status, 404);
  });
});

// ── Shared route pages ───────────────────────────────────────────────────────

describe('GET /r/:token (shared route)', () => {
  test('renders the route with embedded coords + map script', async () => {
    const { kv, env } = freshEnv();
    const userId = 'u1', routeId = 'route-1', token = 'abc123token';
    const route = {
      id: routeId, userId, name: 'Ma boucle test',
      coords: [[49.35, 2.90], [49.36, 2.91], [49.37, 2.92]],
      meters: 5400, seconds: 3600, difficulty: 'easy', pathType: 'foot', mode: 'loop',
    };
    kv.store.set(`savedroute:${userId}:${routeId}`, JSON.stringify(route));
    kv.store.set(`routeshare:${token}`, JSON.stringify({ userId, routeId }));

    const res = await worker.fetch(get(`/r/${token}`), env, {});
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /Ma boucle test/);
    assert.match(html, /5\.4 km/);
    assert.match(html, /id="bwr-route"/);
    assert.match(html, /49\.35/);            // coords embedded as JSON
    assert.match(html, /public-route-map\.js/);
    assert.match(html, /canonical" href="https:\/\/bwrmaps\.com\/r\/abc123token"/);
  });

  test('404 for an unknown/expired token', async () => {
    const { env } = freshEnv();
    const res = await worker.fetch(get('/r/nope'), env, {});
    assert.equal(res.status, 404);
  });

  test('rejects a malformed token', async () => {
    const { env } = freshEnv();
    const res = await worker.fetch(get('/r/has spaces!'), env, {});
    assert.equal(res.status, 404);
  });
});

// ── Sitemap ───────────────────────────────────────────────────────────────

describe('GET /sitemap.xml', () => {
  test('injects a <url> for every curated trail', async () => {
    const { kv, env } = freshEnv();
    kv.store.set('besttour:aaaaaaaa-0000-0000-0000-000000000000',
      JSON.stringify({ id: 'aaaaaaaa-0000-0000-0000-000000000000', name: 'Trail Un', updatedAt: '2026-05-05T10:00:00Z' }));

    const res = await worker.fetch(get('/sitemap.xml'), env, {});
    assert.equal(res.status, 200);
    assert.match(res.headers.get('Content-Type') || '', /xml/);
    const xml = await res.text();
    assert.match(xml, /<loc>https:\/\/bwrmaps\.com\/<\/loc>/);             // base preserved
    assert.match(xml, /\/balade\/trail-un-aaaaaaaa/);                      // trail injected
    assert.match(xml, /<lastmod>2026-05-05<\/lastmod>/);
    assert.match(xml, /<\/urlset>/);
  });
});

// ── Helpers ─────────────────────────────────────────────────────────────────

describe('slug helpers', () => {
  test('slugify strips accents and punctuation', () => {
    assert.equal(slugify('Forêt de Compiègne — Boucle #1'), 'foret-de-compiegne-boucle-1');
  });
  test('trailPath appends the 8-hex id prefix', () => {
    assert.equal(trailPath({ id: '12345678-abcd-0000-0000-000000000000', name: 'Test' }), '/balade/test-12345678');
  });
});
