let currentUser = null;
let map = null;
let mode = null;
let pathType = 'foot';
let difficulty = 'easy';
let routingPriority = 'forest';
let surfaceFilter = 'any';
let startMarker = null;
let endMarker = null;
let routeLayer = null;
let savedPathsLayer = null;
let savedPaths = [];       // raw paths array — used by the graph router
let pickingPoint = null;
let lastRoute = null;      // most recent computed route — used by save/share


// ── Auth ──────────────────────────────────────────────────────────────────────
(async () => {
  currentUser = await requireAuth();
  if (!currentUser) return;
  initUserMenu();
  initMap();
  loadSavedPaths();
  applyPlanGates();
  updateQuotaStrip();
  initSaveShareButtons();
  initRouteHistory();
  await handleSharedRouteParam();
  applyAISuggestionParams();
})();

// ── Plan-based UI gating ──────────────────────────────────────────────────────
// Locks mode cards, difficulty buttons, premium tile layers and exports for
// users whose plan does not include the feature. See js/features.js.
function applyPlanGates() {
  const plan = currentUser?.plan || 'free';

  // Lock multi-stop (visual hint only — there is no button yet)

  // Lock Hard difficulty
  if (!BWR.can('difficulty_hard', plan)) {
    const hardBtn = document.querySelector('.diff-btn[data-diff="hard"]');
    if (hardBtn) markBtnLocked(hardBtn, 'silver');
  }

  // Lock satellite tile button
  if (!BWR.can('satellite_tiles', plan)) {
    const satBtn = document.querySelector('.layer-btn[data-layer="satellite"]');
    if (satBtn) markBtnLocked(satBtn, 'gold');
  }
  // Lock IGN topo for free users (default tile becomes OSM)
  if (!BWR.can('ign_topo_tiles', plan)) {
    const ignBtn = document.querySelector('.layer-btn[data-layer="ign"]');
    if (ignBtn) markBtnLocked(ignBtn, 'silver');
  }
}

function markCardLocked(el, tier, featureLabel) {
  el.classList.add('locked-feature');
  el.setAttribute('data-tier', tier);
  // Don't disable the click — intercept it to show an upsell.
  el.addEventListener('click', interceptLocked, true);
  if (!el.querySelector('.lock-badge')) {
    const badge = document.createElement('span');
    badge.className = `lock-badge tier-${tier}`;
    badge.textContent = tier === 'gold' ? '👑 Or' : '🔒 Argent';
    el.appendChild(badge);
  }
  el.dataset.featureLabel = featureLabel;
}
function markBtnLocked(el, tier) {
  el.classList.add('locked-feature');
  el.setAttribute('data-tier', tier);
  el.addEventListener('click', interceptLocked, true);
  if (!el.querySelector('.lock-badge')) {
    const badge = document.createElement('span');
    badge.className = `lock-badge tier-${tier}`;
    badge.textContent = tier === 'gold' ? '👑' : '🔒';
    el.appendChild(badge);
  }
}
function interceptLocked(e) {
  if (!e.currentTarget.classList.contains('locked-feature')) return;
  e.preventDefault();
  e.stopPropagation();
  const tier  = e.currentTarget.getAttribute('data-tier') || 'silver';
  const label = e.currentTarget.dataset.featureLabel || 'Cette fonctionnalité';
  showUpgradeModal(tier, label);
}

function showUpgradeModal(tier, featureLabel) {
  const planLabel = tier === 'gold' ? 'Or' : 'Argent';
  const icon      = tier === 'gold' ? '🥇' : '🥈';
  const existing = document.getElementById('upgradeModal');
  if (existing) existing.remove();
  const m = document.createElement('div');
  m.id = 'upgradeModal';
  m.className = 'upgrade-modal-overlay';
  m.innerHTML = `
    <div class="upgrade-modal-card">
      <button class="um-close" aria-label="Fermer">×</button>
      <div class="um-icon">${icon}</div>
      <h3>${featureLabel} est réservé au plan ${planLabel}</h3>
      <p>Débloquez les trajets illimités, l'export GPX, le profil altimétrique et bien plus.</p>
      <a href="plans.html" class="um-cta">Voir le plan ${planLabel} →</a>
      <button class="um-secondary">Plus tard</button>
    </div>
  `;
  document.body.appendChild(m);
  m.querySelector('.um-close').onclick   = () => m.remove();
  m.querySelector('.um-secondary').onclick = () => m.remove();
  m.addEventListener('click', e => { if (e.target === m) m.remove(); });
}

