let currentUser = null;
let map = null;
let mode = null;
let pathType = 'foot';
let difficulty = 'easy';
let transportMode = 'foot';

// ── Lazy-loader helper ────────────────────────────────────────────────────────
const _scriptCache = {};
function loadScript(src) {
  if (_scriptCache[src]) return _scriptCache[src];
  _scriptCache[src] = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.head.appendChild(s);
  });
  return _scriptCache[src];
}
const _loadElevation  = () => loadScript('js/elevation.js');
const _loadRouteSave  = () => loadScript('js/route-save.js');
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
  initAiPlanner();
  initQuickStart();
  initStep2Collapse();
  if (new URLSearchParams(location.search).has('lat')) {
    handleBestTourParam();
  } else {
    restoreSavedAddress();
    // Smart default: pre-select "Boucle" so the user can place a point and
    // generate immediately — no need to choose a mode first.
    if (!mode) {
      const loopCard = document.querySelector('.mode-card[data-mode="loop"]');
      if (loopCard) loopCard.click();
    }
  }
  loadSavedPaths();
  applyPlanGates();
  updateQuotaStrip();
  initSaveShareButtons();
  initRouteHistory();
  await handleSharedRouteParam();
})();

// ── Quick start — one-tap loop from current location ──────────────────────────
function initQuickStart() {
  const chips = document.getElementById('qsChips');
  const distInput = document.getElementById('distanceInput');

  // Sync the default active chip (8 km) into the distance field on load.
  const activeChip = chips?.querySelector('.qs-chip.active');
  if (activeChip && distInput) distInput.value = activeChip.dataset.km;

  // Distance chips: highlight + mirror into the (hidden) distance input.
  chips?.querySelectorAll('.qs-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      chips.querySelectorAll('.qs-chip').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      if (distInput) distInput.value = chip.dataset.km;
    });
  });

  // Keep the chips in sync if the user edits the advanced distance field.
  distInput?.addEventListener('input', () => {
    chips?.querySelectorAll('.qs-chip').forEach(c =>
      c.classList.toggle('active', c.dataset.km === String(parseFloat(distInput.value))));
  });

  // "Personnaliser" reveals the advanced preferences panel and scrolls to it.
  document.getElementById('qsCustomize')?.addEventListener('click', () => {
    openStep2();
    document.getElementById('step1')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  // The one-tap button: ensure loop mode, geolocate, drop the start point, generate.
  document.getElementById('btnQuickLoop')?.addEventListener('click', quickLoopFromLocation);
}

function quickLoopFromLocation() {
  const btn = document.getElementById('btnQuickLoop');
  if (!navigator.geolocation) {
    showToast('La géolocalisation n\'est pas disponible sur cet appareil.');
    return;
  }
  // Make sure we're in loop mode (unlocks the flow + shows the distance group).
  if (mode !== 'loop') {
    const loopCard = document.querySelector('.mode-card[data-mode="loop"]');
    if (loopCard && !loopCard.classList.contains('locked-feature')) loopCard.click();
  }
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = '⏳ Localisation…';
  navigator.geolocation.getCurrentPosition(
    pos => {
      const { latitude: lat, longitude: lng } = pos.coords;
      map.setView([lat, lng], 15);
      resetPoints();
      pickingPoint = 'start';
      onMapClick({ latlng: { lat, lng } });   // places start marker + enables generate
      btn.disabled = false;
      btn.textContent = original;
      const gen = document.getElementById('btnGenerate');
      if (gen && !gen.disabled) gen.click();    // generate immediately
    },
    () => {
      btn.disabled = false;
      btn.textContent = original;
      showToast('Position introuvable — autorise la localisation ou clique sur la carte.');
    },
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 }
  );
}

// ── ✨ AI planner — natural language → planner controls → auto-generate ────────
function initAiPlanner() {
  const input = document.getElementById('aiInput');
  const submit = document.getElementById('aiSubmit');
  if (!input || !submit) return;

  const run = () => runAiPlan(input.value.trim());
  submit.addEventListener('click', run);
  input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); run(); } });
  document.querySelectorAll('#aiChips .ai-chip').forEach(chip =>
    chip.addEventListener('click', () => { input.value = chip.dataset.q; run(); }));
}

function setAiFeedback(kind, html) {
  const fb = document.getElementById('aiFeedback');
  if (!fb) return;
  fb.className = `ai-feedback ai-feedback-${kind}`;
  fb.innerHTML = html;
  fb.classList.remove('hidden');
}

