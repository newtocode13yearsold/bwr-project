import { listKeys } from '../kv.js';
import { getUserFromToken } from '../auth-utils.js';
import { isBotUA, describeDevice } from './admin.js';

// ── Client-side error monitoring (homegrown, Sentry-lite) ────────────────────
// A global handler in public/js/errors.js beacons every uncaught error and
// unhandled promise rejection to POST /api/track/error. We group identical
// errors under one signature (so a bug that fires 1 000 times is one row with a
// count, not 1 000 rows), keep a small deduped log in KV, and fire a throttled
// ntfy.sh push the first time a signature appears (and again if it recurs after
// a quiet spell). The admin browses them in the "🐞 Erreurs JS" panel.
//
// Everything here is best-effort and must NEVER surface an error to a visitor:
// monitoring that breaks the page it monitors is worse than no monitoring.

const ERR_TTL      = 60 * 60 * 24 * 30;   // 30 days — old errors self-expire
const ALERT_COOLDOWN_MS = 6 * 60 * 60 * 1000; // re-alert a recurring error at most every 6 h
const MAX_MSG      = 500;
const MAX_STACK    = 4000;
const MAX_SOURCE   = 300;
const MAX_PAGE     = 120;

/** Tiny stable FNV-1a hash → 8-char hex. Good enough to group identical errors. */
function sig(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

const clean = (v, max) => (typeof v === 'string' ? v : '').replace(/\s+$/,'').slice(0, max);

// The first "at …" frame of a stack — the most stable part to group on (a line
// number in bundled code shifts between deploys, the function name rarely does).
function topFrame(stack) {
  if (!stack) return '';
  const m = stack.match(/\bat\s+[^\n]+/);
  return m ? m[0].slice(0, 200) : stack.split('\n')[0].slice(0, 200);
}

/**
 * Error-monitoring endpoints.
 * @param {Request} request
 * @param {import('../kv.js').Env} env
 * @param {{ pathname: string, json: Function, fail: Function, cors: Object, waitUntil: Function }} ctx
 * @returns {Promise<Response|null>}
 */
export async function handleErrors(request, env, { pathname, json, fail, cors, waitUntil }) {
  // ── Ingest one client error (PUBLIC — errors happen before/without login) ──
  if (pathname === '/api/track/error' && request.method === 'POST') {
    try {
      const body = await request.json().catch(() => ({}));
      const ua   = request.headers.get('user-agent') || '';

      // Drop bots hitting the endpoint directly — their "errors" are noise.
      if (isBotUA(ua)) return json({ ok: true, bot: true });

      const message = clean(body.message, MAX_MSG);
      if (!message) return json({ ok: true }); // nothing actionable

      const kind   = body.kind === 'unhandledrejection' ? 'unhandledrejection' : 'error';
      const stack  = clean(body.stack, MAX_STACK);
      const source = clean(body.source, MAX_SOURCE);
      const line   = Number.isFinite(body.line) ? Math.trunc(body.line) : null;
      const col    = Number.isFinite(body.col)  ? Math.trunc(body.col)  : null;
      let page = clean(body.page, MAX_PAGE).toLowerCase();
      if (!page || page[0] !== '/') page = '/';
      const device = describeDevice(ua);

      const signature = sig(`${kind}|${message}|${topFrame(stack)}|${page}`);
      const key = `errlog:${signature}`;
      const now = Date.now();
      const nowIso = new Date(now).toISOString();

      const existingRaw = await env.BWR_KV.get(key);
      const rec = existingRaw ? JSON.parse(existingRaw) : {
        sig: signature, kind, message, stack, source, line, col, page,
        device, count: 0, firstSeen: nowIso, lastSeen: nowIso, lastAlertAt: 0,
      };

      rec.count    = (rec.count || 0) + 1;
      rec.lastSeen = nowIso;
      // Keep the freshest sample details (device/stack can differ per hit).
      if (device) rec.device = device;
      if (stack)  rec.stack  = stack;

      // Alert the first time we see a signature, and again only if it recurs
      // after a quiet spell — so one flaky bug can't spam the phone.
      const shouldAlert = !existingRaw || (now - (rec.lastAlertAt || 0)) > ALERT_COOLDOWN_MS;
      if (shouldAlert) rec.lastAlertAt = now;

      await env.BWR_KV.put(key, JSON.stringify(rec), { expirationTtl: ERR_TTL });

      if (shouldAlert) {
        const where = source ? `${source}${line != null ? ':' + line : ''}` : page;
        const alert = () => fetch('https://ntfy.sh/bwr-ciril8596', {
          method: 'POST',
          headers: { 'Title': 'BWR — Erreur JS', 'Tags': 'bug', 'Priority': 'default',
                     'Content-Type': 'text/plain; charset=utf-8' },
          body: `${message}\n${where} · ${page}${device ? ' · ' + device : ''}` +
                (rec.count > 1 ? `\n(revenu · ${rec.count}× au total)` : ''),
        }).catch(() => {});
        if (waitUntil) waitUntil(alert()); else await alert();
      }

      return json({ ok: true });
    } catch {
      // Monitoring must never break a visitor's page.
      return json({ ok: true });
    }
  }

  // ── List errors (admin only) ─────────────────────────────────────────────
  if (pathname === '/api/errors' && request.method === 'GET') {
    const admin = await getUserFromToken(env, request);
    if (!admin || admin.role !== 'admin') return fail('Accès refusé.', 403);

    const keys   = await listKeys(env, 'errlog:');
    const values = await Promise.all(keys.map(k => env.BWR_KV.get(k.name)));
    const errors = values.filter(Boolean).map(v => JSON.parse(v))
      .sort((a, b) => new Date(b.lastSeen) - new Date(a.lastSeen));
    const total  = errors.reduce((n, e) => n + (e.count || 0), 0);
    return json({ errors, distinct: errors.length, total });
  }

  // ── Clear all errors (admin only) ────────────────────────────────────────
  if (pathname === '/api/errors' && request.method === 'DELETE') {
    const admin = await getUserFromToken(env, request);
    if (!admin || admin.role !== 'admin') return fail('Accès refusé.', 403);
    const keys = await listKeys(env, 'errlog:');
    await Promise.all(keys.map(k => env.BWR_KV.delete(k.name)));
    return json({ ok: true, cleared: keys.length });
  }

  // ── Delete / resolve one error (admin only) ──────────────────────────────
  if (pathname.startsWith('/api/errors/') && request.method === 'DELETE') {
    const admin = await getUserFromToken(env, request);
    if (!admin || admin.role !== 'admin') return fail('Accès refusé.', 403);
    const signature = decodeURIComponent(pathname.slice('/api/errors/'.length)).slice(0, 64);
    if (!signature) return fail('Signature manquante.');
    await env.BWR_KV.delete(`errlog:${signature}`);
    return json({ ok: true });
  }

  return null;
}