// ── Weekly route quota strip ──────────────────────────────────────────────────
function updateQuotaStrip() {
  const plan  = currentUser?.plan || 'free';
  const limit = BWR.limitOf('routes_per_week', plan);
  const stripEl = document.getElementById('quotaStrip');
  if (!stripEl) return;
  if (limit === Infinity) {
    stripEl.classList.add('hidden');
    return;
  }
  const stats = currentUser?.stats || {};
  const count = stats.weekStart === isoMonday() ? (stats.weeklyRoutes || 0) : 0;
  const remaining = Math.max(0, limit - count);
  const pct = Math.min(100, (count / limit) * 100);

  // Urgency: warn at 1 remaining, danger at 0
  const urgency = remaining === 0 ? 'qs-danger' : remaining === 1 ? 'qs-warn' : '';
  stripEl.className = `quota-strip${urgency ? ' ' + urgency : ''}`;

  const remainingLabel = remaining === 0
    ? 'Limite atteinte'
    : `${remaining} restant${remaining > 1 ? 's' : ''}`;

  stripEl.innerHTML = `
    <div class="qs-header">
      <span class="qs-label">Trajets cette semaine</span>
      <span class="qs-remaining">${remainingLabel}</span>
    </div>
    <div class="qs-bar"><div class="qs-fill" style="width:${pct}%"></div></div>
    <div style="display:flex;align-items:center;justify-content:space-between;gap:8px">
      <span class="qs-count">${count} / ${limit}</span>
      <a href="plans.html" class="qs-cta">Illimité avec Argent →</a>
    </div>
  `;
}

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
      ${currentUser.role === 'admin' ? '<a href="admin.html">⚙️ Admin</a>' : ''}
      <button class="dropdown-logout" id="btnLogout">Se déconnecter</button>
    </div>
  `;
  document.getElementById('userBtn').addEventListener('click', () =>
    document.getElementById('userDropdown').classList.toggle('hidden'));
  document.getElementById('btnLogout').addEventListener('click', () => logout());
  document.addEventListener('click', e => {
    if (!menuEl.contains(e.target)) document.getElementById('userDropdown')?.classList.add('hidden');
  });
}

// ── Map ───────────────────────────────────────────────────────────────────────
const LAYER_MAX_ZOOM = { ign: 17, osm: 19, satellite: 20 };
const TILE_LAYERS = {
  ign: () => L.tileLayer(
    'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
    { attribution: 'Map data: &copy; OpenStreetMap contributors, SRTM | Style: &copy; OpenTopoMap', maxNativeZoom: 17, maxZoom: 17, subdomains: ['a','b','c'] }
  ),
  osm: () => L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    { attribution: '© OpenStreetMap', maxNativeZoom: 19, maxZoom: 19, detectRetina: true }
  ),
  satellite: () => L.tileLayer(
    'https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=ORTHOIMAGERY.ORTHOPHOTOS&STYLE=normal&FORMAT=image/jpeg&TILEMATRIXSET=PM&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}',
    { attribution: '© IGN', maxNativeZoom: 20, maxZoom: 20, detectRetina: true }
  ),
};
let currentTile = null;

function initMap() {
  const plan = currentUser?.plan || 'free';
  const defaultLayer = BWR.can('ign_topo_tiles', plan) ? 'ign' : 'osm';
  map = L.map('map', { zoomControl: true, maxZoom: LAYER_MAX_ZOOM[defaultLayer] }).setView(MAP_CENTER, MAP_ZOOM);
  currentTile = TILE_LAYERS[defaultLayer]();
  currentTile.addTo(map);
  // Reflect that on the layer-button row if it exists
  setTimeout(() => {
    document.querySelectorAll('.layer-btn').forEach(b => b.classList.toggle('active', b.dataset.layer === defaultLayer));
  }, 0);
  map.on('click', onMapClick);
  setTimeout(() => map.invalidateSize(), 100);
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', () => map.invalidateSize());
  }

  // Layer switcher
  document.querySelectorAll('.layer-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      map.removeLayer(currentTile);
      const layerKey = btn.dataset.layer;
      map.setMaxZoom(LAYER_MAX_ZOOM[layerKey]);
      currentTile = TILE_LAYERS[layerKey]();
      currentTile.addTo(map);
      document.querySelectorAll('.layer-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
  });
}

// ── Geolocation ───────────────────────────────────────────────────────────────
document.getElementById('btnLocate').addEventListener('click', () => {
  if (!navigator.geolocation) return;
  const btn = document.getElementById('btnLocate');
  btn.textContent = '⏳';
  navigator.geolocation.getCurrentPosition(
    pos => {
      btn.textContent = '📍';
      const { latitude: lat, longitude: lng } = pos.coords;
      map.setView([lat, lng], 15);
      if (mode) onMapClick({ latlng: { lat, lng } });
    },
    () => { btn.textContent = '📍'; }
  );
});

// ── Address search ────────────────────────────────────────────────────────────
let searchTimeout = null;
document.getElementById('addressInput').addEventListener('input', e => {
  clearTimeout(searchTimeout);
  const q = e.target.value.trim();
  if (q.length < 3) { hideSearch(); return; }
  searchTimeout = setTimeout(() => doSearch(q), 400);
});

document.getElementById('addressInput').addEventListener('blur', () => {
  setTimeout(hideSearch, 200);
});

async function doSearch(q) {
  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=5&countrycodes=fr`,
      { headers: { 'Accept-Language': 'fr' } }
    );
    const data = await res.json();
    showSearchResults(data);
  } catch {}
}

function showSearchResults(results) {
  const el = document.getElementById('searchResults');
  if (!results.length) { hideSearch(); return; }
  el.innerHTML = results.map(r => `
    <div class="search-item" data-lat="${r.lat}" data-lon="${r.lon}">
      ${r.display_name.split(',').slice(0, 3).join(', ')}
    </div>
  `).join('');
  el.classList.remove('hidden');
  el.querySelectorAll('.search-item').forEach(item => {
    item.addEventListener('mousedown', () => {
      const lat = parseFloat(item.dataset.lat);
      const lng = parseFloat(item.dataset.lon);
      map.setView([lat, lng], 15);
      document.getElementById('addressInput').value = item.textContent.trim();
      hideSearch();
      if (mode) onMapClick({ latlng: { lat, lng } });
    });
  });
}

function hideSearch() {
  document.getElementById('searchResults').classList.add('hidden');
}

async function loadSavedPaths() {
  try {
    const res = await fetch(`${API_URL}/api/paths`);
    savedPaths = await res.json();
    savedPathsLayer = L.layerGroup();
    savedPaths.forEach(p => {
      L.polyline(p.coordinates, {
        color: STATUS_COLORS[p.status] || '#9ca3af',
        weight: 4, opacity: 0.55,
      }).bindTooltip(p.name || '').addTo(savedPathsLayer);
    });
    savedPathsLayer.addTo(map);
  } catch {}
}

// ── Step 1: Mode ──────────────────────────────────────────────────────────────
document.querySelectorAll('.mode-card').forEach(card => {
  card.addEventListener('click', () => {
    document.querySelectorAll('.mode-card').forEach(c => c.classList.remove('active'));
    card.classList.add('active');
    mode = card.dataset.mode;

    document.getElementById('distanceGroup').style.display = mode === 'loop' ? '' : 'none';

    document.getElementById('step3Title').textContent =
      mode === 'loop' ? 'Point de départ' : 'Points de départ et arrivée';
    document.getElementById('step3Hint').textContent =
      mode === 'loop'
        ? 'Clique sur la carte pour placer le point de départ de ta boucle.'
        : 'Clique d\'abord pour le départ (A), puis pour l\'arrivée (B).';

    unlock('step2');
    unlock('step3');
    resetPoints();
    pickingPoint = 'start';
    map.getContainer().style.cursor = 'crosshair';
  });
});

// ── Step 2: Options ───────────────────────────────────────────────────────────
document.querySelectorAll('.pathtype-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.pathtype-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    pathType = btn.dataset.type;
  });
});

document.querySelectorAll('.diff-btn[data-diff]').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.diff-btn[data-diff]').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    difficulty = btn.dataset.diff;
  });
});

document.querySelectorAll('.diff-btn[data-priority]').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.diff-btn[data-priority]').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    routingPriority = btn.dataset.priority;
  });
});

document.querySelectorAll('.diff-btn[data-surface]').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.diff-btn[data-surface]').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    surfaceFilter = btn.dataset.surface;
  });
});

// ── Step 3: Map clicks ────────────────────────────────────────────────────────
function onMapClick(e) {
  if (!mode || !pickingPoint) return;
  const { lat, lng } = e.latlng;

  if (pickingPoint === 'start') {
    if (startMarker) map.removeLayer(startMarker);
    startMarker = L.marker([lat, lng], { icon: pinIcon('A', '#1e4d14') }).addTo(map);
    if (mode === 'loop') {
      pickingPoint = null;
      map.getContainer().style.cursor = '';
      unlock('step4');
      enableGenerate();
    } else {
      pickingPoint = 'end';
    }
    updatePointStatus();
  } else if (pickingPoint === 'end') {
    if (endMarker) map.removeLayer(endMarker);
    endMarker = L.marker([lat, lng], { icon: pinIcon('B', '#dc2626') }).addTo(map);
    pickingPoint = null;
    map.getContainer().style.cursor = '';
    updatePointStatus();
    unlock('step4');
    enableGenerate();
  }
}

function pinIcon(label, color) {
  return L.divIcon({
    html: `<div style="background:${color};color:white;width:32px;height:32px;border-radius:50% 50% 50% 0;transform:rotate(-45deg);display:flex;align-items:center;justify-content:center;border:3px solid white;box-shadow:0 2px 8px rgba(0,0,0,0.35)"><span style="transform:rotate(45deg);font-weight:800;font-size:0.85rem">${label}</span></div>`,
    iconSize: [32, 32], iconAnchor: [16, 32], className: '',
  });
}

