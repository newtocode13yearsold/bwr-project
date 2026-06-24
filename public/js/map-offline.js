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
];

const _zoneCacheKey = id => `bwr_zone_cached:${id}`;

function _zoneTiles(bbox) {
  const tiles = [];
  const subs  = ['a', 'b', 'c'];
  for (let z = 10; z <= 15; z++) {
    const x0 = lonToTileX(bbox.west, z),  x1 = lonToTileX(bbox.east, z);
    const y0 = latToTileY(bbox.north, z), y1 = latToTileY(bbox.south, z);
    for (let x = x0; x <= x1; x++)
      for (let y = y0; y <= y1; y++)
        tiles.push(`https://${subs[(x + y) % 3]}.tile.opentopomap.org/${z}/${x}/${y}.png`);
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
async function downloadOfflineZone(zone, onProgress) {
  const tiles = _zoneTiles(zone.bbox);
  const cache = await caches.open('bwr-offline-tiles');
  let done = 0, ok = 0;
  const BATCH = 4; // gentle on the tile server; avoids triggering rate limits
  for (let i = 0; i < tiles.length; i += BATCH) {
    const results = await Promise.all(
      tiles.slice(i, i + BATCH).map(t => _fetchTileWithRetry(cache, t))
    );
    ok += results.filter(Boolean).length;
    done += results.length;
    if (onProgress) onProgress(Math.round(done / tiles.length * 100));
    await _sleep(120); // brief pause between batches
  }
  const failed = tiles.length - ok;
  // Only flag the zone as fully cached when essentially everything stored.
  // A partial download stays un-flagged so the user is told to retry rather
  // than discovering blank patches in the forest with no signal.
  if (ok / tiles.length >= 0.97) localStorage.setItem(_zoneCacheKey(zone.id), '1');
  else localStorage.removeItem(_zoneCacheKey(zone.id));
  return { total: tiles.length, ok, failed };
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
        const { total, ok, failed } = await downloadOfflineZone(zone, pct => { btn.textContent = `⏳ ${pct}%`; });
        if (failed === 0) {
          btn.textContent = '✅ Téléchargée';
          showToast(`✅ ${zone.name} sauvegardée hors-ligne ! (${ok} tuiles)`);
        } else if (ok / total >= 0.97) {
          // essentially complete — flagged as cached, minor gaps acceptable
          btn.textContent = '✅ Téléchargée';
          showToast(`✅ ${zone.name} sauvegardée (${ok}/${total} tuiles)`);
        } else {
          // too patchy to trust offline — keep it as a retry, don't fake success
          btn.textContent = '⚠️ Incomplète — réessayer';
          showToast(`⚠️ ${zone.name} : ${ok}/${total} tuiles seulement (limite du serveur). Réessayez dans un instant.`);
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
