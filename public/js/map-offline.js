// ── Offline tile download ─────────────────────────────────────────────────────
// Lazy-loaded by map.js when the user first clicks the "Télécharger" button.

function lonToTileX(lon, z) { return Math.floor((lon + 180) / 360 * Math.pow(2, z)); }
function latToTileY(lat, z) {
  return Math.floor((1 - Math.log(Math.tan(lat * Math.PI / 180) + 1 / Math.cos(lat * Math.PI / 180)) / Math.PI) / 2 * Math.pow(2, z));
}

// Hardcoded bounding box for the entire Forêt de Compiègne
const FOREST_BBOX = { north: 49.47, south: 49.27, west: 2.65, east: 3.10 };

async function downloadOfflineTiles() {
  if (!BWR.can('offline_cache', _userPlan)) {
    showToast('🔒 Cartes hors-ligne disponibles avec Argent — voir plans');
    return;
  }

  const btn = document.getElementById('btnOffline');
  if (btn && btn.dataset.downloading === '1') return;

  // Build tile list for the full forest bbox at zoom 10–15
  const tiles = [];
  const subs  = ['a', 'b', 'c'];
  for (let z = 10; z <= 15; z++) {
    const x0 = lonToTileX(FOREST_BBOX.west, z),  x1 = lonToTileX(FOREST_BBOX.east, z);
    const y0 = latToTileY(FOREST_BBOX.north, z),  y1 = latToTileY(FOREST_BBOX.south, z);
    for (let x = x0; x <= x1; x++)
      for (let y = y0; y <= y1; y++)
        tiles.push(`https://${subs[(x + y) % 3]}.tile.opentopomap.org/${z}/${x}/${y}.png`);
  }

  if (btn) {
    btn.dataset.downloading = '1';
    btn.querySelector('.btn-emoji').textContent = '⏳';
    btn.querySelector('.btn-label').textContent = '0%';
    btn.disabled = true;
  }

  try {
    const cache = await caches.open('bwr-offline-tiles');
    let done = 0;
    const BATCH = 8;
    for (let i = 0; i < tiles.length; i += BATCH) {
      await Promise.all(tiles.slice(i, i + BATCH).map(async tileUrl => {
        try { await cache.put(tileUrl, await fetch(tileUrl, { mode: 'no-cors' })); } catch {}
        done++;
      }));
      if (btn) btn.querySelector('.btn-label').textContent = `${Math.round(done / tiles.length * 100)}%`;
    }
    localStorage.setItem('bwr_forest_cached', '1');
    showToast(`✅ Forêt de Compiègne sauvegardée hors-ligne ! (${tiles.length} tuiles)`);
  } catch {
    showToast('Erreur lors du téléchargement hors-ligne');
  } finally {
    if (btn) {
      delete btn.dataset.downloading;
      btn.querySelector('.btn-emoji').textContent = '✅';
      btn.querySelector('.btn-label').textContent = 'Téléchargée';
      btn.disabled = false;
    }
  }
}