function updatePointStatus() {
  const el = document.getElementById('pointStatus');
  if (mode === 'loop') {
    el.innerHTML = startMarker
      ? `<div class="point-tag set">✓ Départ placé</div>`
      : `<div class="point-tag waiting">○ En attente...</div>`;
  } else {
    el.innerHTML = `
      <div class="point-tag ${startMarker ? 'set' : 'waiting'}">${startMarker ? '✓' : '○'} Point A — Départ</div>
      <div class="point-tag ${endMarker ? 'set' : 'waiting'}">${endMarker ? '✓' : '○'} Point B — Arrivée</div>
    `;
  }
}

function resetPoints() {
  if (startMarker) { map.removeLayer(startMarker); startMarker = null; }
  if (endMarker)   { map.removeLayer(endMarker);   endMarker = null; }
  if (routeLayer)  { map.removeLayer(routeLayer);  routeLayer = null; }
  document.getElementById('pointStatus').innerHTML = '';
  document.getElementById('routeResult').classList.add('hidden');
  document.getElementById('btnGenerate').disabled = true;
}

function enableGenerate() {
  document.getElementById('btnGenerate').disabled = false;
}

// ── Step 4: Generate ──────────────────────────────────────────────────────────
document.getElementById('btnGenerate').addEventListener('click', generateRoute);

async function generateRoute() {
  const btn = document.getElementById('btnGenerate');

  // ── Weekly quota check — enforced server-side ──
  const plan = currentUser?.plan || 'free';
  if (BWR.limitOf('routes_per_week', plan) !== Infinity) {
    btn.textContent = 'Vérification…';
    btn.classList.add('loading');
    btn.disabled = true;
    try {
      const qRes = await fetchWithTimeout(`${API_URL}/api/auth/consume-route`, {
        method: 'POST',
        headers: { ...authHeader() },
      }, 8000);
      const qData = await qRes.json();
      if (!qRes.ok || !qData.ok) {
        showQuotaExceededModal({ used: qData.used ?? 3, limit: qData.limit ?? 3 });
        btn.textContent = 'Calculer le trajet';
        btn.classList.remove('loading');
        btn.disabled = false;
        return;
      }
      // Reflect the server's authoritative count locally so the strip is accurate
      if (currentUser.stats) {
        currentUser.stats.weeklyRoutes = qData.used;
        currentUser.stats.weekStart = isoMonday();
      }
      updateQuotaStrip();
    } catch {
      // Network error — fail open to avoid blocking users on transient issues
    }
  }

  btn.textContent = 'Calcul en cours…';
  btn.classList.add('loading');
  btn.disabled = true;

  const sLat = startMarker.getLatLng().lat;
  const sLng = startMarker.getLatLng().lng;
  let result = null;
  let distanceKm = 10;

  try {
    if (mode === 'loop') {
      distanceKm = parseFloat(document.getElementById('distanceInput').value) || 10;
      result = await routeLoop(sLat, sLng, distanceKm);
    } else {
      const eLat = endMarker.getLatLng().lat;
      const eLng = endMarker.getLatLng().lng;
      result = await routeAtob(sLat, sLng, eLat, eLng);
    }
  } catch (err) {
    console.error('Routing error:', err);
    const msg = err.name === 'AbortError' ? 'Serveur trop lent, réessaie' : err.message;
    btn.textContent = 'Erreur: ' + msg;
    btn.classList.remove('loading');
    setTimeout(() => { btn.textContent = 'Calculer le trajet'; btn.disabled = false; }, 5000);
    return;
  }

  // Track usage stats locally (cache) and persist to server
  const prevCount = parseInt(localStorage.getItem('bwr_route_count') || '0');
  const prevKm    = parseFloat(localStorage.getItem('bwr_km_total')   || '0');
  const deltaKm   = result.meters / 1000;
  localStorage.setItem('bwr_route_count', prevCount + 1);
  localStorage.setItem('bwr_km_total', (prevKm + deltaKm).toFixed(2));
  if (getToken()) {
    fetch(`${API_URL}/api/auth/stats`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeader() },
      body: JSON.stringify({ routes: 1, km: deltaKm }),
    }).catch(() => {});
  }

  updateQuotaStrip();

  try {
    displayRoute(result, mode === 'loop' ? distanceKm : null);
  } catch (err) {
    console.error('displayRoute error:', err);
  }

  btn.textContent = 'Calculer le trajet';
  btn.classList.remove('loading');
  btn.disabled = false;
}

// ── Graph router (uses only your admin-tagged paths) ─────────────────────────
// Pure functions live in js/graph-router.js (loaded before this script).
// This guarantees forest-only routing and true loops with no backtracking.

function filterPaths(paths) {
  if (pathType === 'foot')  return paths.filter(p => !p.pathType || p.pathType === 'foot');
  if (pathType === 'bike')  return paths.filter(p => p.pathType === 'bike');
  return paths; // champs / mix: all paths
}

// ── Fetch with timeout ────────────────────────────────────────────────────────
function fetchWithTimeout(url, opts = {}, ms = 10000) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { ...opts, signal: ctrl.signal }).finally(() => clearTimeout(id));
}

// ── ORS fallback (via worker, needs ORS_KEY set in Cloudflare) ─────────────────
function orsProfile() {
  const map = { bike: 'cycling-mountain', champs: 'foot-walking', mix: 'foot-walking' };
  return map[pathType] || 'foot-hiking';
}
async function callORS(body) {
  const res = await fetchWithTimeout(`${API_URL}/api/route`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeader() },
    body: JSON.stringify(body),
  }, 12000);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `ORS ${res.status}`);
  const feat = data.features?.[0];
  if (!feat) throw new Error('ORS: aucun itinéraire');
  return {
    coords: feat.geometry.coordinates.map(([lon, lat]) => [lat, lon]),
    meters: feat.properties.summary.distance,
    seconds: feat.properties.summary.duration,
  };
}

// ── OSRM fallback (no key needed, always works) ────────────────────────────────
function osrmProfile() { return pathType === 'bike' ? 'cycling' : 'foot'; }

async function osrmRoute(wpList) {
  const p = osrmProfile();
  const c = wpList.map(w => `${w.lon},${w.lat}`).join(';');
  const res = await fetchWithTimeout(`https://router.project-osrm.org/route/v1/${p}/${c}?overview=full&geometries=geojson`);
  const data = await res.json();
  if (data.code !== 'Ok' || !data.routes?.[0]) throw new Error('OSRM: no route');
  const r = data.routes[0];
  return { coords: r.geometry.coordinates.map(([lon, lat]) => [lat, lon]), meters: r.distance, seconds: r.duration };
}

