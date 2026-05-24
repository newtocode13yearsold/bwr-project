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
const _userPlan   = (typeof normalisePlan === 'function') ? normalisePlan(_cachedUser?.plan) : (_cachedUser?.plan || 'free');

const map = L.map('map', { zoomControl: true, minZoom: 10, maxZoom: LAYER_MAX_ZOOM.ign }).setView(MAP_CENTER, MAP_ZOOM);
TILE_LAYERS.ign.addTo(map);

let currentLayer = 'ign';
let allPaths = [];
let pathLayers = {};
let activeFilters = new Set(['easy', 'medium', 'hard', 'not_passable', 'no_bike']);

function pathWeight() {
  const z = map.getZoom();
  return Math.max(2, Math.min(20, Math.round((z - 8) * 0.9)));
}

function updatePathWeights() {
  const w = pathWeight();
  Object.values(pathLayers).forEach(l => l.setStyle({ weight: w }));
}
map.on('zoom zoomend', updatePathWeights);

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

// ── Paths ─────────────────────────────────────────────────────────────────────
async function loadPaths() {
  try {
    const res = await fetch(`${API_URL}/api/paths`);
    allPaths = await res.json();
    renderPaths();
  } catch {}
}

function renderPaths() {
  Object.values(pathLayers).forEach(l => map.removeLayer(l));
  pathLayers = {};

  allPaths.forEach(path => {
    if (!activeFilters.has(path.status)) return;

    const color = STATUS_COLORS[path.status] || '#9ca3af';
    const line = L.polyline(path.coordinates, {
      color,
      weight: pathWeight(),
      opacity: 0.85,
    });

    const condHTML = path.conditions?.length
      ? `<div class="popup-cond-row">${path.conditions.map(c => {
          const icons = { dry:'✅', muddy:'⚠️', fallen:'❌', mtb:'🚴', running:'🏃', family:'👨‍👩‍👧' };
          const labels = { dry:'Sec', muddy:'Boueux', fallen:'Arbres tombés', mtb:'Idéal MTB', running:'Running', family:'Famille' };
          return `<span class="popup-cond-tag">${icons[c] || ''} ${labels[c] || c}</span>`;
        }).join('')}</div>`
      : '';
    line.on('click', (e) => {
      L.DomEvent.stopPropagation(e);
      openPathPopup(path, e.latlng);
    });

    line.addTo(map);
    pathLayers[path.id] = line;
  });
}

// ── Path popup & report flow ──────────────────────────────────────────────────
const REPORT_ICONS  = { fallen_tree:'🌲', flooded:'💧', closed:'🚫', danger:'⚠️', other:'📝' };
const REPORT_LABELS = { fallen_tree:'Arbre tombé', flooded:'Chemin inondé', closed:'Chemin fermé', danger:'Danger', other:'Autre' };

