// map-poi.js — points-of-interest layer for the map page (parking, water,
// picnic, viewpoint, toilet). Everyone sees the layer; Silver+/admin can add,
// and the author or an admin can edit/delete. Loaded AFTER js/map.js (needs the
// shared `map`, `_userPlan`, `_cachedUser`, `showToast`, `API_URL`, auth helpers).
//
// Backend: GET /api/pois, POST /api/pois, PUT/DELETE /api/pois/:id.

// Keep in sync with POI_TYPES in worker/handlers/poi.js.
const POI_TYPES = {
  parking:   { icon: '🅿️', label: 'Parking' },
  water:     { icon: '🚰', label: 'Point d\'eau' },
  picnic:    { icon: '🧺', label: 'Aire de pique-nique' },
  viewpoint: { icon: '👀', label: 'Point de vue' },
  toilet:    { icon: '🚻', label: 'Toilettes' },
};

const poiLayer = L.layerGroup();
let _pois = [];
let _poiLayerVisible = true;
window.poiAddModeActive = false;

function _poiAuth() {
  return (typeof getToken === 'function' && getToken()) ? authHeader() : {};
}
function _poiEsc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function _poiIcon(type) {
  const t = POI_TYPES[type] || { icon: '📍' };
  return L.divIcon({
    className: 'poi-marker',
    html: `<span class="poi-pin">${t.icon}</span>`,
    iconSize: [30, 30],
    iconAnchor: [15, 30],
    popupAnchor: [0, -28],
  });
}

async function loadPois() {
  try {
    const res = await fetch(`${API_URL}/api/pois`);
    if (!res.ok) return;
    const data = await res.json();
    if (!Array.isArray(data)) return;
    _pois = data;
    renderPois();
  } catch (e) {
    console.error('loadPois:', e);
  }
}

function renderPois() {
  poiLayer.clearLayers();
  _pois.forEach(poi => {
    if (typeof poi.lat !== 'number' || typeof poi.lon !== 'number') return;
    L.marker([poi.lat, poi.lon], { icon: _poiIcon(poi.type), keyboard: false })
      .addTo(poiLayer)
      .on('click', () => openPoiPopup(poi));
  });
}

function openPoiPopup(poi) {
  const t = POI_TYPES[poi.type] || { icon: '📍', label: poi.type };
  const isAdmin = _cachedUser?.role === 'admin';
  const isOwner = _cachedUser?.id && poi.createdBy === _cachedUser.id;
  const canEdit = isAdmin || isOwner;

  const controls = canEdit
    ? `<div class="poi-popup-actions">
        <button class="rv-btn rv-btn-ghost" id="poiEdit-${poi.id}">✎ Modifier</button>
        <button class="rv-btn rv-btn-danger" id="poiDel-${poi.id}">🗑 Supprimer</button>
      </div>` : '';

  L.popup({ maxWidth: 260 })
    .setLatLng([poi.lat, poi.lon])
    .setContent(`
      <div class="popup poi-popup">
        <strong>${t.icon} ${_poiEsc(poi.name || t.label)}</strong>
        <span class="poi-type-tag">${t.label}</span>
        ${poi.note ? `<p class="popup-notes">${_poiEsc(poi.note)}</p>` : ''}
        <div class="poi-popup-meta">Ajouté par ${_poiEsc(poi.createdByName || 'un membre')}</div>
        ${controls}
      </div>
    `)
    .openOn(map);

  setTimeout(() => {
    document.getElementById(`poiEdit-${poi.id}`)?.addEventListener('click', () => openPoiForm(poi, [poi.lat, poi.lon]));
    document.getElementById(`poiDel-${poi.id}`)?.addEventListener('click', async () => {
      if (!confirm('Supprimer ce point ?')) return;
      try {
        const res = await fetch(`${API_URL}/api/pois/${poi.id}`, { method: 'DELETE', headers: { ..._poiAuth() } });
        if (res.ok) {
          _pois = _pois.filter(p => p.id !== poi.id);
          renderPois();
          map.closePopup();
          showToast('🗑 Point supprimé.');
        } else { showToast('Erreur lors de la suppression.'); }
      } catch { showToast('Erreur réseau.'); }
    });
  }, 50);
}