async function osrmTrip(wpList) {
  const p = osrmProfile();
  const c = wpList.map(w => `${w.lon},${w.lat}`).join(';');
  const res = await fetchWithTimeout(`https://router.project-osrm.org/trip/v1/${p}/${c}?roundtrip=true&source=first&destination=any&overview=full&geometries=geojson`);
  const data = await res.json();
  if (data.code !== 'Ok' || !data.trips?.[0]) throw new Error('OSRM trip: no route');
  const t = data.trips[0];
  return { coords: t.geometry.coordinates.map(([lon, lat]) => [lat, lon]), meters: t.distance, seconds: t.duration };
}

function osrmLoopWaypoints(sLat, sLng, radiusKm) {
  const rLat = radiusKm / 111;
  const rLng = radiusKm / (111 * Math.cos(sLat * Math.PI / 180));
  const ring = [0, 45, 90, 135, 180, 225, 270, 315].map(deg => {
    const rad = deg * Math.PI / 180;
    return { lat: +(sLat + rLat * Math.cos(rad)).toFixed(6), lon: +(sLng + rLng * Math.sin(rad)).toFixed(6) };
  });
  return [{ lat: sLat, lon: sLng }, ...ring];
}

async function osrmLoopWithRetry(sLat, sLng, targetKm) {
  let r = targetKm / (2 * Math.PI), result;
  for (let i = 0; i < 3; i++) {
    result = await osrmTrip(osrmLoopWaypoints(sLat, sLng, r));
    const ratio = (targetKm * 1000) / result.meters;
    if (Math.abs(ratio - 1) < 0.2) break;
    r = Math.min(r * ratio, 25);
  }
  return result;
}

// ── OSM path helpers for hybrid A→B routing ───────────────────────────────────
function osmDataToCoordPaths(data) {
  const nodeMap = {};
  data.elements.forEach(el => { if (el.type === 'node') nodeMap[el.id] = [el.lat, el.lon]; });
  const result = [];
  data.elements.forEach(el => {
    if (el.type !== 'way') return;
    const coordinates = el.nodes.map(id => nodeMap[id]).filter(Boolean);
    if (coordinates.length >= 2) result.push({
      coordinates,
      _highway: el.tags?.highway,
      _surface: el.tags?.surface,
    });
  });
  return result;
}

function applyOsmSurfaceWeights(paths) {
  if (surfaceFilter === 'any') return paths;
  return paths.map(p => {
    const highway = p._highway || '';
    const surface = p._surface || '';
    const isPaved = /^(asphalt|paved|concrete|sett|cobblestone|paving_stones)$/.test(surface);
    let w = 1;
    if (surfaceFilter === 'natural') {
      // Prefer unpaved; penalize paved surfaces and types usually paved
      if (isPaved) w = 6;
      else if (highway === 'footway' || highway === 'cycleway') w = 2;
    } else if (surfaceFilter === 'paved') {
      // Prefer asphalt/concrete; penalize dirt tracks and narrow paths
      if (isPaved) w = 1;
      else if (highway === 'footway' || highway === 'cycleway') w = 1.5;
      else if (highway === 'track') w = 5;
      else if (highway === 'path' || highway === 'bridleway') w = 4;
    }
    if (w === 1) return p;
    return { ...p, _weight: (p._weight || 1) * w };
  });
}

async function fetchOsmPathsForBbox(minLat, minLng, maxLat, maxLng) {
  try {
    const bbox = `${minLat.toFixed(4)},${minLng.toFixed(4)},${maxLat.toFixed(4)},${maxLng.toFixed(4)}`;
    const res = await fetchWithTimeout(`${API_URL}/api/osm?bbox=${bbox}`, {}, 20000);
    if (!res.ok) { console.warn('OSM bbox fetch failed:', res.status); return []; }
    const data = await res.json();
    if (!Array.isArray(data?.elements)) { console.warn('OSM response malformed'); return []; }
    return osmDataToCoordPaths(data);
  } catch (e) { console.warn('fetchOsmPathsForBbox:', e.message); return []; }
}

// ── Public routing entry points ───────────────────────────────────────────────
async function routeAtob(sLat, sLng, eLat, eLng) {
  // Shortest mode: Dijkstra on raw OSM forest paths (no admin bias, no weight penalty).
  // Fetches path/track/footway/bridleway/cycleway in a wide bbox and finds the
  // genuinely shortest forest route. Falls back to ORS then OSRM only if graph fails.
  if (routingPriority === 'shortest') {
    try {
      const pad = 0.05;
      const osmPaths = await fetchOsmPathsForBbox(
        Math.min(sLat, eLat) - pad, Math.min(sLng, eLng) - pad,
        Math.max(sLat, eLat) + pad, Math.max(sLng, eLng) + pad,
      );
      if (osmPaths.length) {
        const r = graphAtob(sLat, sLng, eLat, eLng, applyOsmSurfaceWeights(osmPaths));
        console.info(`routing: OSM graph (${osmPaths.length} chemins, ${(r.meters/1000).toFixed(1)} km)`);
        return r;
      }
    } catch (e) { console.warn('OSM graph shortest:', e.message); }
    try {
      const r = await callORS({ profile: orsProfile(), coordinates: [[sLng, sLat], [eLng, eLat]] });
      console.info(`routing: ORS (${(r.meters/1000).toFixed(1)} km)`);
      return r;
    } catch (e) { console.warn('ORS shortest:', e.message); }
    console.info('routing: OSRM fallback');
    return osrmRoute([{ lat: sLat, lon: sLng }, { lat: eLat, lon: eLng }]);
  }

  // 1. Hybrid graph: admin paths preferred, OSM fills gaps (skipped in 'shortest' mode)
  if (savedPaths.length) {
    try {
      const filtered = filterPaths(savedPaths);
      // Skip graph if either endpoint is more than 1.5 km from the nearest admin path.
      // When admin paths only cover a distant area, nearestNode snaps to a faraway node
      // and Dijkstra routes through there instead of the direct path.
      if (filtered.length) {
        const { nodes: adminNodes } = buildGraph(filtered);
        const sSnap = nearestNode(adminNodes, sLat, sLng);
        const eSnap = nearestNode(adminNodes, eLat, eLng);
        const MAX_SNAP_M = 1500;
        if (!sSnap || !eSnap
          || haversineM(sLat, sLng, sSnap.lat, sSnap.lon) > MAX_SNAP_M
          || haversineM(eLat, eLng, eSnap.lat, eSnap.lon) > MAX_SNAP_M) {
          console.warn('graph hybrid: endpoints trop loin des chemins admin, fallback OSRM');
          throw new Error('snap trop loin');
        }
      }
      const pad = 0.02;
      const osmPaths = await fetchOsmPathsForBbox(
        Math.min(sLat, eLat) - pad, Math.min(sLng, eLng) - pad,
        Math.max(sLat, eLat) + pad, Math.max(sLng, eLng) + pad,
      );
      const weightedOsmPaths = applyOsmSurfaceWeights(osmPaths);
      const result = graphAtobHybrid(sLat, sLng, eLat, eLng, filtered, weightedOsmPaths);
      const straightM = haversineM(sLat, sLng, eLat, eLng);
      if (result.meters > straightM * 3) { throw new Error('graph hybrid: trop long'); }
      // If admin route is > 1.5× straight line, try OSM-only graph to see if there's a shorter path.
      if (result.meters > straightM * 1.5 && weightedOsmPaths.length) {
        try {
          const osmOnly = graphAtob(sLat, sLng, eLat, eLng, weightedOsmPaths);
          if (osmOnly.meters < result.meters) { console.info('routing: OSM shorter than admin, using OSM'); return osmOnly; }
        } catch {}
      }
      console.info('routing: admin graph');
      return result;
    } catch (e) { console.warn('graph hybrid:', e.message); }
  }
  // 2. OSM-only graph — forest/path network from OSM, no road penalty, no admin bias.
  // Used when admin paths don't cover the clicked area. Wider bbox captures paths near endpoints.
  try {
    const pad = 0.05;
    const osmPaths = await fetchOsmPathsForBbox(
      Math.min(sLat, eLat) - pad, Math.min(sLng, eLng) - pad,
      Math.max(sLat, eLat) + pad, Math.max(sLng, eLng) + pad,
    );
    if (osmPaths.length) {
      const result = graphAtob(sLat, sLng, eLat, eLng, applyOsmSurfaceWeights(osmPaths));
      const straightM = haversineM(sLat, sLng, eLat, eLng);
      if (result.meters <= straightM * 4) return result;
      console.warn('OSM graph: route trop longue, fallback OSRM');
    }
  } catch (e) { console.warn('OSM graph:', e.message); }
  // 3. ORS (needs ORS_KEY in Cloudflare)
  try {
    return await callORS({ profile: orsProfile(), coordinates: [[sLng, sLat], [eLng, eLat]] });
  } catch (e) { console.warn('ORS:', e.message); }
  // 4. OSRM — last resort, uses all roads and paths
  return osrmRoute([{ lat: sLat, lon: sLng }, { lat: eLat, lon: eLng }]);
}