async function runAiPlan(text) {
  if (!text || text.length < 3) {
    setAiFeedback('error', 'Décris ta balade en quelques mots.');
    return;
  }
  const submit = document.getElementById('aiSubmit');
  submit.disabled = true;
  submit.classList.add('loading');
  setAiFeedback('loading', '🧠 Je réfléchis à ton trajet…');

  let intent;
  try {
    const res = await fetchWithTimeout(`${API_URL}/api/ai-plan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeader() },
      body: JSON.stringify({ text }),
    }, 30000);
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.plan) {
      setAiFeedback('error', data.error || 'Petit souci de mon côté, réessaie dans un instant.');
      return;
    }
    // Off-topic / unclear request: the assistant replies conversationally
    // instead of forcing a route. Show its message and stop here.
    if (data.understood === false) {
      setAiFeedback('info', data.reply || 'Dis-moi plutôt la distance ou l\'ambiance de balade que tu cherches 🌲');
      return;
    }
    intent = data.plan;
    intent.reply = data.reply || null;
  } catch {
    setAiFeedback('error', 'Pas de connexion — vérifie ta connexion et réessaie.');
    return;
  } finally {
    submit.disabled = false;
    submit.classList.remove('loading');
  }

  await applyAiIntent(intent);
}

// Resolve a free-text place name to coordinates: first try the named forest
// junctions (instant, offline), then fall back to Nominatim geocoding bounded to
// the Compiègne forest. Returns { lat, lng } or null.
async function resolvePlace(name) {
  if (!name) return null;
  const norm = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ');
  const qTokens = norm(name).split(/\s+/).filter(t => t.length > 2 && !['les', 'des', 'carrefour', 'etang', 'etangs'].includes(t));

  // 1. Fuzzy match against named carrefours (require ≥2 distinctive token hits).
  if (typeof CARREFOURS !== 'undefined' && qTokens.length) {
    let best = null, bestScore = 0;
    for (const c of CARREFOURS) {
      const cn = norm(c.name);
      const score = qTokens.filter(t => cn.includes(t)).length;
      if (score > bestScore) { bestScore = score; best = c; }
    }
    if (best && bestScore >= 2) return { lat: best.lat, lng: best.lon };
  }

  // 2. Nominatim, biased to the forest bounding box.
  const bbox = '2.70,49.50,3.05,49.28'; // left,top,right,bottom
  const tryGeocode = async (q, bounded) => {
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}`
      + `&format=json&limit=1&countrycodes=fr&viewbox=${bbox}${bounded ? '&bounded=1' : ''}`;
    const res = await fetch(url, { headers: { 'Accept-Language': 'fr' } });
    const d = await res.json();
    return d[0] ? { lat: parseFloat(d[0].lat), lng: parseFloat(d[0].lon) } : null;
  };
  try {
    return (await tryGeocode(`${name}, Forêt de Compiègne`, true))
        || (await tryGeocode(`${name}, Compiègne`, false));
  } catch {
    return null;
  }
}

// Drive the existing planner controls from the AI intent, then auto-generate.
async function applyAiIntent(intent) {
  const wantMode = intent.mode === 'atob' ? 'atob' : 'loop';

  // 1. Mode — clicking the card unlocks the steps and sets pickingPoint = 'start'.
  const card = document.querySelector(`.mode-card[data-mode="${wantMode}"]`);
  if (card && !card.classList.contains('locked-feature')) card.click();

  // 2. Preferences (each click updates the matching state variable).
  if (intent.pathType)  document.querySelector(`.pathtype-btn[data-type="${intent.pathType}"]`)?.click();
  if (intent.difficulty) document.querySelector(`.diff-btn[data-diff="${intent.difficulty}"]`)?.click();
  if (intent.transport)  document.querySelector(`.diff-btn[data-transport="${intent.transport}"]`)?.click();

  // 3. Distance (loop only).
  if (wantMode === 'loop' && intent.distanceKm) {
    const di = document.getElementById('distanceInput');
    if (di) { di.value = Math.min(100, Math.max(1, intent.distanceKm)); di.dispatchEvent(new Event('input')); }
  }

  // 4. Resolve and drop the start point.
  setAiFeedback('loading', '📍 Je localise ' + (intent.startPlace || 'le départ') + '…');
  let start = await resolvePlace(intent.startPlace);
  let placeNote = '';
  if (!start) {
    start = { lat: MAP_CENTER[0], lng: MAP_CENTER[1] };
    if (intent.startPlace) placeNote = ` (lieu introuvable — point placé au centre, ajuste-le)`;
  }

  resetPoints();
  pickingPoint = 'start';
  map.setView([start.lat, start.lng], 14);
  onMapClick({ latlng: { lat: start.lat, lng: start.lng } });

  // 5. A→B: resolve and place the arrival point too.
  if (wantMode === 'atob') {
    const end = await resolvePlace(intent.endPlace);
    if (end) {
      pickingPoint = 'end';
      onMapClick({ latlng: { lat: end.lat, lng: end.lng } });
    }
  }

  setAiFeedback('ok', `✓ ${intent.reply || intent.summary}${placeNote}`);

  // 6. Generate — reuses the full three-tier routing engine + quota gate.
  const gen = document.getElementById('btnGenerate');
  if (gen && !gen.disabled) gen.click();
}

// ── Step 2 (Préférences) collapse toggle ──────────────────────────────────────
function openStep2() {
  const step2 = document.getElementById('step2');
  if (!step2) return;
  step2.classList.remove('collapsed');
  document.getElementById('step2Header')?.setAttribute('aria-expanded', 'true');
}
function initStep2Collapse() {
  const header = document.getElementById('step2Header');
  const step2 = document.getElementById('step2');
  if (!header || !step2) return;
  const toggle = () => {
    const collapsed = step2.classList.toggle('collapsed');
    header.setAttribute('aria-expanded', String(!collapsed));
  };
  header.addEventListener('click', toggle);
  header.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
  });
}

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
      <a href="plans" class="um-cta">Voir le plan ${planLabel} →</a>
      <button class="um-secondary">Plus tard</button>
    </div>
  `;
  document.body.appendChild(m);
  const closeUpgrade = () => { document.removeEventListener('keydown', onKeyUpgrade); m.remove(); };
  const onKeyUpgrade = e => { if (e.key === 'Escape') closeUpgrade(); };
  document.addEventListener('keydown', onKeyUpgrade);
  m.querySelector('.um-close').onclick    = closeUpgrade;
  m.querySelector('.um-secondary').onclick = closeUpgrade;
  m.addEventListener('click', e => { if (e.target === m) closeUpgrade(); });
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
  const count = stats.weekStart === BWR.isoMonday() ? (stats.weeklyRoutes || 0) : 0;
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
      <a href="plans" class="qs-cta">Illimité avec Argent →</a>
    </div>
  `;
}

