const CONDITIONS = [
  { id: 'dry',     icon: '✅', label: 'Sec' },
  { id: 'muddy',   icon: '🟤', label: 'Boueux' },
  { id: 'rutted',  icon: '🛞', label: 'Ornières' },
  { id: 'fallen',  icon: '❌', label: 'Arbres tombés' },
  { id: 'mtb',     icon: '🚴', label: 'Idéal MTB' },
  { id: 'running', icon: '🏃', label: 'Running' },
  { id: 'family',  icon: '👨‍👩‍👧', label: 'Famille' },
];

function getSelectedConditions(containerId) {
  return [...document.querySelectorAll(`#${containerId} .cond-tag.active`)]
    .map(btn => btn.dataset.cond);
}

function setConditions(containerId, active = []) {
  document.querySelectorAll(`#${containerId} .cond-tag`).forEach(btn => {
    btn.classList.toggle('active', active.includes(btn.dataset.cond));
  });
}

function initConditionTags(containerId) {
  document.querySelectorAll(`#${containerId} .cond-tag`).forEach(btn => {
    btn.addEventListener('click', () => btn.classList.toggle('active'));
  });
}

const REPORT_ICONS  = { fallen_tree:'🌲', flooded:'💧', muddy:'🟤', rutted:'🛞', broken_sign:'🪧', closed:'🚫', danger:'⚠️', other:'📝' };
const REPORT_LABELS_ADMIN = { fallen_tree:'Arbre tombé', flooded:'Chemin inondé', muddy:'Boueux', rutted:'Ornières', broken_sign:'Carrefour cassé', closed:'Chemin fermé', danger:'Danger', other:'Autre' };

let currentUser = null;
let drawnCoordinates = null;
let allPaths = [];
let allReports = [];
let reportMarkerLayer = null;
let pathLayers = {};
let osmLayers = [];
let map = null;
let drawControl = null;
let drawnItems = null;
let selectModeActive = false;
let offlineSelectMode = false;
let splitModeActive = false;
let splitTargetPath = null;

// ── Auth check ────────────────────────────────────────────────────────────────
(async () => {
  currentUser = await requireAuth('admin');
  if (!currentUser) return;
  initUserMenu();
  initMap();
  await loadPaths();
  await loadReports();
})();

function initUserMenu() {
  const menuEl = document.getElementById('userMenu');
  const initials = currentUser.name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);
  menuEl.innerHTML = `
    <button class="user-btn" id="userBtn">
      <div class="user-avatar">${initials}</div>
      ${currentUser.name.split(' ')[0]}
    </button>
    <div class="user-dropdown hidden" id="userDropdown">
      <span class="dropdown-name">${currentUser.name}</span>
      <a href="/">🏠 Accueil</a>
      <a href="map">🗺 Voir la carte</a>
      <a href="profile">👤 Mon profil</a>
      <button class="dropdown-logout" id="btnLogout">Se déconnecter</button>
    </div>
  `;
  document.getElementById('userBtn').addEventListener('click', () => {
    document.getElementById('userDropdown').classList.toggle('hidden');
  });
  document.getElementById('btnLogout').addEventListener('click', () => logout());
  document.addEventListener('click', (e) => {
    if (!menuEl.contains(e.target)) document.getElementById('userDropdown')?.classList.add('hidden');
  });
}

// ── Map init ──────────────────────────────────────────────────────────────────
function initMap() {
  map = L.map('map', { minZoom: 10, maxZoom: 17 }).setView(MAP_CENTER, MAP_ZOOM);

  ignLayer = L.tileLayer(
    'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
    { attribution: 'Map data: &copy; OpenStreetMap contributors, SRTM | Style: &copy; OpenTopoMap', maxNativeZoom: 17, maxZoom: 17, subdomains: ['a','b','c'] }
  );
  ignLayer.addTo(map);

  setTimeout(() => map.invalidateSize(), 100);
  initConditionTags('newConditions');
  initConditionTags('editConditions');

  drawnItems = new L.FeatureGroup();
  map.addLayer(drawnItems);
  reportMarkerLayer = L.layerGroup().addTo(map);

  drawControl = new L.Control.Draw({
    draw: {
      polyline: { shapeOptions: { color: '#3b82f6', weight: 5 } },
      polygon: false, rectangle: false, circle: false, marker: false, circlemarker: false,
    },
    edit: { featureGroup: drawnItems, remove: false },
  });

  map.on(L.Draw.Event.CREATED, (e) => {
    drawnItems.clearLayers();
    drawnItems.addLayer(e.layer);
    drawnCoordinates = e.layer.getLatLngs().map(ll => [ll.lat, ll.lng]);
    map.removeControl(drawControl);
    document.getElementById('pathForm').classList.remove('hidden');
    showStatus('Chemin tracé — remplis le formulaire et enregistre.');
  });

  map.on('zoomend', updatePathWeights);

  const carrefourLayer = L.layerGroup();
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
    if (map.getZoom() >= 15) {
      if (!map.hasLayer(carrefourLayer)) carrefourLayer.addTo(map);
    } else {
      if (map.hasLayer(carrefourLayer)) map.removeLayer(carrefourLayer);
    }
  }
  map.on('zoomend', updateCarrefourVisibility);
  updateCarrefourVisibility();

  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', () => map.invalidateSize());
  }
}

function pathWeight() {
  if (!map) return 3;
  const z = map.getZoom();
  const metersPerPixel = 40075016 * Math.cos(49.35 * Math.PI / 180) / (256 * Math.pow(2, z));
  return Math.max(2, Math.min(12, Math.round(20 / metersPerPixel)));
}

function updatePathWeights() {
  const w = pathWeight();
  Object.values(pathLayers).forEach(layers => {
    // pathLayers stores [visibleLine, hitTarget] arrays
    if (Array.isArray(layers)) layers[0].setStyle({ weight: w });
    else layers.setStyle({ weight: w });
  });
}

// ── Select mode — click an OSM path ──────────────────────────────────────────
document.getElementById('btnSelectPath').addEventListener('click', async () => {
  if (selectModeActive) {
    exitSelectMode();
    return;
  }
  enterSelectMode();
  await loadOSMPaths();
});

let ignLayer = null;

