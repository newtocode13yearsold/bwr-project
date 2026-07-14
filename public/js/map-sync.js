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

// Reports queue lives in IndexedDB (js/outbox.js), not localStorage, so the
// service worker can replay it via a Background Sync `sync` event while the page
// is closed. Patches stay in localStorage (admin-only, no closed-app replay need).

async function updateMapSyncBanner() {
  const banner = document.getElementById('mapSyncBanner');
  if (!banner) return;
  const reports = await bwrOutbox.count().catch(() => 0);
  const total = getMapPatches().length + reports;
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

async function queueMapReport(data) {
  const count = await bwrOutbox.count().catch(() => 0);
  if (count >= 20) { showToast('⚠️ File hors-ligne pleine (20 signalements max).'); return; }
  // Snapshot the auth header + full URL now: the service worker replays this with
  // no page context, so it can't call authHeader() or read API_URL itself.
  const record = { url: `${API_URL}/api/reports`, auth: authHeader(), payload: data, queuedAt: Date.now() };
  try {
    await bwrOutbox.add(record);
  } catch {
    // Storage full (usually the base64 photo) — retry without the photo.
    record.payload = { ...data, photo: null };
    try { await bwrOutbox.add(record); } catch {}
  }
  requestReportSync();
  updateMapSyncBanner();
}

// Ask the browser to fire a `sync` event (tag 'bwr-sync-reports') as soon as it
// has connectivity — even if the page is closed by then. The SW handler in sw.js
// drains the outbox. Where Background Sync is unavailable (Safari/Firefox), this
// is a no-op and the `online` listener below is the fallback path.
function requestReportSync() {
  if ('serviceWorker' in navigator && 'SyncManager' in self) {
    navigator.serviceWorker.ready
      .then(reg => reg.sync.register('bwr-sync-reports'))
      .catch(() => {});
  }
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

// Page-side replay: the fallback for browsers without Background Sync, and what
// the manual "Synchroniser" button triggers. The SW `sync` handler shares the
// same outbox, so whichever fires first drains it and the other finds it empty.
async function replayMapReports() {
  const records = await bwrOutbox.all().catch(() => []);
  if (records.length === 0) return;
  document.getElementById('mapSyncBanner')?.classList.add('syncing');
  let sent = 0;
  for (const rec of records) {
    try {
      const res = await fetch(rec.url || `${API_URL}/api/reports`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(rec.auth || {}) },
        body: JSON.stringify(rec.payload),
      });
      // Drop on success, or on a permanent client error (retrying won't help).
      if (res.ok || (res.status >= 400 && res.status < 500 && res.status !== 429)) {
        await bwrOutbox.delete(rec._id);
        if (res.ok) sent++;
      }
    } catch { /* offline again — leave it queued */ }
  }
  document.getElementById('mapSyncBanner')?.classList.remove('syncing');
  await updateMapSyncBanner();
  if (sent > 0 && (await bwrOutbox.count().catch(() => 0)) === 0) {
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

// Shared tile-layer switch, driven by both the Filtres radios and the floating
// .layer-btn buttons on the map. Keeps both UIs in sync and gates satellite.
function switchTileLayer(wanted) {
  if (wanted === currentLayer || !TILE_LAYERS[wanted]) { syncLayerControls(); return; }
  // Gate satellite — show upsell instead of switching.
  if (wanted === 'satellite' && !BWR.can('satellite_tiles', _userPlan)) {
    showUpgradeToast('La vue satellite', BWR.requiredTier('satellite_tiles'));
    syncLayerControls();
    return;
  }
  map.removeLayer(TILE_LAYERS[currentLayer]);
  currentLayer = wanted;
  map.setMaxZoom(LAYER_MAX_ZOOM[currentLayer]);
  TILE_LAYERS[currentLayer].addTo(map);
  syncLayerControls();
}

// Reflect currentLayer on both the radios and the floating buttons.
function syncLayerControls() {
  const radio = document.querySelector(`input[name="tileLayer"][value="${currentLayer}"]`);
  if (radio) radio.checked = true;
  document.querySelectorAll('.layer-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.layer === currentLayer);
  });
}

document.querySelectorAll('input[name="tileLayer"]').forEach(radio => {
  radio.addEventListener('change', () => switchTileLayer(radio.value));
});
document.querySelectorAll('.layer-btn').forEach(btn => {
  btn.addEventListener('click', () => switchTileLayer(btn.dataset.layer));
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
  // Deep link from the home-page menu ("Cartes hors-ligne" → map?offline=1):
  // open the zone picker automatically once the map is ready.
  try {
    if (new URLSearchParams(location.search).get('offline') === '1') {
      window.addEventListener('load', () => setTimeout(() => btn.click(), 400));
    }
  } catch {}
})();

// One-time migration of any reports still queued in the old localStorage store
// into IndexedDB, so users mid-upgrade don't lose pending offline reports.
async function migrateLegacyReports() {
  let legacy = [];
  try { legacy = JSON.parse(localStorage.getItem('bwr_map_reports') || '[]'); } catch {}
  if (!legacy.length) return;
  for (const item of legacy) {
    const { queuedAt, ...payload } = item;
    try {
      await bwrOutbox.add({ url: `${API_URL}/api/reports`, auth: authHeader(), payload, queuedAt: queuedAt || Date.now() });
    } catch {}
  }
  localStorage.removeItem('bwr_map_reports');
}

// When the service worker drains the outbox (via a Background Sync `sync` event,
// possibly while this tab was backgrounded), it messages open clients so the
// map refreshes its reports layer and clears the pending banner.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data && e.data.type === 'reports-synced') {
      updateMapSyncBanner();
      if (typeof loadReports === 'function') loadReports();
    }
  });
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────
initUserMenu();
restoreSearchAddress();
loadPaths();
loadReports();
migrateLegacyReports().then(() => {
  if (navigator.onLine) { replayMapPatches(); replayMapReports(); }
  updateMapSyncBanner();
});

const btnMapSync = document.getElementById('btnMapSync');
if (btnMapSync) btnMapSync.addEventListener('click', function () { replayMapPatches(); replayMapReports(); });
