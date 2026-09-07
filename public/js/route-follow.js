// route-follow.js — live "guide me" navigation for a planned route.
// Lazy-loaded from the routes page (js/routes.js → _loadRouteFollow) the first
// time the user taps "🧭 Suivre l'itinéraire" on a generated/imported route.
//
// It opens a full-screen navigation HUD with its own Leaflet map, watches the
// live GPS position, and continuously matches it against the planned polyline:
//   • projects the position onto the route to get progress + distance remaining,
//   • measures the perpendicular ("cross-track") distance to warn when the user
//     strays off the trail (with voice + vibration + a "go back" bearing),
//   • pre-computes turn maneuvers from the route geometry and announces the next
//     one ("Dans 150 m, tournez à gauche").
//
// No network at follow-time — every computation is local, so guidance keeps
// working offline in the forest. Reuses the page globals haversineM / bearingDeg
// / bearingDelta (js/graph-router.js, loaded before this file). Exposes
// window.RouteFollow.start(coords, meta).
(function () {
  'use strict';

  // ── Tunables ────────────────────────────────────────────────────────────────
  const OFF_ROUTE_ON_M   = 35;   // trigger "off route" past this cross-track distance
  const OFF_ROUTE_OFF_M  = 20;   // clear it once back within this (hysteresis)
  const ARRIVE_M         = 25;   // "arrived" when this close to the end
  const TURN_MIN_DEG     = 30;   // ignore vertices that bend less than this
  const UTURN_DEG        = 135;  // treat a very sharp bend as a demi-tour
  const REANNOUNCE_MS    = 12000; // min gap between two identical spoken cues
  const DEG_M            = 111320; // metres per degree of latitude (good enough locally)

  let active = false;
  let watchId = null;
  let wakeLock = null;
  let map = null, routeLine = null, userMarker = null, offMarker = null;
  let coords = [], cum = [], totalM = 0, maneuvers = [];
  let follow = true;               // auto-recentre the map on the user
  let voiceOn = true;
  let offRoute = false;
  let lastSpoken = { text: '', t: 0 };
  let spokenTurn = null;           // { along, level } already announced for current turn
  let transportKmh = 4.5;
  let el = {};                     // cached HUD elements

  // ── Geometry helpers ─────────────────────────────────────────────────────────
  function hv(aLat, aLng, bLat, bLng) {
    // Fall back to a local haversine if the graph-router global isn't present.
    if (typeof haversineM === 'function') return haversineM(aLat, aLng, bLat, bLng);
    const R = 6371000, dLat = (bLat - aLat) * Math.PI / 180, dLng = (bLng - aLng) * Math.PI / 180;
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * Math.PI / 180) * Math.cos(bLat * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
  }
  function brg(aLat, aLng, bLat, bLng) {
    if (typeof bearingDeg === 'function') return bearingDeg(aLat, aLng, bLat, bLng);
    const φ1 = aLat * Math.PI / 180, φ2 = bLat * Math.PI / 180, Δλ = (bLng - aLng) * Math.PI / 180;
    const y = Math.sin(Δλ) * Math.cos(φ2);
    const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  }

  // Cumulative distance from the start to each vertex.
  function buildCum(cs) {
    const out = [0];
    for (let i = 1; i < cs.length; i++) out[i] = out[i - 1] + hv(cs[i - 1][0], cs[i - 1][1], cs[i][0], cs[i][1]);
    return out;
  }

  // Project (lat,lng) onto the whole route. Returns the nearest point, the
  // perpendicular (off-route) distance, and the along-route distance at that
  // projection. Uses a local equirectangular plane centred on the query point.
  function project(lat, lng) {
    const latR = lat * Math.PI / 180;
    const kx = DEG_M * Math.cos(latR), ky = DEG_M;
    const px = lng * kx, py = lat * ky;
    let best = { off: Infinity, along: 0, lat, lng };
    for (let i = 0; i < coords.length - 1; i++) {
      const aLng = coords[i][1] * kx, aLat = coords[i][0] * ky;
      const bLng = coords[i + 1][1] * kx, bLat = coords[i + 1][0] * ky;
      const vx = bLng - aLng, vy = bLat - aLat;
      const len2 = vx * vx + vy * vy;
      let t = len2 ? ((px - aLng) * vx + (py - aLat) * vy) / len2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const projLng = aLng + t * vx, projLat = aLat + t * vy;
      const dx = px - projLng, dy = py - projLat;
      const off = Math.sqrt(dx * dx + dy * dy);
      if (off < best.off) {
        const pLat = projLat / ky, pLng = projLng / kx;
        best = { off, along: cum[i] + t * (cum[i + 1] - cum[i]), lat: pLat, lng: pLng };
      }
    }
    return best;
  }

  // Pre-compute turn maneuvers at interior vertices where the heading swings.
  function buildManeuvers(cs) {
    const out = [];
    for (let i = 1; i < cs.length - 1; i++) {
      const b1 = brg(cs[i - 1][0], cs[i - 1][1], cs[i][0], cs[i][1]);
      const b2 = brg(cs[i][0], cs[i][1], cs[i + 1][0], cs[i + 1][1]);
      const signed = ((b2 - b1 + 540) % 360) - 180; // >0 right, <0 left
      const mag = Math.abs(signed);
      if (mag < TURN_MIN_DEG) continue;
      out.push({
        along: cum[i],
        dir: signed > 0 ? 'right' : 'left',
        sharp: mag >= UTURN_DEG,
        slight: mag < 55,
      });
    }
    // Merge maneuvers closer than 25 m — keep the sharper one.
    return out.filter((m, i) => i === 0 || m.along - out[i - 1].along > 25);
  }

  function fmtDist(m) {
    if (m < 950) return Math.round(m / 10) * 10 + ' m';
    return (m / 1000).toFixed(1).replace('.', ',') + ' km';
  }
  function fmtDur(sec) {
    if (!isFinite(sec) || sec <= 0) return '—';
    const h = Math.floor(sec / 3600), min = Math.round((sec % 3600) / 60);
    return h > 0 ? `${h}h${String(min).padStart(2, '0')}` : `${min} min`;
  }
  const COMPASS = ['nord', 'nord-est', 'est', 'sud-est', 'sud', 'sud-ouest', 'ouest', 'nord-ouest'];
  function compass(b) { return COMPASS[Math.round(((b % 360) + 360) % 360 / 45) % 8]; }
  function turnLabel(m) {
    if (m.sharp) return `Demi-tour ${m.dir === 'right' ? 'à droite' : 'à gauche'}`;
    const verb = m.slight ? 'Légèrement à' : 'Tournez à';
    return `${verb} ${m.dir === 'right' ? 'droite' : 'gauche'}`;
  }
  function turnArrow(m) {
    if (m.sharp) return m.dir === 'right' ? '↩' : '↪';
    return m.dir === 'right' ? '↱' : '↰';
  }

  // ── Voice ─────────────────────────────────────────────────────────────────────
  function speak(text) {
    if (!voiceOn || !('speechSynthesis' in window)) return;
    const now = Date.now();
    if (text === lastSpoken.text && now - lastSpoken.t < REANNOUNCE_MS) return;
    lastSpoken = { text, t: now };
    try {
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'fr-FR';
      const v = speechSynthesis.getVoices().find(x => /^fr/i.test(x.lang));
      if (v) u.voice = v;
      speechSynthesis.cancel();
      speechSynthesis.speak(u);
    } catch (_) {}
  }
  function vibrate(pattern) { try { navigator.vibrate && navigator.vibrate(pattern); } catch (_) {} }

  // ── HUD ────────────────────────────────────────────────────────────────────────
  function buildHud() {
    const root = document.createElement('div');
    root.className = 'rf-overlay';
    root.innerHTML = `
      <div class="rf-banner" id="rfBanner">
        <div class="rf-arrow" id="rfArrow">🧭</div>
        <div class="rf-instr">
          <div class="rf-instr-dist" id="rfInstrDist">Acquisition GPS…</div>
          <div class="rf-instr-text" id="rfInstrText">Placez-vous sur le tracé pour démarrer.</div>
        </div>
      </div>
      <div class="rf-map" id="rfMap"></div>
      <div class="rf-acc" id="rfAcc"></div>
      <button class="rf-recenter" id="rfRecenter" title="Recentrer">🎯</button>
      <div class="rf-bottom">
        <div class="rf-progress"><div class="rf-progress-fill" id="rfProgFill"></div></div>
        <div class="rf-stats">
          <div class="rf-stat"><strong id="rfRemain">—</strong><span>restant</span></div>
          <div class="rf-stat"><strong id="rfEta">—</strong><span>arrivée dans</span></div>
          <div class="rf-stat"><strong id="rfPct">0%</strong><span>parcouru</span></div>
        </div>
        <div class="rf-actions">
          <button class="rf-btn rf-voice" id="rfVoice">🔊 Voix</button>
          <button class="rf-btn rf-quit" id="rfQuit">✕ Quitter</button>
        </div>
      </div>`;
    document.body.appendChild(root);
    el = {
      root,
      banner: root.querySelector('#rfBanner'),
      arrow: root.querySelector('#rfArrow'),
      instrDist: root.querySelector('#rfInstrDist'),
      instrText: root.querySelector('#rfInstrText'),
      acc: root.querySelector('#rfAcc'),
      progFill: root.querySelector('#rfProgFill'),
      remain: root.querySelector('#rfRemain'),
      eta: root.querySelector('#rfEta'),
      pct: root.querySelector('#rfPct'),
    };
    root.querySelector('#rfQuit').addEventListener('click', stop);
    root.querySelector('#rfRecenter').addEventListener('click', () => { follow = true; if (userMarker) map.panTo(userMarker.getLatLng()); });
    root.querySelector('#rfVoice').addEventListener('click', (e) => {
      voiceOn = !voiceOn;
      e.currentTarget.classList.toggle('off', !voiceOn);
      e.currentTarget.textContent = voiceOn ? '🔊 Voix' : '🔇 Voix';
      if (!voiceOn && 'speechSynthesis' in window) speechSynthesis.cancel();
    });
  }

  function initMap() {
    map = L.map(el.root.querySelector('#rfMap'), {
      zoomControl: false, attributionControl: false, preferCanvas: true,
    });
    // Same offline-cached topo proxy the planner map uses, so guidance keeps
    // its basemap without a signal.
    L.tileLayer('/tiles/topo/{z}/{x}/{y}.png', { maxNativeZoom: 15, maxZoom: 18 }).addTo(map);
    routeLine = L.polyline(coords, { color: '#22c55e', weight: 6, opacity: 0.95, lineJoin: 'round', lineCap: 'round' }).addTo(map);
    L.polyline(coords, { color: '#ffffff', weight: 10, opacity: 0.35 }).addTo(map).bringToBack();
    // Start / end pins
    L.circleMarker(coords[0], { radius: 6, color: '#fff', weight: 2, fillColor: '#16a34a', fillOpacity: 1 }).addTo(map);
    L.circleMarker(coords[coords.length - 1], { radius: 7, color: '#fff', weight: 2, fillColor: '#ef4444', fillOpacity: 1 }).addTo(map);
    map.fitBounds(routeLine.getBounds(), { padding: [50, 50] });
    // Manual pan disables auto-follow until the user taps recentre.
    map.on('dragstart', () => { follow = false; });
    setTimeout(() => map.invalidateSize(), 60);
  }

  function arrowIcon(heading) {
    const rot = (typeof heading === 'number' && !isNaN(heading)) ? heading : 0;
    return L.divIcon({
      className: 'rf-userdot',
      html: `<div class="rf-userdot-inner" style="transform:rotate(${rot}deg)">
               <svg viewBox="0 0 24 24" width="30" height="30"><path d="M12 2 L19 21 L12 16 L5 21 Z" fill="#2563eb" stroke="#fff" stroke-width="1.5" stroke-linejoin="round"/></svg>
             </div>`,
      iconSize: [30, 30], iconAnchor: [15, 15],
    });
  }

  // ── Position handling ──────────────────────────────────────────────────────────
  function onPosition(pos) {
    const { latitude: lat, longitude: lng, accuracy, heading, speed } = pos.coords;
    el.acc.textContent = accuracy ? `±${Math.round(accuracy)} m` : '';
    el.acc.classList.toggle('poor', accuracy > OFF_ROUTE_ON_M);

    // Marker
    if (!userMarker) userMarker = L.marker([lat, lng], { icon: arrowIcon(heading), zIndexOffset: 1000 }).addTo(map);
    else { userMarker.setLatLng([lat, lng]); userMarker.setIcon(arrowIcon(heading)); }
    if (follow) map.setView([lat, lng], Math.max(map.getZoom(), 16), { animate: true });

    const p = project(lat, lng);
    const remaining = Math.max(0, totalM - p.along);
    const pct = totalM ? Math.min(100, Math.round(p.along / totalM * 100)) : 0;

    // Live speed → ETA (fall back to the transport default).
    const kmh = (typeof speed === 'number' && speed > 0.3) ? speed * 3.6 : transportKmh;
    el.remain.textContent = fmtDist(remaining);
    el.eta.textContent = fmtDur(remaining / (kmh * 1000 / 3600));
    el.pct.textContent = pct + '%';
    el.progFill.style.width = pct + '%';

    // Arrival
    if (remaining <= ARRIVE_M) {
      el.banner.className = 'rf-banner arrived';
      el.arrow.textContent = '🏁';
      el.instrDist.textContent = 'Arrivée';
      el.instrText.textContent = 'Vous êtes arrivé à destination !';
      speak('Vous êtes arrivé à destination.');
      vibrate([200, 100, 200]);
      if (offMarker) { map.removeLayer(offMarker); offMarker = null; }
      return;
    }

    // Off-route detection with hysteresis
    if (!offRoute && p.off > OFF_ROUTE_ON_M) offRoute = true;
    else if (offRoute && p.off < OFF_ROUTE_OFF_M) offRoute = false;

    if (offRoute) {
      const back = compass(brg(lat, lng, p.lat, p.lng));
      el.banner.className = 'rf-banner off';
      el.arrow.textContent = '⚠️';
      el.instrDist.textContent = `Hors itinéraire · ${fmtDist(p.off)}`;
      el.instrText.textContent = `Revenez sur le tracé — vers le ${back}`;
      // Show the shortest way back to the line.
      if (!offMarker) offMarker = L.polyline([[lat, lng], [p.lat, p.lng]], { color: '#ef4444', weight: 3, dashArray: '6 6' }).addTo(map);
      else offMarker.setLatLngs([[lat, lng], [p.lat, p.lng]]);
      speak(`Vous quittez l'itinéraire. Revenez vers le ${back}.`);
      vibrate(300);
      return;
    }
    if (offMarker) { map.removeLayer(offMarker); offMarker = null; }

    // On-route: announce the next maneuver, if any.
    const next = maneuvers.find(m => m.along > p.along + 4);
    el.banner.className = 'rf-banner';
    if (next) {
      const d = next.along - p.along;
      el.arrow.textContent = turnArrow(next);
      el.instrDist.textContent = fmtDist(d);
      el.instrText.textContent = turnLabel(next);
      // Spoken cues at ~200 m, ~60 m and ~15 m before each turn (once per level).
      const level = d <= 20 ? 0 : d <= 70 ? 1 : d <= 220 ? 2 : 3;
      if (level < 3 && (!spokenTurn || spokenTurn.along !== next.along || spokenTurn.level > level)) {
        spokenTurn = { along: next.along, level };
        const lbl = turnLabel(next).toLowerCase();
        speak(level === 0 ? `Maintenant, ${lbl}` : `Dans ${fmtDist(d)}, ${lbl}`);
        if (level === 0) vibrate([120, 60, 120]);
      }
    } else {
      el.arrow.textContent = '⬆️';
      el.instrDist.textContent = fmtDist(remaining);
      el.instrText.textContent = 'Continuez tout droit jusqu\'à l\'arrivée';
    }
  }

  function onError(err) {
    const msgs = { 1: 'Autorisez la localisation pour le guidage.', 2: 'Signal GPS indisponible.', 3: 'Signal GPS trop lent.' };
    el.instrDist.textContent = 'GPS';
    el.instrText.textContent = msgs[err.code] || 'Erreur GPS';
  }

  async function requestWakeLock() {
    try { if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen'); } catch (_) {}
  }
  function onVisible() {
    if (document.visibilityState === 'visible' && active && !wakeLock) requestWakeLock();
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────────
  function start(routeCoords, meta) {
    if (active) return;
    if (!Array.isArray(routeCoords) || routeCoords.length < 2) return;
    if (typeof L === 'undefined') { alert('Carte indisponible.'); return; }
    if (!navigator.geolocation) { alert('La géolocalisation n\'est pas disponible sur cet appareil.'); return; }

    active = true;
    coords = routeCoords.map(c => [c[0], c[1]]);
    cum = buildCum(coords);
    totalM = cum[cum.length - 1];
    maneuvers = buildManeuvers(coords);
    offRoute = false; spokenTurn = null; follow = true; voiceOn = true;
    transportKmh = meta && meta.transportMode === 'bike' ? 15 : 4.5;

    buildHud();
    initMap();
    document.body.classList.add('rf-open');
    requestWakeLock();
    document.addEventListener('visibilitychange', onVisible);
    // Prime the speech engine (some browsers need a first user-gesture-triggered call).
    if ('speechSynthesis' in window) { try { speechSynthesis.getVoices(); } catch (_) {} }
    speak('Guidage démarré. Bonne balade.');

    watchId = navigator.geolocation.watchPosition(onPosition, onError, {
      enableHighAccuracy: true, maximumAge: 2000, timeout: 20000,
    });
  }

  function stop() {
    if (!active) return;
    active = false;
    if (watchId !== null) { navigator.geolocation.clearWatch(watchId); watchId = null; }
    if ('speechSynthesis' in window) speechSynthesis.cancel();
    if (wakeLock) { try { wakeLock.release(); } catch (_) {} wakeLock = null; }
    document.removeEventListener('visibilitychange', onVisible);
    if (map) { map.remove(); map = null; }
    userMarker = offMarker = routeLine = null;
    document.body.classList.remove('rf-open');
    if (el.root) el.root.remove();
    el = {};
  }

  window.RouteFollow = { start, stop, isActive: () => active };
})();
