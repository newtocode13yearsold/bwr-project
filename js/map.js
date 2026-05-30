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
    { attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>', maxNativeZoom: 19, maxZoom: 19, detectRetina: true }
  ),
  ign: L.tileLayer(
    'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
    { attribution: 'Map data: &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, <a href="http://viewfinderpanoramas.org">SRTM</a> | Style: &copy; <a href="https://opentopomap.org">OpenTopoMap</a>', maxNativeZoom: 17, maxZoom: 17, subdomains: ['a','b','c'] }
  ),
  satellite: L.tileLayer(
    'https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=ORTHOIMAGERY.ORTHOPHOTOS&STYLE=normal&FORMAT=image/jpeg&TILEMATRIXSET=PM&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}',
    { attribution: '&copy; <a href="https://www.geoportail.gouv.fr/">IGN</a>', maxNativeZoom: 20, maxZoom: 20, detectRetina: true }
  ),
};

const _cachedUser = (typeof getCachedUser === 'function') ? getCachedUser() : null;
const _userPlan   = (typeof BWR !== 'undefined') ? BWR.normalisePlan(_cachedUser?.plan) : (_cachedUser?.plan || 'free');

const map = L.map('map', { zoomControl: true, minZoom: 10, maxZoom: LAYER_MAX_ZOOM.ign }).setView(MAP_CENTER, MAP_ZOOM);
TILE_LAYERS.ign.addTo(map);

let currentLayer = 'ign';
let allPaths = [];
let activeFilters = new Set(['easy', 'medium', 'hard', 'not_passable', 'no_bike']);

// ── Path tile layer ────────────────────────────────────────────────────────────
// Paths are drawn directly onto map tiles so they scale at exactly the same rate
// as the basemap — no polyline overlays, no weight-update lag.
const PathTileLayer = L.GridLayer.extend({
  initialize(options) {
    L.GridLayer.prototype.initialize.call(this, options);
    this._paths = [];
    this._filters = new Set();
  },
  setPaths(paths, filters) {
    this._paths = paths;
    if (filters) this._filters = new Set(filters);
    this.redraw();
  },
  createTile(coords) {
    const size   = this.getTileSize();
    const canvas = document.createElement('canvas');
    canvas.width = size.x;
    canvas.height = size.y;
    const ctx = canvas.getContext('2d');
    const map = this._map;
    if (!map || !this._paths.length) return canvas;

    const z   = coords.z;
    const ox  = coords.x * size.x;
    const oy  = coords.y * size.y;
    // Real-world trail width (20 m) converted to pixels at this zoom level
    const mpp = 40075016 * Math.cos(49.35 * Math.PI / 180) / (256 * Math.pow(2, z));
    const sw  = Math.max(1.5, Math.min(12, 20 / mpp));

    ctx.lineCap     = 'round';
    ctx.lineJoin    = 'round';
    ctx.globalAlpha = 0.85;
    ctx.lineWidth   = sw;

    this._paths.forEach(path => {
      if (!this._filters.has(path.status)) return;
      if (!path.coordinates || path.coordinates.length < 2) return;
      const pts = path.coordinates.map(([lat, lng]) => {
        const pt = map.project(L.latLng(lat, lng), z);
        return { x: pt.x - ox, y: pt.y - oy };
      });

      ctx.strokeStyle = STATUS_COLORS[path.status] || '#9ca3af';
      ctx.setLineDash([]);
      ctx.beginPath();
      pts.forEach((p, i) => i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y));
      ctx.stroke();

      if (path.pathType === 'bike') {
        // Dot spacing ~18 m in pixels at this zoom
        const dotGap = Math.max(6, Math.min(28, 18 / mpp));
        ctx.save();
        ctx.strokeStyle = 'rgba(255,255,255,0.85)';
        ctx.lineWidth = sw * 0.38;
        ctx.lineCap = 'round';
        ctx.setLineDash([0.1, dotGap]);
        ctx.beginPath();
        pts.forEach((p, i) => i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y));
        ctx.stroke();
        ctx.restore();
      }
    });
    return canvas;
  },
});

const pathTileLayer = new PathTileLayer({ tileSize: 256, zIndex: 200 });
pathTileLayer.addTo(map);

if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', () => map.invalidateSize());
}