function initUserMenu() {
  const menuEl = document.getElementById('userMenu');
  const initials = currentUser.name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);
  menuEl.innerHTML = `
    <button class="user-btn" id="userBtn">
      <div class="user-avatar">${initials}</div>
      <span class="btn-label">${currentUser.name.split(' ')[0]}</span>
    </button>
    <div class="user-dropdown hidden" id="userDropdown">
      <span class="dropdown-name">${currentUser.name}</span>
      <a href="/">🏠 Accueil</a>
      <a href="map">🗺 Voir la carte</a>
      <a href="profile">👤 Mon profil</a>
      ${currentUser.role === 'admin' ? '<a href="admin">⚙️ Admin</a>' : ''}
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
    // maxNativeZoom 15 + crossOrigin: must mirror the map page (js/map.js) so the
    // offline-downloaded forest tiles (cached z10–15, CORS/non-opaque) cover this
    // page too. Without the cap, zooming past 15 requests uncached z16/17 tiles
    // and the route planner goes blank offline.
    { attribution: 'Map data: &copy; OpenStreetMap contributors, SRTM | Style: &copy; OpenTopoMap', maxNativeZoom: 15, maxZoom: 17, subdomains: ['a','b','c'], crossOrigin: true }
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
  if (typeof addForestBoundaries === 'function') addForestBoundaries(map);

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
  // Persist whatever is typed so the address stays "locked in" across pages,
  // even before the user picks a suggestion. Shared with the map page.
  if (q) localStorage.setItem('bwr_saved_address', JSON.stringify({ label: e.target.value }));
  else localStorage.removeItem('bwr_saved_address');
  if (q.length < 3) {
    hideSearch();
    return;
  }
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
      const label = item.textContent.trim();
      map.setView([lat, lng], 15);
      document.getElementById('addressInput').value = label;
      localStorage.setItem('bwr_saved_address', JSON.stringify({ label, lat, lng }));
      hideSearch();
      if (mode) onMapClick({ latlng: { lat, lng } });
    });
  });
}

function hideSearch() {
  document.getElementById('searchResults').classList.add('hidden');
}

function restoreSavedAddress() {
  try {
    const saved = JSON.parse(localStorage.getItem('bwr_saved_address'));
    if (!saved || !saved.label) return;
    const savedMode = localStorage.getItem('bwr_saved_mode');
    if (savedMode) {
      const card = document.querySelector(`.mode-card[data-mode="${savedMode}"]`);
      if (card && !card.classList.contains('locked-feature')) card.click();
    }
    document.getElementById('addressInput').value = saved.label;
    // Only recentre when we have real coordinates (a typed-but-not-selected
    // address has just a label).
    if (typeof saved.lat === 'number' && typeof saved.lng === 'number') {
      map.setView([saved.lat, saved.lng], 15);
    }
  } catch (_) {}
}

async function loadSavedPaths() {
  try {
    const res = await fetch(`${API_URL}/api/paths`);
    const data = await res.json();
    // Offline with nothing cached yet returns {error:"offline"}, not an array.
    savedPaths = Array.isArray(data) ? data : [];
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
    localStorage.setItem('bwr_saved_mode', mode);

    document.getElementById('distanceGroup').style.display = mode === 'loop' ? '' : 'none';
    // "Priorité" (Forestier / Plus court) only affects A→B routing — a fixed-distance
    // loop has no "shortest" variant — so hide it in loop mode to avoid a dead control.
    document.getElementById('priorityGroup').style.display = mode === 'loop' ? 'none' : '';

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
    // Keep the travel mode (and therefore the time estimate) consistent with the
    // path type: a cycle path implies riding, walking paths imply walking. The
    // user can still override afterwards with the "Mode de déplacement" buttons.
    syncTransportToPathType(pathType);
  });
});

// Set transportMode from the chosen path type and reflect it on the
// "Mode de déplacement" buttons, so picking "Cyclable" updates the time too.
function syncTransportToPathType(type) {
  const desired = type === 'bike' ? 'bike' : 'foot';
  if (desired === transportMode) return;
  transportMode = desired;
  document.querySelectorAll('.diff-btn[data-transport]').forEach(b =>
    b.classList.toggle('active', b.dataset.transport === desired));
}

document.querySelectorAll('.diff-btn[data-diff]').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.diff-btn[data-diff]').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    difficulty = btn.dataset.diff;
  });
});

document.querySelectorAll('.diff-btn[data-transport]').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.diff-btn[data-transport]').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    transportMode = btn.dataset.transport;
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
    // One retry tolerates a genuine transient blip; after that we fail CLOSED.
    // Failing open here is an easy bypass (block this request → unlimited routes),
    // and only free-tier users ever reach this branch, so blocking is the safe default.
    let qData = null;
    for (let attempt = 0; attempt < 2 && !qData; attempt++) {
      try {
        const qRes = await fetchWithTimeout(`${API_URL}/api/auth/consume-route`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeader() },
          body: JSON.stringify({ mode }),
        }, 8000);
        const body = await qRes.json().catch(() => ({}));
        qData = { ...body, ok: qRes.ok && body.ok === true };
      } catch {
        qData = null; // retry once
      }
    }

    if (!qData) {
      showToast('Impossible de vérifier ton quota hebdomadaire. Vérifie ta connexion et réessaie.');
      btn.textContent = 'Calculer le trajet';
      btn.classList.remove('loading');
      btn.disabled = false;
      return;
    }
    if (!qData.ok) {
      if (qData.reason === 'loop') {
        showLoopQuotaModal({ used: qData.used ?? 3, limit: qData.limit ?? 3 });
      } else {
        showQuotaExceededModal({ used: qData.used ?? 10, limit: qData.limit ?? 10 });
      }
      btn.textContent = 'Calculer le trajet';
      btn.classList.remove('loading');
      btn.disabled = false;
      return;
    }
    // Reflect the server's authoritative count locally so the strip is accurate
    if (currentUser.stats) {
      currentUser.stats.weeklyRoutes = qData.used;
      currentUser.stats.weekStart = BWR.isoMonday();
    }
    updateQuotaStrip();
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
    const isNetworkErr = err.name === 'AbortError' || err.name === 'TypeError' || err.message === 'Failed to fetch';
    if (isNetworkErr) {
      showToast('Pas de connexion — vérifie ta connexion et réessaie.');
    }
    const msg = isNetworkErr ? 'Pas de connexion' : err.message;
    btn.textContent = 'Erreur: ' + msg;
    btn.classList.remove('loading');
    setTimeout(() => { btn.textContent = 'Calculer le trajet'; btn.disabled = false; }, 5000);
    return;
  }

  // Increment route count only — km are tracked via real GPS (see GpsTracker)
  const prevCount = parseInt(localStorage.getItem('bwr_route_count') || '0');
  localStorage.setItem('bwr_route_count', prevCount + 1);
  if (getToken()) {
    fetch(`${API_URL}/api/auth/stats`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeader() },
      body: JSON.stringify({ routes: 1, km: 0 }),
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
  return transportMode === 'bike' ? 'cycling-mountain' : 'foot-hiking';
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
function osrmProfile() { return transportMode === 'bike' ? 'cycling' : 'foot'; }

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

function osrmLoopWaypoints(sLat, sLng, radiusKm, rotationDeg = 0) {
  const rLat = radiusKm / 111;
  const rLng = radiusKm / (111 * Math.cos(sLat * Math.PI / 180));
  const ring = [0, 45, 90, 135, 180, 225, 270, 315].map(deg => {
    const rad = (deg + rotationDeg) * Math.PI / 180;
    return { lat: +(sLat + rLat * Math.cos(rad)).toFixed(6), lon: +(sLng + rLng * Math.sin(rad)).toFixed(6) };
  });
  return [{ lat: sLat, lon: sLng }, ...ring];
}

async function osrmLoopWithRetry(sLat, sLng, targetKm, seed = 0) {
  // Rotate the compass ring by a per-day angle so the loop shape changes daily.
  const rotationDeg = (seed % 8) * 45;
  let r = targetKm / (2 * Math.PI), result;
  for (let i = 0; i < 3; i++) {
    result = await osrmTrip(osrmLoopWaypoints(sLat, sLng, r, rotationDeg));
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

// Client-side OSM bbox cache — avoids re-fetching the same area within a session.
// Server already caches 7 days in KV; this cuts even that round-trip for repeated calls.
const _osmPathCache = new Map();

async function fetchOsmPathsForBbox(minLat, minLng, maxLat, maxLng) {
  const bbox = `${minLat.toFixed(4)},${minLng.toFixed(4)},${maxLat.toFixed(4)},${maxLng.toFixed(4)}`;
  if (_osmPathCache.has(bbox)) return _osmPathCache.get(bbox);
  try {
    // Generous timeout: the worker may retry a flaky Overpass instance. A late
    // success is still cached server-side, making the user's next attempt instant.
    const res = await fetchWithTimeout(`${API_URL}/api/osm?bbox=${bbox}`, {}, 35000);
    if (!res.ok) { console.warn('OSM bbox fetch failed:', res.status); return []; }
    const data = await res.json();
    if (!Array.isArray(data?.elements)) { console.warn('OSM response malformed'); return []; }
    const paths = osmDataToCoordPaths(data);
    // Evict oldest entry to bound memory usage
    if (_osmPathCache.size >= 5) _osmPathCache.delete(_osmPathCache.keys().next().value);
    _osmPathCache.set(bbox, paths);
    return paths;
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
        const r = graphAtob(sLat, sLng, eLat, eLng, applyOsmSurfaceWeights(osmPaths), transportMode);
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

  // Forest mode: route over ALL paths on the map. The OSM forest-path network
  // (path/track/footway/bridleway/cycleway) plus the admin paths are merged into one
  // stitched graph (see buildGraph), so the router can use every path and transfer
  // between networks wherever they cross — no more being trapped on the admin network.
  const straightM = haversineM(sLat, sLng, eLat, eLng);
  const pad = 0.05;
  const osmPaths = await fetchOsmPathsForBbox(
    Math.min(sLat, eLat) - pad, Math.min(sLng, eLng) - pad,
    Math.max(sLat, eLat) + pad, Math.max(sLng, eLng) + pad,
  );
  const weightedOsmPaths = applyOsmSurfaceWeights(osmPaths);
  const admin = savedPaths.length ? filterPaths(savedPaths) : [];

  // 1. Combined admin + OSM graph (admin mildly preferred). Also compute the OSM-only
  //    route and keep whichever is shorter — guards against any residual admin detour.
  if (weightedOsmPaths.length || admin.length) {
    let best = null;
    try {
      const hybrid = graphAtobHybrid(sLat, sLng, eLat, eLng, admin, weightedOsmPaths, transportMode);
      if (hybrid.meters <= straightM * 4) best = hybrid;
    } catch (e) { console.warn('graph hybrid:', e.message); }
    if (weightedOsmPaths.length) {
      try {
        const osmOnly = graphAtob(sLat, sLng, eLat, eLng, weightedOsmPaths, transportMode);
        if (osmOnly.meters <= straightM * 4 && (!best || osmOnly.meters < best.meters)) best = osmOnly;
      } catch (e) { console.warn('OSM graph:', e.message); }
    }
    if (best) { console.info(`routing: forest graph (${(best.meters / 1000).toFixed(1)} km)`); return best; }
  }
  // 2. ORS (needs ORS_KEY in Cloudflare)
  try {
    return await callORS({ profile: orsProfile(), coordinates: [[sLng, sLat], [eLng, eLat]] });
  } catch (e) { console.warn('ORS:', e.message); }
  // 3. OSRM — last resort, uses all roads and paths
  return osrmRoute([{ lat: sLat, lon: sLng }, { lat: eLat, lon: eLng }]);
}

// A small integer that changes once per day (and per start point), so the same
// start point produces a different boucle from one day to the next. Stable
// within a given day so a refresh shows the same loop.
function dailyLoopSeed(sLat, sLng) {
  const day = new Date().toISOString().slice(0, 10); // YYYY-MM-DD, local-day granularity
  const key = `${day}|${sLat.toFixed(4)}|${sLng.toFixed(4)}`;
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0;
  return Math.abs(h) % 100000 + 1; // never 0 (0 = deterministic mode)
}

async function routeLoop(sLat, sLng, targetKm) {
  const seed = dailyLoopSeed(sLat, sLng);
  // 1. Hybrid graph router — real loop. Admin paths are the primary network and
  //    OSM (unnoted) paths fill gaps, so the loop continues past the edge of the
  //    curated network instead of stopping where noted paths run out.
  try {
    const admin = filterPaths(savedPaths);
    // bbox roughly covers the loop's reach around the start point (radius ≈ half the target)
    const radiusKm = Math.max(targetKm / 2, 1);
    const padLat = radiusKm / 111;
    const padLng = radiusKm / (111 * Math.cos(sLat * Math.PI / 180));
    const osmPaths = applyOsmSurfaceWeights(
      await fetchOsmPathsForBbox(sLat - padLat, sLng - padLng, sLat + padLat, sLng + padLng),
    );
    if (admin.length || osmPaths.length) {
      // seed rotates the turnaround direction each day → a fresh loop daily
      return graphLoopHybrid(sLat, sLng, targetKm, admin, osmPaths, transportMode, seed);
    }
  } catch (e) { console.warn('graph loop hybrid:', e.message); }
  // 2. ORS round_trip (needs ORS_KEY) — vary the seed daily so the shape changes
  try {
    return await callORS({
      profile: orsProfile(),
      coordinates: [[sLng, sLat]],
      round_trip: { length: Math.round(targetKm * 1000), points: 5, seed },
    });
  } catch (e) { console.warn('ORS:', e.message); }
  // 3. OSRM trip — always works; rotate its waypoint ring by the daily seed
  return osrmLoopWithRetry(sLat, sLng, targetKm, seed);
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
  document.querySelector('#statDuration + small').textContent =
    transportMode === 'bike' ? 'Durée estimée (vélo)' : 'Durée estimée (à pied)';

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

  // Elevation profile — only for Silver+ (lazy-loaded)
  if (BWR.can('elevation_profile', plan)) {
    _loadElevation()
      .then(() => fetchElevation(coords))
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
          <a href="plans" class="el-cta">Débloquer avec Argent →</a>
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
          <span>10 trajets / semaine</span>
        </div>
        <div class="qm-arrow">→</div>
        <div class="qm-tier qm-silver">
          <strong>🥈 Argent</strong>
          <span>Illimité · 2,99€/mois</span>
        </div>
      </div>
      <p class="qm-perks">+ Boucles illimitées, profil altimétrique, export GPX, cartes hors-ligne…</p>
      <a href="plans" class="um-cta">Passer à Argent</a>
      <button class="um-secondary">Revenir lundi</button>
    </div>
  `;
  document.body.appendChild(m);
  const closeQuota = () => { document.removeEventListener('keydown', onKeyQuota); m.remove(); };
  const onKeyQuota = e => { if (e.key === 'Escape') closeQuota(); };
  document.addEventListener('keydown', onKeyQuota);
  m.querySelector('.um-close').onclick    = closeQuota;
  m.querySelector('.um-secondary').onclick = closeQuota;
  m.addEventListener('click', e => { if (e.target === m) closeQuota(); });
}

