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

async function downloadOfflineZone(zone, onProgress) {
  const tiles = _zoneTiles(zone.bbox);
  const cache = await caches.open('bwr-offline-tiles');
  let done = 0;
  const BATCH = 8;
  for (let i = 0; i < tiles.length; i += BATCH) {
    await Promise.all(tiles.slice(i, i + BATCH).map(async tileUrl => {
      try { await cache.put(tileUrl, await fetch(tileUrl, { mode: 'no-cors' })); } catch {}
      done++;
    }));
    if (onProgress) onProgress(Math.round(done / tiles.length * 100));
  }
  localStorage.setItem(_zoneCacheKey(zone.id), '1');
  return tiles.length;
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
        const count = await downloadOfflineZone(zone, pct => { btn.textContent = `⏳ ${pct}%`; });
        btn.textContent = '✅ Téléchargée';
        showToast(`✅ ${zone.name} sauvegardée hors-ligne ! (${count} tuiles)`);
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
