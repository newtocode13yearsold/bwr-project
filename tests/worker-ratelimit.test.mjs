// Unit tests for the generic fixed-window rate limiter (worker/auth-utils.js).
//
// These specifically guard the "banned forever" regression: the limiter used to
// rely on the KV key EXPIRING to reset the window, but re-`put` the key with
// `expirationTtl: undefined`, which Cloudflare treats as "no expiry" — so the
// counter became permanent and the caller was blocked forever. The fix stores
// the window end time (`resetAt`) inside the value and resets the count once it
// passes. The old test KV mock ignored TTL entirely, which is exactly why the
// original bug was invisible, so this mock models both TTL expiry AND a
// controllable clock to prove the reset works without depending on TTL.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { checkRateLimit } from '../worker/auth-utils.js';

// Time-aware KV mock: honours expirationTtl (stores an absolute expiry and drops
// the key on get() once passed) and reads a shared `clock` so tests can advance
// time deterministically.
function makeTimedKV(clock) {
  const store = new Map(); // key → { value, expiresAt|null }
  return {
    async get(key) {
      const rec = store.get(key);
      if (!rec) return null;
      if (rec.expiresAt != null && rec.expiresAt <= clock.now) {
        store.delete(key);
        return null;
      }
      return rec.value;
    },
    async put(key, value, opts = {}) {
      const expiresAt = opts.expirationTtl != null
        ? clock.now + opts.expirationTtl * 1000
        : null;
      store.set(key, { value, expiresAt });
    },
    async delete(key) { store.delete(key); },
  };
}

describe('checkRateLimit', () => {
  test('allows up to the limit, then blocks within the window', async () => {
    const clock = { now: 1_000_000 };
    const env = { BWR_KV: makeTimedKV(clock) };

    assert.equal(await checkRateLimit(env, 'contact', '1.1.1.1', 2, 3600), true);
    assert.equal(await checkRateLimit(env, 'contact', '1.1.1.1', 2, 3600), true);
    assert.equal(await checkRateLimit(env, 'contact', '1.1.1.1', 2, 3600), false);
  });

  test('resets once the window elapses — caller is NOT banned forever', async () => {
    const clock = { now: 1_000_000 };
    const env = { BWR_KV: makeTimedKV(clock) };

    // Exhaust the 2/hour contact limit.
    assert.equal(await checkRateLimit(env, 'contact', '2.2.2.2', 2, 3600), true);
    assert.equal(await checkRateLimit(env, 'contact', '2.2.2.2', 2, 3600), true);
    assert.equal(await checkRateLimit(env, 'contact', '2.2.2.2', 2, 3600), false);

    // Advance past the window end.
    clock.now += 3600 * 1000 + 1;

    // The window must reset and allow requests again.
    assert.equal(await checkRateLimit(env, 'contact', '2.2.2.2', 2, 3600), true,
      'window should reset after windowSeconds — the "banned forever" bug');
    assert.equal(await checkRateLimit(env, 'contact', '2.2.2.2', 2, 3600), true);
    assert.equal(await checkRateLimit(env, 'contact', '2.2.2.2', 2, 3600), false);
  });

  test('the stored value always carries a TTL, so the key can never outlive its window', async () => {
    const clock = { now: 500 };
    let lastOpts = null;
    const base = makeTimedKV(clock);
    const env = { BWR_KV: { ...base, async put(k, v, opts) { lastOpts = opts; return base.put(k, v, opts); } } };

    await checkRateLimit(env, 'signup', '3.3.3.3', 5, 3600); // first write
    assert.ok(lastOpts && lastOpts.expirationTtl > 0, 'first write must set a TTL');

    await checkRateLimit(env, 'signup', '3.3.3.3', 5, 3600); // second write (the old bug spot)
    assert.ok(lastOpts && lastOpts.expirationTtl > 0,
      'subsequent writes must NOT pass expirationTtl:undefined (that made keys permanent)');
  });

  test('mid-window requests keep the same resetAt (window does not slide)', async () => {
    const clock = { now: 0 };
    const env = { BWR_KV: makeTimedKV(clock) };

    await checkRateLimit(env, 'forum', 'u1', 10, 3600);
    clock.now += 1800 * 1000; // half-way through
    const raw = await env.BWR_KV.get('ratelimit:forum:u1');
    const resetAt = JSON.parse(raw).resetAt;
    await checkRateLimit(env, 'forum', 'u1', 10, 3600);
    const raw2 = await env.BWR_KV.get('ratelimit:forum:u1');
    assert.equal(JSON.parse(raw2).resetAt, resetAt, 'resetAt must be stable within a window');
  });

  test('tolerates a legacy bare-integer value (old format) by starting a fresh window', async () => {
    const clock = { now: 0 };
    const env = { BWR_KV: makeTimedKV(clock) };
    await env.BWR_KV.put('ratelimit:contact:legacy', '1', { expirationTtl: 3600 });
    // Should not throw on the old integer shape; treats it as a fresh window.
    assert.equal(await checkRateLimit(env, 'contact', 'legacy', 2, 3600), true);
  });
});