function enterSelectMode() {
  selectModeActive = true;
  document.getElementById('btnSelectPath').textContent = '✕ Annuler';
  document.getElementById('btnSelectPath').style.background = 'rgba(239,68,68,0.4)';
  map.getContainer().style.cursor = 'crosshair';
  // Keep IGN tiles — they are more accurate for forest paths
  showStatus('Clique sur un chemin en pointillés pour le sélectionner.');
}

function exitSelectMode() {
  selectModeActive = false;
  offlineSelectMode = false;
  document.getElementById('btnSelectPath').textContent = '🗺 Sélectionner un chemin';
  document.getElementById('btnSelectPath').style.background = '';
  map.getContainer().style.cursor = '';
  clearOSMLayer();
  renderPaths();
  showStatus('');
}

// ── Split mode ────────────────────────────────────────────────────────────────
function nearestPointIndex(coords, latlng) {
  let best = 0, bd = Infinity;
  coords.forEach(([lat, lon], i) => {
    const d = (lat - latlng.lat) ** 2 + (lon - latlng.lng) ** 2;
    if (d < bd) { bd = d; best = i; }
  });
  return best;
}

function enterSplitMode(path) {
  splitModeActive = true;
  splitTargetPath = path;
  map.closePopup();
  map.getContainer().style.cursor = 'crosshair';
  const layer = pathLayers[path.id];
  if (layer) layer[0].setStyle({ color: '#f59e0b', weight: pathWeight() + 4, opacity: 1 });
  document.getElementById('btnSplitCancel').style.display = '';
  showStatus(`Clique sur "${path.name || 'le chemin'}" pour le couper en deux.`);
}

function exitSplitMode() {
  if (splitTargetPath) {
    const layer = pathLayers[splitTargetPath.id];
    if (layer) layer[0].setStyle({ color: STATUS_COLORS[splitTargetPath.status] || '#9ca3af', weight: pathWeight(), opacity: 0.9 });
  }
  splitModeActive = false;
  splitTargetPath = null;
  map.getContainer().style.cursor = '';
  document.getElementById('btnSplitCancel').style.display = 'none';
  showStatus('');
}

async function handleSplitClick(path, latlng) {
  const coords = path.coordinates;
  const idx = nearestPointIndex(coords, latlng);
  if (idx <= 0 || idx >= coords.length - 1) {
    showStatus('Clique plus au milieu du chemin pour le couper.', true);
    return;
  }
  const part1 = coords.slice(0, idx + 1);
  const part2 = coords.slice(idx);
  exitSplitMode();
  await saveSplitPaths(path, part1, part2);
}

async function saveSplitPaths(path, part1, part2) {
  showStatus('Découpage en cours…');
  const base = { pathType: path.pathType, status: path.status, notes: path.notes || '', conditions: path.conditions || [] };
  const [r1, r2] = await Promise.all([
    fetch(`${API_URL}/api/paths`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeader() }, body: JSON.stringify({ ...base, name: (path.name || 'Chemin') + ' (1)', coordinates: part1 }) }),
    fetch(`${API_URL}/api/paths`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeader() }, body: JSON.stringify({ ...base, name: (path.name || 'Chemin') + ' (2)', coordinates: part2 }) }),
  ]);
  if (r1.ok && r2.ok) {
    // Delete original directly — do NOT use deletePath() which calls loadPaths() early
    await fetch(`${API_URL}/api/paths/${path.id}`, { method: 'DELETE', headers: authHeader() });
    await loadPaths(); // single reload after everything is done
    showStatus(`"${path.name || 'Chemin'}" découpé en 2 sections — clique sur chaque partie pour changer la couleur.`);
  } else {
    showStatus('Erreur lors du découpage.', true);
    await loadPaths();
  }
}

async function loadOSMPaths() {
  if (map.getZoom() < 12) {
    showStatus('Zoome plus près de la forêt (zoom minimum : 12).', true);
    exitSelectMode();
    return;
  }

  // Offline: try cached OSM data, then fall back to editing existing paths
  if (!navigator.onLine) {
    const cached = localStorage.getItem('bwr_osm_cache');
    if (cached) {
      try {
        renderOSMPaths(JSON.parse(cached));
        const count = osmLayers.length;
        showStatus(count > 0
          ? `${count} chemins (cache hors-ligne) — clique sur un chemin en pointillés.`
          : 'Hors-ligne — clique sur un chemin pour modifier sa couleur.');
        if (count === 0) { offlineSelectMode = true; renderPaths(); }
        return;
      } catch {}
    }
    offlineSelectMode = true;
    renderPaths();
    showStatus('Hors-ligne — clique sur un chemin pour modifier sa couleur.');
    return;
  }

  showStatus('Chargement des chemins…');

  const b = map.getBounds();
  const bbox = `${b.getSouth().toFixed(4)},${b.getWest().toFixed(4)},${b.getNorth().toFixed(4)},${b.getEast().toFixed(4)}`;

  try {
    const res = await fetch(`${API_URL}/api/osm?bbox=${bbox}`);
    if (!res.ok) throw new Error();
    const data = await res.json();
    try { localStorage.setItem('bwr_osm_cache', JSON.stringify(data)); } catch {}
    renderOSMPaths(data);
    const count = osmLayers.length;
    if (count === 0) {
      showStatus('Aucun chemin trouvé ici — zoome sur la forêt de Compiègne.');
    } else {
      showStatus(`${count} chemins disponibles — clique sur un chemin en pointillés.`);
    }
  } catch {
    // Network error after passing the online check — try cache, then fall back
    const cached = localStorage.getItem('bwr_osm_cache');
    if (cached) {
      try {
        renderOSMPaths(JSON.parse(cached));
        const count = osmLayers.length;
        if (count > 0) {
          showStatus(`${count} chemins (cache) — clique sur un chemin en pointillés.`);
          return;
        }
      } catch {}
    }
    showStatus('Chemins OSM indisponibles — clique sur un chemin existant pour modifier sa couleur.');
  }
}

function detectPathType(tags) {
  if (!tags) return 'foot';
  const hw = tags.highway || '';
  if (
    hw === 'cycleway' ||
    tags.bicycle === 'designated' ||
    (hw === 'path' && tags.bicycle === 'yes') ||
    tags.route === 'bicycle'
  ) return 'bike';
  return 'foot';
}

