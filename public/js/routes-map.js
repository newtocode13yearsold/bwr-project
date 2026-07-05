// routes-map.js — Leaflet map, geolocation, address search, saved-path overlay,
// save/share buttons and deep-links for the route planner page.
// Split out of routes.js. Classic script: loaded before js/routes.js (the entry
// file that declares shared `let` state and runs the boot IIFE last). The planner
// UX lives in js/routes-planner.js; routing engines in js/routes-engine.js.

// ── Map ───────────────────────────────────────────────────────────────────────
const LAYER_MAX_ZOOM = { ign: 17, osm: 19, satellite: 20 };
const TILE_LAYERS = {
  ign: () => L.tileLayer(
    'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
    // maxNativeZoom 15 + crossOrigin: must mirror the map page (js/map.js) so the
    // offline-downloaded forest tiles (cached z10–15, CORS/non-opaque) cover this
    // page too. Without the cap, zooming past 15 requests uncached z16/17 tiles
    // and the route planner goes blank offline.
    { attribution: 'Map data: &copy; OpenStreetMap contributors, SRTM | Style: &copy; OpenTopoMap', maxNativeZoom: 15, maxZoom: 17, subdomains: ['a','b','c'], crossOrigin: true }
  ),
  osm: () => L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    { attribution: '© OpenStreetMap', maxNativeZoom: 19, maxZoom: 19, detectRetina: true }
  ),
  satellite: () => L.tileLayer(
    'https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=ORTHOIMAGERY.ORTHOPHOTOS&STYLE=normal&FORMAT=image/jpeg&TILEMATRIXSET=PM&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}',
    { attribution: '© IGN', maxNativeZoom: 20, maxZoom: 20, detectRetina: true }
  ),
};
let currentTile = null;

// Self-heal grey tiles. On zoom/pan Leaflet fires a burst of tile requests;
// OpenTopoMap rate-limits part of the burst (429/403) and then leaves those
// tiles a PERMANENT grey square — it never re-requests a failed tile on its own,
// which is why half the forest goes grey behind the route. Re-request each failed
// tile a few times with a growing backoff (long enough to outlast the rate-limit
// window) so the gaps fill themselves in. Mirrors the map page (js/map.js).
const _TILE_RETRY_DELAYS = [600, 1500, 3000, 5000];
function makeTilesSelfHealing(layer) {
  layer.on('tileerror', (e) => {
    const img = e.tile;
    if (!img) return;
    const tries = img._bwrRetries || 0;
    if (tries >= _TILE_RETRY_DELAYS.length) return; // give up; avoid retry loops
    img._bwrRetries = tries + 1;
    // Keep existing query params intact (the satellite WMTS URL carries its tile
    // coords in the query); just swap our own retry marker.
    const base = (img.src || '').replace(/[?&]bwrRetry=\d+/, '');
    const sep = base.includes('?') ? '&' : '?';
    setTimeout(() => { img.src = base + sep + 'bwrRetry=' + (tries + 1); }, _TILE_RETRY_DELAYS[tries]);
  });
  return layer;
}

function initMap() {
  const plan = currentUser?.plan || 'free';
  const defaultLayer = BWR.can('ign_topo_tiles', plan) ? 'ign' : 'osm';
  map = L.map('map', { zoomControl: true, maxZoom: LAYER_MAX_ZOOM[defaultLayer] }).setView(MAP_CENTER, MAP_ZOOM);
  currentTile = makeTilesSelfHealing(TILE_LAYERS[defaultLayer]());
  currentTile.addTo(map);
  // Reflect that on the layer-button row if it exists
  setTimeout(() => {
    document.querySelectorAll('.layer-btn').forEach(b => b.classList.toggle('active', b.dataset.layer === defaultLayer));
  }, 0);
  map.on('click', onMapClick);
  setTimeout(() => map.invalidateSize(), 100);
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', () => map.invalidateSize());
  }
  if (typeof addForestBoundaries === 'function') addForestBoundaries(map);

  // Layer switcher
  document.querySelectorAll('.layer-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      map.removeLayer(currentTile);
      const layerKey = btn.dataset.layer;
      map.setMaxZoom(LAYER_MAX_ZOOM[layerKey]);
      currentTile = makeTilesSelfHealing(TILE_LAYERS[layerKey]());
      currentTile.addTo(map);
      document.querySelectorAll('.layer-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
  });
}

// ── Geolocation ───────────────────────────────────────────────────────────────
document.getElementById('btnLocate').addEventListener('click', () => {
  if (!navigator.geolocation) return;
  const btn = document.getElementById('btnLocate');
  btn.textContent = '⏳';
  navigator.geolocation.getCurrentPosition(
    pos => {
      btn.textContent = '📍';
      const { latitude: lat, longitude: lng } = pos.coords;
      map.setView([lat, lng], 15);
      if (mode) onMapClick({ latlng: { lat, lng } });
    },
    () => { btn.textContent = '📍'; }
  );
});

