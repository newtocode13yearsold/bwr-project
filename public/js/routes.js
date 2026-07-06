// routes.js — entry file for the route planner page.
// This file owns the shared `let` state, the lazy-loader helper, the boot IIFE
// and small shared helpers (toast / escapeHtml / lock / unlock / GpsTracker).
// It is loaded LAST on routes.html (after routes-engine.js, routes-map.js and
// routes-planner.js) so that by the time the boot IIFE runs every function those
// modules define is already available. The extracted modules reference the shared
// state below only inside function bodies (call time), so there is no TDZ risk.

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
  currentUser = await requireAuth(null, 'Le planificateur nécessite un compte gratuit.');
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

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
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
