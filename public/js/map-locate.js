// map-locate.js — "locate me" / live tracking, the address search bar and the
// carrefour name labels for the map page.
// Split out of map.js. Classic script loaded AFTER js/map.js and js/map-paths.js
// (it uses the shared `map`, `allPaths`, `activeFilters`, `trackWalkedPaths`,
// `openPathPopup`, `_mapHaversineM`, `renderPaths`). Top-level code only attaches
// handlers / builds the carrefour layer against already-created globals.

// ── Locate me ─────────────────────────────────────────────────────────────────
let locationMarker = null;
let locationCircle = null;
let locationWatchId = null;
let _currentPosition = null;
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
  _currentPosition = null;
  locateState = 'idle';
  _updateLocateBtn();
}

function _findNearestPath(lat, lng) {
  let best = null, bestDist = Infinity, bestLatLng = null;
  for (const path of allPaths) {
    if (!activeFilters.has(path.status)) continue;
    if (!path.coordinates || path.coordinates.length < 2) continue;
    for (let i = 0; i < path.coordinates.length - 1; i++) {
      const [lat1, lng1] = path.coordinates[i];
      const [lat2, lng2] = path.coordinates[i + 1];
      const dx = lat2 - lat1, dy = lng2 - lng1;
      const len2 = dx * dx + dy * dy;
      const t = len2 ? Math.max(0, Math.min(1, ((lat - lat1) * dx + (lng - lng1) * dy) / len2)) : 0;
      const nearLat = lat1 + t * dx, nearLng = lng1 + t * dy;
      const d = _mapHaversineM(lat, lng, nearLat, nearLng);
      if (d < bestDist) { bestDist = d; best = path; bestLatLng = [nearLat, nearLng]; }
    }
  }
  return bestDist <= 60 ? { path: best, dist: Math.round(bestDist), latlng: bestLatLng } : null;
}

// "Mon point" — one tap selects the path you're standing on AND lets you report
// the exact spot you're at. Works for every plan. If geolocation isn't active yet,
// it kicks it off and runs as soon as the first fix lands.
let _pendingSelectHere = false;

async function selectHere() {
  if (!_currentPosition) return;
  const here = L.latLng(_currentPosition.lat, _currentPosition.lng);
  const result = _findNearestPath(_currentPosition.lat, _currentPosition.lng);
  if (result) {
    // On (or within 60 m of) a known path → open it; its report buttons file at this spot.
    openPathPopup(result.path, L.latLng(result.latlng[0], result.latlng[1]));
  } else {
    // Off any known path → let the user report the precise place they're standing on.
    await _loadMapEdit();
    openReportPopup(null, here);
  }
}

document.getElementById('btnSelectPath').addEventListener('click', () => {
  if (_currentPosition) { selectHere(); return; }
  if (!navigator.geolocation) {
    showLocateToast('Géolocalisation non disponible', true);
    return;
  }
  _pendingSelectHere = true;
  showLocateToast('Localisation en cours…');
  startLocationWatch();
});

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
      html: '<div class="location-dot-inner"></div>',
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
  startLocationWatch();
});

// Begin the GPS watch (shared by the locate button and the "Mon point" button).
function startLocationWatch() {
  if (locationWatchId !== null) return; // already watching
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

      _currentPosition = { lat, lng };
      updateLocationLayers(lat, lng, accuracy);
      trackWalkedPaths(lat, lng);

      // Re-center map on every fix while following (Google Maps-style continuous tracking)
      if (locateState === 'following') {
        const targetZoom = wasSearching ? Math.max(map.getZoom(), 15) : map.getZoom();
        map.setView([lat, lng], targetZoom, { animate: true, duration: wasSearching ? 0.8 : 0.4 });
      }

      // Fulfil a queued "Mon point" tap as soon as we have a fix.
      if (_pendingSelectHere) { _pendingSelectHere = false; selectHere(); }
    },
    (err) => {
      _pendingSelectHere = false;
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
}

// ── Search bar ────────────────────────────────────────────────────────────────
let searchPin = null;
let searchTimer = null;

document.getElementById('mapSearchInput').addEventListener('input', e => {
  const q = e.target.value.trim();
  document.getElementById('mapSearchClear').classList.toggle('hidden', !q);
  clearTimeout(searchTimer);
  // Persist whatever is typed so the address stays "locked in" across pages,
  // even before the user picks a suggestion. Shared with the routes page.
  if (q) saveSearchAddress({ label: e.target.value });
  else localStorage.removeItem('bwr_saved_address');
  if (q.length < 3) { closeSearchResults(); return; }
  searchTimer = setTimeout(() => doMapSearch(q), 380);
});

document.getElementById('mapSearchClear').addEventListener('click', () => {
  document.getElementById('mapSearchInput').value = '';
  document.getElementById('mapSearchClear').classList.add('hidden');
  closeSearchResults();
  localStorage.removeItem('bwr_saved_address');
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
      const label = item.querySelector('.search-item-name').textContent;
      document.getElementById('mapSearchInput').value = label;
      document.getElementById('mapSearchClear').classList.remove('hidden');
      closeSearchResults();
      if (searchPin) map.removeLayer(searchPin);
      searchPin = L.marker([lat, lng]).addTo(map);
      map.setView([lat, lng], 15);
      // Lock in the chosen address (with coords) so it survives page changes.
      saveSearchAddress({ label, lat, lng });
    });
  });
}

function closeSearchResults() {
  document.getElementById('mapSearchResults').classList.add('hidden');
}

function saveSearchAddress(obj) {
  try { localStorage.setItem('bwr_saved_address', JSON.stringify(obj)); } catch {}
}

// Restore the address the user last entered (on map or routes page) so it stays
// "locked in" when navigating between pages.
function restoreSearchAddress() {
  try {
    const saved = JSON.parse(localStorage.getItem('bwr_saved_address'));
    if (!saved || !saved.label) return;
    const input = document.getElementById('mapSearchInput');
    if (!input) return;
    input.value = saved.label;
    document.getElementById('mapSearchClear').classList.remove('hidden');
    if (typeof saved.lat === 'number' && typeof saved.lng === 'number') {
      if (searchPin) map.removeLayer(searchPin);
      searchPin = L.marker([saved.lat, saved.lng]).addTo(map);
      map.setView([saved.lat, saved.lng], 15);
    }
  } catch {}
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

map.on('zoomend', () => { renderPaths(); updateCarrefourVisibility(); });
updateCarrefourVisibility();