async function routeLoop(sLat, sLng, targetKm) {
  // 1. Graph router — real loop, forest only
  if (savedPaths.length) {
    try { return graphLoop(sLat, sLng, targetKm, filterPaths(savedPaths), pathType); } catch (e) { console.warn('graph:', e.message); }
  }
  // 2. ORS round_trip (needs ORS_KEY)
  try {
    return await callORS({
      profile: orsProfile(),
      coordinates: [[sLng, sLat]],
      round_trip: { length: Math.round(targetKm * 1000), points: 5, seed: 1 },
    });
  } catch (e) { console.warn('ORS:', e.message); }
  // 3. OSRM trip — always works
  return osrmLoopWithRetry(sLat, sLng, targetKm);
}

// ── Display route ─────────────────────────────────────────────────────────────
function displayRoute({ coords, meters, seconds }, requestedKm = null) {
  if (routeLayer) map.removeLayer(routeLayer);

  lastRoute = { coords, meters, seconds };
  setSaveShareEnabled(true);

  // Gold users can override route color (free/silver get default difficulty colors)
  const plan = currentUser?.plan || 'free';
  const customColor = BWR.can('custom_route_color', plan) ? localStorage.getItem('bwr_route_color') : null;
  const color = customColor || (difficulty === 'easy' ? '#22c55e' : difficulty === 'medium' ? '#f97316' : '#ef4444');
  routeLayer = L.polyline(coords, { color, weight: 6, opacity: 0.9 }).addTo(map);
  map.fitBounds(routeLayer.getBounds(), { padding: [40, 40] });

  // Exact distance display
  const m = Math.round(meters);
  if (m < 1000) {
    document.getElementById('statDistance').textContent = `${m} m`;
    document.getElementById('statDistanceSub').textContent = '';
  } else {
    const km = (m / 1000).toFixed(2);
    document.getElementById('statDistance').textContent = `${km} km`;
    document.getElementById('statDistanceSub').textContent =
      `${m.toLocaleString('fr-FR')} mètres`;
  }

  // Duration
  const h = Math.floor(seconds / 3600);
  const min = Math.round((seconds % 3600) / 60);
  document.getElementById('statDuration').textContent =
    h > 0 ? `${h}h${String(min).padStart(2, '0')}` : `${min} min`;

  // Badges
  const badgeDiff = { easy: 'Facile', medium: 'Moyen', hard: 'Difficile' }[difficulty];
  const badgeTypeMap = { foot: '🌲 Forestier', bike: '🚴 Cyclable', champs: '🌾 Champs', mix: '🗺️ Mix' };
  const badgeCssMap  = { foot: 'foot', bike: 'bike', champs: 'foot', mix: 'foot' };
  const badgeMode    = mode === 'loop' ? '🔄 Boucle' : '➡️ A → B';
  document.getElementById('resultBadges').innerHTML = `
    <span class="badge ${difficulty}">${badgeDiff}</span>
    <span class="badge ${badgeCssMap[pathType]}">${badgeTypeMap[pathType]}</span>
    <span class="badge foot">${badgeMode}</span>
  `;

  // Resume text
  const typeLabelMap = {
    foot:   'chemin forestier',
    bike:   'piste cyclable',
    champs: 'chemin de champs',
    mix:    'chemin mixte (sentiers + routes)',
  };
  const typeDescMap = {
    foot:   'L\'itinéraire emprunte des sentiers et chemins forestiers, en évitant les routes.',
    bike:   'L\'itinéraire privilégie les pistes cyclables, avec de courtes sections de route si nécessaire.',
    champs: 'L\'itinéraire emprunte des chemins de campagne et chemins agricoles.',
    mix:    'L\'itinéraire mélange sentiers, chemins et routes pour la meilleure connexion possible.',
  };
  const typeLabel = typeLabelMap[pathType];
  const diffLabel = { easy: 'facile', medium: 'moyen', hard: 'difficile' }[difficulty];
  const distLabel = meters < 1000
    ? `${Math.round(meters)} mètres`
    : `${(meters / 1000).toFixed(2)} km (${Math.round(meters).toLocaleString('fr-FR')} mètres)`;
  const resumeEl = document.getElementById('routeResume');
  resumeEl.innerHTML = `
    <p><strong>📋 Résumé</strong></p>
    <p>
      ${mode === 'loop' ? 'Boucle' : 'Trajet A → B'} de <strong>${distLabel}</strong>
      en <strong>${typeLabel}</strong>, niveau <strong>${diffLabel}</strong>.
      ${mode === 'loop'
        ? 'Le départ et l\'arrivée sont au même point.'
        : 'Le trajet relie ton point de départ à ton point d\'arrivée.'}
    </p>
    <p>Durée estimée : <strong>${document.getElementById('statDuration').textContent}</strong>. ${typeDescMap[pathType]}</p>
  `;

  // Warning if loop distance is more than 1 km off
  const warningEl = document.getElementById('distanceWarning');
  warningEl.classList.add('hidden');
  warningEl.textContent = '';
  if (requestedKm !== null) {
    const diff = meters - requestedKm * 1000;
    if (Math.abs(diff) > 1000) {
      const actual = (meters / 1000).toFixed(1);
      const asked  = requestedKm.toFixed(1);
      const diffKm = (Math.abs(diff) / 1000).toFixed(1);
      const dir    = diff > 0 ? 'plus long' : 'plus court';
      warningEl.textContent =
        `⚠️ Désolé, l'itinéraire le plus proche trouvé fait ${actual} km — soit ${diffKm} km ${dir} que les ${asked} km demandés. Aucun chemin plus adapté n'existe dans cette zone.`;
      warningEl.classList.remove('hidden');
    }
  }

  // Elevation stat placeholder while loading
  document.getElementById('statAscent').textContent = '…';
  document.getElementById('elevationWrap').classList.add('hidden');

  document.getElementById('routeResult').classList.remove('hidden');
  document.getElementById('routeResult').scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  // Export buttons — gated by plan
  const typeLabelShort = { foot: 'forestier', bike: 'cyclable', champs: 'champs', mix: 'mix' }[pathType];
  const routeName = `BWR_${mode === 'loop' ? 'boucle' : 'atob'}_${typeLabelShort}_${new Date().toISOString().slice(0,10)}`;

  const btnGPX = document.getElementById('btnGPX');
  if (btnGPX) {
    if (BWR.can('gpx_export', plan)) {
      btnGPX.classList.remove('locked-feature');
      btnGPX.querySelector('.lock-badge')?.remove();
      btnGPX.onclick = () => downloadGPX(coords, routeName);
    } else {
      btnGPX.classList.add('locked-feature');
      btnGPX.setAttribute('data-tier', 'silver');
      btnGPX.dataset.featureLabel = 'L\'export GPX';
      if (!btnGPX.querySelector('.lock-badge')) {
        const b = document.createElement('span'); b.className = 'lock-badge tier-silver'; b.textContent = '🔒 Argent';
        btnGPX.appendChild(b);
      }
      btnGPX.onclick = (e) => { e.preventDefault(); showUpgradeModal('silver', 'L\'export GPX'); };
    }
  }
  const btnKML = document.getElementById('btnKML');
  if (btnKML) {
    if (BWR.can('kml_export', plan)) {
      btnKML.classList.remove('locked-feature');
      btnKML.querySelector('.lock-badge')?.remove();
      btnKML.onclick = () => downloadKML(coords, routeName);
    } else {
      btnKML.classList.add('locked-feature');
      btnKML.setAttribute('data-tier', 'gold');
      btnKML.dataset.featureLabel = 'L\'export KML';
      if (!btnKML.querySelector('.lock-badge')) {
        const b = document.createElement('span'); b.className = 'lock-badge tier-gold'; b.textContent = '👑 Or';
        btnKML.appendChild(b);
      }
      btnKML.onclick = (e) => { e.preventDefault(); showUpgradeModal('gold', 'L\'export KML'); };
    }
  }
  const btnStrava = document.getElementById('btnStrava');
  if (btnStrava) {
    if (BWR.can('strava_komoot_push', plan)) {
      btnStrava.classList.remove('locked-feature');
      btnStrava.onclick = () => pushToStrava(coords, routeName);
    } else {
      btnStrava.classList.add('locked-feature');
      btnStrava.onclick = (e) => { e.preventDefault(); showUpgradeModal('gold', 'Le push Strava'); };
    }
  }

  // Elevation profile — only for Silver+
  if (BWR.can('elevation_profile', plan)) {
    fetchElevation(coords)
      .then(elevs => drawElevationChart(elevs, meters))
      .catch(() => { document.getElementById('statAscent').textContent = '—'; });
  } else {
    const wrap = document.getElementById('elevationWrap');
    if (wrap) {
      wrap.classList.remove('hidden');
      wrap.innerHTML = `
        <div class="elevation-locked">
          <span class="el-icon">⛰️</span>
          <strong>Profil altimétrique</strong>
          <p>Voyez le dénivelé, l'altitude min/max et la pente — disponibles à partir du plan Argent.</p>
          <a href="plans.html" class="el-cta">Débloquer avec Argent →</a>
        </div>
      `;
    }
    document.getElementById('statAscent').textContent = '🔒';
  }
}

