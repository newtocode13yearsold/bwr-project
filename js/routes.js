let currentUser = null;
let map = null;
let mode = null;
let pathType = 'foot';
let difficulty = 'easy';
let startMarker = null;
let endMarker = null;
let routeLayer = null;
let savedPathsLayer = null;
let savedPaths = [];       // raw paths array — used by the graph router
let pickingPoint = null;


// ── Auth ──────────────────────────────────────────────────────────────────────
(async () => {
  currentUser = await requireAuth();
  if (!currentUser) return;
  initUserMenu();
  initMap();
  loadSavedPaths();
  applyPlanGates();
  updateQuotaStrip();
})();

// ── Plan-based UI gating ──────────────────────────────────────────────────────
// Locks mode cards, difficulty buttons, premium tile layers and exports for
// users whose plan does not include the feature. See js/features.js.
function applyPlanGates() {
  const plan = currentUser?.plan || 'free';

  // Lock loop mode if disallowed (free users currently)
  if (!can('loop_mode', plan)) {
    const loopCard = document.querySelector('.mode-card[data-mode="loop"]');
    if (loopCard) markCardLocked(loopCard, 'silver', 'Mode boucle');
  }
  // Lock multi-stop (visual hint only — there is no button yet)

  // Lock Hard difficulty
  if (!can('difficulty_hard', plan)) {
    const hardBtn = document.querySelector('.diff-btn[data-diff="hard"]');
    if (hardBtn) markBtnLocked(hardBtn, 'silver');
  }

  // Lock satellite tile button
  if (!can('satellite_tiles', plan)) {
    const satBtn = document.querySelector('.layer-btn[data-layer="satellite"]');
    if (satBtn) markBtnLocked(satBtn, 'gold');
  }
  // Lock IGN topo for free users (default tile becomes OSM)
  if (!can('ign_topo_tiles', plan)) {
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
  const limit = limitOf('routes_per_week', plan);
  const stripEl = document.getElementById('quotaStrip');
  if (!stripEl) return;
  if (limit === Infinity) {
    stripEl.classList.add('hidden');
    return;
  }
  const { count } = readWeekly();
  const remaining = Math.max(0, limit - count);
  const pct = Math.min(100, (count / limit) * 100);
  stripEl.classList.remove('hidden');
  stripEl.innerHTML = `
    <div class="qs-text">
      <strong>${count} / ${limit}</strong> trajets utilisés cette semaine
      <span class="qs-sub">${remaining > 0 ? `${remaining} restant${remaining > 1 ? 's' : ''}` : 'Limite atteinte'}</span>
    </div>
    <div class="qs-bar"><div class="qs-fill" style="width:${pct}%"></div></div>
    <a href="plans.html" class="qs-cta">Passer à Argent — illimité →</a>
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
const TILE_LAYERS = {
  ign: () => L.tileLayer(
    'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
    { attribution: 'Map data: &copy; OpenStreetMap contributors, SRTM | Style: &copy; OpenTopoMap', maxNativeZoom: 17, maxZoom: 25, subdomains: ['a','b','c'], detectRetina: true }
  ),
  osm: () => L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    { attribution: '© OpenStreetMap', maxNativeZoom: 19, maxZoom: 25, detectRetina: true }
  ),
  satellite: () => L.tileLayer(
    'https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=ORTHOIMAGERY.ORTHOPHOTOS&STYLE=normal&FORMAT=image/jpeg&TILEMATRIXSET=PM&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}',
    { attribution: '© IGN', maxNativeZoom: 20, maxZoom: 25, detectRetina: true }
  ),
};
let currentTile = null;

function initMap() {
  map = L.map('map', { zoomControl: true, maxZoom: 25 }).setView(MAP_CENTER, MAP_ZOOM);
  // Free users get OSM by default (IGN/satellite gated)
  const plan = currentUser?.plan || 'free';
  const defaultLayer = can('ign_topo_tiles', plan) ? 'ign' : 'osm';
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
      currentTile = TILE_LAYERS[btn.dataset.layer]();
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

document.querySelectorAll('.diff-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.diff-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    difficulty = btn.dataset.diff;
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

  // ── Weekly quota check (free tier hard limit) ──
  const plan  = currentUser?.plan || 'free';
  const quota = checkRouteQuota(plan);
  if (!quota.ok) {
    showQuotaExceededModal(quota);
    return;
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
    btn.textContent = 'Erreur: ' + err.message;
    btn.classList.remove('loading');
    setTimeout(() => { btn.textContent = 'Calculer le trajet'; btn.disabled = false; }, 5000);
    return;
  }

  // Track usage stats shown on profile page
  const prevCount = parseInt(localStorage.getItem('bwr_route_count') || '0');
  const prevKm    = parseFloat(localStorage.getItem('bwr_km_total')   || '0');
  localStorage.setItem('bwr_route_count', prevCount + 1);
  localStorage.setItem('bwr_km_total', (prevKm + result.meters / 1000).toFixed(2));

  // Bump the weekly quota and refresh the strip
  bumpWeekly();
  updateQuotaStrip();

  displayRoute(result, mode === 'loop' ? distanceKm : null);

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

// ── ORS fallback (via worker, needs ORS_KEY set in Cloudflare) ─────────────────
function orsProfile() {
  const map = { bike: 'cycling-mountain', champs: 'foot-walking', mix: 'foot-walking' };
  return map[pathType] || 'foot-hiking';
}
async function callORS(body) {
  const res = await fetch(`${API_URL}/api/route`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeader() },
    body: JSON.stringify(body),
  });
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
  const res = await fetch(`https://router.project-osrm.org/route/v1/${p}/${c}?overview=full&geometries=geojson`);
  const data = await res.json();
  if (data.code !== 'Ok' || !data.routes?.[0]) throw new Error('OSRM: no route');
  const r = data.routes[0];
  return { coords: r.geometry.coordinates.map(([lon, lat]) => [lat, lon]), meters: r.distance, seconds: r.duration };
}

async function osrmTrip(wpList) {
  const p = osrmProfile();
  const c = wpList.map(w => `${w.lon},${w.lat}`).join(';');
  const res = await fetch(`https://router.project-osrm.org/trip/v1/${p}/${c}?roundtrip=true&source=first&destination=any&overview=full&geometries=geojson`);
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

// ── Public routing entry points ────────────────────────────────────────────────
async function routeAtob(sLat, sLng, eLat, eLng) {
  // ORS (needs ORS_KEY in Cloudflare)
  try {
    return await callORS({ profile: orsProfile(), coordinates: [[sLng, sLat], [eLng, eLat]] });
  } catch (e) { console.warn('ORS:', e.message); }
  // OSRM — uses all roads and paths (city streets, forest paths, etc.)
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

  // Gold users can override route color (free/silver get default difficulty colors)
  const plan = currentUser?.plan || 'free';
  const customColor = can('custom_route_color', plan) ? localStorage.getItem('bwr_route_color') : null;
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
    if (can('gpx_export', plan)) {
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
    if (can('kml_export', plan)) {
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
    if (can('strava_komoot_push', plan)) {
      btnStrava.classList.remove('locked-feature');
      btnStrava.onclick = () => pushToStrava(coords, routeName);
    } else {
      btnStrava.classList.add('locked-feature');
      btnStrava.onclick = (e) => { e.preventDefault(); showUpgradeModal('gold', 'Le push Strava'); };
    }
  }

  // Elevation profile — only for Silver+
  if (can('elevation_profile', plan)) {
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
