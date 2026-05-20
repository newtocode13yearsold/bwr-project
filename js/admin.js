const CONDITIONS = [
  { id: 'dry',     icon: '✅', label: 'Sec' },
  { id: 'muddy',   icon: '⚠️', label: 'Boueux' },
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

let currentUser = null;
let drawnCoordinates = null;
let allPaths = [];
let pathLayers = {};
let osmLayers = [];
let map = null;
let drawControl = null;
let drawnItems = null;
let selectModeActive = false;

// ── Auth check ────────────────────────────────────────────────────────────────
(async () => {
  currentUser = await requireAuth('admin');
  if (!currentUser) return;
  initUserMenu();
  initMap();
  loadPaths();
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
      <a href="map.html">Voir la carte</a>
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
  map = L.map('map').setView(MAP_CENTER, MAP_ZOOM);

  ignLayer = L.tileLayer(
    'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
    { attribution: 'Map data: &copy; OpenStreetMap contributors, SRTM | Style: &copy; OpenTopoMap', maxZoom: 17, subdomains: ['a','b','c'] }
  );
  ignLayer.addTo(map);

  setTimeout(() => map.invalidateSize(), 100);
  initConditionTags('newConditions');
  initConditionTags('editConditions');

  drawnItems = new L.FeatureGroup();
  map.addLayer(drawnItems);

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

  // Scale path weight on zoom
  map.on('zoomend', updatePathWeights);
}

function pathWeight() {
  if (!map) return 4;
  const z = map.getZoom();
  return Math.max(2, Math.min(10, Math.round((z - 8) * 0.7)));
}

function updatePathWeights() {
  const w = pathWeight();
  Object.values(pathLayers).forEach(l => l.setStyle({ weight: w }));
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
  document.getElementById('btnSelectPath').textContent = '🗺 Sélectionner un chemin';
  document.getElementById('btnSelectPath').style.background = '';
  map.getContainer().style.cursor = '';
  // IGN stays on — nothing to switch back
  clearOSMLayer();
  showStatus('');
}

async function loadOSMPaths() {
  if (map.getZoom() < 12) {
    showStatus('Zoome plus près de la forêt (zoom minimum : 12).', true);
    exitSelectMode();
    return;
  }

  showStatus('Chargement des chemins…');

  const b = map.getBounds();
  const bbox = `${b.getSouth().toFixed(4)},${b.getWest().toFixed(4)},${b.getNorth().toFixed(4)},${b.getEast().toFixed(4)}`;

  try {
    const res = await fetch(`${API_URL}/api/osm?bbox=${bbox}`);
    if (!res.ok) throw new Error();
    const data = await res.json();
    renderOSMPaths(data);
    const count = osmLayers.length;
    if (count === 0) {
      showStatus('Aucun chemin trouvé ici — zoome sur la forêt de Compiègne.');
    } else {
      showStatus(`${count} chemins disponibles — clique sur un chemin en pointillés.`);
    }
  } catch {
    showStatus('Impossible de charger les chemins. Réessaie.', true);
    exitSelectMode();
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

    // Skip paths already saved
    const alreadySaved = allPaths.some(p =>
      Math.abs(p.coordinates[0][0] - coords[0][0]) < 0.0001 &&
      Math.abs(p.coordinates[0][1] - coords[0][1]) < 0.0001
    );
    if (alreadySaved) return;

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

  L.popup({ maxWidth: 280, className: 'admin-popup' })
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
  const res = await fetch(`${API_URL}/api/paths`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeader() },
    body: JSON.stringify({ name, pathType, status, notes: '', conditions, coordinates }),
  });
  if (res.ok) {
    showStatus(`"${name}" enregistré !`);
    await loadPaths();
  } else {
    showStatus('Erreur lors de l\'enregistrement.', true);
  }
}

// ── Draw mode (manual) ────────────────────────────────────────────────────────
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

// ── Load & render saved paths ─────────────────────────────────────────────────
async function loadPaths() {
  const res = await fetch(`${API_URL}/api/paths`);
  allPaths = await res.json();
  renderPaths();
}

function renderPaths() {
  Object.values(pathLayers).forEach(l => map.removeLayer(l));
  pathLayers = {};

  allPaths.forEach(path => {
    const line = L.polyline(path.coordinates, {
      color: STATUS_COLORS[path.status] || '#9ca3af',
      weight: pathWeight(),
      opacity: 0.9,
    });
    line.on('click', (e) => {
      L.DomEvent.stopPropagation(e);
      if (!selectModeActive) openColorPopup(path, e.latlng);
    });
    line.addTo(map);
    pathLayers[path.id] = line;
  });
}

// ── Color popup ───────────────────────────────────────────────────────────────
function openColorPopup(path, latlng) {
  const colorButtons = Object.entries(STATUS_COLORS).map(([status, color]) => {
    const isActive = path.status === status;
    return `<button class="color-btn ${isActive ? 'active' : ''}" style="background:${color}" data-status="${status}" title="${STATUS_LABELS[status]}">${isActive ? '✓' : ''}</button>`;
  }).join('');

  L.popup({ maxWidth: 280, className: 'admin-popup' })
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
        <div class="color-popup-actions">
          <button class="popup-edit-btn" id="editBtn-${path.id}">✎ Modifier les infos</button>
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
    document.getElementById(`editBtn-${path.id}`)?.addEventListener('click', () => {
      map.closePopup();
      openEditForm(path);
    });
    document.getElementById(`delBtn-${path.id}`)?.addEventListener('click', async () => {
      if (!confirm(`Supprimer "${path.name || 'ce chemin'}" ?`)) return;
      await deletePath(path.id);
      map.closePopup();
    });
  }, 50);
}

async function updatePathStatus(path, newStatus) {
  const res = await fetch(`${API_URL}/api/paths/${path.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...authHeader() },
    body: JSON.stringify({ ...path, status: newStatus }),
  });
  if (res.ok) {
    showStatus(`Couleur changée en "${STATUS_LABELS[newStatus]}" !`);
    await loadPaths();
  } else {
    showStatus('Erreur lors du changement.', true);
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

// ── Status bar ────────────────────────────────────────────────────────────────
function showStatus(msg, isError = false) {
  const el = document.getElementById('adminStatus');
  el.textContent = msg;
  el.className = 'admin-status' + (isError ? ' error' : (msg ? ' success' : ''));
  if (msg) setTimeout(() => { el.textContent = ''; el.className = 'admin-status'; }, 4000);
}