// Modal shown when free users hit their weekly route quota
function showQuotaExceededModal(quota) {
  const existing = document.getElementById('quotaModal');
  if (existing) existing.remove();
  const m = document.createElement('div');
  m.id = 'quotaModal';
  m.className = 'upgrade-modal-overlay';
  m.innerHTML = `
    <div class="upgrade-modal-card quota-card">
      <button class="um-close" aria-label="Fermer">×</button>
      <div class="um-icon">🌿</div>
      <h3>Vous avez atteint la limite hebdomadaire</h3>
      <p><strong>${quota.used} / ${quota.limit}</strong> trajets utilisés cette semaine.</p>
      <div class="qm-comparison">
        <div class="qm-tier qm-free">
          <strong>🌿 Gratuit</strong>
          <span>3 trajets / semaine</span>
        </div>
        <div class="qm-arrow">→</div>
        <div class="qm-tier qm-silver">
          <strong>🥈 Argent</strong>
          <span>Illimité · 3,99€/mois</span>
        </div>
      </div>
      <p class="qm-perks">+ Mode boucle, profil altimétrique, export GPX, suggestions, cartes hors-ligne…</p>
      <a href="plans.html" class="um-cta">Passer à Argent</a>
      <button class="um-secondary">Revenir lundi</button>
    </div>
  `;
  document.body.appendChild(m);
  m.querySelector('.um-close').onclick   = () => m.remove();
  m.querySelector('.um-secondary').onclick = () => m.remove();
  m.addEventListener('click', e => { if (e.target === m) m.remove(); });
}

// ── Elevation profile (Open-Elevation API) ────────────────────────────────────
async function fetchElevation(coords) {
  // Sample up to 100 evenly-spaced points to stay under API limits
  const step = Math.max(1, Math.floor(coords.length / 100));
  const sampled = coords.filter((_, i) => i % step === 0);
  if (sampled[sampled.length - 1] !== coords[coords.length - 1])
    sampled.push(coords[coords.length - 1]);

  const locations = sampled.map(([lat, lon]) => ({ latitude: lat, longitude: lon }));
  const res = await fetch('https://api.open-elevation.com/api/v1/lookup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ locations }),
  });
  if (!res.ok) throw new Error('elevation API error');
  const data = await res.json();
  return data.results.map(r => r.elevation);
}