// ── Address search ────────────────────────────────────────────────────────────
let searchTimeout = null;
document.getElementById('addressInput').addEventListener('input', e => {
  clearTimeout(searchTimeout);
  const q = e.target.value.trim();
  // Persist whatever is typed so the address stays "locked in" across pages,
  // even before the user picks a suggestion. Shared with the map page.
  if (q) localStorage.setItem('bwr_saved_address', JSON.stringify({ label: e.target.value }));
  else localStorage.removeItem('bwr_saved_address');
  if (q.length < 3) {
    hideSearch();
    return;
  }
  searchTimeout = setTimeout(() => doSearch(q), 400);
});

document.getElementById('addressInput').addEventListener('blur', () => {
  setTimeout(hideSearch, 200);
});

async function doSearch(q) {
  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=5&countrycodes=fr`,
      { headers: { 'Accept-Language': 'fr' } }
    );
    const data = await res.json();
    showSearchResults(data);
  } catch {}
}

function showSearchResults(results) {
  const el = document.getElementById('searchResults');
  if (!results.length) { hideSearch(); return; }
  el.innerHTML = results.map(r => `
    <div class="search-item" data-lat="${escapeHtml(String(r.lat))}" data-lon="${escapeHtml(String(r.lon))}">
      ${escapeHtml(r.display_name.split(',').slice(0, 3).join(', '))}
    </div>
  `).join('');
  el.classList.remove('hidden');
  el.querySelectorAll('.search-item').forEach(item => {
    item.addEventListener('mousedown', () => {
      const lat = parseFloat(item.dataset.lat);
      const lng = parseFloat(item.dataset.lon);
      const label = item.textContent.trim();
      map.setView([lat, lng], 15);
      document.getElementById('addressInput').value = label;
      localStorage.setItem('bwr_saved_address', JSON.stringify({ label, lat, lng }));
      hideSearch();
      if (mode) onMapClick({ latlng: { lat, lng } });
    });
  });
}

function hideSearch() {
  document.getElementById('searchResults').classList.add('hidden');
}

function restoreSavedAddress() {
  try {
    const saved = JSON.parse(localStorage.getItem('bwr_saved_address'));
    if (!saved || !saved.label) return;
    const savedMode = localStorage.getItem('bwr_saved_mode');
    if (savedMode) {
      const card = document.querySelector(`.mode-card[data-mode="${savedMode}"]`);
      if (card && !card.classList.contains('locked-feature')) card.click();
    }
    document.getElementById('addressInput').value = saved.label;
    // Only recentre when we have real coordinates (a typed-but-not-selected
    // address has just a label).
    if (typeof saved.lat === 'number' && typeof saved.lng === 'number') {
      map.setView([saved.lat, saved.lng], 15);
    }
  } catch (_) {}
}

async function loadSavedPaths() {
  try {
    const res = await fetch(`${API_URL}/api/paths`);
    const data = await res.json();
    // Offline with nothing cached yet returns {error:"offline"}, not an array.
    savedPaths = Array.isArray(data) ? data : [];
    savedPathsLayer = L.layerGroup();
    savedPaths.forEach(p => {
      L.polyline(p.coordinates, {
        color: STATUS_COLORS[p.status] || '#9ca3af',
        weight: 4, opacity: 0.55,
      }).bindTooltip(p.name || '').addTo(savedPathsLayer);
    });
    savedPathsLayer.addTo(map);
  } catch {}
}

// ── Save / share buttons ──────────────────────────────────────────────────────
function setSaveShareEnabled(enabled) {
  const plan = currentUser?.plan || 'free';
  const canSave = BWR.can('route_history', plan);
  const btnSave  = document.getElementById('btnSaveRoute');
  const btnShare = document.getElementById('btnShareRoute');
  if (btnSave)  btnSave.disabled  = !enabled || !canSave;
  if (btnShare) btnShare.disabled = !enabled || !canSave;
}

function initSaveShareButtons() {
  const plan = currentUser?.plan || 'free';
  const canSave = BWR.can('route_history', plan);

  const btnSave = document.getElementById('btnSaveRoute');
  const btnShare = document.getElementById('btnShareRoute');

  if (!btnSave || !btnShare) return;

  btnSave.disabled  = true;
  btnShare.disabled = true;

  if (!canSave) {
    btnSave.onclick  = () => showUpgradeModal('silver', 'La sauvegarde de trajets');
    btnShare.onclick = () => showUpgradeModal('silver', 'Le partage de trajets');
    return;
  }

  // Lazy-load route-save.js on first click
  btnSave.onclick  = async () => { await _loadRouteSave(); saveCurrentRoute(); };
  btnShare.onclick = async () => { await _loadRouteSave(); shareCurrentRoute(); };
}

// ── Save / share / history → js/route-save.js (lazy-loaded) ──────────────────

function initRouteHistory() {
  const plan = currentUser?.plan || 'free';
  const panelEl = document.getElementById('routeHistory');
  if (!panelEl) return;

  const lazyToggle = async () => { await _loadRouteSave(); toggleHistory(); };

  if (!BWR.can('route_history', plan)) {
    panelEl.classList.remove('hidden');
    const body = document.getElementById('historyBody');
    body.style.display = 'none';
    body.innerHTML = `
      <div class="history-empty">
        <p>🔒 Sauvegardez vos trajets avec le plan Argent.</p>
        <a href="plans" style="color:#6d28d9;font-weight:700">Voir les plans →</a>
      </div>`;
    document.getElementById('historyToggle').addEventListener('click', lazyToggle);
    return;
  }

  panelEl.classList.remove('hidden');
  document.getElementById('historyBody').style.display = 'none';
  document.getElementById('historyToggle').addEventListener('click', lazyToggle);
}

// ── Best tour deep-link (?lat=&lng=&distance=&mode=&type=&diff=) ──────────────
function handleBestTourParam() {
  const params = new URLSearchParams(location.search);
  const lat = parseFloat(params.get('lat'));
  const lng = parseFloat(params.get('lng'));
  if (!lat || !lng) return;

  const targetMode = params.get('mode') || 'loop';
  const targetType = params.get('type') || 'foot';
  const targetDiff = params.get('diff') || 'easy';
  const targetDist = parseFloat(params.get('distance')) || 10;

  // Select mode
  const modeCard = document.querySelector(`.mode-card[data-mode="${targetMode}"]`);
  if (modeCard && !modeCard.classList.contains('locked-feature')) modeCard.click();

  // Select path type
  const typeBtn = document.querySelector(`.pathtype-btn[data-type="${targetType}"]`);
  if (typeBtn) {
    document.querySelectorAll('.pathtype-btn').forEach(b => b.classList.remove('active'));
    typeBtn.classList.add('active');
    pathType = targetType;
    syncTransportToPathType(pathType);
  }

  // Select difficulty
  const diffBtn = document.querySelector(`.diff-btn[data-diff="${targetDiff}"]`);
  if (diffBtn) {
    document.querySelectorAll('.diff-btn[data-diff]').forEach(b => b.classList.remove('active'));
    diffBtn.classList.add('active');
    difficulty = targetDiff;
  }

  // Set distance
  if (targetMode === 'loop') {
    const distInput = document.getElementById('distanceInput');
    if (distInput) distInput.value = targetDist;
  }

  // Pan map, place start marker, then auto-generate
  map.setView([lat, lng], 14);
  setTimeout(() => {
    onMapClick({ latlng: { lat, lng } });
    setTimeout(() => {
      const btnGen = document.getElementById('btnGenerate');
      if (btnGen && !btnGen.disabled) btnGen.click();
    }, 500);
  }, 400);
}

// ── Shared route from URL (?share=token) ──────────────────────────────────────
async function handleSharedRouteParam() {
  const token = new URLSearchParams(location.search).get('share');
  if (!token) return;

  try {
    const res = await fetch(`${API_URL}/api/savedroutes/share/${token}`);
    if (!res.ok) { showToast('Lien de partage invalide ou expiré.'); return; }
    const route = await res.json();

    const color = route.difficulty === 'easy' ? '#22c55e' : route.difficulty === 'medium' ? '#f97316' : '#ef4444';
    if (routeLayer) map.removeLayer(routeLayer);
    routeLayer = L.polyline(route.coords, { color, weight: 6, opacity: 0.9 }).addTo(map);
    map.fitBounds(routeLayer.getBounds(), { padding: [40, 40] });

    const km   = (route.meters / 1000).toFixed(2);
    const modeIcon = route.mode === 'loop' ? '🔄 Boucle' : '➡️ A → B';
    const banner = document.createElement('div');
    banner.className = 'shared-route-banner';
    banner.innerHTML = `🔗 Trajet partagé : <strong>${escapeHtml(route.name)}</strong> — ${modeIcon}, ${km} km`;
    document.getElementById('routeResult').prepend(banner);
    document.getElementById('routeResult').classList.remove('hidden');
  } catch {
    showToast('Impossible de charger le trajet partagé.');
  }
}
