// ── Save / share / history ────────────────────────────────────────────────────
// Lazy-loaded by routes.js on first save, share, or history-panel open.
// All globals (lastRoute, map, routeLayer, currentUser, difficulty, pathType,
// mode, API_URL, authHeader, showToast, escapeHtml) are defined in routes.js
// which executes first.

// ── Internal history state ────────────────────────────────────────────────────
let historyOpen   = false;
let historyLoaded = false;

// ── Save ──────────────────────────────────────────────────────────────────────
async function saveCurrentRoute() {
  if (!lastRoute) return;
  const btn = document.getElementById('btnSaveRoute');
  btn.disabled = true;
  btn.textContent = '⏳ Sauvegarde…';

  const typeLabelShort = { foot: 'Forestier', bike: 'Cyclable', champs: 'Champs', mix: 'Mix' }[pathType] || '';
  const defaultName = `${mode === 'loop' ? 'Boucle' : 'Trajet'} ${typeLabelShort} ${(lastRoute.meters / 1000).toFixed(1)} km`;

  try {
    const res = await fetch(`${API_URL}/api/savedroutes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeader() },
      body: JSON.stringify({
        name: defaultName,
        coords: lastRoute.coords,
        meters: lastRoute.meters,
        seconds: lastRoute.seconds,
        difficulty,
        pathType,
        mode,
      }),
    });
    if (!res.ok) throw new Error((await res.json()).error || `HTTP ${res.status}`);
    const { shareToken } = await res.json();
    lastRoute._shareToken = shareToken;
    showToast('Trajet sauvegardé !');
    refreshHistoryIfOpen();
  } catch (e) {
    showToast(`Erreur : ${e.message}`);
  } finally {
    btn.textContent = '💾 Sauvegarder';
    btn.disabled = false;
  }
}

// ── Share ─────────────────────────────────────────────────────────────────────
async function shareCurrentRoute() {
  if (!lastRoute) return;

  if (lastRoute._shareToken) {
    copyShareLink(lastRoute._shareToken);
    return;
  }

  const btn = document.getElementById('btnShareRoute');
  btn.disabled = true;
  btn.textContent = '⏳…';

  const typeLabelShort = { foot: 'Forestier', bike: 'Cyclable', champs: 'Champs', mix: 'Mix' }[pathType] || '';
  const defaultName = `${mode === 'loop' ? 'Boucle' : 'Trajet'} ${typeLabelShort} ${(lastRoute.meters / 1000).toFixed(1)} km`;

  try {
    const res = await fetch(`${API_URL}/api/savedroutes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeader() },
      body: JSON.stringify({
        name: defaultName,
        coords: lastRoute.coords,
        meters: lastRoute.meters,
        seconds: lastRoute.seconds,
        difficulty,
        pathType,
        mode,
      }),
    });
    if (!res.ok) throw new Error((await res.json()).error || `HTTP ${res.status}`);
    const { shareToken } = await res.json();
    lastRoute._shareToken = shareToken;
    copyShareLink(shareToken);
    refreshHistoryIfOpen();
  } catch (e) {
    showToast(`Erreur : ${e.message}`);
  } finally {
    btn.textContent = '🔗 Partager';
    btn.disabled = false;
  }
}

function copyShareLink(token) {
  const url = `${location.origin}${location.pathname}?share=${token}`;
  if (navigator.clipboard) {
    navigator.clipboard.writeText(url).then(() => showToast('Lien copié dans le presse-papiers !'));
  } else {
    const ta = document.createElement('textarea');
    ta.value = url;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
    showToast('Lien copié !');
  }
}

// ── History panel ─────────────────────────────────────────────────────────────
function toggleHistory() {
  historyOpen = !historyOpen;
  document.getElementById('historyChevron').classList.toggle('open', historyOpen);
  const body = document.getElementById('historyBody');
  body.style.display = historyOpen ? 'block' : 'none';

  if (historyOpen && !historyLoaded) {
    fetchAndRenderHistory();
  }
}

function refreshHistoryIfOpen() {
  if (historyOpen) fetchAndRenderHistory();
  else historyLoaded = false;
}

async function fetchAndRenderHistory() {
  const listEl = document.getElementById('historyList');
  const loadEl = document.getElementById('historyLoading');
  loadEl.style.display = 'block';
  listEl.innerHTML = '';

  try {
    const res = await fetch(`${API_URL}/api/savedroutes`, { headers: authHeader() });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const routes = await res.json();
    historyLoaded = true;
    loadEl.style.display = 'none';
    if (!routes.length) {
      listEl.innerHTML = '<div class="history-empty">Aucun trajet sauvegardé.</div>';
      return;
    }
    listEl.innerHTML = routes.map(r => {
      const km       = (r.meters / 1000).toFixed(1);
      const date     = new Date(r.savedAt).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' });
      const modeIcon = r.mode === 'loop' ? '🔄' : '➡️';
      return `
        <div class="history-item" data-id="${r.id}" data-token="${r.shareToken}">
          <div class="history-item-info">
            <div class="history-item-name">${escapeHtml(r.name)}</div>
            <div class="history-item-meta">${modeIcon} ${km} km · ${date}</div>
          </div>
          <div class="history-item-actions">
            <button class="btn-history-replay" title="Afficher sur la carte">▶</button>
            <button class="btn-history-share"  title="Copier le lien de partage">🔗</button>
            <button class="btn-history-delete" title="Supprimer">🗑</button>
          </div>
        </div>`;
    }).join('');

    listEl.querySelectorAll('.history-item').forEach(el => {
      const id    = el.dataset.id;
      const token = el.dataset.token;
      el.querySelector('.btn-history-replay').onclick = () => replaySavedRoute(id);
      el.querySelector('.btn-history-share').onclick  = () => copyShareLink(token);
      el.querySelector('.btn-history-delete').onclick = () => deleteSavedRoute(id, el);
    });
  } catch (e) {
    loadEl.style.display = 'none';
    listEl.innerHTML = `<div class="history-empty">Erreur : ${e.message}</div>`;
  }
}

async function replaySavedRoute(id) {
  try {
    const res = await fetch(`${API_URL}/api/savedroutes/${id}`, { headers: authHeader() });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const route = await res.json();
    if (routeLayer) map.removeLayer(routeLayer);
    const color = route.difficulty === 'easy' ? '#22c55e' : route.difficulty === 'medium' ? '#f97316' : '#ef4444';
    routeLayer = L.polyline(route.coords, { color, weight: 6, opacity: 0.9 }).addTo(map);
    map.fitBounds(routeLayer.getBounds(), { padding: [40, 40] });
    showToast('Trajet affiché sur la carte.');
  } catch (e) {
    showToast(`Erreur : ${e.message}`);
  }
}

async function deleteSavedRoute(id, el) {
  if (!confirm('Supprimer ce trajet ?')) return;
  try {
    const res = await fetch(`${API_URL}/api/savedroutes/${id}`, {
      method: 'DELETE',
      headers: authHeader(),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    el.remove();
    const listEl = document.getElementById('historyList');
    if (!listEl.children.length) listEl.innerHTML = '<div class="history-empty">Aucun trajet sauvegardé.</div>';
    showToast('Trajet supprimé.');
  } catch (e) {
    showToast(`Erreur : ${e.message}`);
  }
}
