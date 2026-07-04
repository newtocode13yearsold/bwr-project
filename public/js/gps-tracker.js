// ── Shared GPS distance tracker ───────────────────────────────────────────────
// Drop-in distance counter for any page that has a `#btnGpsTracker` button and
// (optionally) a global Leaflet `map`. km are counted only from real GPS
// movement (watchPosition), not from a generated route — same noise filtering
// as the route-planner tracker (accuracy / min-move / max-speed thresholds).
//
// On stop it adds the session km to `bwr_km_total` and posts them to
// /api/auth/stats (when signed in), mirroring routes.js GpsTracker so totals
// stay consistent across pages. Used by the map and admin pages.
(function () {
  const btn = document.getElementById('btnGpsTracker');
  if (!btn) return;

  const MIN_ACCURACY_M = 25;    // discard fixes with accuracy worse than 25 m
  const MIN_MOVE_KM    = 0.005; // 5 m minimum displacement — filters GPS jitter
  const MAX_SPEED_KMH  = 22;    // max realistic walking/biking speed; discards jumps

  let watchId    = null;
  let lastPos    = null;
  let sessionKm  = 0;
  let active     = false;
  let userMarker = null;

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

  function haversine(lat1, lng1, lat2, lng2) {
    const R    = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a    = Math.sin(dLat / 2) ** 2
               + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180)
               * Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  function fmtKm(km) {
    return km.toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' km';
  }

  function setLabel() {
    btn.textContent = active ? `⏹ ${fmtKm(sessionKm)}` : '▶ Suivi GPS';
    btn.title = active ? 'Terminer le suivi de distance' : 'Compter ma distance parcourue';
  }

  function onPosition(pos) {
    const { latitude, longitude, accuracy } = pos.coords;
    if (accuracy > MIN_ACCURACY_M) return; // wait for a usable fix

    const m = leafletMap();
    if (m) {
      if (!userMarker) {
        userMarker = L.circleMarker([latitude, longitude], {
          radius: 7, color: '#2563eb', fillColor: '#3b82f6',
          fillOpacity: 0.9, weight: 2,
        }).addTo(m).bindTooltip('📍 Vous êtes ici', { permanent: false });
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
      setLabel();
    }
    lastPos = { lat: latitude, lng: longitude, t: pos.timestamp };
  }

  function start() {
    if (!navigator.geolocation) {
      toast('La géolocalisation n\'est pas disponible sur cet appareil.');
      return;
    }
    if (active) return;
    sessionKm = 0;
    lastPos   = null;
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

  function stop() {
    if (!active) return;
    if (watchId !== null) { navigator.geolocation.clearWatch(watchId); watchId = null; }
    active = false;
    btn.classList.remove('tracking');

    const m = leafletMap();
    if (userMarker && m) { m.removeLayer(userMarker); userMarker = null; }

    if (sessionKm >= 0.05) {
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
      toast(`✅ ${fmtKm(sessionKm)} ajoutés à ton total !`);
    } else {
      toast('Balade trop courte — moins de 50 m enregistrés.');
    }
    sessionKm = 0;
    setLabel();
  }

  btn.addEventListener('click', () => { active ? stop() : start(); });
  setLabel();
})();
