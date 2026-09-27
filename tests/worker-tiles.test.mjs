// Basemap tile-proxy tests (worker/handlers/tiles.js).
//
// Why these matter: the proxy is what makes IGN the licence-clean default
// basemap. tile.openstreetmap.org and OpenTopoMap are donation-funded volunteer
// servers whose usage policies exclude heavy/commercial use, so a regression
// that quietly sends the default layer back to them is a licensing problem, not
// just a cosmetic one. These tests pin:
//   • /tiles/ign/…  → IGN "Plan IGN v2" on data.geopf.fr
//   • /tiles/topo/… → OpenTopoMap (kept as an optional extra style)
//   • the two use SEPARATE edge-cache namespaces, so switching a route's
//     upstream can never serve 30-day-old imagery from the other source
//   • coordinate validation still rejects junk that would poison the cache
//
// `caches` is undefined under the Node test runner, so the handler's cache
// branches are skipped and every request goes straight to the stubbed fetch —
// which is exactly what we want to assert on.

import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { handleTiles } from '../worker/handlers/tiles.js';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

/** Stub fetch, recording every upstream URL the handler asks for. */
function stubFetch({ status = 200, body = 'PNG' } = {}) {
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return new Response(body, { status, headers: { 'Content-Type': 'image/png' } });
  };
  return calls;
}

const ctx = (pathname) => ({ pathname, waitUntil: undefined });
const get = (pathname) => handleTiles(new Request(`https://bwr.test${pathname}`), {}, ctx(pathname));

describe('tile proxy — routing', () => {
  test('/tiles/ign/… fetches IGN Plan IGN v2 from the Géoplateforme', async () => {
    const calls = stubFetch();
    const res = await get('/tiles/ign/13/4161/2801.png');
    assert.equal(res.status, 200);
    assert.equal(calls.length, 1);
    assert.match(calls[0], /^https:\/\/data\.geopf\.fr\/wmts\?/);
    assert.match(calls[0], /LAYER=GEOGRAPHICALGRIDSYSTEMS\.PLANIGNV2/);
    // WMTS carries the tile coords in the query string, row = y, col = x.
    assert.match(calls[0], /TILEMATRIX=13/);
    assert.match(calls[0], /TILEROW=2801/);
    assert.match(calls[0], /TILECOL=4161/);
  });

  test('/tiles/ign/… never touches an OSM-Foundation or OpenTopoMap server', async () => {
    const calls = stubFetch();
    await get('/tiles/ign/13/4161/2801.png');
    for (const u of calls) {
      assert.ok(!u.includes('tile.openstreetmap.org'), `default basemap must not hit OSMF tiles: ${u}`);
      assert.ok(!u.includes('opentopomap.org'), `default basemap must not hit OpenTopoMap: ${u}`);
    }
  });

  test('/tiles/topo/… still serves OpenTopoMap', async () => {
    const calls = stubFetch();
    const res = await get('/tiles/topo/13/4161/2801.png');
    assert.equal(res.status, 200);
    assert.match(calls[0], /^https:\/\/[abc]\.tile\.opentopomap\.org\/13\/4161\/2801\.png$/);
  });

  test('a non-tile path is not ours — returns null so the router continues', async () => {
    assert.equal(await get('/api/paths'), null);
    assert.equal(await get('/tiles/topo/13/4161/2801.jpg'), null);
  });

  test('an unknown tile source returns null rather than proxying anywhere', async () => {
    globalThis.fetch = async () => { throw new Error('must not fetch an unknown source'); };
    assert.equal(await get('/tiles/evil/13/4161/2801.png'), null);
    assert.equal(await get('/tiles/satellite/13/4161/2801.png'), null);
  });
});

describe('tile proxy — validation', () => {
  test('rejects out-of-range tile coords (cache-poisoning guard)', async () => {
    globalThis.fetch = async () => { throw new Error('must not fetch an invalid tile'); };
    // At z=2 there are only 4×4 tiles, so x=9 is out of range.
    assert.equal((await get('/tiles/ign/2/9/1.png')).status, 400);
    assert.equal((await get('/tiles/ign/2/1/9.png')).status, 400);
  });

  test('rejects a zoom beyond what the source serves', async () => {
    globalThis.fetch = async () => { throw new Error('must not fetch an invalid tile'); };
    assert.equal((await get('/tiles/ign/20/1/1.png')).status, 400);
  });

  test('rejects non-GET methods', async () => {
    const res = await handleTiles(
      new Request('https://bwr.test/tiles/ign/13/4161/2801.png', { method: 'POST' }),
      {}, ctx('/tiles/ign/13/4161/2801.png'),
    );
    assert.equal(res.status, 405);
  });

  test('passes an upstream error status through without caching it', async () => {
    stubFetch({ status: 404, body: 'nope' });
    const res = await get('/tiles/ign/13/4161/2801.png');
    assert.equal(res.status, 404);
  });
});

describe('tile proxy — response headers', () => {
  test('serves a long-lived, CORS-open, image/png response', async () => {
    stubFetch();
    const res = await get('/tiles/ign/13/4161/2801.png');
    assert.equal(res.headers.get('Content-Type'), 'image/png');
    assert.equal(res.headers.get('Access-Control-Allow-Origin'), '*');
    assert.match(res.headers.get('Cache-Control'), /max-age=2592000/);
  });
});
