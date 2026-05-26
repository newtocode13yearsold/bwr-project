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

  // Show route planner button for logged-in users
  document.getElementById('btnPlanRoute').style.display = '';

  // Show path-edit button for silver+ users
  if (BWR.can('path_difficulty_edit', _userPlan)) {
    document.getElementById('btnEditPaths').style.display = '';
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
async function loadPaths() {
  try {
    const res = await fetch(`${API_URL}/api/paths`);
    allPaths = await res.json();
    renderPaths();
    showPathHintIfNeeded();
  } catch {}
}

function renderPaths() {
  pathTileLayer.setPaths(allPaths, activeFilters);
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

map.on('click', e => {
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

// ── Path edit mode (silver+) ──────────────────────────────────────────────────
let pathEditModeActive = false;
let _editPolylines = [];

function renderEditPolylines() {
  _editPolylines.forEach(l => map.removeLayer(l));
  _editPolylines = [];
}

function clearEditPolylines() {
  _editPolylines.forEach(l => map.removeLayer(l));
  _editPolylines = [];
}

let _osmEditLayers = [];

function clearOsmEditLayers() {
  _osmEditLayers.forEach(l => map.removeLayer(l));
  _osmEditLayers = [];
}

async function loadOsmEditPaths() {
  if (map.getZoom() < 12) {
    showToast('Zoome plus près de la forêt (zoom minimum : 12).');
    exitPathEditMode();
    return;
  }
  showEditModeBar('Chargement des chemins…');
  const b = map.getBounds();
  const bbox = `${b.getSouth().toFixed(4)},${b.getWest().toFixed(4)},${b.getNorth().toFixed(4)},${b.getEast().toFixed(4)}`;
  try {
    const res = await fetch(`${API_URL}/api/osm?bbox=${bbox}`);
    if (!res.ok) throw new Error();
    const data = await res.json();
    renderOsmEditPaths(data);
    const count = _osmEditLayers.length;
    if (count === 0) {
      showEditModeBar('Aucun chemin OSM trouvé ici — zoome sur la forêt.');
    } else {
      showEditModeBar(`${count} chemins disponibles — clique sur un chemin en pointillés`);
    }
  } catch {
    showToast('Impossible de charger les chemins OSM.');
    exitPathEditMode();
  }
}

function renderOsmEditPaths(data) {
  clearOsmEditLayers();
  const nodes = {};
  data.elements.forEach(el => {
    if (el.type === 'node') nodes[el.id] = [el.lat, el.lon];
  });
  data.elements.forEach(el => {
    if (el.type !== 'way') return;
    const coords = el.nodes.map(id => nodes[id]).filter(Boolean);
    if (coords.length < 2) return;
    const alreadySaved = allPaths.some(p =>
      p.coordinates && Math.abs(p.coordinates[0][0] - coords[0][0]) < 0.0001 &&
      Math.abs(p.coordinates[0][1] - coords[0][1]) < 0.0001
    );
    if (alreadySaved) return;
    const name = el.tags?.name || el.tags?.ref || 'Chemin sans nom';
    const line = L.polyline(coords, { color: '#475569', weight: 3, opacity: 0.65, dashArray: '6, 6' });
    line.on('mouseover', () => { line.setStyle({ color: '#2563eb', opacity: 1, weight: 5, dashArray: null }); map.getContainer().style.cursor = 'pointer'; });
    line.on('mouseout',  () => { line.setStyle({ color: '#475569', opacity: 0.65, weight: 3, dashArray: '6, 6' }); map.getContainer().style.cursor = 'crosshair'; });
    line.on('click', e => { L.DomEvent.stopPropagation(e); openNewPathPopupUser(coords, name, e.latlng); });
    line.addTo(map);
    _osmEditLayers.push(line);
  });
}

function openNewPathPopupUser(coords, name, latlng) {
  L.popup({ maxWidth: 260, className: 'admin-popup', autoClose: false, closeOnClick: false })
    .setLatLng(latlng)
    .setContent(`
      <div class="color-popup">
        <div class="color-popup-name">${name}</div>
        <div class="color-popup-label">Choisir la difficulté :</div>
        <div class="color-popup-btns" id="newUserColorBtns">
          ${Object.entries(STATUS_COLORS).map(([status, color]) => `
            <button class="color-btn" style="background:${color}" data-status="${status}" title="${STATUS_LABELS[status]}"></button>
          `).join('')}
        </div>
        <div class="color-popup-legend">
          <span style="color:${STATUS_COLORS.easy}">● Facile</span>
          <span style="color:${STATUS_COLORS.medium}">● Moyen</span>
          <span style="color:${STATUS_COLORS.hard}">● Difficile</span>
          <span style="color:${STATUS_COLORS.not_passable}">● Impraticable</span>
          <span style="color:${STATUS_COLORS.no_bike}">● Vélo interdit</span>
        </div>
      </div>
    `)
    .openOn(map);
  setTimeout(() => {
    document.querySelectorAll('#newUserColorBtns .color-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        map.closePopup();
        const res = await fetch(`${API_URL}/api/paths`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeader() },
          body: JSON.stringify({ name, pathType: 'foot', status: btn.dataset.status, notes: '', conditions: [], coordinates: coords }),
        });
        if (res.ok) {
          const saved = await res.json();
          allPaths.push(saved);
          renderPaths();
          clearOsmEditLayers();
          await loadOsmEditPaths();
          showToast(`✅ "${name}" enregistré !`);
        } else {
          showToast('Erreur lors de l\'enregistrement.');
        }
      });
    });
  }, 50);
}

