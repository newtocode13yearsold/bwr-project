import { handleAdmin }      from './worker/handlers/admin.js';
import { handleAuth }       from './worker/handlers/auth.js';
import { handlePaths }      from './worker/handlers/paths.js';
import { handleReports }    from './worker/handlers/reports.js';
import { handleContent }    from './worker/handlers/content.js';
import { handleSavedRoutes } from './worker/handlers/savedroutes.js';
import { handleSocial }     from './worker/handlers/social.js';
import { handleForum }      from './worker/handlers/forum.js';
import { handlePush }       from './worker/handlers/push.js';

const ALLOWED_ORIGINS = new Set([
  'https://bwrmaps.com',
  'https://www.bwrmaps.com',
  'https://bwr-worker.ciril8596.workers.dev',
  'http://localhost:8787',
]);

// Cloudflare Pages preview deployments (*.pages.dev) are also allowed
const isAllowedOrigin = o => ALLOWED_ORIGINS.has(o) || /^https:\/\/[^.]+\.pages\.dev$/.test(o);

/**
 * @typedef {{ BWR_KV: KVNamespace, ORS_KEY?: string, ANTHROPIC_API_KEY?: string,
 *             RESEND_API_KEY?: string, RESEND_FROM?: string,
 *             ADMIN_NAME?: string, ADMIN_EMAIL?: string, AI?: Ai,
 *             VAPID_PUBLIC_KEY?: string, VAPID_PRIVATE_KEY?: string, VAPID_SUBJECT?: string,
 *             ASSETS: Fetcher }} Env
 */

export default {
  /**
   * Main HTTP handler — dispatches to focused route-group modules.
   * Each handler returns a Response or null; first non-null wins.
   * @param {Request} request
   * @param {Env} env
   * @param {ExecutionContext} [execCtx]
   * @returns {Promise<Response>}
   */
  async fetch(request, env, execCtx) {
    const url      = new URL(request.url);

    // Canonical host: 301 every non-primary host (www + the legacy workers.dev
    // URL) to the apex bwrmaps.com so there's a single indexed site. Runs on
    // every request because run_worker_first is enabled (see wrangler.jsonc).
    if (url.hostname === 'www.bwrmaps.com' ||
        url.hostname === 'bwr-worker.ciril8596.workers.dev') {
      url.hostname = 'bwrmaps.com';
      url.port = '';
      return Response.redirect(url.toString(), 301);
    }

    const pathname = url.pathname;
    const origin   = request.headers.get('Origin') ?? '';
    const allowedOrigin = isAllowedOrigin(origin)
      ? origin
      : 'https://bwrmaps.com';

    const cors = {
      'Access-Control-Allow-Origin':  allowedOrigin,
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Vary': 'Origin',
      'X-Frame-Options': 'DENY',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'Permissions-Policy': 'geolocation=(self)',
      'Strict-Transport-Security': 'max-age=31536000; includeSubDomains; preload',
    };

    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });

    /** @param {unknown} data @param {number} [status] */
    const json = (data, status = 200) =>
      new Response(JSON.stringify(data), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

    /** @param {string} msg @param {number} [status] */
    const fail = (msg, status = 400) =>
      new Response(JSON.stringify({ error: msg }), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

    // waitUntil lets handlers run best-effort background work (e.g. the hazard
    // push fan-out) without blocking the response. Falls back to detached
    // execution when no ExecutionContext is provided (e.g. unit tests).
    const waitUntil = execCtx && execCtx.waitUntil
      ? p => execCtx.waitUntil(p)
      : p => { Promise.resolve(p).catch(() => {}); };

    const ctx = { pathname, url, json, fail, cors, waitUntil };

    const apiResponse =
      await handleAdmin(request, env, ctx)      ??
      await handleAuth(request, env, ctx)        ??
      await handlePaths(request, env, ctx)       ??
      await handleReports(request, env, ctx)     ??
      await handleContent(request, env, ctx)     ??
      await handleSavedRoutes(request, env, ctx) ??
      await handleSocial(request, env, ctx)      ??
      await handleForum(request, env, ctx)       ??
      await handlePush(request, env, ctx);

    if (apiResponse) return apiResponse;

    // Unmatched /api/* is a genuine 404; anything else is a static-asset
    // request — hand it to the assets binding (the Worker runs first now).
    if (pathname.startsWith('/api/')) {
      return new Response('Not found', { status: 404, headers: cors });
    }
    return env.ASSETS.fetch(request);
  },
};
