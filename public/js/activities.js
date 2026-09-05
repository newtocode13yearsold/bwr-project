// ── Mes sorties — hike journal (recorded activities) ──────────────────────────
// Lists the walks the user recorded with the GPS tracker (POST /api/activities
// from gps-tracker.js), lets them rename / delete / export GPX, and replays a
// track on an inline Leaflet map with a play/scrub control.
// Moved out of an inline <script>: the site CSP is `script-src 'self'`.
(function () {
  'use strict';

  const root = document.getElementById('actRoot');
  if (!root) return;

  // ── helpers ────────────────────────────────────────────────────────────────
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const fmtKm = (m) => (m / 1000).toLocaleString('fr-FR', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + ' km';

  function fmtDuration(s) {
    s = Math.max(0, Math.round(s));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
    if (h > 0) return `${h} h ${String(m).padStart(2, '0')}`;
    if (m > 0) return `${m} min`;
    return `${s} s`;
  }

  function fmtDate(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  }

  // Average pace (min/km), only meaningful for walking/running distances.
  function fmtPace(meters, seconds) {
    if (!meters || !seconds) return '—';
    const paceSecPerKm = seconds / (meters / 1000);
    const m = Math.floor(paceSecPerKm / 60), s = Math.round(paceSecPerKm % 60);
    return `${m}′${String(s).padStart(2, '0')}″/km`;
  }

  let activities = [];

  // ── rendering ────────────────────────────────────────────────────────────────
  function renderEmpty() {
    root.innerHTML = `
      <div class="act-empty">
        <h2>Aucune sortie enregistrée pour l'instant</h2>
        <p>Ouvrez la <a href="map">carte</a>, appuyez sur <b>▶ Suivi GPS</b> et partez marcher.<br>
        À la fin, gardez votre balade ici — distance, durée, dénivelé et tracé, tout est sauvegardé.</p>
      </div>`;
  }

  function summaryStrip() {
    const totalM = activities.reduce((a, x) => a + (x.meters || 0), 0);
    const totalS = activities.reduce((a, x) => a + (x.seconds || 0), 0);
    return `
      <div class="act-summary">
        <div class="act-sum-card"><div class="act-sum-val">${activities.length}</div><div class="act-sum-lbl">Sorties</div></div>
        <div class="act-sum-card"><div class="act-sum-val">${fmtKm(totalM)}</div><div class="act-sum-lbl">Distance totale</div></div>
        <div class="act-sum-card"><div class="act-sum-val">${fmtDuration(totalS)}</div><div class="act-sum-lbl">Temps total</div></div>
      </div>`;
  }

  function card(a) {
    const asc = a.ascent ? `<div class="act-stat"><b>↑ ${a.ascent} m</b><span>Dénivelé</span></div>` : '';
    return `
      <div class="act-card" data-id="${esc(a.id)}">
        <div class="act-card-head">
          <div class="act-name" data-role="name" title="Cliquer pour renommer">${esc(a.name)}</div>
          <div class="act-date">${esc(fmtDate(a.startedAt || a.savedAt))}</div>
        </div>
        <div class="act-stats">
          <div class="act-stat"><b>${fmtKm(a.meters)}</b><span>Distance</span></div>
          <div class="act-stat"><b>${fmtDuration(a.seconds)}</b><span>Durée</span></div>
          <div class="act-stat"><b>${fmtPace(a.meters, a.movingSeconds || a.seconds)}</b><span>Allure moy.</span></div>
          ${asc}
        </div>
        <div class="act-actions">
          <button class="act-btn primary" data-role="replay">▶ Rejouer</button>
          <button class="act-btn ghost" data-role="gpx">⬇ GPX</button>
          <button class="act-btn ghost" data-role="rename">✎ Renommer</button>
          <button class="act-btn danger" data-role="delete">Supprimer</button>
        </div>
      </div>`;
  }

  function render() {
    if (!activities.length) return renderEmpty();
    root.innerHTML = summaryStrip() + activities.map(card).join('');
  }

  // ── data ──────────────────────────────────────────────────────────────────
  async function load() {
    try {
      const res = await fetch(`${API_URL}/api/activities`, { headers: authHeader() });
      if (!res.ok) throw new Error('load failed');
      activities = await res.json();
      render();
    } catch {
      root.innerHTML = '<div class="act-empty"><p>Impossible de charger votre journal. Vérifiez votre connexion et réessayez.</p></div>';
    }
  }

  async function fetchFull(id) {
    const res = await fetch(`${API_URL}/api/activities/${id}`, { headers: authHeader() });
    if (!res.ok) throw new Error('fetch failed');
    return res.json();
  }

  // ── actions ─────────────────────────────────────────────────────────────────
  async function doRename(a, cardEl) {
    const next = prompt('Nouveau nom de la sortie :', a.name);
    if (next == null) return;
    const name = next.trim();
    if (!name || name === a.name) return;
    try {
      const res = await fetch(`${API_URL}/api/activities/${a.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...authHeader() },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) throw new Error();
      a.name = name;
      cardEl.querySelector('[data-role="name"]').textContent = name;
    } catch {
      alert('Le renommage a échoué. Réessayez.');
    }
  }

  async function doDelete(a, cardEl) {
    if (!confirm(`Supprimer « ${a.name} » ? Cette action est définitive.`)) return;
    try {
      const res = await fetch(`${API_URL}/api/activities/${a.id}`, { method: 'DELETE', headers: authHeader() });
      if (!res.ok) throw new Error();
      activities = activities.filter((x) => x.id !== a.id);
      render();
    } catch {
      alert('La suppression a échoué. Réessayez.');
    }
  }

  async function doGpx(a) {
    try {
      const full = await fetchFull(a.id);
      const coords = (full.coords || []).map((c) => [c[0], c[1]]);
      if (coords.length < 2) return alert('Tracé indisponible.');
      const opts = { description: `Sortie BWR — ${fmtKm(full.meters)} le ${fmtDate(full.startedAt)}` };
      if (Array.isArray(full.elevations) && full.elevations.length === coords.length) opts.elevations = full.elevations;
      downloadGPX(coords, full.name || 'sortie', opts);
    } catch {
      alert('Export GPX impossible. Réessayez.');
    }
  }

  // ── replay ──────────────────────────────────────────────────────────────────
  const overlay = document.getElementById('replayOverlay');
  const replay = { map: null, marker: null, doneLine: null, coords: [], raf: null, playing: false, progress: 0 };

  function closeReplay() {
    replay.playing = false;
    if (replay.raf) cancelAnimationFrame(replay.raf);
    overlay.classList.remove('open');
  }

  async function openReplay(a) {
    let full;
    try { full = await fetchFull(a.id); } catch { return alert('Tracé indisponible.'); }
    const coords = (full.coords || []).map((c) => [c[0], c[1]]);
    if (coords.length < 2) return alert('Tracé indisponible.');

    document.getElementById('replayTitle').textContent = full.name || 'Rejouer';
    overlay.classList.add('open');
    replay.coords = coords;

    if (!replay.map) {
      replay.map = L.map('replayMap', { zoomControl: true });
      L.tileLayer('/tiles/topo/{z}/{x}/{y}.png', {
        attribution: 'Map data: © OpenStreetMap contributors, SRTM | © OpenTopoMap',
        maxNativeZoom: 15, maxZoom: 17,
      }).addTo(replay.map);
    }
    // Leaflet needs a reflow tick after the container becomes visible.
    setTimeout(() => replay.map.invalidateSize(), 60);

    if (replay.fullLine) replay.map.removeLayer(replay.fullLine);
    if (replay.doneLine) replay.map.removeLayer(replay.doneLine);
    if (replay.marker) replay.map.removeLayer(replay.marker);

    replay.fullLine = L.polyline(coords, { color: '#9ca3af', weight: 4, opacity: 0.55 }).addTo(replay.map);
    replay.doneLine = L.polyline([], { color: '#1e4d14', weight: 5 }).addTo(replay.map);
    replay.marker = L.circleMarker(coords[0], { radius: 8, color: '#fff', weight: 2, fillColor: '#1e4d14', fillOpacity: 1 }).addTo(replay.map);
    replay.map.fitBounds(replay.fullLine.getBounds(), { padding: [30, 30] });

    setProgress(0);
    setPlaying(false);
  }

  const scrub = document.getElementById('replayScrub');
  const timeLbl = document.getElementById('replayTime');
  const playBtn = document.getElementById('replayPlay');

  function setProgress(p) {
    replay.progress = Math.min(1, Math.max(0, p));
    const coords = replay.coords;
    const n = coords.length;
    const idxF = replay.progress * (n - 1);
    const idx = Math.floor(idxF);
    const done = coords.slice(0, idx + 1);
    const cur = coords[Math.min(idx, n - 1)];
    if (replay.doneLine) replay.doneLine.setLatLngs(done);
    if (replay.marker && cur) replay.marker.setLatLng(cur);
    scrub.value = String(Math.round(replay.progress * 1000));
    timeLbl.textContent = `${Math.round(replay.progress * 100)} %`;
  }

  function setPlaying(on) {
    replay.playing = on;
    playBtn.textContent = on ? '⏸' : '▶';
    if (on) {
      if (replay.progress >= 1) setProgress(0);
      let last = performance.now();
      const DURATION = 12000; // full replay in ~12 s regardless of walk length
      const step = (now) => {
        if (!replay.playing) return;
        const dt = now - last; last = now;
        setProgress(replay.progress + dt / DURATION);
        if (replay.progress >= 1) { setPlaying(false); return; }
        replay.raf = requestAnimationFrame(step);
      };
      replay.raf = requestAnimationFrame(step);
    } else if (replay.raf) {
      cancelAnimationFrame(replay.raf);
    }
  }

  playBtn.addEventListener('click', () => setPlaying(!replay.playing));
  scrub.addEventListener('input', () => { setPlaying(false); setProgress(scrub.value / 1000); });
  document.getElementById('replayClose').addEventListener('click', closeReplay);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeReplay(); });

  // ── event delegation on the card list ────────────────────────────────────────
  root.addEventListener('click', (e) => {
    const cardEl = e.target.closest('.act-card');
    if (!cardEl) return;
    const a = activities.find((x) => x.id === cardEl.dataset.id);
    if (!a) return;
    const role = e.target.closest('[data-role]')?.dataset.role;
    if (role === 'replay') openReplay(a);
    else if (role === 'gpx') doGpx(a);
    else if (role === 'rename' || role === 'name') doRename(a, cardEl);
    else if (role === 'delete') doDelete(a, cardEl);
  });

  // ── boot ─────────────────────────────────────────────────────────────────────
  (async function boot() {
    const user = await requireAuth();
    if (!user) return;
    load();
  })();
})();
