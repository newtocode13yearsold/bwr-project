const TILE_LAYERS = {
  ign: L.tileLayer(
    'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
    { attribution: 'Map data: &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, <a href="http://viewfinderpanoramas.org">SRTM</a> | Style: &copy; <a href="https://opentopomap.org">OpenTopoMap</a>', maxZoom: 17, subdomains: ['a','b','c'] }
  ),
  satellite: L.tileLayer(
    'https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=ORTHOIMAGERY.ORTHOPHOTOS&STYLE=normal&FORMAT=image/jpeg&TILEMATRIXSET=PM&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}',
    { attribution: '&copy; <a href="https://www.geoportail.gouv.fr/">IGN</a>', maxZoom: 20 }
  ),
};

const map = L.map('map', { zoomControl: true }).setView(MAP_CENTER, MAP_ZOOM);
TILE_LAYERS.ign.addTo(map);

let currentLayer = 'ign';
let allPaths = [];
let pathLayers = {};
let activeFilters = new Set(['easy', 'medium', 'hard', 'not_passable']);

function pathWeight() {
  const z = map.getZoom();
  return Math.max(2, Math.min(10, Math.round((z - 8) * 0.7)));
}

map.on('zoomend', () => {
  const w = pathWeight();
  Object.values(pathLayers).forEach(l => l.setStyle({ weight: w }));
});

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
      <a href="profile.html">Mon profil</a>
      ${user.role === 'admin' ? '<a href="admin.html">Panneau admin</a>' : ''}
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
    updateCount();
  } catch {
    document.getElementById('pathCount').textContent = 'Impossible de charger les chemins.';
  }
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

    // Hover glow — highlight on mouse-over, restore on mouse-out
    line.on('mouseover', function () {
      this.setStyle({ weight: pathWeight() + 3, opacity: 1 });
      this.bringToFront();
    });
    line.on('mouseout', function () {
      this.setStyle({ weight: pathWeight(), opacity: 0.85 });
    });

    // Tooltip shows name without needing to click
    line.bindTooltip(path.name || 'Chemin sans nom', {
      sticky: true,
      direction: 'top',
      offset: [0, -6],
      className: 'path-tooltip',
    });

    const condHTML = path.conditions?.length
      ? `<div class="popup-cond-row">${path.conditions.map(c => {
          const icons = { dry:'✅', muddy:'⚠️', fallen:'❌', mtb:'🚴', running:'🏃', family:'👨‍👩‍👧' };
          const labels = { dry:'Sec', muddy:'Boueux', fallen:'Arbres tombés', mtb:'Idéal MTB', running:'Running', family:'Famille' };
          return `<span class="popup-cond-tag">${icons[c] || ''} ${labels[c] || c}</span>`;
        }).join('')}</div>`
      : '';
    line.bindPopup(`
      <div class="popup">
        <strong>${path.name || 'Chemin sans nom'}</strong>
        <span class="popup-status" style="background:${STATUS_COLORS[path.status]}">${STATUS_LABELS[path.status] || path.status}</span>
        ${condHTML}
        ${path.notes ? `<p class="popup-notes">${path.notes}</p>` : ''}
      </div>
    `);

    line.addTo(map);
    pathLayers[path.id] = line;
  });
}

function updateCount() {
  const visible = Object.keys(pathLayers).length;
  document.getElementById('pathCount').textContent =
    `${visible} chemin${visible !== 1 ? 's' : ''} affiché${visible !== 1 ? 's' : ''}`;
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
    map.removeLayer(TILE_LAYERS[currentLayer]);
    currentLayer = radio.value;
    TILE_LAYERS[currentLayer].addTo(map);
  });
});

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
  // Hide when zoomed out — names are unreadable below this level
  if (map.getZoom() >= 14) {
    if (!map.hasLayer(carrefourLayer)) carrefourLayer.addTo(map);
  } else {
    if (map.hasLayer(carrefourLayer)) map.removeLayer(carrefourLayer);
  }
}

map.on('zoomend', updateCarrefourVisibility);
updateCarrefourVisibility();

initUserMenu();
loadPaths();