function renderOSMPaths(data) {
  clearOSMLayer();

  const nodes = {};
  data.elements.forEach(el => {
    if (el.type === 'node') nodes[el.id] = [el.lat, el.lon];
  });

  data.elements.forEach(el => {
    if (el.type !== 'way') return;
    const coords = el.nodes.map(id => nodes[id]).filter(Boolean);
    if (coords.length < 2) return;

    // Skip paths already saved (require both endpoints to match, not just the first)
    const last = coords[coords.length - 1];
    const endpointsMatch = (p) => {
      if (!p.coordinates || p.coordinates.length < 2) return false;
      const pLast = p.coordinates[p.coordinates.length - 1];
      return (
        Math.abs(p.coordinates[0][0] - coords[0][0]) < 0.0001 &&
        Math.abs(p.coordinates[0][1] - coords[0][1]) < 0.0001 &&
        Math.abs(pLast[0] - last[0]) < 0.0001 &&
        Math.abs(pLast[1] - last[1]) < 0.0001
      );
    };
    if (allPaths.some(endpointsMatch) || getOfflineNewPaths().some(endpointsMatch)) return;

    const autoType = detectPathType(el.tags);

    const line = L.polyline(coords, {
      color: '#475569',
      weight: 3,
      opacity: 0.6,
      dashArray: '6, 6',
    });

    line.on('mouseover', () => line.setStyle({ color: '#2563eb', opacity: 1, weight: 4 }));
    line.on('mouseout',  () => line.setStyle({ color: '#475569', opacity: 0.6, weight: 3 }));
    line.on('click', (e) => {
      L.DomEvent.stopPropagation(e);
      const name = el.tags?.name || el.tags?.ref || 'Chemin sans nom';
      openNewPathPopup(coords, name, e.latlng, autoType);
    });

    line.addTo(map);
    osmLayers.push(line);
  });
}

function clearOSMLayer() {
  osmLayers.forEach(l => map.removeLayer(l));
  osmLayers = [];
}

function openNewPathPopup(coords, name, latlng, autoType = 'foot') {
  const footStyle = autoType === 'foot'
    ? 'border:2px solid #1e4d14;background:#f0f7ec'
    : 'border:2px solid #e2e8da;background:white';
  const bikeStyle = autoType === 'bike'
    ? 'border:2px solid #1e4d14;background:#f0f7ec'
    : 'border:2px solid #e2e8da;background:white';
  const autoLabel = autoType === 'bike'
    ? '<span style="font-size:0.72rem;color:#6b7280;display:block;margin-bottom:6px">🤖 Détecté automatiquement comme piste cyclable</span>'
    : '<span style="font-size:0.72rem;color:#6b7280;display:block;margin-bottom:6px">🤖 Détecté automatiquement comme chemin forestier</span>';

  const popupContent = `
    <div class="color-popup">
      <div class="color-popup-name">${name}</div>
      <div class="color-popup-label">Type de chemin :</div>
      ${autoLabel}
      <div style="display:flex;gap:6px;margin-bottom:10px">
        <button class="type-btn" data-type="foot" style="flex:1;padding:6px 4px;${footStyle};border-radius:8px;font-size:0.8rem;font-weight:600;cursor:pointer">🌲 Forestier</button>
        <button class="type-btn" data-type="bike" style="flex:1;padding:6px 4px;${bikeStyle};border-radius:8px;font-size:0.8rem;font-weight:600;cursor:pointer">🚴 Cyclable</button>
      </div>
      <div class="color-popup-label">Choisir la couleur :</div>
      <div class="color-popup-btns" id="newColorBtns">
        ${Object.entries(STATUS_COLORS).map(([status, color]) => `
          <button class="color-btn" style="background:${color}" data-status="${status}" title="${STATUS_LABELS[status]}"></button>
        `).join('')}
      </div>
      <div class="color-popup-legend">
        <span style="color:${STATUS_COLORS.easy}">● Facile</span>
        <span style="color:${STATUS_COLORS.medium}">● Moyen</span>
        <span style="color:${STATUS_COLORS.hard}">● Difficile</span>
        <span style="color:${STATUS_COLORS.not_passable}">● Impraticable</span>
      </div>
    </div>
  `;

  L.popup({ maxWidth: 280, className: 'admin-popup', autoClose: false, closeOnClick: false })
    .setLatLng(latlng)
    .setContent(popupContent)
    .openOn(map);

  setTimeout(() => {
    let selectedType = autoType;
    document.querySelectorAll('.type-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        selectedType = btn.dataset.type;
        document.querySelectorAll('.type-btn').forEach(b => {
          b.style.borderColor = '#e2e8da';
          b.style.background = 'white';
        });
        btn.style.borderColor = '#1e4d14';
        btn.style.background = '#f0f7ec';
      });
    });
    document.querySelectorAll('#newColorBtns .color-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        map.closePopup();
        await saveNewPath(name, btn.dataset.status, coords, selectedType);
        exitSelectMode();
      });
    });
  }, 50);
}

async function saveNewPath(name, status, coordinates, pathType = 'foot', conditions = []) {
  const payload = { name, pathType, status, notes: '', conditions, coordinates };
  if (!navigator.onLine) {
    queueOfflineNewPath(payload);
    const tempPath = { ...payload, id: `offline_${Date.now()}` };
    allPaths.push(tempPath);
    localStorage.setItem('bwr_cached_paths', JSON.stringify(allPaths));
    renderPaths();
    showStatus(`📶 Hors-ligne — "${name}" enregistré, envoi à la reconnexion.`);
    return;
  }
  try {
    const res = await fetch(`${API_URL}/api/paths`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeader() },
      body: JSON.stringify(payload),
    });
    if (res.ok) {
      showStatus(`"${name}" enregistré !`);
      await loadPaths();
    } else if (res.status === 503) {
      queueOfflineNewPath(payload);
      allPaths.push({ ...payload, id: `offline_${Date.now()}` });
      localStorage.setItem('bwr_cached_paths', JSON.stringify(allPaths));
      renderPaths();
      showStatus(`📶 Hors-ligne — "${name}" enregistré, envoi à la reconnexion.`);
    } else {
      showStatus('Erreur lors de l\'enregistrement.', true);
    }
  } catch {
    queueOfflineNewPath(payload);
    allPaths.push({ ...payload, id: `offline_${Date.now()}` });
    localStorage.setItem('bwr_cached_paths', JSON.stringify(allPaths));
    renderPaths();
    showStatus(`📶 Hors-ligne — "${name}" enregistré, envoi à la reconnexion.`);
  }
}