// Free users get a small weekly allowance of loop routes; A→B stays bounded only
// by the 10-routes/week quota. Shown when the loop sub-quota is exhausted.
function showLoopQuotaModal(quota) {
  const existing = document.getElementById('quotaModal');
  if (existing) existing.remove();
  const m = document.createElement('div');
  m.id = 'quotaModal';
  m.className = 'upgrade-modal-overlay';
  m.innerHTML = `
    <div class="upgrade-modal-card quota-card">
      <button class="um-close" aria-label="Fermer">×</button>
      <div class="um-icon">🔄</div>
      <h3>Vous avez utilisé vos boucles gratuites</h3>
      <p><strong>${quota.used} / ${quota.limit}</strong> boucles utilisées cette semaine.</p>
      <div class="qm-comparison">
        <div class="qm-tier qm-free">
          <strong>🌿 Gratuit</strong>
          <span>${quota.limit} boucles / semaine</span>
        </div>
        <div class="qm-arrow">→</div>
        <div class="qm-tier qm-silver">
          <strong>🥈 Argent</strong>
          <span>Boucles illimitées · 2,99€/mois</span>
        </div>
      </div>
      <p class="qm-perks">Les trajets A → B restent disponibles. + profil altimétrique, export GPX, cartes hors-ligne…</p>
      <a href="plans" class="um-cta">Passer à Argent</a>
      <button class="um-secondary">Revenir lundi</button>
    </div>
  `;
  document.body.appendChild(m);
  const closeQuota = () => { document.removeEventListener('keydown', onKeyQuota); m.remove(); };
  const onKeyQuota = e => { if (e.key === 'Escape') closeQuota(); };
  document.addEventListener('keydown', onKeyQuota);
  m.querySelector('.um-close').onclick     = closeQuota;
  m.querySelector('.um-secondary').onclick = closeQuota;
  m.addEventListener('click', e => { if (e.target === m) closeQuota(); });
}

