const TILE_LAYERS = {
  ign: L.tileLayer(
    'https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=GEOGRAPHICALGRIDSYSTEMS.MAPS&STYLE=normal&FORMAT=image/jpeg&TILEMATRIXSET=PM&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}',
    { attribution: '&copy; <a href="https://www.geoportail.gouv.fr/">IGN</a>', maxZoom: 18 }
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

    const line = L.polyline(path.coordinates, {
      color: STATUS_COLORS[path.status] || '#9ca3af',
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

initUserMenu();
loadPaths();
