/* Nav drawer + hamburger are built and wired by js/ui-shared.js (grouped,
   labelled sections), shared with every other page. */

/* ── Smooth scroll for anchor links ──────────────────────────────────── */
document.querySelectorAll('a[href^="#"]').forEach(a => {
  a.addEventListener('click', e => {
    const target = document.querySelector(a.getAttribute('href'));
    if (target) { e.preventDefault(); target.scrollIntoView({ behavior: 'smooth' }); }
  });
});

/* ── Fade-in on scroll ───────────────────────────────────────────────── */
const observer = new IntersectionObserver(entries => {
  entries.forEach(entry => {
    if (entry.isIntersecting) entry.target.classList.add('visible');
  });
}, { threshold: 0.12 });
document.querySelectorAll('.feature-card, .step-item, .about-inner, .contact-inner').forEach(el => {
  el.classList.add('fade-up');
  observer.observe(el);
});

/* ── "Dernière vérif. terrain" — auto-set to the current month ─────────── */
/* Written in JS so the homepage never shows a stale month and looks abandoned.
   Uses an abbreviated French month + year, e.g. "sept. 2026". */
(function () {
  var hero = document.getElementById('heroStatCheck');
  var faq  = document.getElementById('faqCheckDate');
  if (!hero && !faq) return;
  try {
    var txt = new Date().toLocaleDateString('fr-FR', { month: 'short', year: 'numeric' });
    var pretty = txt.charAt(0).toUpperCase() + txt.slice(1);
    if (hero) hero.textContent = pretty;
    // FAQ uses the long month form for a full sentence, e.g. "septembre 2026".
    if (faq) {
      var long = new Date().toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' });
      faq.textContent = long;
    }
  } catch {}
})();

/* ── Feature carousel ────────────────────────────────────────────────── */
(function () {
  var track  = document.getElementById('fcarouselTrack');
  if (!track) return;
  var slides = Array.from(track.querySelectorAll('.fcarousel-slide'));
  var dots   = Array.from(document.querySelectorAll('.fcar-dot'));
  var total  = slides.length;
  var cur    = 0;

  function render() {
    slides.forEach(function (sl, i) {
      var offset = ((i - cur) % total + total) % total;
      if (offset === 0)                sl.dataset.state = 'center';
      else if (offset === 1)           sl.dataset.state = 'right';
      else if (offset === total - 1)   sl.dataset.state = 'left';
      else if (offset < total / 2)     sl.dataset.state = 'hidden-right';
      else                             sl.dataset.state = 'hidden-left';
    });
    dots.forEach(function (d, i) { d.classList.toggle('active', i === cur); });
  }

  function goTo(idx) {
    cur = ((idx % total) + total) % total;
    render();
  }

  function next() { goTo(cur + 1); }
  function prev() { goTo(cur - 1); }

  slides.forEach(function (sl) {
    sl.addEventListener('click', function () {
      if (sl.dataset.state === 'right') next();
      else if (sl.dataset.state === 'left') prev();
    });
  });

  dots.forEach(function (d) {
    d.addEventListener('click', function () { goTo(+d.dataset.goto); });
  });

  var touchX = null;
  track.addEventListener('touchstart', function (e) {
    touchX = e.touches[0].clientX;
  }, { passive: true });
  track.addEventListener('touchend', function (e) {
    if (touchX === null) return;
    var dx = e.changedTouches[0].clientX - touchX;
    if (Math.abs(dx) > 40) dx < 0 ? next() : prev();
    touchX = null;
  }, { passive: true });

  var dragX = null;
  track.addEventListener('mousedown', function (e) { dragX = e.clientX; });
  window.addEventListener('mouseup', function (e) {
    if (dragX === null) return;
    var dx = e.clientX - dragX;
    if (Math.abs(dx) > 40) dx < 0 ? next() : prev();
    dragX = null;
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'ArrowRight') { next(); start(); }
    if (e.key === 'ArrowLeft')  { prev(); start(); }
  });

  /* Autoplay: advance every few seconds, but only while the carousel is on
     screen, the tab is visible and the visitor isn't hovering/focusing it.
     Any manual move restarts the countdown so it never jumps right after a click. */
  var AUTOPLAY_MS = 4500;
  var timer = null, hovering = false, onScreen = false;
  var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var root = document.getElementById('fcarousel') || track;

  function stop() { if (timer) { clearInterval(timer); timer = null; } }
  function start() {
    stop();
    if (reduceMotion || hovering || !onScreen || document.hidden) return;
    timer = setInterval(next, AUTOPLAY_MS);
  }

  root.addEventListener('mouseenter', function () { hovering = true;  stop(); });
  root.addEventListener('mouseleave', function () { hovering = false; start(); });
  root.addEventListener('focusin',  function () { hovering = true;  stop(); });
  root.addEventListener('focusout', function () { hovering = false; start(); });
  track.addEventListener('touchend', start, { passive: true });
  dots.forEach(function (d) { d.addEventListener('click', start); });
  document.addEventListener('visibilitychange', start);
  if ('IntersectionObserver' in window) {
    new IntersectionObserver(function (entries) {
      onScreen = entries[0].isIntersecting;
      start();
    }, { threshold: 0.3 }).observe(root);
  } else {
    onScreen = true;
  }

  render();
  start();
})();