// ── Draw mode (manual) ────────────────────────────────────────────────────────
document.getElementById('btnSplitCancel').addEventListener('click', () => exitSplitMode());

document.getElementById('btnDrawPath').addEventListener('click', () => {
  if (!map) return;
  exitSelectMode();
  map.closePopup();
  map.addControl(drawControl);
  new L.Draw.Polyline(map, drawControl.options.draw.polyline).enable();
  showStatus('Clique sur la carte pour tracer. Double-clique pour terminer.');
});

document.getElementById('btnCancelPath').addEventListener('click', () => {
  drawnItems.clearLayers();
  drawnCoordinates = null;
  document.getElementById('pathForm').classList.add('hidden');
  showStatus('');
});

document.getElementById('btnSavePath').addEventListener('click', async () => {
  if (!drawnCoordinates) return;
  const res = await fetch(`${API_URL}/api/paths`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeader() },
    body: JSON.stringify({
      name: document.getElementById('pathName').value || 'Chemin sans nom',
      pathType: document.getElementById('pathType').value,
      status: document.getElementById('pathStatus').value,
      notes: document.getElementById('pathNotes').value,
      conditions: getSelectedConditions('newConditions'),
      coordinates: drawnCoordinates,
    }),
  });
  if (res.ok) {
    drawnItems.clearLayers();
    drawnCoordinates = null;
    document.getElementById('pathForm').classList.add('hidden');
    document.getElementById('pathName').value = '';
    document.getElementById('pathNotes').value = '';
    setConditions('newConditions', []);
    showStatus('Chemin enregistré !');
    await loadPaths();
  } else {
    showStatus('Erreur lors de l\'enregistrement.', true);
  }
});

// ── Offline queue helpers ─────────────────────────────────────────────────────
function getOfflineQueue() {
  try { return JSON.parse(localStorage.getItem('bwr_offline_queue') || '[]'); } catch { return []; }
}
function saveOfflineQueue(q) { localStorage.setItem('bwr_offline_queue', JSON.stringify(q)); }

function queueOfflineChange(id, body) {
  const q = getOfflineQueue();
  const existing = q.findIndex(item => item.id === id);
  if (existing !== -1) q[existing].body = body; else q.push({ id, body });
  saveOfflineQueue(q);
  localStorage.setItem('bwr_cached_paths', JSON.stringify(allPaths));
  updateSyncBanner();
  showStatus('Hors-ligne — changement enregistré, sera envoyé à la reconnexion.');
}

function updateSyncBanner() {
  const banner = document.getElementById('syncBanner');
  if (!banner) return;
  const total = getOfflineQueue().length + getOfflineNewPaths().length;
  if (total === 0) { banner.style.display = 'none'; return; }
  banner.style.display = 'flex';
  banner.querySelector('.sync-count').textContent =
    `${total} changement${total > 1 ? 's' : ''} en attente de synchronisation`;
}

