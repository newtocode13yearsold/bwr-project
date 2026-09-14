// ── Offline tile download — preset zones de l'Oise ─────────────────────────────
// Lazy-loaded by map.js when the user opens the "Cartes hors-ligne" picker.
// The whole department is too large to cache at once, so we offer the main
// forêts as individual downloads (zoom 10–15, OpenTopoMap).

function lonToTileX(lon, z) { return Math.floor((lon + 180) / 360 * Math.pow(2, z)); }
function latToTileY(lat, z) {
  return Math.floor((1 - Math.log(Math.tan(lat * Math.PI / 180) + 1 / Math.cos(lat * Math.PI / 180)) / Math.PI) / 2 * Math.pow(2, z));
}

// Major forêts of the Oise, each a small bbox cached on demand.
const OISE_OFFLINE_ZONES = [
  { id: 'compiegne',    name: 'Forêt de Compiègne',     bbox: { north: 49.46, south: 49.28, west: 2.78, east: 3.04 } },
  { id: 'laigue',       name: 'Forêt de Laigue',        bbox: { north: 49.55, south: 49.43, west: 2.92, east: 3.10 } },
  { id: 'halatte',      name: 'Forêt de Halatte',       bbox: { north: 49.32, south: 49.21, west: 2.52, east: 2.72 } },
  { id: 'chantilly',    name: 'Forêt de Chantilly',     bbox: { north: 49.22, south: 49.08, west: 2.40, east: 2.62 } },
  { id: 'ermenonville', name: "Forêt d'Ermenonville",   bbox: { north: 49.18, south: 49.06, west: 2.54, east: 2.78 } },
  { id: 'hez',          name: 'Forêt de Hez-Froidmont', bbox: { north: 49.43, south: 49.33, west: 2.30, east: 2.50 } },
  { id: 'retheuil',    name: 'Forêt de Retheuil',      bbox: { north: 49.40, south: 49.25, west: 2.92, east: 3.16 } },
  { id: 'retz',         name: 'Forêt de Retz',          bbox: { north: 49.35, south: 49.14, west: 2.95, east: 3.30 } },
];

const _zoneCacheKey = id => `bwr_zone_cached:${id}`;

// The forest nearest a given point (used by the Silver auto-download to pick the
// forest the user is actually in / looking at, so this generalises for free if
// more régions are ever added — no code change, just more zones above).
function _nearestZone(lat, lon) {
  let best = null, bestD = Infinity;
  for (const z of OISE_OFFLINE_ZONES) {
    const cy = (z.bbox.north + z.bbox.south) / 2, cx = (z.bbox.west + z.bbox.east) / 2;
    const d = (lat - cy) * (lat - cy) + (lon - cx) * (lon - cx); // planar is fine at this scale
    if (d < bestD) { bestD = d; best = z; }
  }
  return best;
}

function _zoneTiles(bbox) {
  const tiles = [];
  for (let z = 10; z <= 15; z++) {
    const x0 = lonToTileX(bbox.west, z),  x1 = lonToTileX(bbox.east, z);
    const y0 = latToTileY(bbox.north, z), y1 = latToTileY(bbox.south, z);
    for (let x = x0; x <= x1; x++)
      for (let y = y0; y <= y1; y++)
        // Same-origin edge-cached proxy — matches the URL the map requests so the
        // downloaded tile shares its cache key (see worker/handlers/tiles.js).
        tiles.push(`/tiles/topo/${z}/${x}/${y}.png`);
  }
  return tiles;
}

const _sleep = ms => new Promise(r => setTimeout(r, ms));

