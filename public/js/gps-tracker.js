// ── Shared GPS distance tracker + activity recorder ───────────────────────────
// Drop-in tracker for any page that has a `#btnGpsTracker` button and
// (optionally) a global Leaflet `map`. km are counted only from real GPS
// movement (watchPosition), not from a generated route — same noise filtering
// as the route-planner tracker (accuracy / min-move / max-speed thresholds).
//
// It now ALSO records the track itself (points + timestamps + GPS altitude when
// available). On stop it (1) adds the session km to `bwr_km_total` and posts them
// to /api/auth/stats (mirroring routes.js GpsTracker so totals stay consistent),
// and (2) offers to save the walk as a named activity in the hike journal
// (POST /api/activities) — the Strava-style "record → save → replay later" loop.
// Used by the map and admin pages.
(function () {
  const btn = document.getElementById('btnGpsTracker');
  if (!btn) return;

  const ELE_THRESHOLD_M = 3;    // ignore altitude wobble below 3 m when summing ascent/descent

  let watchId    = null;
  let gps        = null;  // Kalman distance filter (js/gps-filter.js)
  let sessionKm  = 0;
  let active     = false;
  let userMarker = null;
  let track      = [];   // [{ lat, lng, ele: number|null, t: epoch-ms }]
  let startedAt  = null;

  function leafletMap() {
    const m = window.map;
    return (m && typeof m.addLayer === 'function') ? m : null;
  }

  function toast(msg) {
    if (typeof window.showToast === 'function') { window.showToast(msg); return; }
    let el = document.getElementById('gpsTrackerToast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'gpsTrackerToast';
      el.className = 'gps-tracker-toast';
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.classList.add('visible');
    clearTimeout(el._timer);
    el._timer = setTimeout(() => el.classList.remove('visible'), 3200);
  }

  function fmtKm(km) {
    return km.toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' km';
  }

  function setLabel() {
    btn.textContent = active ? `⏹ ${fmtKm(sessionKm)}` : '▶ Suivi GPS';
    btn.title = active ? 'Terminer le suivi de distance' : 'Compter ma distance parcourue';
  }

  function onPosition(pos) {
    const { latitude, longitude, accuracy, altitude } = pos.coords;
    const ele = Number.isFinite(altitude) ? altitude : null;

    // Kalman-smooth the fix + decide how much real distance it adds.
    const r = gps.push(latitude, longitude, accuracy, pos.timestamp);
    if (!r.accepted) return; // fix too vague — wait for a usable one

    // Draw the marker at the SMOOTHED position, not the raw jittery one.
    const m = leafletMap();
    if (m) {
      if (!userMarker) {
        userMarker = L.circleMarker([r.lat, r.lng], {
          radius: 7, color: '#2563eb', fillColor: '#3b82f6',
          fillOpacity: 0.9, weight: 2,
        }).addTo(m).bindTooltip('📍 Vous êtes ici', { permanent: false });
      } else {
        userMarker.setLatLng([r.lat, r.lng]);
      }
    }

    // Seed the recorded track on the first accepted fix so replay/GPX has a start.
    if (track.length === 0) {
      track.push({ lat: r.lat, lng: r.lng, ele, t: pos.timestamp });
      return;
    }

    if (r.added <= 0) return; // no real movement counted this tick

    sessionKm = gps.totalKm;
    track.push({ lat: r.lat, lng: r.lng, ele, t: pos.timestamp });
    setLabel();
  }

  function start() {
    if (!navigator.geolocation) {
      toast('La géolocalisation n\'est pas disponible sur cet appareil.');
      return;
    }
    if (active) return;
    if (typeof createGpsDistanceFilter !== 'function') {
      toast('Suivi GPS indisponible — rechargez la page.');
      return;
    }
    sessionKm = 0;
    gps       = createGpsDistanceFilter();
    track     = [];
    startedAt = new Date().toISOString();
    active    = true;
    btn.classList.add('tracking');
    setLabel();
    toast('🏃 Suivi démarré — bonne balade !');

    watchId = navigator.geolocation.watchPosition(
      onPosition,
      err => {
        const msgs = { 1: 'Permission refusée', 2: 'Signal GPS indisponible', 3: 'Délai dépassé' };
        toast(msgs[err.code] || 'Erreur GPS');
      },
      { enableHighAccuracy: true, maximumAge: 4000, timeout: 15000 }
    );
  }

  // Cumulative ascent / descent from the recorded GPS altitudes, ignoring wobble
  // below ELE_THRESHOLD_M. Returns { ascent, descent } in whole metres; both 0
  // when the device gave no altitude data.
  function elevationStats(pts) {
    let ascent = 0, descent = 0, ref = null;
    for (const p of pts) {
      if (p.ele == null) continue;
      if (ref == null) { ref = p.ele; continue; }
      const d = p.ele - ref;
      if (d >= ELE_THRESHOLD_M) { ascent += d; ref = p.ele; }
      else if (d <= -ELE_THRESHOLD_M) { descent += -d; ref = p.ele; }
    }
    return { ascent: Math.round(ascent), descent: Math.round(descent) };
  }

  // Moving time = sum of gaps between recorded points, capped per-gap so a long
  // pause (phone in pocket, coffee break) doesn't inflate the total.
  function movingSeconds(pts) {
    let s = 0;
    for (let i = 1; i < pts.length; i++) {
      const gap = (pts[i].t - pts[i - 1].t) / 1000;
      if (gap > 0) s += Math.min(gap, 30);
    }
    return Math.round(s);
  }

  function persistKm() {
    const prev = parseFloat(localStorage.getItem('bwr_km_total') || '0');
    localStorage.setItem('bwr_km_total', (prev + sessionKm).toFixed(2));
    const hasAuth = typeof getToken === 'function' && getToken();
    if (hasAuth && typeof API_URL !== 'undefined') {
      fetch(`${API_URL}/api/auth/stats`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeader() },
        body: JSON.stringify({ routes: 0, km: parseFloat(sessionKm.toFixed(2)) }),
      }).catch(() => {});
    }
  }

  function stop() {
    if (!active) return;
    if (watchId !== null) { navigator.geolocation.clearWatch(watchId); watchId = null; }
    active = false;
    btn.classList.remove('tracking');

    const m = leafletMap();
    if (userMarker && m) { m.removeLayer(userMarker); userMarker = null; }

    const finishedTrack = track.slice();
    const finishedKm    = gps ? gps.totalKm : sessionKm;
    const finishedStart = startedAt;

    if (finishedKm >= 0.05) {
      persistKm();
      toast(`✅ ${fmtKm(finishedKm)} ajoutés à votre total !`);
      // Offer to keep it as a journal entry (signed-in users only).
      const hasAuth = typeof getToken === 'function' && getToken();
      if (hasAuth && finishedTrack.length >= 2) {
        setTimeout(() => offerSave(finishedTrack, finishedKm, finishedStart), 400);
      }
    } else {
      toast('Balade trop courte — moins de 50 m enregistrés.');
    }
    sessionKm = 0;
    gps = null;
    track = [];
    startedAt = null;
    setLabel();
  }

  // ── Save-to-journal modal ────────────────────────────────────────────────────
  function offerSave(pts, km, startIso) {
    const durationS = pts.length >= 2 ? Math.round((pts[pts.length - 1].t - pts[0].t) / 1000) : 0;
    const { ascent, descent } = elevationStats(pts);
    const defaultName = `Sortie du ${new Date(startIso).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' })}`;

    const overlay = document.createElement('div');
    overlay.className = 'gps-save-overlay';
    Object.assign(overlay.style, {
      position: 'fixed', inset: '0', zIndex: '99999',
      background: 'rgba(11,36,16,0.55)', display: 'flex',
      alignItems: 'center', justifyContent: 'center', padding: '20px',
    });

    const card = document.createElement('div');
    Object.assign(card.style, {
      background: '#fff', borderRadius: '16px', padding: '24px',
      width: '100%', maxWidth: '420px', boxShadow: '0 20px 60px -20px rgba(0,0,0,0.4)',
      fontFamily: 'var(--font-sans, Inter, system-ui, sans-serif)', color: '#1f2937',
    });

    const h = document.createElement('h3');
    h.textContent = '🥾 Enregistrer cette sortie ?';
    Object.assign(h.style, { margin: '0 0 6px', fontSize: '1.25rem', color: '#0b2410', fontFamily: 'var(--font-display, Fraunces, serif)' });

    const stat = document.createElement('p');
    stat.textContent = `${fmtKm(km)} · ${fmtDuration(durationS)}${ascent ? ` · ↑ ${ascent} m` : ''}`;
    Object.assign(stat.style, { margin: '0 0 16px', fontSize: '0.95rem', color: '#4b5563', fontWeight: '600' });

    const label = document.createElement('label');
    label.textContent = 'Nom de la sortie';
    Object.assign(label.style, { display: 'block', fontSize: '0.78rem', fontWeight: '700', textTransform: 'uppercase', letterSpacing: '0.04em', color: '#0b2410', marginBottom: '6px' });

    const input = document.createElement('input');
    input.type = 'text';
    input.value = defaultName;
    input.maxLength = 80;
    Object.assign(input.style, {
      width: '100%', boxSizing: 'border-box', border: '1.5px solid #e2e8da',
      borderRadius: '10px', padding: '10px 14px', fontSize: '1rem', marginBottom: '18px', outline: 'none',
    });

    // Share-with-followers opt-in (social feed — worker/handlers/friends.js).
    const shareRow = document.createElement('label');
    Object.assign(shareRow.style, { display: 'flex', alignItems: 'center', gap: '9px', cursor: 'pointer', margin: '0 0 18px', fontSize: '0.88rem', color: '#374151', fontWeight: '600' });
    const shareChk = document.createElement('input');
    shareChk.type = 'checkbox';
    Object.assign(shareChk.style, { width: '17px', height: '17px', accentColor: '#1e4d14', cursor: 'pointer' });
    const shareTxt = document.createElement('span');
    shareTxt.textContent = '👥 Partager avec mes abonnés';
    shareRow.append(shareChk, shareTxt);

    const actions = document.createElement('div');
    Object.assign(actions.style, { display: 'flex', gap: '10px', justifyContent: 'flex-end' });

    const skip = document.createElement('button');
    skip.type = 'button';
    skip.textContent = 'Ne pas garder';
    Object.assign(skip.style, { background: '#f3f4f0', color: '#374151', border: 'none', borderRadius: '10px', padding: '10px 18px', fontSize: '0.9rem', fontWeight: '600', cursor: 'pointer' });

    const save = document.createElement('button');
    save.type = 'button';
    save.textContent = 'Enregistrer';
    Object.assign(save.style, { background: '#1e4d14', color: '#a3e635', border: 'none', borderRadius: '10px', padding: '10px 22px', fontSize: '0.9rem', fontWeight: '700', cursor: 'pointer' });

    const close = () => { document.body.removeChild(overlay); };
    skip.addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

    save.addEventListener('click', async () => {
      save.disabled = true;
      save.textContent = 'Enregistrement…';
      const hasEle = pts.some(p => p.ele != null);
      const payload = {
        name: input.value.trim() || defaultName,
        coords: pts.map(p => [p.lat, p.lng]),
        elevations: hasEle ? pts.map(p => (p.ele == null ? 0 : p.ele)) : undefined,
        times: pts.map(p => p.t),
        meters: Math.round(km * 1000),
        seconds: durationS,
        movingSeconds: movingSeconds(pts),
        ascent, descent,
        startedAt: startIso,
        shared: shareChk.checked,
      };
      try {
        const res = await fetch(`${API_URL}/api/activities`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeader() },
          body: JSON.stringify(payload),
        });
        if (!res.ok) throw new Error('save failed');
        close();
        toast('📓 Sortie ajoutée à votre journal !');
      } catch {
        save.disabled = false;
        save.textContent = 'Réessayer';
        toast('Échec de l\'enregistrement — réessayez.');
      }
    });

    actions.append(skip, save);
    card.append(h, stat, label, input, shareRow, actions);
    overlay.append(card);
    document.body.appendChild(overlay);
    input.focus();
    input.select();
  }

  function fmtDuration(s) {
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
    if (h > 0) return `${h} h ${String(m).padStart(2, '0')}`;
    return `${m} min`;
  }

  btn.addEventListener('click', () => { active ? stop() : start(); });
  setLabel();
})();