async function replayOfflineQueue() {
  const q = getOfflineQueue();
  if (q.length === 0) return;
  document.getElementById('syncBanner')?.classList.add('syncing');
  let remaining = [];
  for (const item of q) {
    try {
      const res = await fetch(`${API_URL}/api/paths/${item.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...authHeader() },
        body: JSON.stringify(item.body),
      });
      if (!res.ok) remaining.push(item);
    } catch { remaining.push(item); }
  }
  saveOfflineQueue(remaining);
  document.getElementById('syncBanner')?.classList.remove('syncing');
  updateSyncBanner();
  if (remaining.length === 0) {
    showStatus('Synchronisation terminée — changements envoyés !');
    await loadPaths();
  }
}

// ── Offline queue for new path creations ──────────────────────────────────────
function getOfflineNewPaths() {
  try { return JSON.parse(localStorage.getItem('bwr_offline_new_paths') || '[]'); } catch { return []; }
}
function saveOfflineNewPaths(q) { localStorage.setItem('bwr_offline_new_paths', JSON.stringify(q)); }

function queueOfflineNewPath(data) {
  const q = getOfflineNewPaths();
  q.push({ ...data, queuedAt: Date.now() });
  saveOfflineNewPaths(q);
  updateSyncBanner();
}

async function replayOfflineNewPaths() {
  const q = getOfflineNewPaths();
  if (q.length === 0) return;
  document.getElementById('syncBanner')?.classList.add('syncing');
  let remaining = [];
  for (const item of q) {
    try {
      const { queuedAt, ...payload } = item;
      const res = await fetch(`${API_URL}/api/paths`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeader() },
        body: JSON.stringify(payload),
      });
      if (!res.ok) remaining.push(item);
    } catch { remaining.push(item); }
  }
  saveOfflineNewPaths(remaining);
  document.getElementById('syncBanner')?.classList.remove('syncing');
  updateSyncBanner();
  if (remaining.length === 0 && q.length > 0) {
    showStatus('Synchronisation terminée — nouveaux chemins envoyés !');
    await loadPaths();
  }
}

window.addEventListener('online', async () => {
  await replayOfflineQueue();
  await replayOfflineNewPaths();
});

// ── Load & render saved paths ─────────────────────────────────────────────────
async function loadPaths() {
  try {
    const res = await fetch(`${API_URL}/api/paths`);
    if (!res.ok) throw new Error();
    allPaths = await res.json();
    localStorage.setItem('bwr_cached_paths', JSON.stringify(allPaths));
  } catch {
    const cached = localStorage.getItem('bwr_cached_paths');
    if (cached) { allPaths = JSON.parse(cached); }
  }
  // Show offline-queued new paths immediately with temp IDs until synced
  getOfflineNewPaths().forEach(item => {
    const tempId = `offline_${item.queuedAt}`;
    if (!allPaths.some(p => p.id === tempId)) {
      const { queuedAt, ...path } = item;
      allPaths.push({ ...path, id: tempId });
    }
  });
  renderPaths();
}

async function loadReports() {
  try {
    const res = await fetch(`${API_URL}/api/reports`);
    if (!res.ok) return;
    allReports = await res.json();
    renderReportMarkers();
  } catch {}
}

function renderReportMarkers() {
  reportMarkerLayer.clearLayers();
  allReports.filter(r => r.status === 'open').forEach(r => {
    const path = allPaths.find(p => p.id === r.pathId);
    if (!path) return;
    const coords = path.coordinates;
    const mid = (r.lat && r.lon) ? [r.lat, r.lon] : coords[Math.floor(coords.length / 2)];
    const icon = REPORT_ICONS[r.type] || '⚠️';
    const label = REPORT_LABELS_ADMIN[r.type] || r.type;
    const marker = L.marker(mid, {
      icon: L.divIcon({ className: 'report-marker', html: `<div class="report-dot">${icon}</div>`, iconAnchor: [16, 16], iconSize: [32, 32] }),
    });
    marker.bindPopup(`
      <div class="color-popup">
        <div class="color-popup-name">${icon} ${label}</div>
        <div style="font-size:0.8rem;color:#6b7280;margin-bottom:8px">sur : ${path.name || 'Chemin sans nom'}</div>
        ${r.note ? `<p class="popup-notes" style="margin-bottom:8px">${r.note}</p>` : ''}
        ${(r.hasPhoto || r.photo) ? `<img src="${r.hasPhoto ? `${API_URL}/api/photos/${r.id}` : r.photo}" class="report-popup-photo" alt="photo" style="margin-bottom:8px">` : ''}
        <small style="color:#9ca3af">${new Date(r.date).toLocaleDateString('fr-FR')}</small>
        <button class="btn-primary" id="resolve-${r.id}" style="width:100%;margin-top:10px;padding:8px">✓ Marquer comme résolu</button>
      </div>
    `, { autoClose: false, closeOnClick: false });
    marker.on('popupopen', () => {
      setTimeout(() => {
        document.getElementById(`resolve-${r.id}`)?.addEventListener('click', async () => {
          marker.closePopup();
          await dismissReport(r.id);
        });
      }, 50);
    });
    marker.addTo(reportMarkerLayer);
  });
}

async function dismissReport(reportId) {
  const res = await fetch(`${API_URL}/api/reports/${reportId}`, { method: 'DELETE', headers: authHeader() });
  if (res.ok) {
    allReports = allReports.filter(r => r.id !== reportId);
    renderReportMarkers();
    showStatus('Signalement résolu !');
  } else {
    showStatus('Erreur lors de la résolution.', true);
  }
}

function renderPaths() {
  Object.values(pathLayers).forEach(l => {
    if (Array.isArray(l)) l.forEach(x => map.removeLayer(x));
    else map.removeLayer(l);
  });
  pathLayers = {};

  allPaths.forEach(path => {
    const clickHandler = (e) => {
      L.DomEvent.stopPropagation(e);
      if (splitModeActive && splitTargetPath?.id === path.id) {
        handleSplitClick(path, e.latlng);
      } else if (!splitModeActive) {
        openColorPopup(path, e.latlng);
      }
    };

    // Visible line
    const pathColor = STATUS_COLORS[path.status] || '#9ca3af';
    const line = L.polyline(path.coordinates, {
      color: pathColor,
      weight: offlineSelectMode ? pathWeight() + 2 : pathWeight(),
      opacity: 1,
      dashArray: offlineSelectMode ? '10 7' : null,
    });
    if (offlineSelectMode) {
      line.on('mouseover', () => line.setStyle({ color: '#2563eb', weight: pathWeight() + 4, dashArray: '10 7' }));
      line.on('mouseout',  () => line.setStyle({ color: pathColor,  weight: pathWeight() + 2, dashArray: '10 7' }));
    }
    line.on('click', clickHandler);
    line.addTo(map);

    // Invisible wide hit-target so thin/gray lines are always easy to click
    const hitTarget = L.polyline(path.coordinates, {
      color: 'transparent',
      weight: 20,
      opacity: 0,
      interactive: true,
    });
    hitTarget.on('click', clickHandler);
    hitTarget.addTo(map);

    pathLayers[path.id] = [line, hitTarget];
  });
}

// ── Color popup ───────────────────────────────────────────────────────────────
function openColorPopup(path, latlng) {
  const colorButtons = Object.entries(STATUS_COLORS).map(([status, color]) => {
    const isActive = path.status === status;
    return `<button class="color-btn ${isActive ? 'active' : ''}" style="background:${color}" data-status="${status}" title="${STATUS_LABELS[status]}">${isActive ? '✓' : ''}</button>`;
  }).join('');

  L.popup({ maxWidth: 280, className: 'admin-popup', autoClose: false, closeOnClick: false })
    .setLatLng(latlng)
    .setContent(`
      <div class="color-popup">
        <div class="color-popup-name">${path.name || 'Chemin sans nom'}</div>
        <div class="color-popup-label">Changer la couleur :</div>
        <div class="color-popup-btns" id="colorBtns-${path.id}">${colorButtons}</div>
        <div class="color-popup-legend">
          <span style="color:${STATUS_COLORS.easy}">● Facile</span>
          <span style="color:${STATUS_COLORS.medium}">● Moyen</span>
          <span style="color:${STATUS_COLORS.hard}">● Difficile</span>
          <span style="color:${STATUS_COLORS.not_passable}">● Impraticable</span>
        </div>
        ${path.conditions?.length ? `
        <div class="popup-conditions">
          ${path.conditions.map(c => {
            const def = CONDITIONS.find(x => x.id === c);
            return def ? `<span class="popup-cond-tag">${def.icon} ${def.label}</span>` : '';
          }).join('')}
        </div>` : ''}
        ${(() => {
          const pathReports = allReports.filter(r => r.status === 'open' && r.pathId === path.id);
          if (!pathReports.length) return '';
          return `<div class="popup-reports-section">
            <div class="popup-reports-title">🚨 ${pathReports.length} signalement(s)</div>
            ${pathReports.map(r => `
              <div class="popup-report-row">
                <span>${REPORT_ICONS[r.type] || '⚠️'} ${REPORT_LABELS_ADMIN[r.type] || r.type}${r.note ? ' — ' + r.note : ''}</span>
                <button class="popup-resolve-btn" data-rid="${r.id}">✓ Résolu</button>
              </div>`).join('')}
          </div>`;
        })()}
        <div class="admin-quick-actions">
          <button class="popup-fallen-btn" id="adminFallenTree-${path.id}">🌲 Arbre tombé ici</button>
          <button class="popup-fallen-btn" id="adminMuddy-${path.id}">🟤 Boueux ici</button>
          <button class="popup-fallen-btn" id="adminRutted-${path.id}">🛞 Ornières ici</button>
          <button class="popup-fallen-btn" id="adminBrokenSign-${path.id}">🪧 Carrefour cassé</button>
          ${(() => {
            const openReports = allReports.filter(r => r.status === 'open' && r.pathId === path.id);
            return openReports.length
              ? `<button class="admin-resolved-btn" id="adminResolved-${path.id}" data-rid="${openReports[0].id}">✅ Problème résolu</button>`
              : '';
          })()}
        </div>
        <div class="color-popup-actions">
          <button class="popup-edit-btn" id="editBtn-${path.id}">✎ Modifier</button>
          <button class="popup-split-btn" id="splitBtn-${path.id}">✂️ Couper</button>
          <button class="popup-delete-btn" id="delBtn-${path.id}">🗑</button>
        </div>
      </div>
    `)
    .openOn(map);

  setTimeout(() => {
    document.querySelectorAll(`#colorBtns-${path.id} .color-btn`).forEach(btn => {
      btn.addEventListener('click', async () => {
        await updatePathStatus(path, btn.dataset.status);
        map.closePopup();
      });
    });

    document.getElementById(`adminFallenTree-${path.id}`)?.addEventListener('click', async () => {
      map.closePopup();
      const res = await fetch(`${API_URL}/api/reports`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeader() },
        body: JSON.stringify({ pathId: path.id, type: 'fallen_tree', note: '', lat: latlng.lat, lon: latlng.lng }),
      });
      if (res.ok) {
        const report = await res.json();
        allReports.push(report);
        renderReportMarkers();
        showStatus('🌲 Arbre tombé signalé !');
      } else {
        showStatus('Erreur lors du signalement.', true);
      }
    });

    for (const [btnId, type, msg] of [
      [`adminMuddy-${path.id}`,      'muddy',       '🟤 Boueux signalé !'],
      [`adminRutted-${path.id}`,     'rutted',      '🛞 Ornières signalées !'],
      [`adminBrokenSign-${path.id}`, 'broken_sign', '🪧 Carrefour cassé signalé !'],
    ]) {
      document.getElementById(btnId)?.addEventListener('click', async () => {
        map.closePopup();
        const res = await fetch(`${API_URL}/api/reports`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeader() },
          body: JSON.stringify({ pathId: path.id, type, note: '', lat: latlng.lat, lon: latlng.lng }),
        });
        if (res.ok) {
          const report = await res.json();
          allReports.push(report);
          renderReportMarkers();
          showStatus(msg);
        } else {
          showStatus('Erreur lors du signalement.', true);
        }
      });
    }

    document.getElementById(`adminResolved-${path.id}`)?.addEventListener('click', async () => {
      const rid = document.getElementById(`adminResolved-${path.id}`).dataset.rid;
      map.closePopup();
      await dismissReport(rid);
    });

    document.getElementById(`editBtn-${path.id}`)?.addEventListener('click', () => {
      map.closePopup();
      openEditForm(path);
    });
    document.getElementById(`splitBtn-${path.id}`)?.addEventListener('click', () => {
      enterSplitMode(path);
    });
    document.getElementById(`delBtn-${path.id}`)?.addEventListener('click', async () => {
      if (!confirm(`Supprimer "${path.name || 'ce chemin'}" ?`)) return;
      await deletePath(path.id);
      map.closePopup();
    });
    document.querySelectorAll('.popup-resolve-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        map.closePopup();
        await dismissReport(btn.dataset.rid);
      });
    });
  }, 50);
}

