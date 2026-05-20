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
      <a href="profile.html">Mon profil</a>
      ${currentUser.role === 'admin' ? '<a href="admin.html">Admin</a>' : ''}
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
    'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png',
    { attribution: '&copy; OpenStreetMap &copy; CARTO', maxZoom: 19 }
  ),
  osm: () => L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    { attribution: '© OpenStreetMap', maxZoom: 19 }
  ),
  satellite: () => L.tileLayer(
    'https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=ORTHOIMAGERY.ORTHOPHOTOS&STYLE=normal&FORMAT=image/jpeg&TILEMATRIXSET=PM&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}',
    { attribution: '© IGN', maxZoom: 20 }
  ),
};
let currentTile = null;

function initMap() {
  map = L.map('map', { zoomControl: true }).setView(MAP_CENTER, MAP_ZOOM);
  currentTile = TILE_LAYERS.ign();
  currentTile.addTo(map);
  map.on('click', onMapClick);
  setTimeout(() => map.invalidateSize(), 100);

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

  displayRoute(result, mode === 'loop' ? distanceKm : null);

  btn.textContent = 'Calculer le trajet';
  btn.classList.remove('loading');
  btn.disabled = false;
}

// ── Graph router (uses only your admin-tagged paths) ─────────────────────────
// This guarantees forest-only routing and true loops with no backtracking.