/* ── Hero live map + live stats ──────────────────────────────────────── */
(function () {
  const heroMapEl = document.getElementById('heroMap');
  if (!heroMapEl) return;

  const map = L.map('heroMap', {
    center: MAP_CENTER,
    zoom: MAP_ZOOM,
    zoomControl: false,
    scrollWheelZoom: false,
    dragging: true,
    attributionControl: true,
    touchZoom: false,
    doubleClickZoom: false,
  });
  map.attributionControl.setPrefix(false);

  window.addEventListener('load', function () { map.invalidateSize(); });

  const _homeTiles = L.tileLayer('/tiles/ign/{z}/{x}/{y}.png', {
    // Edge-cached IGN proxy (see worker/handlers/tiles.js). Same-origin, so no
    // subdomains/crossOrigin. maxNativeZoom 15 mirrors js/map.js so this homepage
    // map reuses the offline-downloaded forest tiles (cached z10–15).
    maxNativeZoom: 15, maxZoom: 17,
    attribution: '© IGN',
  });
  // If the same-origin proxy isn't there at all (static preview, proxy outage),
  // switch once to IGN's public WMTS directly so the hero never stays blank.
  let _homeDirect = false;
  function useDirectIgn() {
    if (_homeDirect) return;
    _homeDirect = true;
    map.removeLayer(_homeTiles);
    L.tileLayer('https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0' +
      '&LAYER=GEOGRAPHICALGRIDSYSTEMS.PLANIGNV2&STYLE=normal&FORMAT=image/png' +
      '&TILEMATRIXSET=PM&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}', {
      maxZoom: 17, attribution: '© IGN',
    }).addTo(map);
  }
  fetch('/tiles/ign/13/4162/2801.png')
    .then(r => { if (!r.ok || !(r.headers.get('content-type') || '').startsWith('image/')) useDirectIgn(); })
    .catch(useDirectIgn);
  // Self-heal grey tiles: re-request any tile the proxy/upstream throttles (429/403)
  // with a growing backoff, since Leaflet otherwise leaves it permanently grey.
  const _homeRetryDelays = [600, 1500, 3000, 5000];
  _homeTiles.on('tileerror', (e) => {
    const img = e.tile; if (!img) return;
    const tries = img._bwrRetries || 0;
    if (tries >= _homeRetryDelays.length) return;
    img._bwrRetries = tries + 1;
    const base = (img.src || '').replace(/[?&]bwrRetry=\d+/, '');
    setTimeout(() => { img.src = base + (base.includes('?') ? '&' : '?') + 'bwrRetry=' + (tries + 1); }, _homeRetryDelays[tries]);
  });
  _homeTiles.addTo(map);

  function haversine(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  function countUp(el, target, duration) {
    const steps = 30;
    const stepMs = duration / steps;
    let step = 0;
    const timer = setInterval(() => {
      step++;
      const t = Math.min(step / steps, 1);
      el.textContent = Math.round(t * target);
      if (step >= steps) clearInterval(timer);
    }, stepMs);
  }

  // Fallback when the API is unreachable or empty (e.g. a local preview with an
  // empty KV): draw the pre-baked OSM forest network around the map centre so
  // the hero still shows the real forest trails.
  function drawForestFallback() {
    fetch('data/forest-paths.json')
      .then(r => { if (!r.ok) throw new Error('forest ' + r.status); return r.json(); })
      .then(list => {
        const view = L.latLngBounds([MAP_CENTER[0] - 0.035, MAP_CENTER[1] - 0.06], [MAP_CENTER[0] + 0.035, MAP_CENTER[1] + 0.06]);
        const lines = [];
        (Array.isArray(list) ? list : []).forEach(p => {
          const c = p && p.coordinates;
          if (!c || c.length < 2 || !view.contains(c[0])) return;
          lines.push(L.polyline(c, { color: '#22c55e', weight: 2, opacity: 0.85, lineJoin: 'round', interactive: false }));
        });
        if (!lines.length) return;
        L.featureGroup(lines).addTo(map);
        map.fitBounds(view);
      })
      .catch(() => {});
  }

  fetch(API_URL + '/api/paths')
    .then(r => { if (!r.ok) throw new Error('paths ' + r.status); return r.json(); })
    .then(paths => {
      if (!Array.isArray(paths)) { drawForestFallback(); return; }

      // Draw map paths
      const drawn = [];
      paths.forEach(path => {
        if (!path.coordinates || path.coordinates.length < 2) return;
        const color = (typeof colorForPath === 'function') ? colorForPath(path) : ((STATUS_COLORS && STATUS_COLORS[path.status]) || '#22c55e');
        drawn.push(L.polyline(path.coordinates, {
          color,
          weight: 1.75,
          opacity: 0.95,
          lineJoin: 'round',
        }).addTo(map));
      });
      // Frame the curated paths inside the Compiègne forest so the mini-map shows
      // them up close — a single stray path elsewhere must not zoom out to a region view.
      const fb = L.latLngBounds([FOREST_BOUNDS.minLat, FOREST_BOUNDS.minLng], [FOREST_BOUNDS.maxLat, FOREST_BOUNDS.maxLng]);
      const inForest = drawn.filter(l => fb.contains(l.getBounds().getCenter()));
      if (inForest.length) {
        // Zoom in close and centre on the densest cluster of trails: the path
        // midpoint with the most other midpoints within ~2 km. (A plain average
        // lands in the empty gap between two clusters.)
        const mids = inForest.map(l => l.getBounds().getCenter());
        let best = mids[0], bestN = -1;
        mids.forEach(a => {
          let n = 0;
          mids.forEach(b => { if (Math.abs(a.lat - b.lat) < 0.018 && Math.abs(a.lng - b.lng) < 0.027) n++; });
          if (n > bestN) { bestN = n; best = a; }
        });
        map.setView(best, 13, { animate: false });
      } else if (!drawn.length) {
        drawForestFallback();
      }

      // Count every graded path with valid geometry
      let totalKm = 0;
      let uniqueCount = 0;
      for (const p of paths) {
        const c = p.coordinates;
        if (!c || c.length < 2) continue;
        uniqueCount++;
        for (let i = 1; i < c.length; i++) totalKm += haversine(c[i - 1][0], c[i - 1][1], c[i][0], c[i][1]);
      }

      // Only overwrite the static HTML fallback when we actually got real data.
      // A slow/failed fetch or an empty response must keep the last-known numbers.
      if (uniqueCount === 0) return;

      const kmEl = document.getElementById('heroStatKm');
      const pathsEl = document.getElementById('heroStatPaths');
      if (kmEl) countUp(kmEl, Math.round(totalKm), 1200);
      if (pathsEl) countUp(pathsEl, uniqueCount, 1200);
    })
    .catch(drawForestFallback);
})();

/* ── PWA install prompt ──────────────────────────────────────────────── */
(function () {
  var DISMISS_KEY = 'bwr_install_dismissed';
  var banner = document.getElementById('installBanner');
  var bannerBtn = document.getElementById('installBannerBtn');
  var bannerDismiss = document.getElementById('installBannerDismiss');
  var iosModal = document.getElementById('iosGuideModal');
  var iosClose = document.getElementById('iosGuideClose');
  if (!banner) return;

  // Don't show if already installed or previously dismissed within 7 days
  function isDismissed() {
    try {
      var ts = localStorage.getItem(DISMISS_KEY);
      return ts && (Date.now() - +ts < 7 * 24 * 60 * 60 * 1000);
    } catch { return false; }
  }
  function saveDismiss() {
    try { localStorage.setItem(DISMISS_KEY, Date.now()); } catch {}
  }

  var isStandalone = window.navigator.standalone === true ||
    window.matchMedia('(display-mode: standalone)').matches;
  if (isStandalone || isDismissed()) return;

  var isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  var isAndroidChrome = /android/i.test(navigator.userAgent) && /chrome/i.test(navigator.userAgent);
  var deferredPrompt = null;

  function showBanner() {
    banner.removeAttribute('hidden');
  }

  function hideBanner() {
    banner.setAttribute('hidden', '');
  }

  function showIosModal() {
    iosModal.removeAttribute('hidden');
    iosModal.style.opacity = '0';
    requestAnimationFrame(function () { iosModal.style.opacity = '1'; });
    document.body.style.overflow = 'hidden';
  }

  function hideIosModal() {
    iosModal.style.opacity = '0';
    setTimeout(function () {
      iosModal.setAttribute('hidden', '');
      document.body.style.overflow = '';
    }, 250);
  }

  // Android: capture deferred prompt
  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    deferredPrompt = e;
    setTimeout(showBanner, 3000);
  });

  // iOS Safari: show banner with guide
  if (isIOS && !isStandalone) {
    var isSafari = /safari/i.test(navigator.userAgent) && !/crios|fxios|opios/i.test(navigator.userAgent);
    if (isSafari) {
      setTimeout(showBanner, 3000);
      bannerBtn.textContent = 'Comment installer';
    }
  }

  bannerBtn.addEventListener('click', function () {
    if (deferredPrompt) {
      deferredPrompt.prompt();
      deferredPrompt.userChoice.then(function (result) {
        deferredPrompt = null;
        hideBanner();
        saveDismiss();
      });
    } else if (isIOS) {
      hideBanner();
      showIosModal();
    }
  });

  bannerDismiss.addEventListener('click', function () {
    hideBanner();
    saveDismiss();
  });

  if (iosClose) {
    iosClose.addEventListener('click', function () {
      hideIosModal();
      saveDismiss();
    });
  }

  // Close modal on backdrop click
  if (iosModal) {
    iosModal.addEventListener('click', function (e) {
      if (e.target === iosModal) {
        hideIosModal();
        saveDismiss();
      }
    });
  }

  // Hide install prompt once installed
  window.addEventListener('appinstalled', function () {
    hideBanner();
    deferredPrompt = null;
  });
})();