function openPathPopup(path, latlng) {
  const condHTML = path.conditions?.length
    ? `<div class="popup-cond-row">${path.conditions.map(c => {
        const icons2 = { dry:'✅', muddy:'⚠️', fallen:'❌', mtb:'🚴', running:'🏃', family:'👨‍👩‍👧' };
        const labels2 = { dry:'Sec', muddy:'Boueux', fallen:'Arbres tombés', mtb:'Idéal MTB', running:'Running', family:'Famille' };
        return `<span class="popup-cond-tag">${icons2[c] || ''} ${labels2[c] || c}</span>`;
      }).join('')}</div>` : '';

  L.popup({ maxWidth: 280, autoClose: true, closeOnClick: true })
    .setLatLng(latlng)
    .setContent(`
      <div class="popup">
        <strong>${path.name || 'Chemin sans nom'}</strong>
        <span class="popup-status" style="background:${STATUS_COLORS[path.status]}">${STATUS_LABELS[path.status] || path.status}</span>
        ${condHTML}
        ${path.notes ? `<p class="popup-notes">${path.notes}</p>` : ''}
        <button class="popup-report-btn" id="openReport-${path.id}">⚠️ Signaler un problème</button>
      </div>
    `)
    .openOn(map);

  setTimeout(() => {
    document.getElementById(`openReport-${path.id}`)?.addEventListener('click', () => {
      if (typeof can === 'function' && !can('reports_create', _userPlan)) {
        map.closePopup();
        showToast('🔒 Le signalement est disponible avec Argent — voir plans.html');
        return;
      }
      openReportPopup(path, latlng);
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

function openReportPopup(path, latlng) {
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
    let selectedType = 'fallen_tree';
    let photoData = null;

    const firstBtn = document.querySelector(`#rtypes-${path.id} .rtype-inline-btn`);
    if (firstBtn) firstBtn.classList.add('active');

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
  try {
    const res = await fetch(`${API_URL}/api/reports`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pathId: path.id, type, note, photo, lat: latlng?.lat, lon: latlng?.lng }),
    });
    if (res.ok) {
      const report = await res.json();
      placeReportMarker(report, path.coordinates);
      showToast('✅ Signalement envoyé — merci !');
    } else {
      showToast('Erreur lors du signalement.');
    }
  } catch {
    showToast('Erreur lors du signalement.');
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
    if (wanted === 'satellite' && typeof can === 'function' && !can('satellite_tiles', plan)) {
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
    if (typeof can !== 'function') return;
    if (v === 'satellite' && !can('satellite_tiles', _userPlan)) {
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

document.getElementById('btnLocate').addEventListener('click', () => {
  if (!navigator.geolocation) return;
  const btn = document.getElementById('btnLocate');
  btn.textContent = '⏳';
  btn.disabled = true;

  navigator.geolocation.getCurrentPosition(
    ({ coords: { latitude: lat, longitude: lng, accuracy } }) => {
      btn.textContent = '📍';
      btn.disabled = false;

      if (locationMarker) map.removeLayer(locationMarker);
      if (locationCircle) map.removeLayer(locationCircle);

      locationCircle = L.circle([lat, lng], {
        radius: accuracy,
        color: '#3b82f6', fillColor: '#93c5fd',
        fillOpacity: 0.18, weight: 1.5,
      }).addTo(map);

      locationMarker = L.circleMarker([lat, lng], {
        radius: 9, color: 'white', weight: 3,
        fillColor: '#3b82f6', fillOpacity: 1,
      }).bindPopup('Vous êtes ici').addTo(map);

      map.setView([lat, lng], Math.max(map.getZoom(), 15));
    },
    () => { btn.textContent = '📍'; btn.disabled = false; }
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

document.getElementById('btnReport').addEventListener('click', () => {
  if (typeof can === 'function' && !can('reports_create', _userPlan)) {
    showToast('🔒 Le signalement est disponible avec Argent — voir plans.html');
    return;
  }
  showToast('Clique sur un chemin coloré pour signaler un problème');
});

// ── Contact modal ─────────────────────────────────────────────────────────────
const contactModal = document.getElementById('contactModal');
document.getElementById('btnOpenContact').addEventListener('click', () => {
  contactModal.classList.remove('hidden');
  const u = getCachedUser();
  if (u) { document.getElementById('mcName').value = u.name; document.getElementById('mcEmail').value = u.email; }
});
document.getElementById('btnCloseContact').addEventListener('click', () => contactModal.classList.add('hidden'));
contactModal.addEventListener('click', e => { if (e.target === contactModal) contactModal.classList.add('hidden'); });

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
    setTimeout(() => { contactModal.classList.add('hidden'); status.textContent = ''; }, 1800);
  } catch { status.textContent = 'Erreur, réessaye.'; status.style.color = '#dc2626'; }
  finally { btn.textContent = 'Envoyer'; btn.disabled = false; }
});

// ── Cartes hors-ligne (Silver+) ───────────────────────────────────────────────
function lonToTileX(lon, z) { return Math.floor((lon + 180) / 360 * Math.pow(2, z)); }
function latToTileY(lat, z) {
  return Math.floor((1 - Math.log(Math.tan(lat * Math.PI / 180) + 1 / Math.cos(lat * Math.PI / 180)) / Math.PI) / 2 * Math.pow(2, z));
}

async function downloadOfflineTiles() {
  if (!can('offline_cache', _userPlan)) {
    showToast('🔒 Cartes hors-ligne disponibles avec Argent — voir plans.html');
    return;
  }
  const maxAreas = limitOf('offline_cache', _userPlan);
  const savedCount = parseInt(localStorage.getItem('bwr_offline_areas') || '0');
  if (savedCount >= maxAreas) {
    showToast(`Zone hors-ligne : limite de ${maxAreas} zone${maxAreas > 1 ? 's' : ''} atteinte`);
    return;
  }

  const bounds = map.getBounds();
  const tiles = [];
  for (let z = 13; z <= 16; z++) {
    const x0 = lonToTileX(bounds.getWest(), z),  x1 = lonToTileX(bounds.getEast(), z);
    const y0 = latToTileY(bounds.getNorth(), z),  y1 = latToTileY(bounds.getSouth(), z);
    const subs = ['a', 'b', 'c'];
    for (let x = x0; x <= x1; x++)
      for (let y = y0; y <= y1; y++)
        tiles.push(`https://${subs[(x + y) % 3]}.tile.opentopomap.org/${z}/${x}/${y}.png`);
  }

  if (tiles.length > 3000) { showToast('Zone trop grande — dézoomez un peu'); return; }

  const btn = document.getElementById('btnOffline');
  if (btn) { btn.querySelector('.btn-emoji').textContent = '⏳'; btn.disabled = true; }
  showToast(`📥 ${tiles.length} tuiles en cours de téléchargement…`);

  try {
    const cache = await caches.open('bwr-offline-tiles');
    let done = 0;
    for (const url of tiles) {
      try { await cache.put(url, await fetch(url, { mode: 'no-cors' })); } catch {}
      done++;
    }
    localStorage.setItem('bwr_offline_areas', String(savedCount + 1));
    showToast(`✅ Zone sauvegardée hors-ligne ! (${done} tuiles · ${savedCount + 1}/${maxAreas})`);
  } catch { showToast('Erreur lors du téléchargement hors-ligne'); }
  finally {
    if (btn) { btn.querySelector('.btn-emoji').textContent = '💾'; btn.disabled = false; }
  }
}

// Show offline button for Silver+ users
(function initOfflineBtn() {
  const btn = document.getElementById('btnOffline');
  if (!btn) return;
  if (can('offline_cache', _userPlan)) {
    btn.style.display = '';
    btn.addEventListener('click', downloadOfflineTiles);
  }
})();

initUserMenu();
loadPaths();
loadReports();
