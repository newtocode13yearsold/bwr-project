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

const REPORT_ICONS  = { fallen_tree:'🌲', flooded:'💧', closed:'🚫', danger:'⚠️', other:'📝' };
const REPORT_LABELS_ADMIN = { fallen_tree:'Arbre tombé', flooded:'Chemin inondé', closed:'Chemin fermé', danger:'Danger', other:'Autre' };

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
      <a href="index.html">🏠 Accueil</a>
      <a href="map.html">🗺 Voir la carte</a>
      <a href="profile.html">👤 Mon profil</a>
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
  map = L.map('map', { minZoom: 10 }).setView(MAP_CENTER, MAP_ZOOM);

  ignLayer = L.tileLayer(
    'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
    { attribution: 'Map data: &copy; OpenStreetMap contributors, SRTM | Style: &copy; OpenTopoMap', maxZoom: 17, subdomains: ['a','b','c'], detectRetina: true }
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
  if (layer) layer.setStyle({ color: '#f59e0b', weight: pathWeight() + 4, opacity: 1 });
  document.getElementById('btnSplitCancel').style.display = '';
  showStatus(`Clique sur "${path.name || 'le chemin'}" pour le couper en deux.`);
}

function exitSplitMode() {
  if (splitTargetPath) {
    const layer = pathLayers[splitTargetPath.id];
    if (layer) layer.setStyle({ color: STATUS_COLORS[splitTargetPath.status] || '#9ca3af', weight: pathWeight(), opacity: 0.9 });
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

// ── Load & render saved paths ─────────────────────────────────────────────────
async function loadPaths() {
  const res = await fetch(`${API_URL}/api/paths`);
  allPaths = await res.json();
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
        ${r.photo ? `<img src="${r.photo}" class="report-popup-photo" alt="photo" style="margin-bottom:8px">` : ''}
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
      if (splitModeActive && splitTargetPath?.id === path.id) {
        handleSplitClick(path, e.latlng);
      } else if (!selectModeActive && !splitModeActive) {
        openColorPopup(path, e.latlng);
      }
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