// Fetch one tile and store it, with retries. Returns true only if a genuine
// 200 actually landed in the cache. OpenTopoMap rate-limits bulk fetching
// (429/403, sometimes with no CORS header so fetch() rejects), so a single
// failure must NOT be treated as success — otherwise the zone is marked
// "downloaded" while the cache is empty and the map is blank offline.
async function _fetchTileWithRetry(cache, tileUrl, attempts = 4) {
  for (let a = 0; a < attempts; a++) {
    try {
      // CORS (not no-cors): OpenTopoMap sends Access-Control-Allow-Origin:* plus
      // a real Date/Content-Length, so we store a normal, accurately-sized,
      // dated response. Opaque (no-cors) responses are padded to several MB each
      // by iOS Safari's quota accounting — caching a whole forest of them blows
      // the cache quota and makes iOS evict everything (white-spot gaps). Only
      // store a genuine 200 so a rate-limit/error page never poisons the cache.
      const res = await fetch(tileUrl, { mode: 'cors', cache: 'reload' });
      if (res && res.ok) { await cache.put(tileUrl, res); return true; }
      // 429/5xx → back off and retry; 4xx other than 429 → give up early.
      if (res && res.status !== 429 && res.status < 500) return false;
    } catch { /* network/CORS error → retry */ }
    await _sleep(400 * (a + 1)); // linear backoff: 400, 800, 1200ms
  }
  return false;
}

// Returns { total, ok, failed }. Throttled (small concurrency + per-batch
// pause) to stay within OpenTopoMap's fair-use limits, and reports the REAL
// number of tiles stored so the caller never claims a half-empty zone is ready.
//
// Two phases:
//   1. 'download' — sweep every tile once, gently (small batches, real pauses).
//   2. 'fill'     — retry ONLY the tiles that failed, one at a time with a
//      cooldown between sweeps. Rate-limit rejections arrive in bursts, so the
//      misses cluster into a blank patch; re-grabbing just those tiles after
//      the limit window resets fills the holes instead of leaving a gap.
// onProgress is called with { phase, pct } so the UI can show both phases.
// opts.shouldAbort() is polled between batches/sweeps so a long download can be
// cancelled (used by the Silver auto-download banner). An aborted run leaves the
// zone UN-flagged so it's retried next time rather than trusted half-empty.
async function downloadOfflineZone(zone, onProgress, opts = {}) {
  const tiles = _zoneTiles(zone.bbox);
  const cache = await caches.open('bwr-offline-tiles');
  const report = (phase, done, total) =>
    onProgress && onProgress({ phase, pct: total ? Math.round(done / total * 100) : 100 });
  const aborted = () => !!(opts.shouldAbort && opts.shouldAbort());

  // ── Phase 1: main download, with ADAPTIVE concurrency. ──
  //    Every tile is fetched through our own Cloudflare edge proxy
  //    (/tiles/topo/…), so a tile already warmed at the edge is an instant HIT
  //    with zero upstream load — crawling through those 3-at-a-time was the main
  //    source of slowness. So we start fast (many parallel requests, no pause)
  //    and only throttle when the tile server actually starts rejecting: a clean
  //    batch speeds up, a batch with failures halves the concurrency and pauses
  //    so the rate-limit window can recover. Popular preset zones (already warm)
  //    finish near-instantly; a cold zone self-throttles back to the old
  //    cautious pace, so the blank-patch protection still holds.
  const MAX_CONC = 12, MIN_CONC = 3;
  let conc = MAX_CONC;
  const failed = [];
  let done = 0;
  let i = 0;
  while (i < tiles.length) {
    if (aborted()) return { total: tiles.length, ok: done - failed.length, failed: tiles.length - (done - failed.length), aborted: true };
    const slice = tiles.slice(i, i + conc);
    i += slice.length; // advance by what we actually took, not by the (mutable) conc
    const results = await Promise.all(slice.map(t => _fetchTileWithRetry(cache, t)));
    let batchFails = 0;
    results.forEach((okFlag, j) => { if (!okFlag) { failed.push(slice[j]); batchFails++; } });
    done += slice.length;
    report('download', done, tiles.length);
    if (batchFails === 0) {
      conc = Math.min(MAX_CONC, conc + 2); // server is happy → push harder
    } else {
      conc = Math.max(MIN_CONC, conc >> 1); // getting throttled → back off + cool down
      await _sleep(300 + batchFails * 200);
    }
  }

  // ── Phase 2: fill the gaps. Up to 3 cooldown-spaced sweeps over only the
  //    tiles still missing, one at a time with extra retries, so a rate-limited
  //    burst gets another chance instead of leaving a blank patch. ──
  let gaps = failed;
  for (let sweep = 0; sweep < 3 && gaps.length; sweep++) {
    if (aborted()) return { total: tiles.length, ok: tiles.length - gaps.length, failed: gaps.length, aborted: true };
    await _sleep(1500); // let the server's rate-limit window cool down
    const stillFailed = [];
    let filled = 0;
    for (const tileUrl of gaps) {
      if (aborted()) { gaps = stillFailed.concat(gaps.slice(filled)); return { total: tiles.length, ok: tiles.length - gaps.length, failed: gaps.length, aborted: true }; }
      if (!(await _fetchTileWithRetry(cache, tileUrl, 5))) stillFailed.push(tileUrl);
      report('fill', ++filled, gaps.length);
    }
    gaps = stillFailed;
  }

  const ok = tiles.length - gaps.length;
  // Only flag the zone as cached when it's actually complete (a hair of slack
  // for a stray permanently-blocked tile). A partial download stays un-flagged
  // so the user is told to retry rather than finding a blank patch offline.
  if (ok / tiles.length >= 0.995) localStorage.setItem(_zoneCacheKey(zone.id), '1');
  else localStorage.removeItem(_zoneCacheKey(zone.id));
  return { total: tiles.length, ok, failed: gaps.length };
}

