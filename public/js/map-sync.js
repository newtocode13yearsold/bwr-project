// map-sync.js — offline change queue + replay, layer/status filters, the reports
// overlay, the contact modal, the offline-tile download entry point, and the page
// bootstrap for the map page.
// Split out of map.js. Classic script loaded LAST on map.html (after map.js,
// map-paths.js and map-locate.js) so the bootstrap at the bottom can call every
// function those modules define. Everything above the bootstrap only declares
// functions or attaches listeners against already-created globals.

// ── Offline queue (map page) ───────────────────────────────────────────────────
function getMapPatches() {
  try { return JSON.parse(localStorage.getItem('bwr_map_patches') || '[]'); } catch { return []; }
}
function saveMapPatches(q) { localStorage.setItem('bwr_map_patches', JSON.stringify(q)); }

function getMapReports() {
  try { return JSON.parse(localStorage.getItem('bwr_map_reports') || '[]'); } catch { return []; }
}
function saveMapReports(q) { localStorage.setItem('bwr_map_reports', JSON.stringify(q)); }

function updateMapSyncBanner() {
  const banner = document.getElementById('mapSyncBanner');
  if (!banner) return;
  const total = getMapPatches().length + getMapReports().length;
  if (total === 0) { banner.style.display = 'none'; return; }
  banner.style.display = 'flex';
  banner.querySelector('.sync-count').textContent =
    `${total} changement${total > 1 ? 's' : ''} en attente de synchronisation`;
}

function queueMapPatch(pathId, newStatus) {
  const q = getMapPatches();
  const existing = q.findIndex(item => item.id === pathId);
  if (existing !== -1) q[existing].status = newStatus; else q.push({ id: pathId, status: newStatus });
  saveMapPatches(q);
  updateMapSyncBanner();
}

function queueMapReport(data) {
  const q = getMapReports();
  if (q.length >= 20) { showToast('⚠️ File hors-ligne pleine (20 signalements max).'); return; }
  q.push({ ...data, queuedAt: Date.now() });
  try {
    saveMapReports(q);
  } catch {
    // localStorage full — retry without photo
    q[q.length - 1].photo = null;
    try { saveMapReports(q); } catch {}
  }
  updateMapSyncBanner();
}