function drawElevationChart(elevations, meters) {
  const wrap = document.getElementById('elevationWrap');
  const el = document.getElementById('elevationChart');
  if (!elevations || elevations.length < 2) { wrap.classList.add('hidden'); return; }

  const minE = Math.min(...elevations);
  const maxE = Math.max(...elevations);
  const range = maxE - minE || 1;
  const W = 260, H = 70, PAD = 4;

  const pts = elevations.map((e, i) => {
    const x = PAD + (i / (elevations.length - 1)) * (W - PAD * 2);
    const y = H - PAD - ((e - minE) / range) * (H - PAD * 2);
    return `${x},${y}`;
  });

  const polyFill = `M${pts[0]} ` + pts.slice(1).map(p => `L${p}`).join(' ')
    + ` L${W - PAD},${H - PAD} L${PAD},${H - PAD} Z`;
  const polyLine = `M${pts[0]} ` + pts.slice(1).map(p => `L${p}`).join(' ');

  // Ascent / descent
  let ascent = 0, descent = 0;
  for (let i = 1; i < elevations.length; i++) {
    const d = elevations[i] - elevations[i - 1];
    if (d > 0) ascent += d; else descent -= d;
  }

  document.getElementById('statAscent').textContent =
    `+${Math.round(ascent)} m / -${Math.round(descent)} m`;

  el.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:${H}px;display:block">
      <path d="${polyFill}" fill="rgba(30,77,20,0.15)" stroke="none"/>
      <path d="${polyLine}" fill="none" stroke="#1e4d14" stroke-width="2" stroke-linejoin="round"/>
      <text x="${PAD}" y="${H - 2}" font-size="9" fill="#6b7280">${Math.round(minE)} m</text>
      <text x="${PAD}" y="10" font-size="9" fill="#6b7280">${Math.round(maxE)} m</text>
      <text x="${W / 2}" y="${H - 2}" font-size="9" fill="#9ca3af" text-anchor="middle">${(meters / 1000).toFixed(1)} km</text>
    </svg>
  `;
  wrap.classList.remove('hidden');
}

// ── GPX/KML export now lives in js/exporters.js (downloadGPX, downloadKML, pushToStrava)

// ── Reset ─────────────────────────────────────────────────────────────────────
document.getElementById('btnReset').addEventListener('click', () => {
  resetPoints();
  document.querySelectorAll('.mode-card').forEach(c => c.classList.remove('active'));
  lock('step2'); lock('step3'); lock('step4');
  mode = null; pickingPoint = null;
  map.getContainer().style.cursor = '';
});

function unlock(id) { document.getElementById(id)?.classList.remove('locked'); }
function lock(id)   { document.getElementById(id)?.classList.add('locked'); }

// ── Toast ─────────────────────────────────────────────────────────────────────
function showToast(msg, duration = 2400) {
  let t = document.getElementById('bwrToast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'bwrToast';
    t.className = 'bwr-toast';
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove('show'), duration);
}

// ── Save / share buttons ──────────────────────────────────────────────────────
function setSaveShareEnabled(enabled) {
  const plan = currentUser?.plan || 'free';
  const canSave = BWR.can('route_history', plan);
  const btnSave  = document.getElementById('btnSaveRoute');
  const btnShare = document.getElementById('btnShareRoute');
  if (btnSave)  btnSave.disabled  = !enabled || !canSave;
  if (btnShare) btnShare.disabled = !enabled || !canSave;
}

function initSaveShareButtons() {
  const plan = currentUser?.plan || 'free';
  const canSave = BWR.can('route_history', plan);

  const btnSave = document.getElementById('btnSaveRoute');
  const btnShare = document.getElementById('btnShareRoute');

  if (!btnSave || !btnShare) return;

  btnSave.disabled  = true;
  btnShare.disabled = true;

  if (!canSave) {
    btnSave.onclick = () => showUpgradeModal('silver', 'La sauvegarde de trajets');
    btnShare.onclick = () => showUpgradeModal('silver', 'Le partage de trajets');
    return;
  }

  btnSave.onclick  = saveCurrentRoute;
  btnShare.onclick = shareCurrentRoute;
}

async function saveCurrentRoute() {
  if (!lastRoute) return;
  const btn = document.getElementById('btnSaveRoute');
  btn.disabled = true;
  btn.textContent = '⏳ Sauvegarde…';

  const typeLabelShort = { foot: 'Forestier', bike: 'Cyclable', champs: 'Champs', mix: 'Mix' }[pathType] || '';
  const defaultName = `${mode === 'loop' ? 'Boucle' : 'Trajet'} ${typeLabelShort} ${(lastRoute.meters / 1000).toFixed(1)} km`;

  try {
    const res = await fetch(`${API_URL}/api/savedroutes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeader() },
      body: JSON.stringify({
        name: defaultName,
        coords: lastRoute.coords,
        meters: lastRoute.meters,
        seconds: lastRoute.seconds,
        difficulty,
        pathType,
        mode,
      }),
    });
    if (!res.ok) throw new Error((await res.json()).error || `HTTP ${res.status}`);
    const { shareToken } = await res.json();
    lastRoute._shareToken = shareToken;
    showToast('Trajet sauvegardé !');
    refreshHistoryIfOpen();
  } catch (e) {
    showToast(`Erreur : ${e.message}`);
  } finally {
    btn.textContent = '💾 Sauvegarder';
    btn.disabled = false;
  }
}