// ── User menu ─────────────────────────────────────────────────────────────────
async function initUserMenu() {
  const user = getCachedUser();
  const menuEl = document.getElementById('userMenu');

  if (!user) {
    menuEl.innerHTML = `<a href="login.html" class="btn-icon">Connexion</a>`;
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
      ${user.name.split(' ')[0]}
    </button>
    <div class="user-dropdown hidden" id="userDropdown">
      <span class="dropdown-name">${user.name}</span>
      <a href="index.html">🏠 Accueil</a>
      <a href="profile.html">👤 Mon profil</a>
      ${user.role === 'admin' ? '<a href="admin.html">⚙️ Panneau admin</a>' : ''}
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

// ── Offline queue (map page) ───────────────────────────────────────────────────
function getMapPatches() {
  try { return JSON.parse(localStorage.getItem('bwr_map_patches') || '[]'); } catch { return []; }
}
function saveMapPatches(q) { localStorage.setItem('bwr_map_patches', JSON.stringify(q)); }

function getMapReports() {
  try { return JSON.parse(localStorage.getItem('bwr_map_reports') || '[]'); } catch { return []; }
}
function saveMapReports(q) { localStorage.setItem('bwr_map_reports', JSON.stringify(q)); }

function updateMapSyncBanner() {
  const banner = document.getElementById('mapSyncBanner');
  if (!banner) return;
  const total = getMapPatches().length + getMapReports().length;
  if (total === 0) { banner.style.display = 'none'; return; }
  banner.style.display = 'flex';
  banner.querySelector('.sync-count').textContent =
    `${total} changement${total > 1 ? 's' : ''} en attente de synchronisation`;
}

function queueMapPatch(pathId, newStatus) {
  const q = getMapPatches();
  const existing = q.findIndex(item => item.id === pathId);
  if (existing !== -1) q[existing].status = newStatus; else q.push({ id: pathId, status: newStatus });
  saveMapPatches(q);
  updateMapSyncBanner();
}

function queueMapReport(data) {
  const q = getMapReports();
  if (q.length >= 20) { showToast('⚠️ File hors-ligne pleine (20 signalements max).'); return; }
  q.push({ ...data, queuedAt: Date.now() });
  try {
    saveMapReports(q);
  } catch {
    // localStorage full — retry without photo
    q[q.length - 1].photo = null;
    try { saveMapReports(q); } catch {}
  }
  updateMapSyncBanner();
}

async function replayMapPatches() {
  const q = getMapPatches();
  if (q.length === 0) return;
  document.getElementById('mapSyncBanner')?.classList.add('syncing');
  let remaining = [];
  for (const item of q) {
    try {
      const res = await fetch(`${API_URL}/api/paths/${item.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...authHeader() },
        body: JSON.stringify({ status: item.status }),
      });
      if (!res.ok) remaining.push(item);
    } catch { remaining.push(item); }
  }
  saveMapPatches(remaining);
  document.getElementById('mapSyncBanner')?.classList.remove('syncing');
  updateMapSyncBanner();
  if (remaining.length === 0 && q.length > 0) {
    showToast('✅ Synchronisation terminée — difficultés envoyées !');
    await loadPaths();
  }
}

async function replayMapReports() {
  const q = getMapReports();
  if (q.length === 0) return;
  document.getElementById('mapSyncBanner')?.classList.add('syncing');
  let remaining = [];
  for (const item of q) {
    try {
      const { queuedAt, ...payload } = item;
      const res = await fetch(`${API_URL}/api/reports`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeader() },
        body: JSON.stringify(payload),
      });
      if (!res.ok) remaining.push(item);
    } catch { remaining.push(item); }
  }
  saveMapReports(remaining);
  document.getElementById('mapSyncBanner')?.classList.remove('syncing');
  updateMapSyncBanner();
  if (remaining.length === 0 && q.length > 0) {
    showToast('✅ Synchronisation terminée — signalements envoyés !');
    loadReports();
  }
}

window.addEventListener('online', async () => {
  await replayMapPatches();
  await replayMapReports();
});

// ── Paths ─────────────────────────────────────────────────────────────────────
let walkedPathLayer = null;

async function loadPaths() {
  try {
    const res = await fetch(`${API_URL}/api/paths`);
    allPaths = await res.json();
    renderPaths();
    showPathHintIfNeeded();
    if (_userPlan === 'gold') loadWalkedOverlay();
  } catch {}
}

function renderPaths() {
  pathTileLayer.setPaths(allPaths, activeFilters);
}

// ── Passive walked-path tracking ─────────────────────────────────────────────
// Runs on every GPS fix while live location is active. Requires 3 hits within
// 35 m before marking a path as walked, to avoid false positives from inaccurate GPS.
const _walkHits = new Map();      // pathId → hit count
const _walkConfirmed = new Set(); // pathIds already sent to server this session
let _walkFlushTimer = null;

function _mapHaversineM(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function trackWalkedPaths(lat, lng) {
  if (!allPaths.length || !getToken()) return;
  let newConfirmed = false;
  for (const path of allPaths) {
    if (!path.id || _walkConfirmed.has(path.id)) continue;
    if (!path.coordinates || path.coordinates.length < 2) continue;
    const near = path.coordinates.some(([plat, plng]) => _mapHaversineM(lat, lng, plat, plng) < 35);
    if (near) {
      const hits = (_walkHits.get(path.id) || 0) + 1;
      _walkHits.set(path.id, hits);
      if (hits >= 3) {
        _walkConfirmed.add(path.id);
        newConfirmed = true;
      }
    }
  }
  if (!newConfirmed) return;
  clearTimeout(_walkFlushTimer);
  _walkFlushTimer = setTimeout(() => {
    fetch(`${API_URL}/api/walkedpaths`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeader() },
      body: JSON.stringify({ pathIds: [..._walkConfirmed] }),
    })
      .then(r => r.json())
      .then(() => { if (_userPlan === 'gold') loadWalkedOverlay(); })
      .catch(() => {});
  }, 4000);
}

async function loadWalkedOverlay() {
  try {
    const res = await fetch(`${API_URL}/api/walkedpaths`, {
      headers: { ...authHeader() },
    });
    if (!res.ok) return;
    const data = await res.json();
    renderWalkedOverlay(new Set(data.walkedPathIds || []));
  } catch {}
}

function renderWalkedOverlay(walkedIds) {
  if (walkedPathLayer) { walkedPathLayer.remove(); walkedPathLayer = null; }
  if (!walkedIds.size) return;
  walkedPathLayer = L.layerGroup();
  allPaths.forEach(path => {
    if (!walkedIds.has(path.id) || !path.coordinates || path.coordinates.length < 2) return;
    L.polyline(path.coordinates, {
      color: '#22c55e',
      weight: 7,
      opacity: 0.45,
      lineCap: 'round',
      lineJoin: 'round',
    }).addTo(walkedPathLayer);
  });
  walkedPathLayer.addTo(map);
}

// ── Silver path-edit hint chip ────────────────────────────────────────────────
let _pathHintDismissed = false;
function showPathHintIfNeeded() {
  if (_pathHintDismissed) return;
  if (!BWR.can('path_difficulty_edit', _userPlan)) return;
  if (document.getElementById('pathEditHint')) return;
  const chip = document.createElement('div');
  chip.id = 'pathEditHint';
  chip.className = 'path-edit-hint';
  chip.innerHTML = '✎ Clique sur un chemin pour modifier sa difficulté <button id="pathEditHintClose" title="Fermer">✕</button>';
  document.getElementById('map').appendChild(chip);
  document.getElementById('pathEditHintClose').addEventListener('click', dismissPathHint);
  setTimeout(dismissPathHint, 8000);
}
function dismissPathHint() {
  _pathHintDismissed = true;
  document.getElementById('pathEditHint')?.remove();
}

// ── Click detection on tile-rendered paths ────────────────────────────────────
function _ptSegDistPx(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (!len2) return p.distanceTo(a);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return p.distanceTo(L.point(a.x + t * dx, a.y + t * dy));
}

function _pathAtClick(latlng) {
  const cp = map.latLngToLayerPoint(latlng);
  const THRESH = 24; // px — minimum touch target size
  let best = null, bestD = THRESH;
  allPaths.forEach(path => {
    if (!activeFilters.has(path.status)) return;
    const coords = path.coordinates;
    for (let i = 0; i < coords.length - 1; i++) {
      const a = map.latLngToLayerPoint(coords[i]);
      const b = map.latLngToLayerPoint(coords[i + 1]);
      const d = _ptSegDistPx(cp, a, b);
      if (d < bestD) { bestD = d; best = path; }
    }
  });
  return best;
}

// Bounding box of the Forêt de Compiègne deployment zone
const FOREST_BOUNDS = L.latLngBounds(
  L.latLng(49.20, 2.65),
  L.latLng(49.50, 3.15)
);

map.on('click', e => {
  if (!FOREST_BOUNDS.contains(e.latlng)) {
    showToast('Désolé, nous n\'avons pas encore déployé à cet endroit.');
    return;
  }
  const path = _pathAtClick(e.latlng);
  if (path) {
    dismissPathHint();
    if (pathEditModeActive) openDifficultyPopup(path, e.latlng);
    else openPathPopup(path, e.latlng);
  }
});

// Cursor pointer when hovering near a path
let _hoverThrottle = null;
map.on('mousemove', e => {
  if (_hoverThrottle) return;
  _hoverThrottle = setTimeout(() => { _hoverThrottle = null; }, 40);
  const hit = _pathAtClick(e.latlng);
  map.getContainer().style.cursor = hit ? 'pointer' : (pathEditModeActive ? 'crosshair' : '');
});

// ── Path edit mode → js/map-edit.js (lazy-loaded) ────────────────────────────
let pathEditModeActive = false; // read by click/mousemove handlers above

document.getElementById('btnEditPaths')?.addEventListener('click', async () => {
  await _loadMapEdit();
  if (pathEditModeActive) exitPathEditMode();
  else enterPathEditMode();
});

// ── Path popup & report flow ──────────────────────────────────────────────────
const REPORT_ICONS  = { fallen_tree:'🌲', flooded:'💧', muddy:'🟤', rutted:'🛞', broken_sign:'🪧', closed:'🚫', danger:'⚠️', other:'📝' };
const REPORT_LABELS = { fallen_tree:'Arbre tombé', flooded:'Chemin inondé', muddy:'Boueux', rutted:'Ornières', broken_sign:'Carrefour cassé', closed:'Chemin fermé', danger:'Danger', other:'Autre' };

function openPathPopup(path, latlng) {
  const condHTML = path.conditions?.length
    ? `<div class="popup-cond-row">${path.conditions.map(c => {
        const icons2 = { dry:'✅', muddy:'🟤', rutted:'🛞', fallen:'❌', mtb:'🚴', running:'🏃', family:'👨‍👩‍👧' };
        const labels2 = { dry:'Sec', muddy:'Boueux', rutted:'Ornières', fallen:'Arbres tombés', mtb:'Idéal MTB', running:'Running', family:'Famille' };
        return `<span class="popup-cond-tag">${icons2[c] || ''} ${labels2[c] || c}</span>`;
      }).join('')}</div>` : '';

  const canEdit = BWR.can('path_difficulty_edit', _userPlan);
  const deleteHTML = canEdit
    ? `<button class="popup-delete-path-btn" id="deletePath-${path.id}">🗑 Supprimer ce chemin</button>`
    : '';

  const freeGradesLeft = canEdit
    ? Math.max(0, 5 - (_cachedUser?.stats?.unwalkedGrades || 0))
    : 0;
  const gradeHint = canEdit && freeGradesLeft < 5
    ? `<div class="popup-grade-quota">${freeGradesLeft > 0 ? `${freeGradesLeft} notation${freeGradesLeft > 1 ? 's' : ''} libre${freeGradesLeft > 1 ? 's' : ''} restante${freeGradesLeft > 1 ? 's' : ''}` : '🔒 Limite atteinte — parcourez ce chemin pour noter'}</div>`
    : '';

  const difficultyHTML = canEdit
    ? `<div class="popup-difficulty-section">
        <div class="popup-difficulty-label">🎨 Changer la difficulté :</div>
        <div class="popup-difficulty-btns" id="diffBtns-${path.id}">
          ${Object.entries(STATUS_COLORS).map(([status, color]) => `
            <button class="diff-btn ${path.status === status ? 'active' : ''}"
              style="background:${color}"
              data-status="${status}"
              title="${STATUS_LABELS[status]}">
              ${path.status === status ? '✓' : ''}
            </button>`).join('')}
        </div>
        <div class="popup-difficulty-legend">
          <span style="color:${STATUS_COLORS.easy}">● Facile</span>
          <span style="color:${STATUS_COLORS.medium}">● Moyen</span>
          <span style="color:${STATUS_COLORS.hard}">● Difficile</span>
          <span style="color:${STATUS_COLORS.not_passable}">● Impraticable</span>
          <span style="color:${STATUS_COLORS.no_bike}">● Vélo interdit</span>
        </div>
        ${gradeHint}
      </div>`
    : `<div class="popup-difficulty-locked">
        <span class="lock-tag">🔒 Argent</span>
        <span class="lock-hint">Modifier la difficulté</span>
      </div>`;

  L.popup({ maxWidth: 290, autoClose: false, closeOnClick: false })
    .setLatLng(latlng)
    .setContent(`
      <div class="popup">
        <strong>${path.name || 'Chemin sans nom'}</strong>
        <span class="popup-status" style="background:${STATUS_COLORS[path.status]}">${STATUS_LABELS[path.status] || path.status}</span>
        ${condHTML}
        ${path.notes ? `<p class="popup-notes">${path.notes}</p>` : ''}
        ${difficultyHTML}
        <div class="popup-report-section">
          <button class="popup-fallen-btn" id="openFallenTree-${path.id}">🌲 Arbre tombé ici</button>
          <button class="popup-fallen-btn" id="openFlooded-${path.id}">💧 Chemin inondé</button>
          <button class="popup-fallen-btn" id="openMuddy-${path.id}">🟤 Boueux ici</button>
          <button class="popup-fallen-btn" id="openRutted-${path.id}">🛞 Ornières ici</button>
          <button class="popup-fallen-btn" id="openBrokenSign-${path.id}">🪧 Carrefour cassé</button>
          <button class="popup-report-btn" id="openReport-${path.id}">⚠️ Autre problème</button>
        </div>
        ${deleteHTML}
      </div>
    `)
    .openOn(map);

  setTimeout(() => {
    if (canEdit) {
      document.querySelectorAll(`#diffBtns-${path.id} .diff-btn`).forEach(btn => {
        btn.addEventListener('click', async () => {
          const newStatus = btn.dataset.status;
          if (newStatus === path.status) { map.closePopup(); return; }
          try {
            const res = await fetch(`${API_URL}/api/paths/${path.id}`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json', ...authHeader() },
              body: JSON.stringify({ status: newStatus }),
            });
            if (res.ok) {
              path.status = newStatus;
              const idx = allPaths.findIndex(p => p.id === path.id);
              if (idx !== -1) allPaths[idx].status = newStatus;
              if (_cachedUser?.stats && !res.headers.get('x-already-graded')) {
                _cachedUser.stats.unwalkedGrades = (_cachedUser.stats.unwalkedGrades || 0) + 1;
              }
              renderPaths();
              map.closePopup();
              showToast(`✅ Difficulté mise à jour : ${STATUS_LABELS[newStatus]}`);
            } else if (res.status === 403) {
              const data = await res.json().catch(() => ({}));
              showToast(`🔒 ${data.error || 'Notation non autorisée.'}`);
            } else if (!navigator.onLine || res.status === 503) {
              path.status = newStatus;
              const idx = allPaths.findIndex(p => p.id === path.id);
              if (idx !== -1) allPaths[idx].status = newStatus;
              renderPaths();
              map.closePopup();
              queueMapPatch(path.id, newStatus);
              showToast('📶 Hors-ligne — changement enregistré, envoi à la reconnexion.');
            } else {
              showToast('Erreur lors de la mise à jour.');
            }
          } catch {
            path.status = newStatus;
            const idx = allPaths.findIndex(p => p.id === path.id);
            if (idx !== -1) allPaths[idx].status = newStatus;
            renderPaths();
            map.closePopup();
            queueMapPatch(path.id, newStatus);
            showToast('📶 Hors-ligne — changement enregistré, envoi à la reconnexion.');
          }
        });
      });
    }

    const guardReport = async (type) => {
      if (!BWR.can('reports_create', _userPlan)) {
        map.closePopup();
        showToast('🔒 Le signalement est disponible avec Argent — voir plans.html');
        return;
      }
      await _loadMapEdit();
      openReportPopup(path, latlng, type);
    };

    document.getElementById(`openFallenTree-${path.id}`)?.addEventListener('click', () => guardReport('fallen_tree'));
    document.getElementById(`openFlooded-${path.id}`)?.addEventListener('click', () => guardReport('flooded'));
    document.getElementById(`openMuddy-${path.id}`)?.addEventListener('click', () => guardReport('muddy'));
    document.getElementById(`openRutted-${path.id}`)?.addEventListener('click', () => guardReport('rutted'));
    document.getElementById(`openBrokenSign-${path.id}`)?.addEventListener('click', () => guardReport('broken_sign'));
    document.getElementById(`openReport-${path.id}`)?.addEventListener('click', () => guardReport('fallen_tree'));

    document.getElementById(`deletePath-${path.id}`)?.addEventListener('click', async () => {
      if (!confirm(`Supprimer "${path.name || 'ce chemin'}" ?`)) return;
      const res = await fetch(`${API_URL}/api/paths/${path.id}`, {
        method: 'DELETE',
        headers: authHeader(),
      });
      if (res.ok) {
        allPaths = allPaths.filter(p => p.id !== path.id);
        renderPaths();
        map.closePopup();
        showToast('🗑 Chemin supprimé.');
      } else {
        showToast('Erreur lors de la suppression.');
      }
    });
  }, 50);
}

