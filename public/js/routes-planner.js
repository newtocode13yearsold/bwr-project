// routes-planner.js — the planner UX flow for the route planner page.
// Split out of routes.js. Classic script: loaded before js/routes.js (the entry
// file that declares shared `let` state and runs the boot IIFE last, after every
// function here is defined). Routing engines live in js/routes-engine.js; map/IO
// helpers in js/routes-map.js. Top-level code here only *attaches* event listeners
// (their callbacks read shared state at click time), so load order is safe.

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

  // Lock the "Sur mesure" custom-route builder for free/visitor tiers.
  if (!BWR.can('custom_route_builder', plan)) {
    const customCard = document.querySelector('.mode-card[data-mode="custom"]');
    if (customCard) markCardLocked(customCard, BWR.requiredTier('custom_route_builder'), 'Le trajet sur mesure');
  }

  // Lock Hard difficulty
  if (!BWR.can('difficulty_hard', plan)) {
    const hardBtn = document.querySelector('.diff-btn[data-diff="hard"]');
    if (hardBtn) markBtnLocked(hardBtn, 'silver');
  }

  // Lock satellite tile button
  if (!BWR.can('satellite_tiles', plan)) {
    const satBtn = document.querySelector('.layer-btn[data-layer="satellite"]');
    if (satBtn) markBtnLocked(satBtn, BWR.requiredTier('satellite_tiles'));
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
  const stats = currentUser?.stats || {};
  const level = BWR.levelFromXp(BWR.xpFromStats(stats));
  const limit = BWR.routeLimit(plan, level);
  const stripEl = document.getElementById('quotaStrip');
  if (!stripEl) return;
  if (limit === Infinity) {
    stripEl.classList.add('hidden');
    return;
  }
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

// ── Step 1: Mode ──────────────────────────────────────────────────────────────
document.querySelectorAll('.mode-card').forEach(card => {
  card.addEventListener('click', () => {
    document.querySelectorAll('.mode-card').forEach(c => c.classList.remove('active'));
    card.classList.add('active');
    mode = card.dataset.mode;
    localStorage.setItem('bwr_saved_mode', mode);

    document.getElementById('distanceGroup').style.display = mode === 'loop' ? '' : 'none';
    // "Priorité" (Forestier / Plus court) only affects A→B routing — a fixed-distance
    // loop and the leg-by-leg custom builder have no "shortest" variant — so show it
    // in A→B mode only to avoid a dead control.
    document.getElementById('priorityGroup').style.display = mode === 'atob' ? '' : 'none';
    // Custom "Sur mesure" builder (ordered stop list) only in custom mode.
    document.getElementById('customBuilder')?.classList.toggle('hidden', mode !== 'custom');

    document.getElementById('step3Title').textContent =
      mode === 'loop' ? 'Point de départ'
      : mode === 'custom' ? 'Tes étapes'
      : 'Points de départ et arrivée';
    document.getElementById('step3Hint').textContent =
      mode === 'loop'
        ? 'Clique sur la carte pour placer le point de départ de ta boucle.'
        : mode === 'custom'
        ? 'Clique sur la carte ou cherche un carrefour pour ajouter des étapes dans l\'ordre.'
        : 'Clique d\'abord pour le départ (A), puis pour l\'arrivée (B).';

    unlock('step2');
    unlock('step3');
    resetPoints();
    pickingPoint = mode === 'custom' ? 'waypoint' : 'start';
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

  // Custom "Sur mesure": every click appends the next ordered stop.
  if (mode === 'custom') {
    addWaypoint(lat, lng);
    return;
  }

  // Loop "reshape": when adding via-points on the map, every click appends one.
  if (mode === 'loop' && pickingPoint === 'via') {
    addLoopVia(lat, lng);
    return;
  }

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

// ── Custom "Sur mesure" waypoints ─────────────────────────────────────────────
function customPinIcon(n) {
  return L.divIcon({
    html: `<div style="background:#6d28d9;color:white;width:30px;height:30px;border-radius:50% 50% 50% 0;transform:rotate(-45deg);display:flex;align-items:center;justify-content:center;border:3px solid white;box-shadow:0 2px 8px rgba(0,0,0,0.35)"><span style="transform:rotate(45deg);font-weight:800;font-size:0.8rem">${n}</span></div>`,
    iconSize: [30, 30], iconAnchor: [15, 30], className: '',
  });
}

function addWaypoint(lat, lng, name = '') {
  waypoints.push({ lat, lng, name, marker: null });
  renderWaypoints();
}

function removeWaypoint(i) {
  const wp = waypoints[i];
  if (wp && wp.marker) map.removeLayer(wp.marker);
  waypoints.splice(i, 1);
  renderWaypoints();
}

function moveWaypoint(i, dir) {
  const j = i + dir;
  if (j < 0 || j >= waypoints.length) return;
  [waypoints[i], waypoints[j]] = [waypoints[j], waypoints[i]];
  renderWaypoints();
}

// Redraw all markers (numbers change on reorder/remove) + the ordered stop list,
// and gate the Generate button on having ≥ 2 stops.
function renderWaypoints() {
  waypoints.forEach((wp, idx) => {
    if (wp.marker) map.removeLayer(wp.marker);
    wp.marker = L.marker([wp.lat, wp.lng], { icon: customPinIcon(idx + 1) })
      .addTo(map)
      .bindTooltip(wp.name || `Étape ${idx + 1}`);
  });

  const listEl = document.getElementById('cbStops');
  if (listEl) {
    listEl.innerHTML = waypoints.map((wp, idx) => `
      <li class="cb-stop">
        <span class="cb-stop-num">${idx + 1}</span>
        <span class="cb-stop-name">${escapeHtml(wp.name || `Point (${wp.lat.toFixed(4)}, ${wp.lng.toFixed(4)})`)}</span>
        <span class="cb-stop-actions">
          <button type="button" class="cb-stop-btn" data-act="up" data-i="${idx}" title="Monter" ${idx === 0 ? 'disabled' : ''}>↑</button>
          <button type="button" class="cb-stop-btn" data-act="down" data-i="${idx}" title="Descendre" ${idx === waypoints.length - 1 ? 'disabled' : ''}>↓</button>
          <button type="button" class="cb-stop-btn cb-stop-del" data-act="del" data-i="${idx}" title="Supprimer">✕</button>
        </span>
      </li>`).join('');
    listEl.querySelectorAll('.cb-stop-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const i = parseInt(btn.dataset.i, 10);
        const act = btn.dataset.act;
        if (act === 'del') removeWaypoint(i);
        else if (act === 'up') moveWaypoint(i, -1);
        else moveWaypoint(i, 1);
      });
    });
  }
  document.getElementById('cbEmpty')?.classList.toggle('hidden', waypoints.length > 0);

  if (waypoints.length >= 1) unlock('step4');
  const gen = document.getElementById('btnGenerate');
  if (gen) gen.disabled = waypoints.length < 2;
}

// Searchable carrefour picker — appends a named forest junction as the next stop.
function initCarrefourPicker() {
  const input = document.getElementById('carrefourInput');
  const results = document.getElementById('carrefourResults');
  if (!input || !results) return;
  const norm = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const hide = () => results.classList.add('hidden');

  input.addEventListener('input', () => {
    if (typeof CARREFOURS === 'undefined') return;
    const q = norm(input.value.trim());
    if (q.length < 2) { hide(); return; }
    const matches = CARREFOURS.filter(c => norm(c.name).includes(q)).slice(0, 8);
    if (!matches.length) { hide(); return; }
    results.innerHTML = matches.map(c =>
      `<div class="cb-carrefour-item" data-lat="${c.lat}" data-lon="${c.lon}" data-name="${escapeHtml(c.name)}">${escapeHtml(c.name)}</div>`
    ).join('');
    results.classList.remove('hidden');
    results.querySelectorAll('.cb-carrefour-item').forEach(item => {
      // mousedown fires before the input's blur so the pick isn't lost.
      item.addEventListener('mousedown', () => {
        const lat = parseFloat(item.dataset.lat), lon = parseFloat(item.dataset.lon);
        addWaypoint(lat, lon, item.dataset.name);
        input.value = '';
        hide();
        map.panTo([lat, lon]);
      });
    });
  });
  input.addEventListener('blur', () => setTimeout(hide, 200));
}
initCarrefourPicker();

// ── Loop "reshape" via-points (Silver) ────────────────────────────────────────
// After a loop is generated the user can add carrefours the loop MUST pass
// through, then regenerate. Rendered with the same cb-stop UI as custom stops.
function viaPinIcon(n) {
  return L.divIcon({
    html: `<div style="background:#f97316;color:white;width:28px;height:28px;border-radius:50% 50% 50% 0;transform:rotate(-45deg);display:flex;align-items:center;justify-content:center;border:3px solid white;box-shadow:0 2px 8px rgba(0,0,0,0.35)"><span style="transform:rotate(45deg);font-weight:800;font-size:0.75rem">${n}</span></div>`,
    iconSize: [28, 28], iconAnchor: [14, 28], className: '',
  });
}

function addLoopVia(lat, lng, name = '') {
  loopVias.push({ lat, lng, name, marker: null });
  renderLoopVias();
}

function removeLoopVia(i) {
  const v = loopVias[i];
  if (v && v.marker) map.removeLayer(v.marker);
  loopVias.splice(i, 1);
  renderLoopVias();
}

function moveLoopVia(i, dir) {
  const j = i + dir;
  if (j < 0 || j >= loopVias.length) return;
  [loopVias[i], loopVias[j]] = [loopVias[j], loopVias[i]];
  renderLoopVias();
}

function renderLoopVias() {
  loopVias.forEach((v, idx) => {
    if (v.marker) map.removeLayer(v.marker);
    v.marker = L.marker([v.lat, v.lng], { icon: viaPinIcon(idx + 1) })
      .addTo(map)
      .bindTooltip(v.name || `Passage ${idx + 1}`);
  });
  const listEl = document.getElementById('loopViaList');
  if (listEl) {
    listEl.innerHTML = loopVias.map((v, idx) => `
      <li class="cb-stop">
        <span class="cb-stop-num cb-stop-num-via">${idx + 1}</span>
        <span class="cb-stop-name">${escapeHtml(v.name || `Point (${v.lat.toFixed(4)}, ${v.lng.toFixed(4)})`)}</span>
        <span class="cb-stop-actions">
          <button type="button" class="cb-stop-btn" data-act="up" data-i="${idx}" title="Monter" ${idx === 0 ? 'disabled' : ''}>↑</button>
          <button type="button" class="cb-stop-btn" data-act="down" data-i="${idx}" title="Descendre" ${idx === loopVias.length - 1 ? 'disabled' : ''}>↓</button>
          <button type="button" class="cb-stop-btn cb-stop-del" data-act="del" data-i="${idx}" title="Supprimer">✕</button>
        </span>
      </li>`).join('');
    listEl.querySelectorAll('.cb-stop-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const i = parseInt(btn.dataset.i, 10);
        const act = btn.dataset.act;
        if (act === 'del') removeLoopVia(i);
        else if (act === 'up') moveLoopVia(i, -1);
        else moveLoopVia(i, 1);
      });
    });
  }
}