async function shareCurrentRoute() {
  if (!lastRoute) return;

  // If we already have a share token from saving, use it directly
  if (lastRoute._shareToken) {
    copyShareLink(lastRoute._shareToken);
    return;
  }

  // Otherwise save first, then share
  const btn = document.getElementById('btnShareRoute');
  btn.disabled = true;
  btn.textContent = '⏳…';

  const typeLabelShort = { foot: 'Forestier', bike: 'Cyclable', champs: 'Champs', mix: 'Mix' }[pathType] || '';
  const defaultName = `${mode === 'loop' ? 'Boucle' : 'Trajet'} ${typeLabelShort} ${(lastRoute.meters / 1000).toFixed(1)} km`;

  try {
    const res = await fetch(`${API_URL}/api/savedroutes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeader() },
      body: JSON.stringify({
        name: defaultName,
        coords: lastRoute.coords,
        meters: lastRoute.meters,
        seconds: lastRoute.seconds,
        difficulty,
        pathType,
        mode,
      }),
    });
    if (!res.ok) throw new Error((await res.json()).error || `HTTP ${res.status}`);
    const { shareToken } = await res.json();
    lastRoute._shareToken = shareToken;
    copyShareLink(shareToken);
    refreshHistoryIfOpen();
  } catch (e) {
    showToast(`Erreur : ${e.message}`);
  } finally {
    btn.textContent = '🔗 Partager';
    btn.disabled = false;
  }
}

function copyShareLink(token) {
  const url = `${location.origin}${location.pathname}?share=${token}`;
  if (navigator.clipboard) {
    navigator.clipboard.writeText(url).then(() => showToast('Lien copié dans le presse-papiers !'));
  } else {
    const ta = document.createElement('textarea');
    ta.value = url;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
    showToast('Lien copié !');
  }
}

// ── Route history panel ───────────────────────────────────────────────────────
let historyOpen = false;
let historyLoaded = false;

function initRouteHistory() {
  const plan = currentUser?.plan || 'free';
  const panelEl = document.getElementById('routeHistory');
  if (!panelEl) return;

  if (!BWR.can('route_history', plan)) {
    panelEl.classList.remove('hidden');
    const body = document.getElementById('historyBody');
    body.style.display = 'none';
    body.innerHTML = `
      <div class="history-empty">
        <p>🔒 Sauvegardez vos trajets avec le plan Argent.</p>
        <a href="plans.html" style="color:#6d28d9;font-weight:700">Voir les plans →</a>
      </div>`;
    document.getElementById('historyToggle').addEventListener('click', toggleHistory);
    return;
  }

  panelEl.classList.remove('hidden');
  document.getElementById('historyBody').style.display = 'none';
  document.getElementById('historyToggle').addEventListener('click', toggleHistory);
}

function toggleHistory() {
  historyOpen = !historyOpen;
  document.getElementById('historyChevron').classList.toggle('open', historyOpen);
  const body = document.getElementById('historyBody');
  body.style.display = historyOpen ? 'block' : 'none';

  if (historyOpen && !historyLoaded) {
    fetchAndRenderHistory();
  }
}

function refreshHistoryIfOpen() {
  if (historyOpen) fetchAndRenderHistory();
  else historyLoaded = false;
}

async function fetchAndRenderHistory() {
  const listEl   = document.getElementById('historyList');
  const loadEl   = document.getElementById('historyLoading');
  loadEl.style.display = 'block';
  listEl.innerHTML = '';

  try {
    const res = await fetch(`${API_URL}/api/savedroutes`, { headers: authHeader() });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const routes = await res.json();
    historyLoaded = true;
    loadEl.style.display = 'none';
    if (!routes.length) {
      listEl.innerHTML = '<div class="history-empty">Aucun trajet sauvegardé.</div>';
      return;
    }
    listEl.innerHTML = routes.map(r => {
      const km    = (r.meters / 1000).toFixed(1);
      const date  = new Date(r.savedAt).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' });
      const modeIcon = r.mode === 'loop' ? '🔄' : '➡️';
      return `
        <div class="history-item" data-id="${r.id}" data-token="${r.shareToken}">
          <div class="history-item-info">
            <div class="history-item-name">${escapeHtml(r.name)}</div>
            <div class="history-item-meta">${modeIcon} ${km} km · ${date}</div>
          </div>
          <div class="history-item-actions">
            <button class="btn-history-replay" title="Afficher sur la carte">▶</button>
            <button class="btn-history-share"  title="Copier le lien de partage">🔗</button>
            <button class="btn-history-delete" title="Supprimer">🗑</button>
          </div>
        </div>`;
    }).join('');

    listEl.querySelectorAll('.history-item').forEach(el => {
      const id    = el.dataset.id;
      const token = el.dataset.token;
      el.querySelector('.btn-history-replay').onclick = () => replaySavedRoute(id);
      el.querySelector('.btn-history-share').onclick  = () => copyShareLink(token);
      el.querySelector('.btn-history-delete').onclick = () => deleteSavedRoute(id, el);
    });
  } catch (e) {
    loadEl.style.display = 'none';
    listEl.innerHTML = `<div class="history-empty">Erreur : ${e.message}</div>`;
  }
}

async function replaySavedRoute(id) {
  try {
    const res = await fetch(`${API_URL}/api/savedroutes/${id}`, { headers: authHeader() });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const route = await res.json();
    if (routeLayer) map.removeLayer(routeLayer);
    const color = route.difficulty === 'easy' ? '#22c55e' : route.difficulty === 'medium' ? '#f97316' : '#ef4444';
    routeLayer = L.polyline(route.coords, { color, weight: 6, opacity: 0.9 }).addTo(map);
    map.fitBounds(routeLayer.getBounds(), { padding: [40, 40] });
    showToast('Trajet affiché sur la carte.');
  } catch (e) {
    showToast(`Erreur : ${e.message}`);
  }
}

async function deleteSavedRoute(id, el) {
  if (!confirm('Supprimer ce trajet ?')) return;
  try {
    const res = await fetch(`${API_URL}/api/savedroutes/${id}`, {
      method: 'DELETE',
      headers: authHeader(),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    el.remove();
    const listEl = document.getElementById('historyList');
    if (!listEl.children.length) listEl.innerHTML = '<div class="history-empty">Aucun trajet sauvegardé.</div>';
    showToast('Trajet supprimé.');
  } catch (e) {
    showToast(`Erreur : ${e.message}`);
  }
}

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── AI suggestion URL params (?dist=X&mode=Y&startLat=Z&startLng=W) ──────────
function applyAISuggestionParams() {
  const p = new URLSearchParams(location.search);
  const dist     = parseFloat(p.get('dist'));
  const modeVal  = p.get('mode');
  const startLat = parseFloat(p.get('startLat'));
  const startLng = parseFloat(p.get('startLng'));

  if (!dist && !modeVal) return;

  // Pre-select mode card
  if (modeVal === 'loop' || modeVal === 'atob') {
    const modeCard = document.querySelector(`.mode-card[data-mode="${modeVal}"]`);
    if (modeCard && !modeCard.classList.contains('locked-feature')) modeCard.click();
  }

  // Pre-fill distance slider / input if it exists
  const distInput = document.getElementById('distInput') || document.getElementById('inputDist');
  if (distInput && dist > 0) {
    distInput.value = dist;
    distInput.dispatchEvent(new Event('input', { bubbles: true }));
  }
  const distSlider = document.getElementById('distSlider') || document.getElementById('sliderDist');
  if (distSlider && dist > 0) {
    distSlider.value = dist;
    distSlider.dispatchEvent(new Event('input', { bubbles: true }));
  }

  // Pre-place start marker from home address coords
  if (!isNaN(startLat) && !isNaN(startLng) && map) {
    const latlng = L.latLng(startLat, startLng);
    if (startMarker) map.removeLayer(startMarker);
    startMarker = L.marker(latlng, { draggable: true }).addTo(map);
    startMarker.on('dragend', () => { /* coords update on compute */ });
    map.setView(latlng, 13);

    // Show a banner to inform the user the start was preset
    const banner = document.createElement('div');
    banner.className = 'ai-sugg-banner';
    banner.innerHTML = `🤖 Départ préréglé depuis votre domicile · <button id="clearAiStart">Effacer</button>`;
    document.querySelector('.routes-sidebar')?.prepend(banner);
    document.getElementById('clearAiStart')?.addEventListener('click', () => {
      if (startMarker) { map.removeLayer(startMarker); startMarker = null; }
      banner.remove();
    });
  }
}

// ── Shared route from URL (?share=token) ──────────────────────────────────────
async function handleSharedRouteParam() {
  const token = new URLSearchParams(location.search).get('share');
  if (!token) return;

  try {
    const res = await fetch(`${API_URL}/api/savedroutes/share/${token}`);
    if (!res.ok) { showToast('Lien de partage invalide ou expiré.'); return; }
    const route = await res.json();

    const color = route.difficulty === 'easy' ? '#22c55e' : route.difficulty === 'medium' ? '#f97316' : '#ef4444';
    if (routeLayer) map.removeLayer(routeLayer);
    routeLayer = L.polyline(route.coords, { color, weight: 6, opacity: 0.9 }).addTo(map);
    map.fitBounds(routeLayer.getBounds(), { padding: [40, 40] });

    const km   = (route.meters / 1000).toFixed(2);
    const modeIcon = route.mode === 'loop' ? '🔄 Boucle' : '➡️ A → B';
    const banner = document.createElement('div');
    banner.className = 'shared-route-banner';
    banner.innerHTML = `🔗 Trajet partagé : <strong>${escapeHtml(route.name)}</strong> — ${modeIcon}, ${km} km`;
    document.getElementById('routeResult').prepend(banner);
    document.getElementById('routeResult').classList.remove('hidden');
  } catch {
    showToast('Impossible de charger le trajet partagé.');
  }
}