function enterPathEditMode() {
  pathEditModeActive = true;
  dismissPathHint();
  const btn = document.getElementById('btnEditPaths');
  btn.querySelector('.btn-emoji').textContent = '✕';
  btn.querySelector('.btn-label').textContent = 'Terminer';
  btn.style.background = 'rgba(239,68,68,0.15)';
  btn.style.color = '#dc2626';
  map.getContainer().style.cursor = 'crosshair';
  showEditModeBar('Chargement…');
  loadOsmEditPaths();
}

function exitPathEditMode() {
  pathEditModeActive = false;
  const btn = document.getElementById('btnEditPaths');
  btn.querySelector('.btn-emoji').textContent = '✎';
  btn.querySelector('.btn-label').textContent = 'Modifier';
  btn.style.background = '';
  btn.style.color = '';
  map.getContainer().style.cursor = '';
  clearEditPolylines();
  clearOsmEditLayers();
  hideEditModeBar();
  map.closePopup();
}

function showEditModeBar(text) {
  let bar = document.getElementById('editModeBar');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'editModeBar';
    bar.className = 'edit-mode-bar';
    document.getElementById('map').appendChild(bar);
  }
  bar.textContent = '✎ ' + (text || 'Mode modification');
}

function hideEditModeBar() {
  document.getElementById('editModeBar')?.remove();
}

document.getElementById('btnEditPaths').addEventListener('click', () => {
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
              renderPaths();
              map.closePopup();
              showToast(`✅ Difficulté mise à jour : ${STATUS_LABELS[newStatus]}`);
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

    const guardReport = (cb) => {
      if (!BWR.can('reports_create', _userPlan)) {
        map.closePopup();
        showToast('🔒 Le signalement est disponible avec Argent — voir plans.html');
        return;
      }
      cb();
    };



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

// ── Difficulty-only popup (used in path edit mode) ───────────────────────────
function openDifficultyPopup(path, latlng) {
  const colorButtons = Object.entries(STATUS_COLORS).map(([status, color]) => {
    const isActive = path.status === status;
    return `<button class="color-btn ${isActive ? 'active' : ''}" style="background:${color}" data-status="${status}" title="${STATUS_LABELS[status]}">${isActive ? '✓' : ''}</button>`;
  }).join('');

  L.popup({ maxWidth: 260, className: 'admin-popup', autoClose: false, closeOnClick: false })
    .setLatLng(latlng)
    .setContent(`
      <div class="color-popup">
        <div class="color-popup-name">${path.name || 'Chemin sans nom'}</div>
        <div class="color-popup-label">Changer la difficulté :</div>
        <div class="color-popup-btns" id="editColorBtns-${path.id}">${colorButtons}</div>
        <div class="color-popup-legend">
          <span style="color:${STATUS_COLORS.easy}">● Facile</span>
          <span style="color:${STATUS_COLORS.medium}">● Moyen</span>
          <span style="color:${STATUS_COLORS.hard}">● Difficile</span>
          <span style="color:${STATUS_COLORS.not_passable}">● Impraticable</span>
          <span style="color:${STATUS_COLORS.no_bike}">● Vélo interdit</span>
        </div>
      </div>
    `)
    .openOn(map);

  setTimeout(() => {
    document.querySelectorAll(`#editColorBtns-${path.id} .color-btn`).forEach(btn => {
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
            renderPaths();
            map.closePopup();
            showToast(`✅ Difficulté mise à jour : ${STATUS_LABELS[newStatus]}`);
          } else {
            showToast('Erreur lors de la mise à jour.');
          }
        } catch {
          showToast('Erreur lors de la mise à jour.');
        }
      });
    });
  }, 50);
}

