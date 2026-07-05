// map.js — core/entry for the map page. Creates the Leaflet map, the tile layers
// and the shared `let` state (allPaths / activeFilters / currentLayer), plus the
// user menu and the shared toast. This file is loaded FIRST on map.html (before
// map-paths.js, map-locate.js and map-sync.js) because it declares `const map`
// and other shared state those modules reference at load time. The page bootstrap
// lives at the bottom of map-sync.js (loaded last).

// ── Lazy-loader helper ────────────────────────────────────────────────────────
const _scriptCache = {};
function loadScript(src) {
  if (_scriptCache[src]) return _scriptCache[src];
  _scriptCache[src] = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.head.appendChild(s);
  });
  return _scriptCache[src];
}
const _loadMapEdit    = () => loadScript('js/map-edit.js');
const _loadMapOffline = () => loadScript('js/map-offline.js');

const LAYER_MAX_ZOOM = { osm: 19, ign: 17, satellite: 20 };
const TILE_LAYERS = {
  osm: L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    { attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>', maxNativeZoom: 19, maxZoom: 19, detectRetina: true, updateWhenIdle: false, keepBuffer: 4 }
  ),
  ign: L.tileLayer(
    'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
    // crossOrigin: tiles are requested with CORS (OpenTopoMap sends ACAO:*) so the
    // service worker caches them as non-opaque, dated, real-sized responses. Opaque
    // tiles are padded to several MB each by iOS Safari and blow the cache quota.
    // maxNativeZoom 15: offline downloads only cache z10–15 (z16+ is thousands of
    // tiles per forest and gets rate-limited by OpenTopoMap). Capping the native
    // zoom at 15 means Leaflet never requests a z16/17 tile — it upscales the
    // cached z15 tile instead, so zooming in offline stays sharp-enough rather
    // than going blank. maxZoom 17 still lets the user zoom that far.
    { attribution: 'Map data: &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, <a href="http://viewfinderpanoramas.org">SRTM</a> | Style: &copy; <a href="https://opentopomap.org">OpenTopoMap</a>', maxNativeZoom: 15, maxZoom: 17, subdomains: ['a','b','c'], crossOrigin: true, updateWhenIdle: false, keepBuffer: 4 }
  ),
  satellite: L.tileLayer(
    'https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=ORTHOIMAGERY.ORTHOPHOTOS&STYLE=normal&FORMAT=image/jpeg&TILEMATRIXSET=PM&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}',
    { attribution: '&copy; <a href="https://www.geoportail.gouv.fr/">IGN</a>', maxNativeZoom: 20, maxZoom: 20, detectRetina: true, updateWhenIdle: false, keepBuffer: 4 }
  ),
};

// Self-heal grey tiles. When you zoom/pan, Leaflet fires a burst of tile
// requests at once; OpenTopoMap rate-limits part of the burst (429/403) and
// Leaflet then leaves those tiles a PERMANENT grey square — it never re-requests
// a failed tile on its own. That's why half the forest goes grey behind the
// coloured paths while the rest of the map is fine. Here we re-request each
// failed tile a few times with a growing backoff, long enough to outlast the
// server's rate-limit window, so the grey gaps fill themselves in.
const _TILE_RETRY_DELAYS = [600, 1500, 3000, 5000]; // ms; total reach ~10s
function makeTilesSelfHealing(layer) {
  layer.on('tileerror', (e) => {
    const img = e.tile;
    if (!img) return;
    const tries = img._bwrRetries || 0;
    if (tries >= _TILE_RETRY_DELAYS.length) return; // give up; avoid retry loops
    img._bwrRetries = tries + 1;
    // Drop any previous retry marker, then add a fresh one. Keep existing query
    // params intact (the satellite WMTS URL carries its tile coords in the query).
    const base = (img.src || '').replace(/[?&]bwrRetry=\d+/, '');
    const sep = base.includes('?') ? '&' : '?';
    setTimeout(() => { img.src = base + sep + 'bwrRetry=' + (tries + 1); }, _TILE_RETRY_DELAYS[tries]);
  });
}
Object.values(TILE_LAYERS).forEach(makeTilesSelfHealing);

const _cachedUser = (typeof getCachedUser === 'function') ? getCachedUser() : null;
const _userPlan   = (typeof BWR !== 'undefined') ? BWR.normalisePlan(_cachedUser?.plan) : (_cachedUser?.plan || 'free');

const map = L.map('map', { zoomControl: true, minZoom: 8, maxZoom: LAYER_MAX_ZOOM.ign }).setView(MAP_CENTER, MAP_ZOOM);
window.map = map; // expose for the shared GPS tracker (js/gps-tracker.js)
TILE_LAYERS.ign.addTo(map);

let currentLayer = 'ign';
let allPaths = [];
let activeFilters = new Set(['easy', 'medium', 'hard', 'not_passable', 'no_bike']);

if (typeof addForestBoundaries === 'function') addForestBoundaries(map);

// Recalculate map size whenever the browser chrome resizes or scrolls
// (address bar show/hide, keyboard appearing, iOS Safari toolbar, etc.)
if (window.visualViewport) {
  const _onVVChange = () => map.invalidateSize({ animate: false });
  window.visualViewport.addEventListener('resize', _onVVChange);
  window.visualViewport.addEventListener('scroll', _onVVChange);
}
// Also catch any late layout settle after all resources load
window.addEventListener('load', () => requestAnimationFrame(() => map.invalidateSize({ animate: false })));

// ── User menu ─────────────────────────────────────────────────────────────────
async function initUserMenu() {
  const user = getCachedUser();
  const menuEl = document.getElementById('userMenu');

  if (!user) {
    menuEl.innerHTML = `<a href="login" class="btn-icon">Connexion</a>`;
    return;
  }

  // Show path-edit button in drawer for silver+ users
  if (BWR.can('path_difficulty_edit', _userPlan)) {
    document.getElementById('btnEditPaths')?.classList.remove('hidden');
  }

  if (user.role === 'admin') {
    document.getElementById('navDrawerAdmin')?.classList.remove('hidden');
  }

  const initials = user.name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);
  menuEl.innerHTML = `
    <button class="user-btn" id="userBtn">
      <div class="user-avatar">${initials}</div>
      <span class="btn-label">${user.name.split(' ')[0]}</span>
    </button>
    <div class="user-dropdown hidden" id="userDropdown">
      <span class="dropdown-name">${user.name}</span>
      <a href="/">🏠 Accueil</a>
      <a href="profile">👤 Mon profil</a>
      ${user.role === 'admin' ? '<a href="admin">⚙️ Panneau admin</a>' : ''}
      <button class="dropdown-logout" id="btnLogout">Se déconnecter</button>
    </div>
  `;

  document.getElementById('userBtn').addEventListener('click', () => {
    document.getElementById('userDropdown').classList.toggle('hidden');
  });

  document.getElementById('btnLogout').addEventListener('click', () => logout());

  document.addEventListener('click', (e) => {
    if (!menuEl.contains(e.target)) {
      document.getElementById('userDropdown')?.classList.add('hidden');
    }
  });
}

// ── Toast ───────────────────────────────────────────────────────────────────
// Shared by every map module (map-paths / map-locate / map-sync).
let toastTimer = null;
function showToast(msg) {
  let el = document.getElementById('mapToast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'mapToast';
    el.className = 'map-toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('visible'), 3000);
}
