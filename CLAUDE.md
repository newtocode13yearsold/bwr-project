# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

BWR (Balades en Foret de Compiegne) is a progressive web app for interactive forest path mapping and route planning in the Compiegne forest, France. It combines a serverless backend (Cloudflare Workers) with a vanilla JavaScript frontend (Leaflet maps). The app supports three user tiers (free/silver/gold) with gamification (badges, daily challenges) and crowd-sourced problem reporting.

## Development Commands

Start local dev server (runs on http://localhost:8787):
  npm run dev:worker

Deploy to Cloudflare Workers (requires authentication):
  npm run deploy:worker

Run all automated tests (260 tests, ~3 s):
  npm test

Run tests in watch mode (re-runs on file save):
  npm run test:watch

Create KV namespace (one-time setup):
  npm run kv:create BWR_KV

Note: Frontend is static HTML/JS/CSS served directly by the worker—no build step required.

## Architecture

### Backend (worker.js + worker/ modules)

`worker.js` is a thin dispatcher: it builds the CORS/JSON helpers, then tries each
route-group handler in order (first non-null `Response` wins). The actual endpoint
logic lives in `worker/handlers/` (admin, auth, paths, reports, content, savedroutes,
social), with shared helpers in `worker/kv.js` (KV get/put + `effectivePlan`) and
`worker/auth-utils.js` (password hashing, session lookup, rate limiting, email).

When adding an endpoint, put it in the matching handler module — do **not** grow
`worker.js`. Each handler receives `(request, env, ctx)` where `ctx` carries
`{ pathname, url, json, fail, cors }`.

Main endpoint groups:

- Auth: /api/setup (one-time admin creation), /api/auth/{register,login,logout,me,profile,password,account}, /api/auth/plan/:userId (admin plan changes), /api/auth/stats, /api/auth/consume-route (free weekly quota), /api/auth/wheel-prize
- Email verification: GET /api/auth/verify?token=… (activate account), POST /api/auth/resend-verification (re-send link, rate-limited 5 min)
- Password reset: POST /api/auth/forgot-password (email a reset link — always 200, no account enumeration; IP rate-limited 5/h + per-address 5-min cooldown), POST /api/auth/reset-password ({token, password} — single-use `reset:{token}` KV key, 1-hour TTL; rotates salt+hash, sets `sessionsInvalidatedAt`, clears login lockout)
- Paths (admin-only): POST/PUT/DELETE /api/paths/* — forest/bike paths curated by admin
- Reports (public): POST /api/reports, DELETE /api/reports/:id (admin), GET /api/reports — crowd-sourced issues (fallen trees, floods, etc.)
- Routing: POST /api/route — proxy to OpenRouteService (needs ORS_KEY env var)
- OSM Proxy: GET /api/osm?bbox=... — caches OpenStreetMap path data for 7 days
- Contact: POST /api/contact — sends to ntfy.sh push notification service
- Saved routes (Silver+): POST /api/savedroutes, GET /api/savedroutes, GET /api/savedroutes/:id, DELETE /api/savedroutes/:id
- Share route (public): GET /api/savedroutes/share/:token — returns route by share token, no auth required

Storage: Cloudflare KV with granular per-item keys (no shared arrays):
- user:{id} — JSON user object
- uemail:{email} — userId string (email index for O(1) login lookup)
- pending:{token} — JSON pending registration (24-hour TTL); deleted on verify
- pemail:{email} — token string (pending-registration email index, 24-hour TTL)
- path:{id} — JSON path object
- report:{id} — JSON report object
- photo:{reportId} — data-URI string, 90-day TTL
- contact:{id} — JSON contact message
- session:{token} — session metadata (userId, expiresAt), 30-day TTL
- reset:{token} — JSON {userId, expiresAt}, 1-hour TTL; single-use password-reset link, deleted on use
- osm:{bbox} — cached OpenStreetMap query results, 7-day TTL
- savedroute:{userId}:{id} — JSON saved route (coords, stats, name, shareToken, etc.)
- routeshare:{token} — JSON {userId, routeId}, 180-day TTL; maps share token → route

Migration: POST /api/migrate (admin only) migrates legacy array keys (users/paths/reports/contact_messages) to granular keys. Run once after deploy.

### Frontend Architecture

Pages (all require authentication except login.html):
- map.html + js/map.js: Browse all paths, filter by status (easy/medium/hard/blocked), report issues, view carrefours (named junctions)
- routes.html + js/routes.js: Core UX—interactive route planner with mode selection (A→B or loop), difficulty picker, address search
- profile.html + js/profile.js: User stats, achievements/badges, daily wheel (random hiking tips), custom goals, weather (gold tier only), avatar color picker
- admin.html + js/admin.js: Path management (draw, import from OSM, split, edit, delete), report triage, color/status updates
- login.html + js/login.js: Registration and login forms

Shared modules:
- js/config.js — API endpoint, map center/zoom, status colors
- js/auth.js — Bearer token management, session persistence, role-based access
- js/carrefours.js — Hardcoded junction names (zero network cost)
- sw.js — Service worker (network-first for HTML/JS/CSS, cache-first for assets, always network for API/tiles)

### Route Planning System (Three-Tier Fallback)

The routes.html page uses three routing engines in order of preference:

1. Graph Router (`public/js/graph-router.js`, also unit-tested in `tests/graph-router.test.js`): Uses only admin-curated paths to guarantee forest-only, no-backtrack loops
   - Builds undirected graph from path coordinates (nodes at 0.00001° precision)
   - Connects path endpoints within 80m to form network
   - Uses Dijkstra for A→B; removes outbound edges for loop return (guarantees different route back)
   - Falls back if < 4 nodes or target distance unmatchable

2. OpenRouteService (ORS): Premium API requiring ORS_KEY Cloudflare environment variable
   - Supports round_trip mode (length, points, seed parameters)
   - Returns full route geometry with distance/duration
   - Falls back if key missing or API errors

3. OSRM (Open Source Routing Machine): Free public API (no key), always available
   - For loops: generates 8 compass-point waypoints around start (radius adjusts on retry for target distance)
   - For A→B: simple point-to-point routing
   - Includes all road types (not forest-only like graph router)

Route colors reflect difficulty (stored locally in localStorage):
- Green (#22c55e): Easy
- Orange (#f97316): Medium
- Red (#ef4444): Hard
- Gray (#9ca3af): Impassable

### User Plans and Features

Three tiers gate different features:
- Free: Basic route planning, view all paths, report issues, basic badges
- Silver: plus daily wheel (random tips), custom route colors, additional badges
- Gold: plus weather widget (Open-Meteo API), all badges

Free-tier route quota: **3 generated routes per week**. The single source of truth
for plan gating is `public/js/features.js` (`FEATURES.routes_per_week`). The weekly
counter is enforced server-side by `POST /api/auth/consume-route` (stored in
`user.stats.weeklyRoutes` + `weekStart`); the client calls it before generating and
blocks on a `429`/`{ok:false}`. NOTE: route generation itself happens client-side
(graph router / OSRM), so enforcement is best-effort — the consume-route call is the
gate, but a determined user editing JS could bypass it. Full enforcement would need
server-side route generation. The client fails *closed* (blocks) if the quota check
can't be confirmed, so the one easy bypass (blocking the request) is closed.

If you change the quota number, update it in `features.js`, the `LIMIT` in
`worker/handlers/auth.js` (consume-route), and `tests/features.test.js` together.

Badges are earned based on stats:
- Routes count and total km are persisted server-side in `user.stats` via
  `POST /api/auth/stats` and synced across devices (localStorage is a cache).

## Key Non-Obvious Patterns

1. Password Storage: PBKDF2-SHA-256 (100 000 iterations) with a per-user UUID salt — see `worker/auth-utils.js`. Minimum 8 characters (enforced in `worker/handlers/auth.js` for register and password change). Stored as `passwordHash` + `salt` + `hashVersion: 2`. Legacy SHA-256 accounts (`hashVersion` absent/1) migrate automatically on next successful login.

2. Token Format: Random UUID, no JWT. Sessions stored in KV as session:{token} → {userId, expiresAt}. Bearer header required for auth.

3. Elevation Profile: Async fetch to Open-Elevation API after route displays. Samples evenly-spaced 100-point max to avoid rate limits. Draws SVG sparkline with ascent/descent totals.

4. Report Photos: Resized client-side to 800px max, converted to JPEG data-URI, stored in report object (not separate blob storage). Displayed inline in popups.

5. Path Splitting: Admin feature—splits existing path at clicked point into two new paths (original deleted). Uses nearestPointIndex() to find closest coordinate. Both new paths inherit pathType, status, conditions, notes from original.

6. OSM Path Import: Admin can click "Select Path" to load OpenStreetMap data via /api/osm proxy. Auto-detects bike vs foot based on highway tags. Popup lets admin confirm type and pick color before saving.

7. Carrefours: Fixed list of named forest junctions hardcoded in js/carrefours.js as CARREFOURS array. Markers only show when zoomed in (zoom 15+) to avoid clutter. No API calls—instant load.

8. Service Worker Caching: sw.js uses network-first for app files (HTML/JS/CSS), cache-first for static assets (images, fonts), and always-network for API/tile requests. This ensures latest app version while offline support for cached pages.

9. Search Debounce: Address search (Nominatim OSM) debounced 380-400ms to avoid rate limiting. Results limit to France (countrycodes=fr).

10. Zoom-Dependent Rendering: Path stroke weight scales with map zoom level (function pathWeight() in map.js and admin.js). Carrefour labels only visible at high zoom to prevent visual clutter.

11. Admin Notifications: Reports and contact messages trigger push notifications via ntfy.sh (subscribe to channel bwr-ciril8596). This is a fallback notification channel, not critical—wrapped in try/catch.

12. Plan Enforcement: /api/auth/me endpoint auto-upgrades admin users to gold plan on read. Free-tier badge visibility filtered by tier. Silver/Gold unlock UI sections via renderDailyWheel(), renderGoals(), renderWeather().

## Configuration

Environment Variables (set in Cloudflare Workers dashboard):
- ORS_KEY — OpenRouteService API key (optional; OSRM fallback if missing)
- RESEND_API_KEY — Resend.com API key (required for email verification in production; verification emails are silently skipped in dev if unset)
- RESEND_FROM — Sender address, e.g. `BWR <noreply@yourdomain.com>` (defaults to a placeholder; must match a verified domain in your Resend account)

Constants (js/config.js):
- API_URL — Points to deployed worker endpoint (e.g., https://bwr-worker.ciril8596.workers.dev)
- MAP_CENTER — [49.35, 2.90] (Compiegne forest)
- MAP_ZOOM — 13
- STATUS_COLORS — Maps status string to hex color

Cloudflare Config (wrangler.jsonc):
- assets.directory — ./public (static frontend served from public/)
- kv_namespaces — Binding BWR_KV to the KV namespace
- ai.binding — `AI` (Workers AI, used by admin content generation in `worker/handlers/admin.js`)

## Testing Notes

Automated test suite: **260 tests, ~3 s** (`npm test`). Test files:

| File | What it covers | Style |
|------|---------------|-------|
| `tests/graph-router.test.js` | Pure graph-routing functions (haversine, buildGraph, dijkstra, graphAtob, graphLoop) | CJS, Node test runner |
| `tests/features.test.js` | Plan-gating matrix — `can()`, `limitOf()`, `requiredTier()`, weekly quota helpers | CJS, browser shim for `window`/`localStorage` |
| `tests/worker-auth.test.mjs` | Auth API endpoints with in-memory KV mock (register, login, session, plan change, stats, wheel prize) | ESM |
| `tests/worker-admin.test.mjs` | Admin endpoints (user/plan management, data wipe, content) | ESM |
| `tests/worker-paths.test.mjs` | Path CRUD + OSM proxy behaviour | ESM |
| `tests/worker-savedroutes.test.mjs` | Saved-route CRUD and share-token endpoints | ESM |
| `tests/sw.test.js` | Service-worker cache-version sync | CJS |

E2E (Playwright, `npx playwright test`) runs against the live prod URL — see `tests/e2e/`.

**Rule: run `npm test` before every commit. CI (`.github/workflows/ci.yml`) blocks deploy on `needs: [unit-tests, e2e]`, so red tests never reach production — but a broken local commit can still land on `main` without branch protection. Add a test whenever you change plan gating, KV key schema, or auth logic.**

Manual testing still needed for:
- Routing: A→B on small distances, loop generation near forest boundaries, fallback when graph too small
- Admin Workflows: Path import from OSM, path splitting, report dismissal, plan changes
- Offline: Service worker caching, stale-while-revalidate behavior, API failures
- Mobile: Geolocation button, touch events on map, photo upload from camera

## Important Gotchas

1. Stats Backend-Persisted: Route counts and km are stored server-side in user.stats via POST /api/auth/stats. Stats sync across devices.

2. KV Data Format: All KV values are JSON strings, not objects. Manual JSON.parse() required on read, JSON.stringify() on write. Helper functions getUser/putUser/getPath/putPath/putReport in worker.js handle this.

3. OSM Proxy Caching: Cached for 7 days per bbox. If you change admin path data, OSM overlay will not update until cache expires or you manually clear.

4. CORS Allowlisted: `worker.js` reflects the request Origin only if it matches the allowlist (`bwr-worker.ciril8596.workers.dev`, `localhost:8787`, or any `*.pages.dev` preview); otherwise it falls back to the canonical prod origin. Responses also set `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy`, and `Permissions-Policy`. Add new allowed origins to `ALLOWED_ORIGINS` / `isAllowedOrigin`.

5. Password Hashing: PBKDF2-SHA-256 with 100 000 iterations. Legacy SHA-256 accounts migrate automatically on next login (hashVersion field tracks which scheme).

6. One-Time Setup: /api/setup checks for any user: prefix key. If any exist, rejects with 403. Manual KV cleanup (delete all user:* and uemail:* keys) required to re-run.

7. Email Index: uemail:{email} → userId is a soft index—no atomic transactions. Two concurrent registrations with the same email could both succeed in theory (extremely unlikely in practice). The index must be kept in sync: update both user:{id} and uemail:{email} together on profile email changes.

8. KV is not atomic — counters race: `checkRateLimit`, `consume-route`, and login-attempt tracking all do read-modify-write on KV, which has no atomic increment or compare-and-swap. Concurrent requests can therefore slip slightly past a limit. This is acceptable at the current scale; if a counter ever needs hard guarantees, move it to a Durable Object. Fixed-window TTL is set only on the first write of a window (subsequent increments don't extend it) — this is intentional.

9. Removed feature — daily AI suggestion: the per-user daily/weekly AI hiking suggestion (cron + `worker/ai.js` + `/api/ai-suggestion` + a profile widget + the user `homeAddress`/`homeCoords` fields) was removed. The daily-wheel "Conseil sentier" AI tip (`POST /api/ai-tip` in `worker/handlers/social.js`) is unrelated and still active. Legacy `aisugg:` KV keys self-expire (48h TTL); user-deletion still purges them.