// ── Elevation profile → js/elevation.js (lazy-loaded) ────────────────────────

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
    btnSave.onclick  = () => showUpgradeModal('silver', 'La sauvegarde de trajets');
    btnShare.onclick = () => showUpgradeModal('silver', 'Le partage de trajets');
    return;
  }

  // Lazy-load route-save.js on first click
  btnSave.onclick  = async () => { await _loadRouteSave(); saveCurrentRoute(); };
  btnShare.onclick = async () => { await _loadRouteSave(); shareCurrentRoute(); };
}

// ── Save / share / history → js/route-save.js (lazy-loaded) ──────────────────

function initRouteHistory() {
  const plan = currentUser?.plan || 'free';
  const panelEl = document.getElementById('routeHistory');
  if (!panelEl) return;

  const lazyToggle = async () => { await _loadRouteSave(); toggleHistory(); };

  if (!BWR.can('route_history', plan)) {
    panelEl.classList.remove('hidden');
    const body = document.getElementById('historyBody');
    body.style.display = 'none';
    body.innerHTML = `
      <div class="history-empty">
        <p>🔒 Sauvegardez vos trajets avec le plan Argent.</p>
        <a href="plans" style="color:#6d28d9;font-weight:700">Voir les plans →</a>
      </div>`;
    document.getElementById('historyToggle').addEventListener('click', lazyToggle);
    return;
  }

  panelEl.classList.remove('hidden');
  document.getElementById('historyBody').style.display = 'none';
  document.getElementById('historyToggle').addEventListener('click', lazyToggle);
}

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Best tour deep-link (?lat=&lng=&distance=&mode=&type=&diff=) ──────────────
function handleBestTourParam() {
  const params = new URLSearchParams(location.search);
  const lat = parseFloat(params.get('lat'));
  const lng = parseFloat(params.get('lng'));
  if (!lat || !lng) return;

  const targetMode = params.get('mode') || 'loop';
  const targetType = params.get('type') || 'foot';
  const targetDiff = params.get('diff') || 'easy';
  const targetDist = parseFloat(params.get('distance')) || 10;

  // Select mode
  const modeCard = document.querySelector(`.mode-card[data-mode="${targetMode}"]`);
  if (modeCard && !modeCard.classList.contains('locked-feature')) modeCard.click();

  // Select path type
  const typeBtn = document.querySelector(`.pathtype-btn[data-type="${targetType}"]`);
  if (typeBtn) {
    document.querySelectorAll('.pathtype-btn').forEach(b => b.classList.remove('active'));
    typeBtn.classList.add('active');
    pathType = targetType;
    syncTransportToPathType(pathType);
  }

  // Select difficulty
  const diffBtn = document.querySelector(`.diff-btn[data-diff="${targetDiff}"]`);
  if (diffBtn) {
    document.querySelectorAll('.diff-btn[data-diff]').forEach(b => b.classList.remove('active'));
    diffBtn.classList.add('active');
    difficulty = targetDiff;
  }

  // Set distance
  if (targetMode === 'loop') {
    const distInput = document.getElementById('distanceInput');
    if (distInput) distInput.value = targetDist;
  }

  // Pan map, place start marker, then auto-generate
  map.setView([lat, lng], 14);
  setTimeout(() => {
    onMapClick({ latlng: { lat, lng } });
    setTimeout(() => {
      const btnGen = document.getElementById('btnGenerate');
      if (btnGen && !btnGen.disabled) btnGen.click();
    }, 500);
  }, 400);
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

// ── GPS Tracker — real distance counting ──────────────────────────────────────
// km are counted only from actual GPS movement (watchPosition), not from
// generated route length. Filters out GPS noise via accuracy, min-move,
// and max-speed thresholds.
const GpsTracker = (() => {
  const MIN_ACCURACY_M = 25;   // discard fixes with accuracy worse than 25 m
  const MIN_MOVE_KM    = 0.005; // 5 m minimum displacement — filters GPS jitter
  const MAX_SPEED_KMH  = 22;   // max realistic walking/biking speed; discards jumps

  let watchId    = null;
  let lastPos    = null;
  let sessionKm  = 0;
  let active     = false;
  let userMarker = null;

  function haversine(lat1, lng1, lat2, lng2) {
    const R    = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a    = Math.sin(dLat / 2) ** 2
               + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180)
               * Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  function onPosition(pos) {
    const { latitude, longitude, accuracy } = pos.coords;
    if (accuracy > MIN_ACCURACY_M) {
      setAccuracyLabel(`GPS faible (±${Math.round(accuracy)} m) — en attente…`);
      return;
    }
    setAccuracyLabel(`Précision GPS : ±${Math.round(accuracy)} m`);

    // Update map marker
    if (map) {
      if (!userMarker) {
        userMarker = L.circleMarker([latitude, longitude], {
          radius: 7, color: '#2563eb', fillColor: '#3b82f6',
          fillOpacity: 0.9, weight: 2,
        }).addTo(map).bindTooltip('📍 Vous êtes ici', { permanent: false });
      } else {
        userMarker.setLatLng([latitude, longitude]);
      }
    }

    if (!lastPos) {
      lastPos = { lat: latitude, lng: longitude, t: pos.timestamp };
      return;
    }

    const dtH  = (pos.timestamp - lastPos.t) / 3_600_000;
    const dist = haversine(lastPos.lat, lastPos.lng, latitude, longitude);
    const kmh  = dtH > 0 ? dist / dtH : 0;

    if (dist >= MIN_MOVE_KM && kmh <= MAX_SPEED_KMH) {
      sessionKm += dist;
      const el = document.getElementById('trackerKm');
      if (el) el.textContent = sessionKm.toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' km';
    }
    lastPos = { lat: latitude, lng: longitude, t: pos.timestamp };
  }

  function setAccuracyLabel(text) {
    const el = document.getElementById('trackerAccuracy');
    if (el) el.textContent = text;
  }

  function start() {
    if (!navigator.geolocation) {
      showToast('La géolocalisation n\'est pas disponible sur cet appareil.');
      return;
    }
    if (active) return;
    sessionKm = 0;
    lastPos   = null;
    active    = true;

    const liveEl = document.getElementById('gpsTrackerLive');
    const btn    = document.getElementById('btnTracker');
    const kmEl   = document.getElementById('trackerKm');
    if (liveEl) liveEl.classList.remove('hidden');
    if (btn)    { btn.textContent = '⏹ Terminer la balade'; btn.classList.add('tracking'); }
    if (kmEl)   kmEl.textContent = '0,00 km';
    setAccuracyLabel('Acquisition du signal GPS…');

    watchId = navigator.geolocation.watchPosition(
      onPosition,
      err => {
        const msgs = { 1: 'Permission refusée', 2: 'Signal GPS indisponible', 3: 'Délai dépassé' };
        setAccuracyLabel(msgs[err.code] || 'Erreur GPS');
      },
      { enableHighAccuracy: true, maximumAge: 4000, timeout: 15000 }
    );
  }

  function stop() {
    if (!active) return;
    if (watchId !== null) { navigator.geolocation.clearWatch(watchId); watchId = null; }
    active = false;

    if (userMarker && map) { map.removeLayer(userMarker); userMarker = null; }

    const liveEl = document.getElementById('gpsTrackerLive');
    const btn    = document.getElementById('btnTracker');
    if (liveEl) liveEl.classList.add('hidden');
    if (btn)    { btn.textContent = '▶ Démarrer ma balade'; btn.classList.remove('tracking'); }
    setAccuracyLabel('');

    if (sessionKm >= 0.05) {
      const prev = parseFloat(localStorage.getItem('bwr_km_total') || '0');
      localStorage.setItem('bwr_km_total', (prev + sessionKm).toFixed(2));
      if (getToken()) {
        fetch(`${API_URL}/api/auth/stats`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeader() },
          body: JSON.stringify({ routes: 0, km: parseFloat(sessionKm.toFixed(2)) }),
        }).catch(() => {});
      }
      const kmFmt = sessionKm.toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      showToast(`✅ ${kmFmt} km ajoutés à ton total !`);
    } else {
      showToast('Balade trop courte — moins de 50 m enregistrés.');
    }
  }

  return { start, stop, isActive: () => active };
})();

document.getElementById('btnTracker')?.addEventListener('click', () => {
  if (GpsTracker.isActive()) GpsTracker.stop();
  else GpsTracker.start();
});

// Offline pill — lightweight non-blocking indicator only
(function () {
  var pill = document.getElementById('offline-pill');
  if (!pill) return;
  function update() { pill.classList.toggle('visible', !navigator.onLine); }
  window.addEventListener('online',  update);
  window.addEventListener('offline', update);
  update();
})();