// Add / edit form popup. `poi` is null for a new point at `latlng`.
function openPoiForm(poi, latlng) {
  const editing = !!poi;
  const typeBtns = Object.entries(POI_TYPES).map(([id, t]) =>
    `<button type="button" class="poi-type-btn ${editing && poi.type === id ? 'active' : ''}" data-type="${id}">${t.icon} ${t.label}</button>`
  ).join('');

  const popup = L.popup({ maxWidth: 280, autoClose: false, closeOnClick: false })
    .setLatLng(latlng)
    .setContent(`
      <div class="popup poi-form">
        <strong>${editing ? '✎ Modifier le point' : '➕ Nouveau point'}</strong>
        <div class="poi-type-grid" id="poiTypes">${typeBtns}</div>
        <input type="text" class="poi-input" id="poiName" maxlength="120"
          placeholder="Nom (ex. Parking des Beaux Monts)" value="${editing ? _poiEsc(poi.name) : ''}">
        <textarea class="poi-input" id="poiNote" rows="2" maxlength="500"
          placeholder="Détails (facultatif)…">${editing ? _poiEsc(poi.note) : ''}</textarea>
        <div class="rv-form-actions">
          <button class="rv-btn rv-btn-primary" id="poiSave">${editing ? 'Enregistrer' : 'Ajouter'}</button>
          <button class="rv-btn rv-btn-ghost" id="poiCancel">Annuler</button>
        </div>
      </div>
    `)
    .openOn(map);

  setTimeout(() => {
    const root = popup.getElement();
    if (!root) return;
    let selectedType = editing ? poi.type : null;
    root.querySelectorAll('.poi-type-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        root.querySelectorAll('.poi-type-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        selectedType = btn.dataset.type;
      });
    });

    root.querySelector('#poiCancel')?.addEventListener('click', () => { map.closePopup(); exitPoiAddMode(); });

    root.querySelector('#poiSave')?.addEventListener('click', async () => {
      if (!selectedType) { showToast('Choisissez un type de point.'); return; }
      const name = root.querySelector('#poiName').value.trim();
      const note = root.querySelector('#poiNote').value.trim();
      const payload = { type: selectedType, name, note, lat: latlng[0] ?? latlng.lat, lon: latlng[1] ?? latlng.lng };
      try {
        const res = editing
          ? await fetch(`${API_URL}/api/pois/${poi.id}`, {
              method: 'PUT', headers: { 'Content-Type': 'application/json', ..._poiAuth() },
              body: JSON.stringify({ type: selectedType, name, note }) })
          : await fetch(`${API_URL}/api/pois`, {
              method: 'POST', headers: { 'Content-Type': 'application/json', ..._poiAuth() },
              body: JSON.stringify(payload) });
        if (res.ok) {
          const saved = await res.json();
          if (editing) _pois = _pois.map(p => p.id === saved.id ? saved : p);
          else _pois.push(saved);
          renderPois();
          map.closePopup();
          exitPoiAddMode();
          showToast(editing ? '✅ Point mis à jour.' : '✅ Point ajouté, merci !');
        } else if (res.status === 403) {
          const d = await res.json().catch(() => ({}));
          showToast(`🔒 ${d.error || 'Abonnement Argent requis pour ajouter un point.'}`);
        } else if (res.status === 401) {
          showToast('Connectez-vous pour ajouter un point.');
        } else {
          const d = await res.json().catch(() => ({}));
          showToast(d.error || 'Erreur lors de l\'enregistrement.');
        }
      } catch { showToast('Erreur réseau.'); }
    });
  }, 50);
}

// ── Add mode: next map click drops a new POI ──────────────────────────────────
function enterPoiAddMode() {
  window.poiAddModeActive = true;
  map.getContainer().classList.add('poi-add-cursor');
  document.getElementById('poiAddBtn')?.classList.add('active');
  showToast('📍 Cliquez sur la carte pour placer le point.');
}
function exitPoiAddMode() {
  window.poiAddModeActive = false;
  map.getContainer().classList.remove('poi-add-cursor');
  document.getElementById('poiAddBtn')?.classList.remove('active');
}

// The POI click handler runs alongside map-paths' click handler; that one bails
// out early while poiAddModeActive is true (see js/map-paths.js), so only one
// acts on a given click.
map.on('click', e => {
  if (!window.poiAddModeActive) return;
  openPoiForm(null, [e.latlng.lat, e.latlng.lng]);
  // Leave add mode immediately so a mis-click doesn't open a second form; the
  // form's own Cancel/Save also calls exitPoiAddMode().
  exitPoiAddMode();
});

// ── On-map control (toggle layer + add button for Silver+) ────────────────────
const PoiControl = L.Control.extend({
  options: { position: 'bottomleft' },
  onAdd() {
    const canAdd = (typeof BWR !== 'undefined') && BWR.can('poi_create', _userPlan);
    const el = L.DomUtil.create('div', 'poi-control leaflet-bar');
    el.innerHTML = `
      <button id="poiToggleBtn" class="poi-ctrl-btn" title="Afficher / masquer les points d'intérêt">📍 Points</button>
      ${canAdd ? '<button id="poiAddBtn" class="poi-ctrl-btn poi-ctrl-add" title="Ajouter un point d\'intérêt">➕</button>' : ''}
    `;
    L.DomEvent.disableClickPropagation(el);
    L.DomEvent.disableScrollPropagation(el);
    setTimeout(() => {
      document.getElementById('poiToggleBtn')?.addEventListener('click', () => {
        _poiLayerVisible = !_poiLayerVisible;
        if (_poiLayerVisible) poiLayer.addTo(map);
        else poiLayer.remove();
        document.getElementById('poiToggleBtn')?.classList.toggle('off', !_poiLayerVisible);
      });
      document.getElementById('poiAddBtn')?.addEventListener('click', () => {
        if (window.poiAddModeActive) exitPoiAddMode();
        else enterPoiAddMode();
      });
    }, 0);
    return el;
  },
});

poiLayer.addTo(map);
map.addControl(new PoiControl());
loadPois();