async function updatePathStatus(path, newStatus) {
  const body = { ...path, status: newStatus };

  // Optimistic local update so the map reflects the change immediately
  const idx = allPaths.findIndex(p => p.id === path.id);
  if (idx !== -1) { allPaths[idx] = { ...allPaths[idx], status: newStatus }; renderPaths(); }

  try {
    const res = await fetch(`${API_URL}/api/paths/${path.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...authHeader() },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      localStorage.setItem('bwr_cached_paths', JSON.stringify(allPaths));
      showStatus(`Couleur changée en "${STATUS_LABELS[newStatus]}" !`);
    } else if (!navigator.onLine || res.status === 503) {
      queueOfflineChange(path.id, body);
    } else {
      showStatus('Erreur lors du changement.', true);
    }
  } catch {
    queueOfflineChange(path.id, body);
  }
}

// ── Edit form ─────────────────────────────────────────────────────────────────
function openEditForm(path) {
  document.getElementById('editName').value = path.name || '';
  document.getElementById('editType').value = path.pathType || 'foot';
  document.getElementById('editStatus').value = path.status;
  document.getElementById('editNotes').value = path.notes || '';
  setConditions('editConditions', path.conditions || []);
  const form = document.getElementById('editForm');
  form.dataset.pathId = path.id;
  form.classList.remove('hidden');
}

document.getElementById('btnCancelEdit').addEventListener('click', () => {
  document.getElementById('editForm').classList.add('hidden');
});

document.getElementById('btnUpdatePath').addEventListener('click', async () => {
  const id = document.getElementById('editForm').dataset.pathId;
  const res = await fetch(`${API_URL}/api/paths/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...authHeader() },
    body: JSON.stringify({
      name: document.getElementById('editName').value,
      pathType: document.getElementById('editType').value,
      status: document.getElementById('editStatus').value,
      notes: document.getElementById('editNotes').value,
      conditions: getSelectedConditions('editConditions'),
    }),
  });
  if (res.ok) {
    document.getElementById('editForm').classList.add('hidden');
    showStatus('Chemin mis à jour !');
    await loadPaths();
  } else {
    showStatus('Erreur lors de la mise à jour.', true);
  }
});