function resizeImage(file, maxWidth = 800) {
  return new Promise(resolve => {
    const reader = new FileReader();
    reader.onload = e => {
      const img = new Image();
      img.onload = () => {
        const ratio = Math.min(1, maxWidth / img.width);
        const w = Math.round(img.width * ratio);
        const h = Math.round(img.height * ratio);
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/jpeg', 0.75));
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  });
}

// ── Difficulty / report popups → js/map-edit.js (lazy-loaded) ────────────────

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

// ── Filters ───────────────────────────────────────────────────────────────────
document.querySelectorAll('.filter-check').forEach(cb => {
  cb.addEventListener('change', () => {
    if (cb.checked) activeFilters.add(cb.value);
    else activeFilters.delete(cb.value);
    renderPaths();
    updateCount();
  });
});

document.querySelectorAll('input[name="tileLayer"]').forEach(radio => {
  radio.addEventListener('change', () => {
    const wanted = radio.value;
    const plan = _userPlan;
    // Gate satellite (Gold only) — show upsell instead of switching.
    if (wanted === 'satellite' && !BWR.can('satellite_tiles', plan)) {
      radio.checked = false;
      document.querySelector(`input[name="tileLayer"][value="${currentLayer}"]`).checked = true;
      showUpgradeToast('satellite', 'gold');
      return;
    }
    map.removeLayer(TILE_LAYERS[currentLayer]);
    currentLayer = wanted;
    map.setMaxZoom(LAYER_MAX_ZOOM[currentLayer]);
    TILE_LAYERS[currentLayer].addTo(map);
  });
});

// Visual lock badge next to gated tile-layer options
(function decoratePlanLocks() {
  document.querySelectorAll('label.filter-option').forEach(label => {
    const radio = label.querySelector('input[name="tileLayer"]');
    if (!radio) return;
    const v = radio.value;
    if (v === 'satellite' && !BWR.can('satellite_tiles', _userPlan)) {
      label.classList.add('plan-locked');
      label.insertAdjacentHTML('beforeend', ' <span class="tier-tag gold">👑 Or</span>');
    }
  });
})();

function showUpgradeToast(featureLabel, tier) {
  const planLabel = tier === 'gold' ? 'Or' : 'Argent';
  showToast(`🔒 ${featureLabel} est disponible avec le plan ${planLabel} — voir plans.html`);
}

document.getElementById('toggleFilters').addEventListener('click', () => {
  document.getElementById('filterPanel').classList.toggle('hidden');
});

// ── Locate me ─────────────────────────────────────────────────────────────────
let locationMarker = null;
let locationCircle = null;
let locationWatchId = null;
// states: 'idle' | 'searching' | 'following' | 'watching'
// 'following' = map re-centers on every GPS update (like Google Maps navigation)
// 'watching'  = dot visible but map no longer auto-pans (user dragged away)
let locateState = 'idle';

function showLocateToast(msg, isError = false) {
  let t = document.getElementById('locateToast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'locateToast';
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.className = 'locate-toast' + (isError ? ' locate-toast-error' : '');
  t.classList.add('visible');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove('visible'), 3500);
}

function _updateLocateBtn() {
  const btn = document.getElementById('btnLocate');
  if (!btn) return;
  btn.classList.remove('locate-following', 'locate-searching', 'locate-watching');
  switch (locateState) {
    case 'searching':
      btn.textContent = '⏳';
      btn.classList.add('locate-searching');
      btn.title = 'Annuler';
      break;
    case 'following':
      btn.textContent = '◎ Suivi actif';
      btn.classList.add('locate-following');
      btn.title = 'Arrêter le suivi';
      break;
    case 'watching':
      btn.textContent = '📍 Recentrer';
      btn.classList.add('locate-watching');
      btn.title = 'Recentrer sur ma position';
      break;
    default:
      btn.textContent = '📍 Ma position';
      btn.title = 'Ma position';
  }
}

function stopLocating() {
  if (locationWatchId !== null) {
    navigator.geolocation.clearWatch(locationWatchId);
    locationWatchId = null;
  }
  if (locationMarker) { map.removeLayer(locationMarker); locationMarker = null; }
  if (locationCircle) { map.removeLayer(locationCircle); locationCircle = null; }
  locateState = 'idle';
  _updateLocateBtn();
}

function updateLocationLayers(lat, lng, accuracy) {
  if (locationCircle) locationCircle.setLatLng([lat, lng]).setRadius(accuracy);
  else locationCircle = L.circle([lat, lng], {
    radius: accuracy,
    color: '#3b82f6', fillColor: '#93c5fd',
    fillOpacity: 0.15, weight: 1.5,
    interactive: false,
  }).addTo(map);

  if (locationMarker) locationMarker.setLatLng([lat, lng]);
  else locationMarker = L.marker([lat, lng], {
    icon: L.divIcon({
      className: 'location-dot-icon',
      html: '<div class="location-dot-inner"><div class="location-dot-pulse"></div></div>',
      iconAnchor: [8, 8],
      iconSize: [16, 16],
    }),
    zIndexOffset: 1000,
    interactive: true,
  }).bindPopup('Vous êtes ici').addTo(map);
}

// When the user manually pans the map, stop auto-centering but keep the dot
map.on('dragstart', () => {
  if (locateState === 'following') {
    locateState = 'watching';
    _updateLocateBtn();
  }
});

document.getElementById('btnLocate').addEventListener('click', () => {
  if (!navigator.geolocation) {
    showLocateToast('Géolocalisation non disponible', true);
    return;
  }

  // Dot visible but map drifted away → re-center and resume following
  if (locateState === 'watching') {
    if (locationMarker) {
      map.setView(locationMarker.getLatLng(), Math.max(map.getZoom(), 15), { animate: true, duration: 0.6 });
    }
    locateState = 'following';
    _updateLocateBtn();
    return;
  }

  // Active → stop everything
  if (locateState === 'following' || locateState === 'searching') {
    stopLocating();
    return;
  }

  // idle → start
  locateState = 'searching';
  _updateLocateBtn();

  locationWatchId = navigator.geolocation.watchPosition(
    ({ coords: { latitude: lat, longitude: lng, accuracy } }) => {
      const wasSearching = locateState === 'searching';
      if (wasSearching) {
        locateState = 'following';
        _updateLocateBtn();
        showLocateToast('Position trouvée' + (accuracy > 50 ? ` (±${Math.round(accuracy)} m)` : ''));
      }

      updateLocationLayers(lat, lng, accuracy);
      trackWalkedPaths(lat, lng);

      // Re-center map on every fix while following (Google Maps-style continuous tracking)
      if (locateState === 'following') {
        const targetZoom = wasSearching ? Math.max(map.getZoom(), 15) : map.getZoom();
        map.setView([lat, lng], targetZoom, { animate: true, duration: wasSearching ? 0.8 : 0.4 });
      }
    },
    (err) => {
      stopLocating();
      const msgs = {
        1: 'Permission refusée — autorise la localisation dans les réglages',
        2: 'Position introuvable',
        3: 'Délai dépassé — réessaie',
      };
      showLocateToast(msgs[err.code] || 'Erreur de localisation', true);
    },
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 }
  );
});

// ── Search bar ────────────────────────────────────────────────────────────────
let searchPin = null;
let searchTimer = null;

document.getElementById('mapSearchInput').addEventListener('input', e => {
  const q = e.target.value.trim();
  document.getElementById('mapSearchClear').classList.toggle('hidden', !q);
  clearTimeout(searchTimer);
  if (q.length < 3) { closeSearchResults(); return; }
  searchTimer = setTimeout(() => doMapSearch(q), 380);
});

document.getElementById('mapSearchClear').addEventListener('click', () => {
  document.getElementById('mapSearchInput').value = '';
  document.getElementById('mapSearchClear').classList.add('hidden');
  closeSearchResults();
  if (searchPin) { map.removeLayer(searchPin); searchPin = null; }
});

document.getElementById('mapSearchInput').addEventListener('blur', () => {
  setTimeout(closeSearchResults, 200);
});

async function doMapSearch(q) {
  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=5&countrycodes=fr`,
      { headers: { 'Accept-Language': 'fr' } }
    );
    const data = await res.json();
    showMapSearchResults(data);
  } catch {}
}

function showMapSearchResults(results) {
  const el = document.getElementById('mapSearchResults');
  if (!results.length) { closeSearchResults(); return; }
  el.innerHTML = results.map(r => `
    <div class="map-search-item" data-lat="${r.lat}" data-lon="${r.lon}">
      <span class="search-item-name">${r.display_name.split(',').slice(0, 2).join(', ')}</span>
      <span class="search-item-sub">${r.display_name.split(',').slice(2, 4).join(', ')}</span>
    </div>
  `).join('');
  el.classList.remove('hidden');
  el.querySelectorAll('.map-search-item').forEach(item => {
    item.addEventListener('mousedown', () => {
      const lat = parseFloat(item.dataset.lat);
      const lng = parseFloat(item.dataset.lon);
      document.getElementById('mapSearchInput').value =
        item.querySelector('.search-item-name').textContent;
      document.getElementById('mapSearchClear').classList.remove('hidden');
      closeSearchResults();
      if (searchPin) map.removeLayer(searchPin);
      searchPin = L.marker([lat, lng]).addTo(map);
      map.setView([lat, lng], 15);
    });
  });
}

function closeSearchResults() {
  document.getElementById('mapSearchResults').classList.add('hidden');
}

// ── Carrefour labels ──────────────────────────────────────────────────────────
// Data is hardcoded in js/carrefours.js (CARREFOURS array) — zero network
// request, markers appear at the same instant as the map.
const carrefourLayer = L.layerGroup();

// Build all markers once
CARREFOURS.forEach(c => {
  carrefourLayer.addLayer(L.marker([c.lat, c.lon], {
    icon: L.divIcon({
      className: 'carrefour-marker',
      html: `<span class="carrefour-dot"></span><span class="carrefour-name">${c.name}</span>`,
      iconAnchor: [5, 5],
      iconSize: null,
    }),
    interactive: false,
    zIndexOffset: 500,
  }));
});

function updateCarrefourVisibility() {
  // Show carrefour names at zoom 15+ for all users
  if (map.getZoom() >= 15) {
    if (!map.hasLayer(carrefourLayer)) carrefourLayer.addTo(map);
  } else {
    if (map.hasLayer(carrefourLayer)) map.removeLayer(carrefourLayer);
  }
}

map.on('zoomend', updateCarrefourVisibility);
updateCarrefourVisibility();

async function loadReports() {
  try {
    const res = await fetch(`${API_URL}/api/reports`);
    if (!res.ok) return;
    const reports = await res.json();
    reports.filter(r => r.status === 'open').forEach(r => {
      const path = allPaths.find(p => p.id === r.pathId);
      placeReportMarker(r, path?.coordinates);
    });
  } catch {}
}


// ── Focus trap helper ─────────────────────────────────────────────────────────
function trapFocus(container) {
  const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
  function handler(e) {
    const els = [...container.querySelectorAll(FOCUSABLE)];
    if (!els.length) return;
    const first = els[0], last = els[els.length - 1];
    if (e.key === 'Tab') {
      if (e.shiftKey) { if (document.activeElement === first) { e.preventDefault(); last.focus(); } }
      else            { if (document.activeElement === last)  { e.preventDefault(); first.focus(); } }
    }
  }
  container.addEventListener('keydown', handler);
  return () => container.removeEventListener('keydown', handler);
}

// ── Contact modal ─────────────────────────────────────────────────────────────
const contactModal = document.getElementById('contactModal');
let _contactTrigger = null;
let _contactTrapRelease = null;

function openContactModal() {
  contactModal.classList.remove('hidden');
  const u = getCachedUser();
  if (u) { document.getElementById('mcName').value = u.name; document.getElementById('mcEmail').value = u.email; }
  _contactTrapRelease = trapFocus(contactModal);
  document.getElementById('mcName').focus();
}
function closeContactModal() {
  contactModal.classList.add('hidden');
  if (_contactTrapRelease) { _contactTrapRelease(); _contactTrapRelease = null; }
  if (_contactTrigger) { _contactTrigger.focus(); _contactTrigger = null; }
}

document.getElementById('btnOpenContact').addEventListener('click', e => {
  _contactTrigger = e.currentTarget;
  openContactModal();
});
document.getElementById('btnCloseContact').addEventListener('click', closeContactModal);
contactModal.addEventListener('click', e => { if (e.target === contactModal) closeContactModal(); });
contactModal.addEventListener('keydown', e => { if (e.key === 'Escape') closeContactModal(); });

document.getElementById('mapContactForm').addEventListener('submit', async e => {
  e.preventDefault();
  const name    = document.getElementById('mcName').value.trim();
  const email   = document.getElementById('mcEmail').value.trim();
  const message = document.getElementById('mcMessage').value.trim();
  const btn     = document.getElementById('mcSubmit');
  const status  = document.getElementById('mcStatus');
  if (!name || !email || !message) { status.textContent = 'Tous les champs sont obligatoires.'; status.style.color = '#dc2626'; return; }
  btn.textContent = 'Envoi…'; btn.disabled = true;
  try {
    const res = await fetch(`${API_URL}/api/contact`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, email, message }) });
    if (!res.ok) throw new Error();
    document.getElementById('mapContactForm').reset();
    status.textContent = '✅ Message envoyé — merci !'; status.style.color = '#1e4d14';
    setTimeout(() => { closeContactModal(); status.textContent = ''; }, 1800);
  } catch { status.textContent = 'Erreur, réessaye.'; status.style.color = '#dc2626'; }
  finally { btn.textContent = 'Envoyer'; btn.disabled = false; }
});

// ── Offline tile download → js/map-offline.js (lazy-loaded) ──────────────────
(function initOfflineBtn() {
  const btn = document.getElementById('btnOffline');
  if (!btn) return;
  if (BWR.can('offline_cache', _userPlan)) {
    btn.style.display = '';
    if (localStorage.getItem('bwr_forest_cached') === '1') {
      btn.querySelector('.btn-emoji').textContent = '✅';
      btn.querySelector('.btn-label').textContent = 'Téléchargée';
    }
    btn.addEventListener('click', async () => {
      await _loadMapOffline();
      downloadOfflineTiles();
    });
  }
})();

initUserMenu();
loadPaths();
loadReports();
if (navigator.onLine) { replayMapPatches(); replayMapReports(); }
updateMapSyncBanner();

const btnMapSync = document.getElementById('btnMapSync');
if (btnMapSync) btnMapSync.addEventListener('click', function () { replayMapPatches(); replayMapReports(); });