// ── Zone picker modal ──────────────────────────────────────────────────────────
function openOfflineZonePicker() {
  if (typeof BWR !== 'undefined' && typeof _userPlan !== 'undefined'
      && !BWR.can('offline_cache', _userPlan)) {
    showToast('🔒 Cartes hors-ligne disponibles avec Argent — voir plans');
    return;
  }

  document.getElementById('offlineZoneModal')?.remove();

  const rows = OISE_OFFLINE_ZONES.map(z => {
    const cached = localStorage.getItem(_zoneCacheKey(z.id)) === '1';
    return `
      <div class="offline-zone-row" style="display:flex;align-items:center;justify-content:space-between;gap:10px;padding:9px 0;border-bottom:1px solid var(--border,#e5e7eb)">
        <span style="font-size:0.9rem">🌲 ${z.name}</span>
        <button class="btn-secondary offline-zone-btn" data-zone="${z.id}"
          style="white-space:nowrap;font-size:0.82rem;padding:5px 11px">
          ${cached ? '✅ Téléchargée' : '⬇ Télécharger'}
        </button>
      </div>`;
  }).join('');

  const overlay = document.createElement('div');
  overlay.id = 'offlineZoneModal';
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal-card" style="max-width:420px">
      <button class="modal-close-x" id="offlineZoneClose" aria-label="Fermer">✕</button>
      <h3>Cartes hors-ligne</h3>
      <p style="font-size:0.85rem;color:#6b7280;margin-bottom:6px">
        Téléchargez une forêt pour la consulter sans connexion (zoom 10–15).
      </p>
      <div>${rows}</div>
    </div>`;
  document.body.appendChild(overlay);

  const close = () => overlay.remove();
  overlay.querySelector('#offlineZoneClose').addEventListener('click', close);
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });

  overlay.querySelectorAll('.offline-zone-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (btn.dataset.downloading === '1') return;
      const zone = OISE_OFFLINE_ZONES.find(z => z.id === btn.dataset.zone);
      if (!zone) return;
      btn.dataset.downloading = '1';
      btn.disabled = true;
      btn.textContent = '⏳ 0%';
      try {
        const { total, ok, failed } = await downloadOfflineZone(zone, info => {
          // Phase 2 (gap-filling) gets its own icon so the user can see the app
          // is patching holes rather than stuck at the same percentage.
          btn.textContent = info.phase === 'fill' ? `🧩 ${info.pct}%` : `⏳ ${info.pct}%`;
        });
        if (failed === 0) {
          btn.textContent = '✅ Téléchargée';
          showToast(`✅ ${zone.name} sauvegardée hors-ligne ! (${ok} tuiles)`);
        } else if (ok / total >= 0.995) {
          // essentially complete — flagged as cached, a stray blocked tile aside
          btn.textContent = '✅ Téléchargée';
          showToast(`✅ ${zone.name} sauvegardée (${ok}/${total} tuiles)`);
        } else {
          // too patchy to trust offline — keep it as a retry, don't fake success
          btn.textContent = '⚠️ Incomplète — réessayer';
          showToast(`⚠️ ${zone.name} : ${ok}/${total} tuiles (le serveur a bloqué le reste). Réessayez dans un instant.`);
        }
      } catch {
        btn.textContent = '⬇ Réessayer';
        showToast('Erreur lors du téléchargement hors-ligne');
      } finally {
        delete btn.dataset.downloading;
        btn.disabled = false;
      }
    });
  });
}

// ── Silver auto-download ────────────────────────────────────────────────────────
// When a Silver+ user opens the map, quietly download the forest they're in so
// "works offline" is a real promise, not a hope they happened to pan over the
// right tiles. It downloads exactly the nearest preset forest (a few thousand
// tiles / tens of MB), NOT the whole department — that would be gigabytes and
// blow the browser's storage quota.
//
// Politeness rules:
//   • runs only once a download isn't already in flight,
//   • skips a forest that's already fully cached,
//   • skips if the user cancelled the auto-download for that forest before
//     (opt-out remembered per-forest — never nags again),
//   • needs a connection (can't download while offline).
// A failed/partial run is NOT opted-out, so it self-heals toward complete on the
// next map open.
const _autoOptOutKey = id => `bwr_auto_offline_optout:${id}`;
let _autoRunning = false;

function _autoBanner(zone) {
  document.getElementById('bwrAutoOffline')?.remove();
  const el = document.createElement('div');
  el.id = 'bwrAutoOffline';
  el.setAttribute('role', 'status');
  el.style.cssText =
    'position:fixed;left:50%;bottom:18px;transform:translateX(-50%);z-index:4000;' +
    'display:flex;align-items:center;gap:12px;max-width:92vw;' +
    'background:var(--card,#fff);color:var(--text,#111);border:1px solid var(--border,#e5e7eb);' +
    'box-shadow:0 6px 24px rgba(0,0,0,.18);border-radius:12px;padding:10px 14px;font-size:0.85rem';
  el.innerHTML =
    `<span id="bwrAutoOfflineTxt">📥 Téléchargement de ${zone.name} pour la carte hors-ligne… 0%</span>` +
    `<button id="bwrAutoOfflineCancel" class="btn-secondary" style="white-space:nowrap;padding:4px 10px;font-size:0.8rem">Annuler</button>`;
  document.body.appendChild(el);
  return el;
}

async function autoDownloadNearestZone() {
  if (_autoRunning) return;
  if (!navigator.onLine) return;

  // Which forest? The one nearest the current map view (falls back to centre).
  let lat, lon;
  try { const c = (typeof map !== 'undefined') && map.getCenter(); if (c) { lat = c.lat; lon = c.lng; } } catch {}
  if (lat == null && typeof MAP_CENTER !== 'undefined') { lat = MAP_CENTER[0]; lon = MAP_CENTER[1]; }
  const zone = (lat != null) ? _nearestZone(lat, lon) : OISE_OFFLINE_ZONES[0];
  if (!zone) return;

  if (localStorage.getItem(_zoneCacheKey(zone.id)) === '1') return; // already have it
  if (localStorage.getItem(_autoOptOutKey(zone.id)) === '1') return; // user said no before

  _autoRunning = true;
  let cancelled = false;
  const banner = _autoBanner(zone);
  const txt = banner.querySelector('#bwrAutoOfflineTxt');
  banner.querySelector('#bwrAutoOfflineCancel').addEventListener('click', () => {
    cancelled = true;
    localStorage.setItem(_autoOptOutKey(zone.id), '1'); // remember: don't auto-nag again
    banner.remove();
  });

  try {
    const res = await downloadOfflineZone(zone, info => {
      if (txt) txt.textContent =
        `📥 ${zone.name} hors-ligne… ${info.pct}%${info.phase === 'fill' ? ' (finalisation)' : ''}`;
    }, { shouldAbort: () => cancelled });

    if (cancelled || res.aborted) return; // banner already removed on cancel
    banner.remove();
    if (res.failed === 0 || res.ok / res.total >= 0.995) {
      if (typeof showToast === 'function') showToast(`✅ ${zone.name} disponible hors-ligne`);
    }
    // A patchy run stays silent + un-flagged; it'll retry on the next map open.
  } catch {
    banner.remove();
  } finally {
    _autoRunning = false;
  }
}
