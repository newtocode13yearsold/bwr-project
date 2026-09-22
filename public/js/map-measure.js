// map-measure.js — Google-Maps-style "measure distance" tool.
//
// Right-click (desktop) or long-press (mobile) anywhere on the map opens a small
// context menu; "📏 Mesurer une distance" starts a measurement. From there each
// left-click drops a point, a live line follows the cursor and a floating panel
// shows the running total. Vertices are draggable and right-click-to-remove.
// Double-click or Échap (or the panel button) finishes; the drawn line stays
// until "Effacer".
//
// Loaded on map.html AFTER map-paths.js / map-poi.js. Those two modules' own
// `map.on('click')` / `map.on('mousemove')` handlers bail out while
// `window.measureModeActive` is true, so only this tool acts on a click during a
// measurement (same pattern POI-add mode already uses).
(function () {
  if (typeof map === 'undefined' || typeof L === 'undefined') return;

  const LINE_COLOR = '#1e4d14';

  let measuring = false;    // true while accepting clicks to add points
  let points    = [];       // L.LatLng[] placed so far
  let markers   = [];       // L.Marker[] parallel to points
  let line      = null;     // solid L.Polyline through the points
  let rubber    = null;     // dashed L.Polyline from last point → cursor
  let liveEnd   = null;     // current cursor L.LatLng while measuring
  let panel     = null;     // floating total panel
  let menuEl    = null;     // open context menu, if any

  window.measureModeActive = false; // read by map-paths.js / map-poi.js

  // ── Geometry / formatting ─────────────────────────────────────────────────
  function metersBetween(a, b) {
    const R = 6371000;
    const dLat = (b.lat - a.lat) * Math.PI / 180;
    const dLng = (b.lng - a.lng) * Math.PI / 180;
    const s = Math.sin(dLat / 2) ** 2
            + Math.cos(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180)
            * Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
  }

  function placedMeters() {
    let m = 0;
    for (let i = 1; i < points.length; i++) m += metersBetween(points[i - 1], points[i]);
    return m;
  }

  // Total shown = confirmed segments + the live cursor segment (Google-style
  // preview while you move toward the next point).
  function displayMeters() {
    let m = placedMeters();
    if (measuring && liveEnd && points.length) m += metersBetween(points[points.length - 1], liveEnd);
    return m;
  }

  function fmtDist(m) {
    if (m < 1000) return Math.round(m) + ' m';
    return (m / 1000).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' km';
  }

  // ── Drawing ───────────────────────────────────────────────────────────────
  function vertexIcon() {
    return L.divIcon({ className: 'measure-vertex', iconSize: [14, 14], iconAnchor: [7, 7] });
  }

  function addPoint(latlng) {
    points.push(latlng);
    const m = L.marker(latlng, { icon: vertexIcon(), draggable: true, keyboard: false, zIndexOffset: 1000 });
    m.on('drag', () => {
      const i = markers.indexOf(m);
      if (i >= 0) { points[i] = m.getLatLng(); redraw(); }
    });
    m.on('contextmenu', (ev) => { L.DomEvent.stop(ev); removeVertex(m); });
    m.addTo(map);
    markers.push(m);
    redraw();
  }

  function removeVertex(m) {
    const i = markers.indexOf(m);
    if (i < 0) return;
    map.removeLayer(m);
    markers.splice(i, 1);
    points.splice(i, 1);
    if (!points.length) { clearMeasure(); return; }
    redraw();
  }

  function updateRubber() {
    if (!measuring || !points.length || !liveEnd) {
      if (rubber) { map.removeLayer(rubber); rubber = null; }
      return;
    }
    const seg = [points[points.length - 1], liveEnd];
    if (rubber) rubber.setLatLngs(seg);
    else rubber = L.polyline(seg, { color: LINE_COLOR, weight: 2, opacity: 0.55, dashArray: '6,8', interactive: false }).addTo(map);
  }

  function redraw() {
    if (line) line.setLatLngs(points);
    updateRubber();
    renderPanel();
  }

  // ── Floating total panel ──────────────────────────────────────────────────
  function renderPanel() {
    if (!panel) {
      panel = document.createElement('div');
      panel.className = 'measure-panel';
      document.body.appendChild(panel);
      document.body.classList.add('measuring-active'); // frees the top-centre slot (hides the search bar)
      L.DomEvent.disableClickPropagation(panel);
    }
    const dist = fmtDist(displayMeters());
    const hint = measuring
      ? 'Cliquez pour ajouter des points · double-clic ou Échap pour terminer'
      : (points.length > 1 ? 'Mesure terminée' : 'Placez au moins deux points');
    const btns = measuring
      ? `<button class="measure-btn" data-act="finish">Terminer</button>
         <button class="measure-btn measure-btn-ghost" data-act="clear">Effacer</button>`
      : `<button class="measure-btn" data-act="resume">Reprendre</button>
         <button class="measure-btn measure-btn-ghost" data-act="clear">Effacer</button>`;
    panel.innerHTML = `
      <div class="measure-panel-top">
        <span class="measure-total">📏 ${dist}</span>
        <button class="measure-close" data-act="clear" aria-label="Fermer">✕</button>
      </div>
      <div class="measure-hint">${hint}</div>
      <div class="measure-actions">${btns}</div>`;
    panel.querySelectorAll('[data-act]').forEach(b => {
      b.addEventListener('click', () => {
        const act = b.getAttribute('data-act');
        if (act === 'finish') finishMeasure();
        else if (act === 'clear') clearMeasure();
        else if (act === 'resume') resumeMeasure();
      });
    });
  }

  // ── State transitions ─────────────────────────────────────────────────────
  function startMeasure(latlng) {
    clearMeasure();
    measuring = true;
    window.measureModeActive = true;
    map.doubleClickZoom.disable();
    map.getContainer().style.cursor = 'crosshair';
    line = L.polyline([], { color: LINE_COLOR, weight: 3, opacity: 0.9 }).addTo(map);
    if (latlng) addPoint(latlng);
    renderPanel();
  }

  function resumeMeasure() {
    if (!points.length) return;
    measuring = true;
    window.measureModeActive = true;
    map.doubleClickZoom.disable();
    map.getContainer().style.cursor = 'crosshair';
    if (!line) line = L.polyline(points, { color: LINE_COLOR, weight: 3, opacity: 0.9 }).addTo(map);
    redraw();
  }

  function finishMeasure() {
    measuring = false;
    window.measureModeActive = false;
    liveEnd = null;
    map.doubleClickZoom.enable();
    map.getContainer().style.cursor = '';
    updateRubber();
    if (points.length < 2) { clearMeasure(); return; }
    renderPanel();
  }

  function clearMeasure() {
    measuring = false;
    window.measureModeActive = false;
    liveEnd = null;
    map.doubleClickZoom.enable();
    map.getContainer().style.cursor = '';
    markers.forEach(m => map.removeLayer(m));
    markers = [];
    points = [];
    if (line)   { map.removeLayer(line);   line = null; }
    if (rubber) { map.removeLayer(rubber); rubber = null; }
    if (panel)  { panel.remove(); panel = null; }
    document.body.classList.remove('measuring-active');
  }

  // ── Context menu ──────────────────────────────────────────────────────────
  function closeMenu() {
    if (menuEl) { menuEl.remove(); menuEl = null; }
  }

  function copyCoords(latlng) {
    const txt = `${latlng.lat.toFixed(6)}, ${latlng.lng.toFixed(6)}`;
    const done = () => (typeof showToast === 'function') && showToast('Coordonnées copiées : ' + txt);
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(txt).then(done).catch(done);
    else done();
  }

  function openMenu(clientX, clientY, latlng) {
    closeMenu();
    const items = [];
    if (measuring) {
      items.push({ label: '➕ Ajouter un point ici', act: () => addPoint(latlng) });
      items.push({ label: '✓ Terminer la mesure',    act: finishMeasure });
      items.push({ label: '🗑 Effacer',               act: clearMeasure });
    } else if (points.length) {
      items.push({ label: '📏 Nouvelle mesure',       act: () => startMeasure(latlng) });
      items.push({ label: '🗑 Effacer',               act: clearMeasure });
    } else {
      items.push({ label: '📏 Mesurer une distance',  act: () => startMeasure(latlng) });
    }
    items.push({ label: '📍 Copier les coordonnées',  act: () => copyCoords(latlng) });

    menuEl = document.createElement('div');
    menuEl.className = 'measure-menu';
    items.forEach(it => {
      const b = document.createElement('button');
      b.className = 'measure-menu-item';
      b.textContent = it.label;
      b.addEventListener('click', () => { closeMenu(); it.act(); });
      menuEl.appendChild(b);
    });
    document.body.appendChild(menuEl);
    L.DomEvent.disableClickPropagation(menuEl); // clicks inside the menu don't bubble to the outside-close listener

    // Position at the cursor, clamped inside the viewport.
    const r = menuEl.getBoundingClientRect();
    const x = Math.min(clientX, window.innerWidth  - r.width  - 8);
    const y = Math.min(clientY, window.innerHeight - r.height - 8);
    menuEl.style.left = Math.max(8, x) + 'px';
    menuEl.style.top  = Math.max(8, y) + 'px';
  }

  // One persistent outside-click closer (a right-click that opens a new menu
  // fires `contextmenu`, not `click`, so it won't self-close; openMenu closes any
  // prior menu itself). Registering it once avoids stale one-shot listeners
  // piling up and killing a freshly-opened menu.
  document.addEventListener('click', () => { if (menuEl) closeMenu(); });

  // ── Map wiring ────────────────────────────────────────────────────────────
  map.on('contextmenu', (e) => {
    if (window.poiAddModeActive) return; // don't hijack POI placement
    if (e.originalEvent) L.DomEvent.preventDefault(e.originalEvent);
    const oe = e.originalEvent || {};
    openMenu(oe.clientX ?? 0, oe.clientY ?? 0, e.latlng);
  });

  map.on('click', (e) => {
    if (!measuring) return;
    addPoint(e.latlng);
  });

  map.on('mousemove', (e) => {
    if (!measuring || !points.length) return;
    liveEnd = e.latlng;
    updateRubber();
    renderPanel();
  });

  map.on('dblclick', () => {
    if (!measuring) return;
    // The double-click already fired two 'click's (two near-identical points);
    // drop the duplicate, then finish.
    if (points.length > 1) removeVertexAt(points.length - 1);
    finishMeasure();
  });

  function removeVertexAt(i) {
    const m = markers[i];
    if (m) removeVertex(m);
  }

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (menuEl) { closeMenu(); return; }
    if (measuring) finishMeasure();
  });
})();
