# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

BWR (Balades en Foret de Compiegne) is a progressive web app for interactive forest path mapping and route planning in the Compiegne forest, France. It combines a serverless backend (Cloudflare Workers) with a vanilla JavaScript frontend (Leaflet maps). The app supports three user tiers (free/silver/gold) with gamification (badges, daily challenges) and crowd-sourced problem reporting.

## Development Commands

Start local dev server (runs on http://localhost:8787):
  npm run dev:worker

Deploy to Cloudflare Workers (requires authentication):
  npm run deploy:worker

Run all automated tests (400 tests, ~4 s):
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

- Auth: /api/setup (one-time admin creation), /api/auth/{register,login,logout,me,profile,password,account}, /api/auth/plan/:userId (admin plan changes), /api/auth/stats, /api/auth/consume-route (free weekly quota), /api/auth/wheel-prize, /api/auth/start-trial (self-service one-time free 7-day Silver trial — free accounts only, gated by `silverTrialUsed`; reuses the `planExpiresAt`/`planBase` revert-on-expiry path in `/api/auth/me`)
- Email verification: GET /api/auth/verify?token=… (activate account), POST /api/auth/resend-verification (re-send link, rate-limited 5 min)
- Password reset: POST /api/auth/forgot-password (email a reset link — always 200, no account enumeration; IP rate-limited 5/h + per-address 5-min cooldown), POST /api/auth/reset-password ({token, password} — single-use `reset:{token}` KV key, 1-hour TTL; rotates salt+hash, sets `sessionsInvalidatedAt`, clears login lockout)
- Paths (admin-only): POST/PUT/DELETE /api/paths/* — forest/bike paths curated by admin
- Reports (public): POST /api/reports, DELETE /api/reports/:id (admin), GET /api/reports — crowd-sourced issues (fallen trees, floods, etc.)
- Routing: POST /api/route — proxy to OpenRouteService (needs ORS_KEY env var)
- OSM Proxy: GET /api/osm?bbox=... — caches OpenStreetMap path data for 7 days
- Contact: POST /api/contact — sends to ntfy.sh push notification service
- Notification emails (retention): two best-effort emails via Resend fire from `worker/notify.js` — (1) a forum reply emails the topic author (`notifyForumReply`, triggered from the reply POST via `waitUntil`), (2) a hazard report emails Silver+ owners of a saved route it passes near (`notifyRouteHazardEmail`, sent from `notifyHazard` in `worker/handlers/push.js` alongside the web-push fan-out, independent of any push subscription). Both are gated on the user's `emailNotifications !== false` flag (default on) and carry a one-click List-Unsubscribe link. Toggle it via PUT /api/auth/notifications (auth) or the public GET/POST /api/notify/unsubscribe?uid=…&token=… (token = `unsubscribeToken(user)` = SHA-256 of id+salt, no session needed). Field is surfaced in GET /api/auth/me and toggled from the profile "Emails de notification" block (`renderEmailNotif` in `public/js/profile-plan.js`).
- Analytics: POST /api/track/visit (public — per-page dwell tracking. `public/js/track.js` measures the *visible* time on each page (to the second, paused while the tab is hidden) and sends `{ vid, page, seconds }` on `pagehide`. The server accumulates this into one record per anonymous visitor per month; a visitor is only *counted* (and shown in the admin list) once their cumulative time crosses the `THRESHOLD` (10 s) so bots/bounces are excluded — records under the bar are stored with `counted:false` and filtered out of the list. A server-side User-Agent bot filter (`isBotUA` in `worker/handlers/admin.js`) is a second line of defence — a missing UA is treated as a bot. Each record stores an anonymous `vid`, coarse Cloudflare city/country/region from `request.cf`, a friendly device label from `describeDevice` (never the IP or raw UA), `firstSeen`/`lastSeen`, `visits` (page views), total `seconds`, `counted`, and a `pages` map of `{ path: { seconds, views } }` rendered per-visitor in the admin "Activité" tab), GET /api/analytics/events (admin — recent login/signup events + `totalLogins`/`totalSignups` + `monthlyVisits`/`visitsThisMonth` + `visitors` (per-person list for the current month, most-recently-active first, capped at 500 with `visitorsTruncated`)). Frontend renders the per-visitor list in the profile-less admin "Activité" tab (`loadVisits` in `public/js/admin.js`).
- Site rating (whole-site "avis Google", `worker/handlers/rating.js`): the **average + count + star distribution are public** (footer social proof), the **individual comments are admin-only**. GET /api/rating (public — `{ avg, count, dist:{1..5} }`, plus the caller's own `mine:{stars,comment}` when authed; aggregate cached 5 min under the `reviewsummary` KV key), POST /api/rating ({stars 1–5, comment?} — auth required, **one review per account, editable**; re-posting overwrites `review:{userId}` keeping `createdAt`), GET /api/ratings (admin — full review list with comments, most-recent first), DELETE /api/ratings/:userId (admin). Frontend: the self-contained `public/js/rating.js` injects the footer block + star/comment modal into `.footer-inner`/`.blog-footer` on the marketing pages (index, blog, news, plans, best-tours, forum); the admin "⭐ Avis sur le site" card in `admin-panel.html` is loaded by `loadRatings()` in `public/js/admin.js`.
- Saved routes (Silver+): POST /api/savedroutes, GET /api/savedroutes, GET /api/savedroutes/:id, DELETE /api/savedroutes/:id
- Share route (public): GET /api/savedroutes/share/:token — returns route by share token, no auth required
- Forum (community): GET /api/forum/topics (list — reading is public, but free accounts only get the 5 most recent topics unlocked; older ones come back `locked:true` with no body), GET /api/forum/topics/:id (topic + replies — free users get 403 on a locked topic), POST /api/forum/topics (create — Silver/Gold/admin only), POST /api/forum/topics/:id/replies (reply — Silver/Gold/admin only), PUT /api/forum/topics/:id (edit topic title/body) + PUT /api/forum/topics/:id/replies/:replyId (edit reply body) — author or admin, stamps `editedAt` and keeps thread order (no `lastActivityAt` bump), DELETE /api/forum/topics/:id + DELETE /api/forum/topics/:id/replies/:replyId (author or admin). The free-tier visible count is `FREE_VISIBLE_TOPICS` in `worker/handlers/forum.js`, mirrored by `FEATURES.forum_topics_visible` / `forum_post` in `public/js/features.js`. Frontend: `public/forum.html` + `public/js/forum.js` (single page; list ↔ detail swapped via the `#t/:id` URL hash).

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
- analytics:visits:{YYYY-MM} — integer count of unique anonymous visitors that month (dwell-gated ≥ 10 s), ~13-month TTL
- visitor:{YYYY-MM}:{vid} — JSON per-visitor record {vid, firstSeen, lastSeen, visits, seconds, counted, pages:{path:{seconds,views}}, country, city, region, device}; existence also serves as the once-per-month dedup marker (replaces the old `vseen:` marker), ~13-month TTL
- savedroute:{userId}:{id} — JSON saved route (coords, stats, name, shareToken, etc.)
- routeshare:{token} — JSON {userId, routeId}, 180-day TTL; maps share token → route
- forum:topic:{id} — JSON forum topic {userId, authorName, title, body, createdAt, lastActivityAt, replyCount}
- forum:reply:{topicId}:{paddedTs}:{id} — JSON reply {topicId, userId, authorName, body, createdAt}; ts in the key keeps replies ordered within a topic
- review:{userId} — JSON site review {userId, name, stars, comment, createdAt, updatedAt} (one per account)
- reviewsummary — JSON {avg, count, dist:{1..5}} public rating aggregate, 5-min TTL cache (deliberately NOT prefixed `review:` so `listItems('review:')` never picks it up)

Migration: POST /api/migrate (admin only) migrates legacy array keys (users/paths/reports/contact_messages) to granular keys. Run once after deploy. POST /api/migrate/pathgrades (admin only) attributes every currently-ungraded path to the requesting admin and recomputes every user's `stats.pathGrades` from their `pathgrade:` keys — run once to reconcile the leaderboard "chemins notés" with the total path count after the "creating a path credits a grade" change.

### Frontend Architecture

Pages (all require authentication except login.html):
- map.html + js/map.js: Browse all paths, filter by status (easy/medium/hard/blocked), report issues, view carrefours (named junctions)
- routes.html + js/routes.js: Core UX—interactive route planner with mode selection (A→B or loop), difficulty picker, address search
- profile.html + js/profile.js: User stats, achievements/badges, daily wheel (random hiking tips), custom goals, weather (gold tier only), avatar color picker
- admin.html + js/admin.js: **Carte admin** — map-only workspace: path management (draw, import from OSM, split, edit, delete), report triage, color/status updates
- admin-panel.html + js/admin.js: **Panneau admin** — dashboard landing (messages, members/activity, revenue + AI forecast, monthly challenges, reset-km). Shares `js/admin.js` with admin.html: the boot IIFE runs the map half only when `#map` exists and the dashboard half (`initDashboard()`) only when `#adminDashboard` exists; every top-level element wiring uses `?.` so the absent half is a silent no-op. The two pages are reached via two menu entries ("Carte admin" / "Panneau admin") in the header, nav drawer, and per-page user dropdowns (revealed to admins via the shared `.nav-drawer-admin` class).
- forum.html + js/forum.js: Community forum (threads + replies). Reading is open (free tier sees the 5 most recent topics); Silver/Gold/admin create topics and reply. List and topic detail are one page, swapped via the `#t/:id` hash.
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
- Silver: plus daily wheel (random tips), custom route colors, weather widget (Open-Meteo API), additional badges
- Gold: plus all badges (gold-tier badges)

Free-tier route quota: **10 generated routes per week**. The single source of truth
for plan gating is `public/js/features.js` (`FEATURES.routes_per_week`). The weekly
counter is enforced server-side by `POST /api/auth/consume-route` (stored in
`user.stats.weeklyRoutes` + `weekStart`); the client calls it before generating and
blocks on a `429`/`{ok:false}`. NOTE: route generation itself happens client-side
(graph router / OSRM), so enforcement is best-effort — the consume-route call is the
gate, but a determined user editing JS could bypass it. Full enforcement would need
server-side route generation. The client fails *closed* (blocks) if the quota check
can't be confirmed, so the one easy bypass (blocking the request) is closed.

Free-tier loop sub-quota: **3 loop routes per week** (`FEATURES.loops_per_week`).
Loops also count toward `routes_per_week`, so a loop consumes one of the 3 loop
slots *and* one of the 10 weekly routes; A→B routes only consume a weekly route.
The client sends `{ mode }` to `consume-route`; the server tracks
`user.stats.weeklyLoops` (alongside `weeklyRoutes`, same `weekStart` reset) and
returns `{ ok:false, reason:'loop' }` / `{ reason:'route' }` so the client can show
the right upsell (`showLoopQuotaModal` vs `showQuotaExceededModal`).

If you change either quota number, update it in `features.js`, the matching `LIMIT`
/ `LOOP_LIMIT` in `worker/handlers/auth.js` (consume-route), and `tests/features.test.js`
+ `tests/worker-auth.test.mjs` together.

Badges are earned based on stats:
- Routes count and total km are persisted server-side in `user.stats` via
  `POST /api/auth/stats` and synced across devices (localStorage is a cache).

XP & progression (profile "Mon abonnement & progression" level): XP is **earned
through community contributions, not distance** — `XP = reports×2 + pathGrades`
(the same formula as the leaderboard `points`), 10 XP per level. Computed
client-side in `public/js/profile.js` from `user.stats.reports`/`pathGrades`.

Leaderboard (`GET /api/leaderboard?period=week|month|all`, default `all`):
- `all` — cumulative board built from every `user.stats` (existing behaviour).
- `week` / `month` — built from per-period `xp:{period}:{userId}` buckets
  (`period` = ISO week `2026-W26` or month `2026-06`), so they show only recent
  activity. Buckets are written by `addPeriodXp()` in `worker/kv.js` whenever a
  report is created (`worker/handlers/reports.js`) or a path is graded/un-graded
  (`worker/handlers/paths.js`), with a ~70-day TTL. Forest coverage is cumulative
  so it is `null` (and hidden in the UI) on the periodic boards. Each scope caches
  under `leaderboard:cache[:week|:month]` for 5 min. Frontend tabs live in
  `public/leaderboard.html` / `public/js/leaderboard.js` (default tab: Semaine).
  If you change the XP formula, keep `addPeriodXp`, the all-time map in
  `handleSocial`, `patchLeaderboardCache`, and `public/js/profile.js` in sync.

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
- API_URL — Canonical API host is `https://bwrmaps.com` (custom domain on the same Worker). localhost and `*.workers.dev` deployments call themselves same-origin; the legacy `bwr-worker.ciril8596.workers.dev` still works.
- MAP_CENTER — [49.35, 2.90] (Compiegne forest)
- MAP_ZOOM — 13
- STATUS_COLORS — Maps status string to hex color

Cloudflare Config (wrangler.jsonc):
- assets.directory — ./public (static frontend served from public/)
- kv_namespaces — Binding BWR_KV to the KV namespace
- ai.binding — `AI` (Workers AI, used by admin content generation in `worker/handlers/admin.js`)

## Testing Notes

Automated test suite: **400 tests, ~4 s** (`npm test`). Test files:

| File | What it covers | Style |
|------|---------------|-------|
| `tests/graph-router.test.js` | Pure graph-routing functions (haversine, buildGraph, dijkstra, graphAtob, graphLoop) | CJS, Node test runner |
| `tests/features.test.js` | Plan-gating matrix — `can()`, `limitOf()`, `requiredTier()`, weekly quota helpers | CJS, browser shim for `window`/`localStorage` |
| `tests/worker-auth.test.mjs` | Auth API endpoints with in-memory KV mock (register, login, session, plan change, stats, wheel prize) | ESM |
| `tests/worker-admin.test.mjs` | Admin endpoints (user/plan management, data wipe, content) | ESM |
| `tests/worker-paths.test.mjs` | Path CRUD + OSM proxy behaviour | ESM |
| `tests/worker-savedroutes.test.mjs` | Saved-route CRUD and share-token endpoints | ESM |
| `tests/worker-forum.test.mjs` | Forum topics/replies — Silver+ posting, free-tier 5-topic read limit, locked detail, author/admin edit + deletion | ESM |
| `tests/worker-rating.test.mjs` | Site rating — public aggregate, one-per-account overwrite, star validation, admin-only comment list + delete | ESM |
| `tests/sw.test.js` | Service-worker cache-version sync | CJS |

E2E (Playwright, `npx playwright test`) runs against the live prod URL — see `tests/e2e/`.

**Rule: run `npm test` before every commit. CI (`.github/workflows/ci.yml`) gates deploy on `needs: [unit-tests]` — the deterministic unit suite is the hard gate, so a red unit test never reaches production. The E2E job (`e2e`) runs against the LIVE prod URL and is intentionally **non-blocking** (`continue-on-error: true`, and deploy no longer lists it in `needs`): it's a smoke-test signal only, because live-site tests are flaky from CI's cloud IPs (rate limits, latency, external services). A red E2E run is a warning to investigate, not a deploy blocker. A broken local commit can still land on `main` without branch protection. Add a **unit** test whenever you change plan gating, KV key schema, or auth logic.**

Manual testing still needed for:
- Routing: A→B on small distances, loop generation near forest boundaries, fallback when graph too small
- Admin Workflows: Path import from OSM, path splitting, report dismissal, plan changes
- Offline: Service worker caching, stale-while-revalidate behavior, API failures
- Mobile: Geolocation button, touch events on map, photo upload from camera

## Important Gotchas

1. Stats Backend-Persisted: Route counts and km are stored server-side in user.stats via POST /api/auth/stats. Stats sync across devices.

2. KV Data Format: All KV values are JSON strings, not objects. Manual JSON.parse() required on read, JSON.stringify() on write. Helper functions getUser/putUser/getPath/putPath/putReport in worker.js handle this.

3. OSM Proxy Caching: Cached for 7 days per bbox. If you change admin path data, OSM overlay will not update until cache expires or you manually clear.

4. CORS Allowlisted: `worker.js` reflects the request Origin only if it matches the allowlist (`bwrmaps.com`, `www.bwrmaps.com`, the legacy `bwr-worker.ciril8596.workers.dev`, `localhost:8787`, or any `*.pages.dev` preview); otherwise it falls back to the canonical prod origin `https://bwrmaps.com`. Responses also set `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy`, and `Permissions-Policy`. Add new allowed origins to `ALLOWED_ORIGINS` / `isAllowedOrigin`.

5. Password Hashing: PBKDF2-SHA-256 with 100 000 iterations. Legacy SHA-256 accounts migrate automatically on next login (hashVersion field tracks which scheme).

6. One-Time Setup: /api/setup checks for any user: prefix key. If any exist, rejects with 403. Manual KV cleanup (delete all user:* and uemail:* keys) required to re-run.

7. Email Index: uemail:{email} → userId is a soft index—no atomic transactions. Two concurrent registrations with the same email could both succeed in theory (extremely unlikely in practice). The index must be kept in sync: update both user:{id} and uemail:{email} together on profile email changes.

8. KV is not atomic — counters race: `checkRateLimit`, `consume-route`, and login-attempt tracking all do read-modify-write on KV, which has no atomic increment or compare-and-swap. Concurrent requests can therefore slip slightly past a limit. This is acceptable at the current scale; if a counter ever needs hard guarantees, move it to a Durable Object. Fixed-window TTL is set only on the first write of a window (subsequent increments don't extend it) — this is intentional.

9. Removed feature — daily AI suggestion: the per-user daily/weekly AI hiking suggestion (cron + `worker/ai.js` + `/api/ai-suggestion` + a profile widget + the user `homeAddress`/`homeCoords` fields) was removed. The daily-wheel "Conseil sentier" AI tip (`POST /api/ai-tip` in `worker/handlers/social.js`) is unrelated and still active. Legacy `aisugg:` KV keys self-expire (48h TTL); user-deletion still purges them.