async function replayMapPatches() {
  const q = getMapPatches();
  if (q.length === 0) return;
  document.getElementById('mapSyncBanner')?.classList.add('syncing');
  let remaining = [];
  for (const item of q) {
    try {
      const res = await fetch(`${API_URL}/api/paths/${item.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...authHeader() },
        body: JSON.stringify({ status: item.status }),
      });
      if (!res.ok) remaining.push(item);
    } catch { remaining.push(item); }
  }
  saveMapPatches(remaining);
  document.getElementById('mapSyncBanner')?.classList.remove('syncing');
  updateMapSyncBanner();
  if (remaining.length === 0 && q.length > 0) {
    showToast('✅ Synchronisation terminée — difficultés envoyées !');
    await loadPaths();
  }
}

async function replayMapReports() {
  const q = getMapReports();
  if (q.length === 0) return;
  document.getElementById('mapSyncBanner')?.classList.add('syncing');
  let remaining = [];
  for (const item of q) {
    try {
      const { queuedAt, ...payload } = item;
      const res = await fetch(`${API_URL}/api/reports`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeader() },
        body: JSON.stringify(payload),
      });
      if (!res.ok) remaining.push(item);
    } catch { remaining.push(item); }
  }
  saveMapReports(remaining);
  document.getElementById('mapSyncBanner')?.classList.remove('syncing');
  updateMapSyncBanner();
  if (remaining.length === 0 && q.length > 0) {
    showToast('✅ Synchronisation terminée — signalements envoyés !');
    loadReports();
  }
}

window.addEventListener('online', async () => {
  await replayMapPatches();
  await replayMapReports();
});

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
    // Gate satellite — show upsell instead of switching.
    if (wanted === 'satellite' && !BWR.can('satellite_tiles', plan)) {
      radio.checked = false;
      document.querySelector(`input[name="tileLayer"][value="${currentLayer}"]`).checked = true;
      showUpgradeToast('La vue satellite', BWR.requiredTier('satellite_tiles'));
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
    if (v === 'satellite' && !BWR.can('satellite_tiles', _userPlan)) {
      const tier = BWR.requiredTier('satellite_tiles');
      label.classList.add('plan-locked');
      label.insertAdjacentHTML('beforeend',
        tier === 'gold' ? ' <span class="tier-tag gold">👑 Or</span>'
                        : ' <span class="tier-tag silver">🔒 Argent</span>');
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

// ── Reports overlay ─────────────────────────────────────────────────────────
async function loadReports() {
  try {
    const res = await fetch(`${API_URL}/api/reports`);
    if (!res.ok) return;
    const reports = await res.json();
    const open = reports.filter(r => r.status === 'open');
    if (!open.length) return;
    await _loadMapEdit();
    open.forEach(r => {
      const path = allPaths.find(p => p.id === r.pathId);
      placeReportMarker(r, path?.coordinates);
    });
  } catch {}
}

// ── Focus trap helper ─────────────────────────────────────────────────────────
function trapFocus(container) {
  const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
  function handler(e) {
    const els = [...container.querySelectorAll(FOCUSABLE)];
    if (!els.length) return;
    const first = els[0], last = els[els.length - 1];
    if (e.key === 'Tab') {
      if (e.shiftKey) { if (document.activeElement === first) { e.preventDefault(); last.focus(); } }
      else            { if (document.activeElement === last)  { e.preventDefault(); first.focus(); } }
    }
  }
  container.addEventListener('keydown', handler);
  return () => container.removeEventListener('keydown', handler);
}

// ── Contact modal ─────────────────────────────────────────────────────────────
const contactModal = document.getElementById('contactModal');
let _contactTrigger = null;
let _contactTrapRelease = null;

function openContactModal() {
  contactModal.classList.remove('hidden');
  const u = getCachedUser();
  if (u) { document.getElementById('mcName').value = u.name; document.getElementById('mcEmail').value = u.email; }
  _contactTrapRelease = trapFocus(contactModal);
  document.getElementById('mcName').focus();
}
function closeContactModal() {
  contactModal.classList.add('hidden');
  if (_contactTrapRelease) { _contactTrapRelease(); _contactTrapRelease = null; }
  if (_contactTrigger) { _contactTrigger.focus(); _contactTrigger = null; }
}

document.getElementById('btnOpenContact').addEventListener('click', e => {
  _contactTrigger = e.currentTarget;
  openContactModal();
});
document.getElementById('btnCloseContact').addEventListener('click', closeContactModal);
contactModal.addEventListener('click', e => { if (e.target === contactModal) closeContactModal(); });
contactModal.addEventListener('keydown', e => { if (e.key === 'Escape') closeContactModal(); });

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
    setTimeout(() => { closeContactModal(); status.textContent = ''; }, 1800);
  } catch { status.textContent = 'Erreur, réessaye.'; status.style.color = '#dc2626'; }
  finally { btn.textContent = 'Envoyer'; btn.disabled = false; }
});

// ── Offline tile download (preset Oise zones) → js/map-offline.js (lazy-loaded) ──
(function initOfflineBtn() {
  const btn = document.getElementById('btnOfflineMaps');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    if (!BWR.can('offline_cache', _userPlan)) {
      showToast('🔒 Cartes hors-ligne disponibles avec Argent — voir plans');
      return;
    }
    document.getElementById('navDrawer')?.classList.add('hidden');
    document.getElementById('navDrawerOverlay')?.classList.add('hidden');
    await _loadMapOffline();
    openOfflineZonePicker();
  });
})();

// ── Bootstrap ─────────────────────────────────────────────────────────────────
initUserMenu();
restoreSearchAddress();
loadPaths();
loadReports();
if (navigator.onLine) { replayMapPatches(); replayMapReports(); }
updateMapSyncBanner();

const btnMapSync = document.getElementById('btnMapSync');
if (btnMapSync) btnMapSync.addEventListener('click', function () { replayMapPatches(); replayMapReports(); });