/* ── "Installer l'application" entry in the nav drawer (mirrors map menu) ── */
(function () {
  var btn = document.getElementById('btnInstallApp');
  if (!btn) return;
  var isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  var isStandalone = window.navigator.standalone === true ||
    window.matchMedia('(display-mode: standalone)').matches;
  if (isStandalone) return; // already installed — leave the entry hidden
  var iosModal = document.getElementById('iosGuideModal');
  var deferred = null;

  function reveal() { btn.style.display = ''; }

  // iOS can't fire beforeinstallprompt — show the entry and the manual guide.
  if (isIOS) reveal();

  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    deferred = e;
    reveal();
  });

  btn.addEventListener('click', function () {
    if (deferred) {
      deferred.prompt();
      deferred.userChoice.then(function () { deferred = null; btn.style.display = 'none'; });
    } else if (isIOS && iosModal) {
      iosModal.removeAttribute('hidden');
      iosModal.style.opacity = '0';
      requestAnimationFrame(function () { iosModal.style.opacity = '1'; });
      document.body.style.overflow = 'hidden';
    }
  });

  window.addEventListener('appinstalled', function () { btn.style.display = 'none'; });
})();

/* ── Contact form submission ─────────────────────────────────────────── */
const form = document.getElementById('contactForm');
form?.addEventListener('submit', async e => {
  e.preventDefault();
  const name    = document.getElementById('cName').value.trim();
  const email   = document.getElementById('cEmail').value.trim();
  const message = document.getElementById('cMessage').value.trim();
  const btn     = document.getElementById('cSubmit');
  const status  = document.getElementById('cStatus');
  if (!name || !email || !message) {
    status.textContent = 'Tous les champs sont obligatoires.';
    status.style.color = '#fca5a5';
    return;
  }
  btn.textContent = 'Envoi…';
  btn.disabled = true;
  try {
    const res = await fetch(`${API_URL}/api/contact`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, email, message }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      if (res.status === 429) {
        status.textContent = 'Limite atteinte — 2 messages max par heure. Réessaye plus tard.';
      } else {
        status.textContent = data.error || `Erreur serveur. Réessaye ou écris directement à ${CONTACT_EMAIL}.`;
      }
      status.style.color = '#fca5a5';
      return;
    }
    form.reset();
    status.textContent = '✅ Message envoyé — merci !';
    status.style.color = '#a3e635';
  } catch {
    status.textContent = `Impossible de joindre le serveur. Écrivez directement à ${CONTACT_EMAIL}.`;
    status.style.color = '#fca5a5';
  } finally {
    btn.textContent = 'Envoyer le message';
    btn.disabled = false;
  }
});
