const TILE_LAYERS = {
  plan: L.tileLayer(
    'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png',
    { attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/">CARTO</a>', maxZoom: 19 }
  ),
  topo: L.tileLayer(
    'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
    { attribution: 'Map data: &copy; OpenStreetMap contributors, SRTM | Style: &copy; <a href="https://opentopomap.org">OpenTopoMap</a>', maxZoom: 17, subdomains: ['a','b','c'] }
  ),
  satellite: L.tileLayer(
    'https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=ORTHOIMAGERY.ORTHOPHOTOS&STYLE=normal&FORMAT=image/jpeg&TILEMATRIXSET=PM&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}',
    { attribution: '&copy; <a href="https://www.geoportail.gouv.fr/">IGN</a>', maxZoom: 20 }
  ),
};

const map = L.map('map', { zoomControl: true, fadeAnimation: true, zoomAnimation: true })
  .setView(MAP_CENTER, MAP_ZOOM);

TILE_LAYERS.plan.addTo(map);
let currentLayer = 'plan';

let allPaths = [];
let pathLayers = {};
let activeFilters = new Set(['easy', 'medium', 'hard', 'not_passable']);

function pathWeight() {
  const z = map.getZoom();
  return Math.max(3, Math.min(9, Math.round((z - 8) * 0.8)));
}

// Update both outline + color line on zoom
map.on('zoomend', () => {
  const w = pathWeight();
  Object.values(pathLayers).forEach(group => {
    const layers = group.getLayers();
    if (layers[0]) layers[0].setStyle({ weight: w + 4 });
    if (layers[1]) layers[1].setStyle({ weight: w });
  });
});

// ── User menu ─────────────────────────────────────────────────────────────────
async function initUserMenu() {
  const user = getCachedUser();
  const menuEl = document.getElementById('userMenu');

  if (!user) {
    menuEl.innerHTML = `<a href="login.html" class="btn-icon">Connexion</a>`;
    return;
  }

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
    if (!menuEl.contains(e.target))
      document.getElementById('userDropdown')?.classList.add('hidden');
  });
}

// ── Paths ─────────────────────────────────────────────────────────────────────
async function loadPaths() {
  const loader = document.getElementById('mapLoader');

  // Show cached paths instantly while fresh data loads
  const cached = sessionStorage.getItem('bwr_paths');
  if (cached) {
    try {
      allPaths = JSON.parse(cached);
      renderPaths();
      updateCount();
    } catch {}
  } else {
    loader.classList.remove('hidden');
  }

  try {
    const res = await fetch(`${API_URL}/api/paths`);
    const fresh = await res.json();
    sessionStorage.setItem('bwr_paths', JSON.stringify(fresh));
    allPaths = fresh;
    renderPaths();
    updateCount();
  } catch {
    if (!cached)
      document.getElementById('pathCount').textContent = 'Impossible de charger les chemins.';
  } finally {
    loader.classList.add('hidden');
  }
}

function renderPaths() {
  Object.values(pathLayers).forEach(group => map.removeLayer(group));
  pathLayers = {};

  const w = pathWeight();
  const COND_ICONS   = { dry:'✅', muddy:'⚠️', fallen:'❌', mtb:'🚴', running:'🏃', family:'👨‍👩‍👧' };
  const COND_LABELS  = { dry:'Sec', muddy:'Boueux', fallen:'Arbres tombés', mtb:'Idéal MTB', running:'Running', family:'Famille' };

  allPaths.forEach(path => {
    if (!activeFilters.has(path.status)) return;

    const color = STATUS_COLORS[path.status] || '#9ca3af';

    // White outline underneath → colored line on top = routes "pop" against any basemap
    const outline = L.polyline(path.coordinates, {
      color: 'white', weight: w + 4, opacity: 0.55,
      lineCap: 'round', lineJoin: 'round',
    });
    const line = L.polyline(path.coordinates, {
      color, weight: w, opacity: 0.92,
      lineCap: 'round', lineJoin: 'round',
    });

    const condHTML = path.conditions?.length
      ? `<div class="popup-cond-row">${path.conditions.map(c =>
          `<span class="popup-cond-tag">${COND_ICONS[c] || ''} ${COND_LABELS[c] || c}</span>`
        ).join('')}</div>`
      : '';

    const typeIcon = path.pathType === 'bike' ? '🚴' : '🌲';

    const group = L.featureGroup([outline, line]);
    group.bindPopup(`
      <div class="popup">
        <div class="popup-header">
          <span class="popup-type-icon">${typeIcon}</span>
          <strong>${path.name || 'Chemin sans nom'}</strong>
        </div>
        <span class="popup-status" style="background:${color}">${STATUS_LABELS[path.status] || path.status}</span>
        ${condHTML}
        ${path.notes ? `<p class="popup-notes">${path.notes}</p>` : ''}
      </div>
    `, { maxWidth: 260 });

    group.addTo(map);
    pathLayers[path.id] = group;
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

// Smooth filter panel open/close
document.getElementById('toggleFilters').addEventListener('click', () => {
  document.getElementById('filterPanel').classList.toggle('open');
});

// Close filter panel when clicking outside
document.addEventListener('click', e => {
  const panel = document.getElementById('filterPanel');
  const btn   = document.getElementById('toggleFilters');
  if (panel.classList.contains('open') && !panel.contains(e.target) && !btn.contains(e.target)) {
    panel.classList.remove('open');
  }
});

initUserMenu();
loadPaths();
