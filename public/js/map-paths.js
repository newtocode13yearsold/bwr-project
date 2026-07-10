// map-paths.js — path rendering, walked-path tracking, click detection and the
// path popup / report flow for the map page.
// Split out of map.js. Classic script loaded AFTER js/map.js (which creates the
// shared `const map` and `let allPaths/activeFilters` this file uses) and before
// map-locate.js / map-sync.js. Top-level code here only builds layers / attaches
// handlers that reference already-created globals, so load order is safe.

// ── Path layer ─────────────────────────────────────────────────────────────────
const pathLayer = L.layerGroup().addTo(map);

function pathWeight() {
  return Math.max(2, Math.min(8, map.getZoom() - 10));
}

// ── Paths ─────────────────────────────────────────────────────────────────────
let walkedPathLayer = null;

async function loadPaths() {
  try {
    const res = await fetch(`${API_URL}/api/paths`);
    if (!res.ok) return;
    const data = await res.json();
    if (!Array.isArray(data)) return;
    allPaths = data;
    renderPaths();
    showPathHintIfNeeded();
    if (_userPlan === 'gold') loadWalkedOverlay();
  } catch (e) {
    console.error('loadPaths:', e);
  }
}

function renderPaths() {
  pathLayer.clearLayers();
  if (!Array.isArray(allPaths)) return;
  const w = pathWeight();
  allPaths.forEach(path => {
    if (!activeFilters.has(path.status)) return;
    if (!path.coordinates || path.coordinates.length < 2) return;
    const color = STATUS_COLORS[path.status] || '#9ca3af';
    L.polyline(path.coordinates, {
      color, weight: w, opacity: 0.85, lineCap: 'round', lineJoin: 'round',
    }).addTo(pathLayer);
    if (path.pathType === 'bike') {
      L.polyline(path.coordinates, {
        color: 'rgba(255,255,255,0.85)',
        weight: Math.max(1, w * 0.38),
        opacity: 1, lineCap: 'round', lineJoin: 'round',
        dashArray: `1 ${Math.max(6, w * 2)}`,
      }).addTo(pathLayer);
    }
  });
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

// Deployment zones — a path can only be selected/graded inside one of these boxes.
// Add a new L.latLngBounds here to open up another area.
const DEPLOYED_ZONES = [
  // Oise (60) — whole department + margin
  L.latLngBounds(L.latLng(49.00, 1.60), L.latLng(49.80, 3.25)),
  // Côte d'Opale (Boulogne-sur-Mer / Wimereux / Marquise, Pas-de-Calais 62)
  L.latLngBounds(L.latLng(50.40, 1.50), L.latLng(51.00, 2.10)),
];
const inDeployedZone = latlng => DEPLOYED_ZONES.some(b => b.contains(latlng));

map.on('click', e => {
  if (!inDeployedZone(e.latlng)) {
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
const REPORT_ICONS  = { fallen_tree:'🪵', flooded:'💧', muddy:'🟤', rutted:'🛞', broken_sign:'🪧', closed:'🚫', danger:'⚠️', other:'📝' };
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
          <button class="popup-fallen-btn" id="openFallenTree-${path.id}">🪵 Arbre tombé ici</button>
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
        showToast('🔒 Le signalement est disponible avec Argent — voir plans');
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