function openReportPopup(path, latlng, defaultType = 'fallen_tree') {
  const types = Object.entries(REPORT_LABELS).map(([id, label]) =>
    `<button class="rtype-inline-btn" data-type="${id}">${REPORT_ICONS[id]} ${label}</button>`
  ).join('');

  L.popup({ maxWidth: 290, autoClose: false, closeOnClick: false })
    .setLatLng(latlng)
    .setContent(`
      <div class="popup">
        <strong>⚠️ Signaler un problème</strong>
        <p class="popup-report-path">sur : ${path.name || 'Chemin sans nom'}</p>
        <div class="rtype-inline-grid" id="rtypes-${path.id}">${types}</div>
        <textarea class="popup-report-note" id="rnote-${path.id}" placeholder="Détails (optionnel)..." rows="2"></textarea>
        <label class="photo-upload-label" id="photoLabel-${path.id}">
          📷 Ajouter une photo
          <input type="file" id="rphoto-${path.id}" accept="image/*" capture="environment" style="display:none">
        </label>
        <img id="rphoto-preview-${path.id}" class="report-photo-preview hidden" alt="preview">
        <div class="popup-report-actions">
          <button class="popup-submit-btn" id="rsubmit-${path.id}">Envoyer</button>
          <button class="popup-cancel-btn" id="rcancel-${path.id}">Annuler</button>
        </div>
      </div>
    `)
    .openOn(map);

  setTimeout(() => {
    let selectedType = defaultType;
    let photoData = null;

    const defaultBtn = document.querySelector(`#rtypes-${path.id} .rtype-inline-btn[data-type="${defaultType}"]`);
    if (defaultBtn) defaultBtn.classList.add('active');

    document.querySelectorAll(`#rtypes-${path.id} .rtype-inline-btn`).forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll(`#rtypes-${path.id} .rtype-inline-btn`).forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        selectedType = btn.dataset.type;
      });
    });

    document.getElementById(`photoLabel-${path.id}`)?.addEventListener('click', () => {
      document.getElementById(`rphoto-${path.id}`)?.click();
    });

    document.getElementById(`rphoto-${path.id}`)?.addEventListener('change', async e => {
      const file = e.target.files[0];
      if (!file) return;
      photoData = await resizeImage(file);
      const preview = document.getElementById(`rphoto-preview-${path.id}`);
      if (preview) { preview.src = photoData; preview.classList.remove('hidden'); }
      const label = document.getElementById(`photoLabel-${path.id}`);
      if (label) label.textContent = '✅ Photo ajoutée';
    });

    document.getElementById(`rsubmit-${path.id}`)?.addEventListener('click', async () => {
      const note = document.getElementById(`rnote-${path.id}`)?.value.trim() || '';
      map.closePopup();
      await submitReport(path, selectedType, note, photoData, latlng);
    });

    document.getElementById(`rcancel-${path.id}`)?.addEventListener('click', () => map.closePopup());
  }, 50);
}

async function submitReport(path, type, note, photo = null, latlng = null) {
  const payload = { pathId: path?.id, type, note, photo, lat: latlng?.lat, lon: latlng?.lng };
  if (!navigator.onLine) {
    queueMapReport(payload);
    showToast('📶 Hors-ligne — signalement enregistré, envoi à la reconnexion.');
    return;
  }
  try {
    const res = await fetch(`${API_URL}/api/reports`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeader() },
      body: JSON.stringify(payload),
    });
    if (res.ok) {
      const report = await res.json();
      if (latlng) { report.lat = latlng.lat; report.lon = latlng.lng; }
      placeReportMarker(report, path.coordinates);
      showToast('✅ Signalement envoyé — merci !');
    } else if (res.status === 503) {
      queueMapReport(payload);
      showToast('📶 Hors-ligne — signalement enregistré, envoi à la reconnexion.');
    } else {
      showToast('Erreur lors du signalement.');
    }
  } catch {
    queueMapReport(payload);
    showToast('📶 Hors-ligne — signalement enregistré, envoi à la reconnexion.');
  }
}

function placeReportMarker(report, coords) {
  const mid = (report.lat && report.lon)
    ? [report.lat, report.lon]
    : coords ? coords[Math.floor(coords.length / 2)] : null;
  if (!mid) return;
  const icon = REPORT_ICONS[report.type] || '⚠️';
  const label = REPORT_LABELS[report.type] || report.type;
  L.marker(mid, {
    icon: L.divIcon({ className: 'report-marker', html: `<div class="report-dot">${icon}</div>`, iconAnchor: [16, 16], iconSize: [32, 32] }),
  }).bindPopup(`
    <div class="popup">
      <strong>${icon} ${label}</strong>
      ${report.note ? `<p class="popup-notes">${report.note}</p>` : ''}
      ${(report.hasPhoto || report.photo) ? `<img src="${report.hasPhoto ? `${API_URL}/api/photos/${report.id}` : report.photo}" class="report-popup-photo" alt="photo">` : ''}
      <small style="color:#9ca3af">${new Date(report.date).toLocaleDateString('fr-FR')}</small>
    </div>
  `).addTo(map);
}

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
// states: 'idle' | 'searching' | 'following'
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