function clearLoopVias() {
  loopVias.forEach(v => { if (v.marker) map.removeLayer(v.marker); });
  loopVias = [];
  const listEl = document.getElementById('loopViaList');
  if (listEl) listEl.innerHTML = '';
}

// "＋ Ajouter sur la carte" toggle: arm/disarm map clicks to drop via-points.
function toggleAddViaOnMap() {
  const btn = document.getElementById('btnAddViaMap');
  if (pickingPoint === 'via') {
    pickingPoint = null;
    map.getContainer().style.cursor = '';
    btn?.classList.remove('active');
    if (btn) btn.textContent = '＋ Ajouter sur la carte';
  } else {
    pickingPoint = 'via';
    map.getContainer().style.cursor = 'crosshair';
    btn?.classList.add('active');
    if (btn) btn.textContent = '✓ Clique sur la carte…';
  }
}

// Searchable carrefour picker for loop via-points.
function initLoopViaPicker() {
  const input = document.getElementById('loopViaInput');
  const results = document.getElementById('loopViaResults');
  if (!input || !results) return;
  const norm = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const hide = () => results.classList.add('hidden');

  input.addEventListener('input', () => {
    if (typeof CARREFOURS === 'undefined') return;
    const q = norm(input.value.trim());
    if (q.length < 2) { hide(); return; }
    const matches = CARREFOURS.filter(c => norm(c.name).includes(q)).slice(0, 8);
    if (!matches.length) { hide(); return; }
    results.innerHTML = matches.map(c =>
      `<div class="cb-carrefour-item" data-lat="${c.lat}" data-lon="${c.lon}" data-name="${escapeHtml(c.name)}">${escapeHtml(c.name)}</div>`
    ).join('');
    results.classList.remove('hidden');
    results.querySelectorAll('.cb-carrefour-item').forEach(item => {
      item.addEventListener('mousedown', () => {
        const lat = parseFloat(item.dataset.lat), lon = parseFloat(item.dataset.lon);
        addLoopVia(lat, lon, item.dataset.name);
        input.value = '';
        hide();
        map.panTo([lat, lon]);
      });
    });
  });
  input.addEventListener('blur', () => setTimeout(hide, 200));
}
initLoopViaPicker();
document.getElementById('btnAddViaMap')?.addEventListener('click', toggleAddViaOnMap);
document.getElementById('btnRegenLoop')?.addEventListener('click', () => {
  if (pickingPoint === 'via') toggleAddViaOnMap(); // disarm map-add before regenerating
  document.getElementById('btnGenerate')?.click();
});

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
  // Custom "Sur mesure" stops
  if (waypoints.length) {
    waypoints.forEach(wp => { if (wp.marker) map.removeLayer(wp.marker); });
    waypoints = [];
    renderWaypoints();
  }
  // Loop reshape via-points
  if (loopVias.length) clearLoopVias();
  if (pickingPoint === 'via') { pickingPoint = null; map.getContainer().style.cursor = ''; }
  const btnAddVia = document.getElementById('btnAddViaMap');
  if (btnAddVia) { btnAddVia.classList.remove('active'); btnAddVia.textContent = '＋ Ajouter sur la carte'; }
  document.getElementById('loopPersonalize')?.classList.add('hidden');
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

  let result = null;
  let distanceKm = 10;

  try {
    if (mode === 'custom') {
      // Ordered stops the user placed; optionally close the loop back to stop 1.
      const pts = waypoints.map(w => ({ lat: w.lat, lng: w.lng }));
      if (document.getElementById('cbReturnStart')?.checked && pts.length >= 2) {
        pts.push({ lat: pts[0].lat, lng: pts[0].lng });
      }
      result = await routeCustom(pts);
    } else if (mode === 'loop') {
      const sLat = startMarker.getLatLng().lat;
      const sLng = startMarker.getLatLng().lng;
      distanceKm = parseFloat(document.getElementById('distanceInput').value) || 10;
      if (loopVias.length) {
        // Personalized loop: must pass through every via-point, then back to start.
        // Distance becomes a soft target (a warning shows if it lands far off).
        const pts = [
          { lat: sLat, lng: sLng },
          ...loopVias.map(v => ({ lat: v.lat, lng: v.lng })),
          { lat: sLat, lng: sLng },
        ];
        result = await routeCustom(pts);
      } else {
        result = await routeLoop(sLat, sLng, distanceKm);
      }
    } else {
      const sLat = startMarker.getLatLng().lat;
      const sLng = startMarker.getLatLng().lng;
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

// ── Display route ─────────────────────────────────────────────────────────────
// ── GPX import — bring a Strava/Garmin route onto the graded BWR map ───────────
// Open to every tier (acquisition hook). Reuses displayRoute via mode==='import',
// so imported tracks get the same stats, elevation, save/share and re-export UI.
let importedRouteName = null;

function initGpxImport() {
  const card  = document.getElementById('importGpxCard');
  const btn   = document.getElementById('btnImportGpx');
  const input = document.getElementById('gpxFileInput');
  if (!card || !btn || !input) return;

  // Gate by plan (currently everyone) so future tightening only touches features.js.
  const plan = currentUser?.plan || 'free';
  if (!BWR.can('gpx_import', plan)) { card.classList.add('hidden'); return; }

  btn.addEventListener('click', () => input.click());
  input.addEventListener('change', () => {
    const file = input.files && input.files[0];
    if (file) handleGpxFile(file);
    input.value = ''; // allow re-importing the same file
  });
}

async function handleGpxFile(file) {
  const btn = document.getElementById('btnImportGpx');
  const original = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Lecture…'; }
  try {
    const text = await file.text();
    const { coords, name } = parseGPX(text);

    // Total length from the track geometry (haversineM is global via graph-router.js).
    let meters = 0;
    for (let i = 1; i < coords.length; i++) {
      meters += haversineM(coords[i - 1][0], coords[i - 1][1], coords[i][0], coords[i][1]);
    }
    // Rough duration estimate from the transport mode (imported tracks carry no timing).
    const speed = transportMode === 'bike' ? 4.2 : 1.33; // m/s (~15 / ~4.8 km/h)
    const seconds = meters / speed;

    mode = 'import';
    importedRouteName = String(name).replace(/[^a-z0-9_\- ]+/gi, '_').replace(/\s+/g, '_').slice(0, 60) || 'BWR_import';
    displayRoute({ coords, meters, seconds }, null);
    showToast(`« ${name} » importé — ${(meters / 1000).toFixed(1)} km sur la carte`);
  } catch (err) {
    console.error('GPX import error:', err);
    showToast(err && err.message ? err.message : 'Impossible de lire ce fichier GPX.', 3200);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = original; }
  }
}

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
  const badgeMode    = mode === 'loop' ? '🔄 Boucle'
    : mode === 'custom' ? `🧭 Sur mesure · ${waypoints.length} étapes`
    : mode === 'import' ? '📥 Importé'
    : '➡️ A → B';
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
  const modeLabel = mode === 'loop' ? 'Boucle'
    : mode === 'custom' ? 'Trajet sur mesure'
    : mode === 'import' ? 'Trajet importé'
    : 'Trajet A → B';
  const modeDesc = mode === 'loop'
    ? (loopVias.length
        ? `Le départ et l\'arrivée sont au même point, en passant par tes ${loopVias.length} carrefour${loopVias.length > 1 ? 's' : ''}.`
        : 'Le départ et l\'arrivée sont au même point.')
    : mode === 'custom'
      ? `Le trajet passe par tes ${waypoints.length} étapes, dans l\'ordre choisi.`
      : mode === 'import'
        ? 'Tracé importé depuis ton fichier GPX (Strava, Garmin…), affiché sur la carte BWR.'
        : 'Le trajet relie ton point de départ à ton point d\'arrivée.';
  resumeEl.innerHTML = `
    <p><strong>📋 Résumé</strong></p>
    <p>
      ${modeLabel} de <strong>${distLabel}</strong>
      en <strong>${typeLabel}</strong>, niveau <strong>${diffLabel}</strong>.
      ${modeDesc}
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
  document.getElementById('breakdownWrap')?.classList.add('hidden');

  // Loop "reshape" panel: only for boucles. Silver+ get the carrefour picker;
  // free users get a locked upsell card.
  const lpPanel = document.getElementById('loopPersonalize');
  if (lpPanel) {
    if (mode === 'loop') {
      const canReshape = BWR.can('custom_route_builder', plan);
      document.getElementById('lpPicker')?.classList.toggle('hidden', !canReshape);
      document.getElementById('lpLocked')?.classList.toggle('hidden', canReshape);
      lpPanel.classList.remove('hidden');
    } else {
      lpPanel.classList.add('hidden');
    }
  }

  document.getElementById('routeResult').classList.remove('hidden');
  document.getElementById('routeResult').scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  // Export buttons — gated by plan
  const typeLabelShort = { foot: 'forestier', bike: 'cyclable', champs: 'champs', mix: 'mix' }[pathType];
  const routeName = mode === 'import'
    ? (importedRouteName || 'BWR_import')
    : `BWR_${mode === 'loop' ? 'boucle' : 'atob'}_${typeLabelShort}_${new Date().toISOString().slice(0,10)}`;

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
      const kmlTier = BWR.requiredTier('kml_export');
      btnKML.classList.add('locked-feature');
      btnKML.setAttribute('data-tier', kmlTier);
      btnKML.dataset.featureLabel = 'L\'export KML';
      if (!btnKML.querySelector('.lock-badge')) {
        const b = document.createElement('span');
        b.className = `lock-badge tier-${kmlTier}`;
        b.textContent = kmlTier === 'gold' ? '👑 Or' : '🔒 Argent';
        btnKML.appendChild(b);
      }
      btnKML.onclick = (e) => { e.preventDefault(); showUpgradeModal(kmlTier, 'L\'export KML'); };
    }
  }
  const btnStrava = document.getElementById('btnStrava');
  if (btnStrava) {
    if (BWR.can('strava_komoot_push', plan)) {
      btnStrava.classList.remove('locked-feature');
      btnStrava.onclick = () => pushToStrava(coords, routeName);
    } else {
      btnStrava.classList.add('locked-feature');
      btnStrava.onclick = (e) => { e.preventDefault(); showUpgradeModal(BWR.requiredTier('strava_komoot_push'), 'Le push Strava'); };
    }
  }

  // Way-types & surfaces breakdown — lazy-loaded, available to everyone.
  _loadBreakdown()
    .then(() => renderRouteBreakdown(coords))
    .catch(() => document.getElementById('breakdownWrap')?.classList.add('hidden'));

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
