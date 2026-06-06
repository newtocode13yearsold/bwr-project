// ── Path edit mode, difficulty popup, report popup ────────────────────────────
// Lazy-loaded by map.js when btnEditPaths is first clicked or a report button
// is tapped inside a path popup.
// All globals (map, allPaths, pathEditModeActive, _userPlan, STATUS_COLORS,
// STATUS_LABELS, REPORT_ICONS, REPORT_LABELS, API_URL, authHeader, showToast,
// renderPaths, queueMapReport, queueMapPatch, dismissPathHint) come from
// map.js / config.js, which execute before this file is injected.

// ── Edit-mode internal state ──────────────────────────────────────────────────
let _editPolylines  = [];
let _osmEditLayers  = [];

// ── Edit polylines ────────────────────────────────────────────────────────────
function renderEditPolylines() {
  _editPolylines.forEach(l => map.removeLayer(l));
  _editPolylines = [];
  allPaths.forEach(path => {
    if (!path.coordinates || path.coordinates.length < 2) return;
    const color = STATUS_COLORS[path.status] || '#9ca3af';
    const line = L.polyline(path.coordinates, { color, weight: 6, opacity: 0.85, dashArray: '8, 6' });
    line.on('mouseover', () => { line.setStyle({ weight: 9, opacity: 1 }); map.getContainer().style.cursor = 'pointer'; });
    line.on('mouseout',  () => { line.setStyle({ weight: 6, opacity: 0.85 }); map.getContainer().style.cursor = 'crosshair'; });
    line.on('click', e => { L.DomEvent.stopPropagation(e); openDifficultyPopup(path, e.latlng); });
    line.addTo(map);
    _editPolylines.push(line);
  });
}

function clearEditPolylines() {
  _editPolylines.forEach(l => map.removeLayer(l));
  _editPolylines = [];
}

function clearOsmEditLayers() {
  _osmEditLayers.forEach(l => map.removeLayer(l));
  _osmEditLayers = [];
}

// ── OSM path overlay (for path creation) ─────────────────────────────────────
async function loadOsmEditPaths() {
  if (map.getZoom() < 12) {
    showToast('Zoome plus près de la forêt (zoom minimum : 12).');
    exitPathEditMode();
    return;
  }
  showEditModeBar('Chargement des chemins…');
  const b    = map.getBounds();
  const bbox = `${b.getSouth().toFixed(4)},${b.getWest().toFixed(4)},${b.getNorth().toFixed(4)},${b.getEast().toFixed(4)}`;
  try {
    const res  = await fetch(`${API_URL}/api/osm?bbox=${bbox}`);
    if (!res.ok) throw new Error();
    const data = await res.json();
    renderOsmEditPaths(data);
    const count = _osmEditLayers.length;
    showEditModeBar(count === 0
      ? 'Aucun chemin OSM trouvé ici — zoome sur la forêt.'
      : `${count} chemins disponibles — clique sur un chemin en pointillés`);
  } catch {
    showToast('Chemins OSM indisponibles — tu peux quand même modifier les chemins existants.');
    showEditModeBar('Clique sur un chemin coloré pour changer sa difficulté');
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

// ── Enter / exit edit mode ────────────────────────────────────────────────────
function enterPathEditMode() {
  pathEditModeActive = true;
  dismissPathHint();
  const btn = document.getElementById('btnEditPaths');
  btn.querySelector('.btn-emoji').textContent = '✕';
  btn.querySelector('.btn-label').textContent = 'Terminer';
  btn.style.background = 'rgba(239,68,68,0.15)';
  btn.style.color = '#dc2626';
  map.getContainer().style.cursor = 'crosshair';
  renderEditPolylines();
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

// ── Difficulty popup (used in path edit mode) ─────────────────────────────────
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
          } else if (res.status === 403) {
            const data = await res.json().catch(() => ({}));
            showToast(`🔒 ${data.error || 'Notation non autorisée.'}`);
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

// ── Report popup ──────────────────────────────────────────────────────────────
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
    let photoData    = null;

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
  const icon  = REPORT_ICONS[report.type]  || '⚠️';
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