document.getElementById('btnDeletePath').addEventListener('click', async () => {
  const id = document.getElementById('editForm').dataset.pathId;
  const name = document.getElementById('editName').value;
  if (!confirm(`Supprimer "${name || 'ce chemin'}" ?`)) return;
  document.getElementById('editForm').classList.add('hidden');
  await deletePath(id);
});

async function deletePath(id) {
  const res = await fetch(`${API_URL}/api/paths/${id}`, { method: 'DELETE', headers: authHeader() });
  if (res.ok) { showStatus('Chemin supprimé.'); await loadPaths(); }
  else showStatus('Erreur lors de la suppression.', true);
}

// ── Members panel ─────────────────────────────────────────────────────────────
// ── Messages panel ────────────────────────────────────────────────────────────
document.getElementById('btnMessages').addEventListener('click', async () => {
  document.getElementById('pathForm').classList.add('hidden');
  document.getElementById('editForm').classList.add('hidden');
  document.getElementById('membersPanel').classList.add('hidden');
  const panel = document.getElementById('messagesPanel');
  panel.classList.toggle('hidden');
  if (!panel.classList.contains('hidden')) await loadMessages();
});

document.getElementById('btnCloseMessagesPanel').addEventListener('click', () => {
  document.getElementById('messagesPanel').classList.add('hidden');
});

async function loadMessages() {
  const list = document.getElementById('messagesList');
  list.innerHTML = '<p style="color:#6b7280;font-size:0.88rem">Chargement…</p>';
  try {
    const res = await fetch(`${API_URL}/api/contacts`, { headers: authHeader() });
    const messages = await res.json();
    if (!res.ok) { list.innerHTML = `<p style="color:red">${messages.error}</p>`; return; }
    const badge = document.getElementById('msgBadge');
    if (messages.length > 0) { badge.textContent = messages.length; badge.style.display = ''; }
    else badge.style.display = 'none';
    if (messages.length === 0) { list.innerHTML = '<p style="color:#6b7280;font-size:0.88rem">Aucun message.</p>'; return; }
    list.innerHTML = messages.map(m => {
      const date = new Date(m.date).toLocaleString('fr-FR');
      return `<div data-id="${m.id}" style="padding:12px;background:#f9fafb;border:1px solid #e5e7eb;border-radius:10px">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px">
          <div>
            <div style="font-weight:600;font-size:0.9rem">${m.name}</div>
            <div style="font-size:0.78rem;color:#6b7280">${m.email} · ${date}</div>
          </div>
          <button class="btn-secondary msg-delete-btn" data-id="${m.id}" style="width:auto;padding:4px 10px;font-size:0.78rem;flex-shrink:0">Supprimer</button>
        </div>
        <p style="margin:8px 0 0;font-size:0.88rem;white-space:pre-wrap;color:#374151">${m.message.replace(/</g,'&lt;')}</p>
        <a href="mailto:${m.email}?subject=Re: votre message BWR" style="display:inline-block;margin-top:8px;font-size:0.8rem;color:#166534;text-decoration:underline">↩ Répondre par email</a>
      </div>`;
    }).join('');
    list.querySelectorAll('.msg-delete-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        btn.textContent = '…'; btn.disabled = true;
        await fetch(`${API_URL}/api/contacts/${btn.dataset.id}`, { method: 'DELETE', headers: authHeader() });
        await loadMessages();
      });
    });
  } catch {
    list.innerHTML = '<p style="color:red">Erreur réseau</p>';
  }
}

// load badge count on startup
(async () => {
  try {
    const res = await fetch(`${API_URL}/api/contacts`, { headers: authHeader() });
    if (!res.ok) return;
    const msgs = await res.json();
    const badge = document.getElementById('msgBadge');
    if (msgs.length > 0) { badge.textContent = msgs.length; badge.style.display = ''; }
  } catch {}
})();

document.getElementById('btnMembers').addEventListener('click', async () => {
  document.getElementById('pathForm').classList.add('hidden');
  document.getElementById('editForm').classList.add('hidden');
  const panel = document.getElementById('membersPanel');
  panel.classList.toggle('hidden');
  if (!panel.classList.contains('hidden')) await loadMembers();
});

document.getElementById('btnCloseMembersPanel').addEventListener('click', () => {
  document.getElementById('membersPanel').classList.add('hidden');
});