function stopLocating() {
  if (locationWatchId !== null) {
    navigator.geolocation.clearWatch(locationWatchId);
    locationWatchId = null;
  }
  if (locationMarker) { map.removeLayer(locationMarker); locationMarker = null; }
  if (locationCircle) { map.removeLayer(locationCircle); locationCircle = null; }
  locateState = 'idle';
  const btn = document.getElementById('btnLocate');
  btn.textContent = '📍';
  btn.classList.remove('locate-following', 'locate-searching');
  btn.title = 'Ma position';
}

function updateLocationLayers(lat, lng, accuracy) {
  if (locationCircle) locationCircle.setLatLng([lat, lng]).setRadius(accuracy);
  else locationCircle = L.circle([lat, lng], {
    radius: accuracy,
    color: '#3b82f6', fillColor: '#93c5fd',
    fillOpacity: 0.18, weight: 1.5,
  }).addTo(map);

  if (locationMarker) locationMarker.setLatLng([lat, lng]);
  else locationMarker = L.circleMarker([lat, lng], {
    radius: 9, color: 'white', weight: 3,
    fillColor: '#3b82f6', fillOpacity: 1,
  }).bindPopup('Vous êtes ici').addTo(map);
}

document.getElementById('btnLocate').addEventListener('click', () => {
  if (!navigator.geolocation) {
    showLocateToast('Géolocalisation non disponible', true);
    return;
  }

  // Cycle: idle → following → idle
  if (locateState === 'following' || locateState === 'searching') {
    stopLocating();
    return;
  }

  const btn = document.getElementById('btnLocate');
  locateState = 'searching';
  btn.textContent = '⏳';
  btn.classList.add('locate-searching');
  btn.classList.remove('locate-following');
  btn.title = 'Annuler';

  let firstFix = true;

  locationWatchId = navigator.geolocation.watchPosition(
    ({ coords: { latitude: lat, longitude: lng, accuracy } }) => {
      locateState = 'following';
      btn.textContent = '📍';
      btn.classList.remove('locate-searching');
      btn.classList.add('locate-following');
      btn.title = 'Arrêter le suivi';

      updateLocationLayers(lat, lng, accuracy);

      if (firstFix) {
        firstFix = false;
        map.setView([lat, lng], Math.max(map.getZoom(), 15));
        showLocateToast('Position trouvée' + (accuracy > 50 ? ` (±${Math.round(accuracy)} m)` : ''));
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

// ── Cartes hors-ligne (Silver+) ───────────────────────────────────────────────
function lonToTileX(lon, z) { return Math.floor((lon + 180) / 360 * Math.pow(2, z)); }
function latToTileY(lat, z) {
  return Math.floor((1 - Math.log(Math.tan(lat * Math.PI / 180) + 1 / Math.cos(lat * Math.PI / 180)) / Math.PI) / 2 * Math.pow(2, z));
}

// Hardcoded bounding box for the entire Forêt de Compiègne
const FOREST_BBOX = { north: 49.47, south: 49.27, west: 2.65, east: 3.10 };

async function downloadOfflineTiles() {
  if (!BWR.can('offline_cache', _userPlan)) {
    showToast('🔒 Cartes hors-ligne disponibles avec Argent — voir plans.html');
    return;
  }

  const btn = document.getElementById('btnOffline');
  if (btn && btn.dataset.downloading === '1') return;

  // Build tile list for the full forest bbox at zoom 10–15
  const tiles = [];
  const subs = ['a', 'b', 'c'];
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
  } catch { showToast('Erreur lors du téléchargement hors-ligne'); }
  finally {
    if (btn) {
      delete btn.dataset.downloading;
      btn.querySelector('.btn-emoji').textContent = '✅';
      btn.querySelector('.btn-label').textContent = 'Téléchargée';
      btn.disabled = false;
    }
  }
}

// Show offline button for Silver+ users
(function initOfflineBtn() {
  const btn = document.getElementById('btnOffline');
  if (!btn) return;
  if (BWR.can('offline_cache', _userPlan)) {
    btn.style.display = '';
    if (localStorage.getItem('bwr_forest_cached') === '1') {
      btn.querySelector('.btn-emoji').textContent = '✅';
      btn.querySelector('.btn-label').textContent = 'Téléchargée';
    }
    btn.addEventListener('click', downloadOfflineTiles);
  }
})();

initUserMenu();
loadPaths();
loadReports();
if (navigator.onLine) { replayMapPatches(); replayMapReports(); }
updateMapSyncBanner();