function haversineM(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function nodeKey(lat, lon) {
  return `${lat.toFixed(5)},${lon.toFixed(5)}`;
}

function buildGraph(paths) {
  const nodes = new Map();
  const adj   = new Map();

  function ensure(lat, lon) {
    const k = nodeKey(lat, lon);
    if (!nodes.has(k)) { nodes.set(k, { lat, lon, k }); adj.set(k, []); }
    return k;
  }
  function link(k1, k2, d) {
    adj.get(k1).push({ to: k2, d });
    adj.get(k2).push({ to: k1, d });
  }

  paths.forEach(path => {
    const c = path.coordinates;
    const keys = c.map(([lat, lon]) => ensure(lat, lon));
    for (let i = 0; i < keys.length - 1; i++) {
      const d = haversineM(c[i][0], c[i][1], c[i + 1][0], c[i + 1][1]);
      if (!adj.get(keys[i]).some(e => e.to === keys[i + 1])) link(keys[i], keys[i + 1], d);
    }
  });

  // Connect path endpoints within 40 m so separate paths join up
  const endpoints = [];
  paths.forEach(p => {
    const c = p.coordinates;
    endpoints.push([c[0][0], c[0][1]]);
    endpoints.push([c[c.length - 1][0], c[c.length - 1][1]]);
  });
  for (let i = 0; i < endpoints.length; i++) {
    for (let j = i + 1; j < endpoints.length; j++) {
      const d = haversineM(...endpoints[i], ...endpoints[j]);
      if (d > 0 && d < 80) {
        const ka = nodeKey(...endpoints[i]), kb = nodeKey(...endpoints[j]);
        if (adj.has(ka) && adj.has(kb) && !adj.get(ka).some(e => e.to === kb)) link(ka, kb, d);
      }
    }
  }

  return { nodes, adj };
}

function dijkstra(adj, start, end = null) {
  const dist = new Map([[start, 0]]);
  const prev = new Map();
  const queue = [[0, start]];

  while (queue.length) {
    queue.sort((a, b) => a[0] - b[0]);
    const [d, u] = queue.shift();
    if (end && u === end) break;
    if (d > (dist.get(u) ?? Infinity)) continue;
    for (const { to, d: w } of (adj.get(u) || [])) {
      const nd = d + w;
      if (nd < (dist.get(to) ?? Infinity)) {
        dist.set(to, nd); prev.set(to, u); queue.push([nd, to]);
      }
    }
  }
  return { dist, prev };
}

function rebuildPath(prev, start, end) {
  const path = [];
  let cur = end;
  while (cur !== undefined) {
    path.unshift(cur);
    if (cur === start) break;
    cur = prev.get(cur);
  }
  return path[0] === start ? path : null;
}

function nearestNode(nodes, lat, lon) {
  let best = null, bd = Infinity;
  for (const n of nodes.values()) {
    const d = haversineM(lat, lon, n.lat, n.lon);
    if (d < bd) { bd = d; best = n; }
  }
  return best;
}

function graphToResult(nodes, keys, pathTyp) {
  const coords = keys.map(k => { const n = nodes.get(k); return [n.lat, n.lon]; });
  let meters = 0;
  for (let i = 0; i < keys.length - 1; i++) {
    const a = nodes.get(keys[i]), b = nodes.get(keys[i + 1]);
    meters += haversineM(a.lat, a.lon, b.lat, b.lon);
  }
  const speed = pathTyp === 'bike' ? 4.17 : 1.11; // m/s
  return { coords, meters, seconds: meters / speed };
}

function filterPaths(paths) {
  if (pathType === 'foot')  return paths.filter(p => !p.pathType || p.pathType === 'foot');
  if (pathType === 'bike')  return paths.filter(p => p.pathType === 'bike');
  return paths; // champs / mix: all paths
}

// A → B on the graph
function graphAtob(sLat, sLng, eLat, eLng) {
  const paths = filterPaths(savedPaths);
  if (!paths.length) throw new Error('Aucun chemin de ce type enregistré');
  const { nodes, adj } = buildGraph(paths);
  const sNode = nearestNode(nodes, sLat, sLng);
  const eNode = nearestNode(nodes, eLat, eLng);
  const { prev } = dijkstra(adj, sNode.k, eNode.k);
  const keys = rebuildPath(prev, sNode.k, eNode.k);
  if (!keys) throw new Error('Aucun chemin entre ces deux points');
  return graphToResult(nodes, keys, pathType);
}

// Loop on the graph — routes out one way, removes those edges, routes back differently.
// This guarantees a true loop with zero backtracking.
function graphLoop(sLat, sLng, targetKm) {
  const paths = filterPaths(savedPaths);
  if (!paths.length) throw new Error('Aucun chemin de ce type enregistré');
  const { nodes, adj } = buildGraph(paths);
  if (nodes.size < 4) throw new Error('Pas assez de chemins — ajoutes-en depuis le panneau admin');

  const startNode = nearestNode(nodes, sLat, sLng);
  const targetM   = targetKm * 1000;

  // 1. Dijkstra from start → distances to all nodes
  const { dist, prev: prevOut } = dijkstra(adj, startNode.k);

  // 2. Pick the node closest to half the target distance
  let midKey = null, midDiff = Infinity;
  for (const [k, d] of dist) {
    if (d <= 0) continue;
    const diff = Math.abs(d - targetM / 2);
    if (diff < midDiff) { midDiff = diff; midKey = k; }
  }
  if (!midKey) throw new Error('Le réseau est trop petit pour cette distance');

  // 3. Reconstruct outgoing path start → mid
  const outKeys = rebuildPath(prevOut, startNode.k, midKey);
  if (!outKeys) throw new Error('Impossible de calculer l\'aller');

  // 4. Copy adjacency list and remove all edges used on the way out
  const adjBack = new Map([...adj].map(([k, edges]) => [k, [...edges]]));
  for (let i = 0; i < outKeys.length - 1; i++) {
    const a = outKeys[i], b = outKeys[i + 1];
    adjBack.set(a, adjBack.get(a).filter(e => e.to !== b));
    adjBack.set(b, adjBack.get(b).filter(e => e.to !== a));
  }

  // 5. Route back mid → start on different edges
  const { prev: prevBack } = dijkstra(adjBack, midKey, startNode.k);
  const backKeys = rebuildPath(prevBack, midKey, startNode.k);
  if (!backKeys) throw new Error('Impossible de former une boucle — ajoute plus de chemins dans la zone');

  return graphToResult(nodes, [...outKeys, ...backKeys.slice(1)], pathType);
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
  // 1. Graph router — only your tagged forest paths, guaranteed correct terrain
  if (savedPaths.length) {
    try { return graphAtob(sLat, sLng, eLat, eLng); } catch (e) { console.warn('graph:', e.message); }
  }
  // 2. ORS (needs ORS_KEY in Cloudflare)
  try {
    return await callORS({ profile: orsProfile(), coordinates: [[sLng, sLat], [eLng, eLat]] });
  } catch (e) { console.warn('ORS:', e.message); }
  // 3. OSRM — always works, any path
  return osrmRoute([{ lat: sLat, lon: sLng }, { lat: eLat, lon: eLng }]);
}

async function routeLoop(sLat, sLng, targetKm) {
  // 1. Graph router — real loop, forest only
  if (savedPaths.length) {
    try { return graphLoop(sLat, sLng, targetKm); } catch (e) { console.warn('graph:', e.message); }
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

  const color = difficulty === 'easy' ? '#22c55e' : difficulty === 'medium' ? '#f97316' : '#ef4444';
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

  // GPX export
  const typeLabelShort = { foot: 'forestier', bike: 'cyclable', champs: 'champs', mix: 'mix' }[pathType];
  const routeName = `BWR_${mode === 'loop' ? 'boucle' : 'atob'}_${typeLabelShort}`;
  document.getElementById('btnGPX').onclick = () => downloadGPX(coords, routeName);

  // Elevation profile (async, fills in after route appears)
  fetchElevation(coords)
    .then(elevs => drawElevationChart(elevs, meters))
    .catch(() => { document.getElementById('statAscent').textContent = '—'; });
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

// ── GPX export ────────────────────────────────────────────────────────────────
function downloadGPX(coords, routeName) {
  const now = new Date().toISOString();
  const trkpts = coords.map(([lat, lon]) =>
    `    <trkpt lat="${lat.toFixed(6)}" lon="${lon.toFixed(6)}"></trkpt>`
  ).join('\n');

  const gpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="BWR — Balades en forêt de Compiègne"
  xmlns="http://www.topografix.com/GPX/1/1">
  <metadata>
    <name>${routeName}</name>
    <time>${now}</time>
  </metadata>
  <trk>
    <name>${routeName}</name>
    <trkseg>
${trkpts}
    </trkseg>
  </trk>
</gpx>`;

  const blob = new Blob([gpx], { type: 'application/gpx+xml' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url;
  a.download = `${routeName.replace(/\s+/g, '_')}.gpx`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

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