async function loadMembers() {
  const list = document.getElementById('membersList');
  list.innerHTML = '<p style="color:#6b7280;font-size:0.88rem">Chargement…</p>';
  try {
    const res = await fetch(`${API_URL}/api/users`, { headers: authHeader() });
    const users = await res.json();
    if (!res.ok) { list.innerHTML = `<p style="color:red">${users.error}</p>`; return; }
    const planIcon = { free: '🌿', silver: '🥈', gold: '🥇' };
    list.innerHTML = users.map(u => {
      const expiry = u.planExpiresAt
        ? `<span style="font-size:0.75rem;color:#f97316">⏳ expire le ${new Date(u.planExpiresAt).toLocaleDateString('fr-FR')}</span>`
        : '';
      return `<div style="display:flex;justify-content:space-between;align-items:center;padding:10px 12px;background:#f9fafb;border:1px solid #e5e7eb;border-radius:10px">
        <div>
          <div style="font-weight:600;font-size:0.9rem">${u.name}</div>
          <div style="font-size:0.78rem;color:#6b7280">${u.email}</div>
          <div style="margin-top:3px">${planIcon[u.plan] || '🌿'} <strong>${u.plan}</strong> ${expiry}</div>
        </div>
        ${u.role !== 'admin' ? `<button class="btn-secondary member-plan-btn" style="width:auto;padding:6px 12px;font-size:0.8rem"
          data-id="${u.id}" data-name="${u.name.replace(/"/g,'&quot;')}" data-plan="${u.plan}" data-base="${u.planBase||'free'}">Modifier plan</button>` : ''}
      </div>`;
    }).join('');
    list.querySelectorAll('.member-plan-btn').forEach(btn => {
      btn.addEventListener('click', () =>
        openMemberPlan(btn.dataset.id, btn.dataset.name, btn.dataset.plan, btn.dataset.base, btn));
    });
  } catch (e) {
    list.innerHTML = `<p style="color:red">Erreur réseau</p>`;
  }
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

let _memberPlanTrigger = null;
let _memberPlanTrapRelease = null;

function openMemberPlan(userId, name, plan, planBase, triggerEl) {
  document.getElementById('memberPlanUserId').value = userId;
  document.getElementById('memberPlanTitle').textContent = `Plan de ${name}`;
  document.getElementById('memberPlanSelect').value = plan;
  document.getElementById('memberPlanBase').value = planBase || 'free';
  document.getElementById('memberPlanExpiry').value = '';
  const modal = document.getElementById('memberPlanModal');
  modal.classList.remove('hidden');
  _memberPlanTrigger = triggerEl || null;
  _memberPlanTrapRelease = trapFocus(modal);
  document.getElementById('memberPlanSelect').focus();
}
function closeMemberPlan() {
  document.getElementById('memberPlanModal').classList.add('hidden');
  if (_memberPlanTrapRelease) { _memberPlanTrapRelease(); _memberPlanTrapRelease = null; }
  if (_memberPlanTrigger) { _memberPlanTrigger.focus(); _memberPlanTrigger = null; }
}

document.getElementById('btnCancelMemberPlan').addEventListener('click', closeMemberPlan);
document.getElementById('memberPlanModal').addEventListener('keydown', e => { if (e.key === 'Escape') closeMemberPlan(); });

document.getElementById('btnSaveMemberPlan').addEventListener('click', async () => {
  const userId  = document.getElementById('memberPlanUserId').value;
  const plan    = document.getElementById('memberPlanSelect').value;
  const expiry  = document.getElementById('memberPlanExpiry').value;
  const base    = document.getElementById('memberPlanBase').value;
  const btn     = document.getElementById('btnSaveMemberPlan');
  btn.textContent = 'Enregistrement…';
  btn.disabled = true;
  try {
    const body = { plan };
    if (expiry) { body.planExpiresAt = new Date(expiry + 'T23:59:59').toISOString(); body.planBase = base; }
    else        { body.planExpiresAt = null; body.planBase = null; }
    const res = await fetch(`${API_URL}/api/auth/plan/${userId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...authHeader() },
      body: JSON.stringify(body),
    });
    if (!res.ok) { const d = await res.json(); throw new Error(d.error); }
    closeMemberPlan();
    showStatus('Plan mis à jour !');
    await loadMembers();
  } catch (e) {
    showStatus(e.message || 'Erreur', true);
  } finally {
    btn.textContent = 'Enregistrer';
    btn.disabled = false;
  }
});

// ── Status bar ────────────────────────────────────────────────────────────────
function showStatus(msg, isError = false) {
  const el = document.getElementById('adminStatus');
  el.textContent = msg;
  el.className = 'admin-status' + (isError ? ' error' : (msg ? ' success' : ''));
  if (msg) setTimeout(() => { el.textContent = ''; el.className = 'admin-status'; }, 4000);
}

// On load: show pending banner and replay queues if already online
updateSyncBanner();
if (navigator.onLine) { replayOfflineQueue(); replayOfflineNewPaths(); }

const btnAdminSync = document.getElementById('btnAdminSync');
if (btnAdminSync) btnAdminSync.addEventListener('click', function () { replayOfflineQueue(); replayOfflineNewPaths(); });

// ── Offline tile download (full Forêt de Compiègne) ───────────────────────
const FOREST_BBOX = { north: 49.47, south: 49.27, west: 2.65, east: 3.10 };
function lonToTileX(lon, z) { return Math.floor((lon + 180) / 360 * Math.pow(2, z)); }
function latToTileY(lat, z) {
  return Math.floor((1 - Math.log(Math.tan(lat * Math.PI / 180) + 1 / Math.cos(lat * Math.PI / 180)) / Math.PI) / 2 * Math.pow(2, z));
}

(async function initAdminOfflineBtn() {
  const btn = document.getElementById('btnOfflineAdmin');
  if (!btn) return;
  if (localStorage.getItem('bwr_forest_cached') === '1') {
    btn.querySelector('.btn-emoji').textContent = '✅';
    btn.querySelector('.btn-label').textContent = 'Téléchargée';
  }
  btn.addEventListener('click', async () => {
    if (btn.dataset.downloading === '1') return;
    btn.dataset.downloading = '1';
    btn.querySelector('.btn-emoji').textContent = '⏳';
    btn.querySelector('.btn-label').textContent = '0%';
    btn.disabled = true;
    const tiles = [];
    const subs = ['a', 'b', 'c'];
    for (let z = 10; z <= 15; z++) {
      const x0 = lonToTileX(FOREST_BBOX.west, z),  x1 = lonToTileX(FOREST_BBOX.east, z);
      const y0 = latToTileY(FOREST_BBOX.north, z),  y1 = latToTileY(FOREST_BBOX.south, z);
      for (let x = x0; x <= x1; x++)
        for (let y = y0; y <= y1; y++)
          tiles.push(`https://${subs[(x + y) % 3]}.tile.opentopomap.org/${z}/${x}/${y}.png`);
    }
    try {
      const cache = await caches.open('bwr-offline-tiles');
      let done = 0;
      const BATCH = 8;
      for (let i = 0; i < tiles.length; i += BATCH) {
        await Promise.all(tiles.slice(i, i + BATCH).map(async url => {
          try { await cache.put(url, await fetch(url, { mode: 'no-cors' })); } catch {}
          done++;
        }));
        btn.querySelector('.btn-label').textContent = `${Math.round(done / tiles.length * 100)}%`;
      }
      localStorage.setItem('bwr_forest_cached', '1');
      showStatus(`Carte hors-ligne sauvegardée ! (${tiles.length} tuiles)`);
      btn.querySelector('.btn-emoji').textContent = '✅';
      btn.querySelector('.btn-label').textContent = 'Téléchargée';
    } catch { showStatus('Erreur lors du téléchargement.', true); }
    finally {
      delete btn.dataset.downloading;
      btn.disabled = false;
    }
  });
}());
