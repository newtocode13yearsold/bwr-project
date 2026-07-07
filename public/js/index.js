/* ── Sticky nav shadow ───────────────────────────────────────────────── */
const nav = document.getElementById('nav');
if (nav) {
  window.addEventListener('scroll', () => {
    nav.classList.toggle('scrolled', window.scrollY > 20);
  });
}

/* ── Nav drawer (index uses navBurger, not btnNavMenu) ───────────────── */
(function () {
  var overlay  = document.getElementById('navDrawerOverlay');
  var drawer   = document.getElementById('navDrawer');
  var burger   = document.getElementById('navBurger');
  var closeBtn = document.getElementById('btnNavDrawerClose');
  if (!overlay || !drawer || !burger) return;
  function openDrawer() {
    overlay.classList.remove('hidden');
    drawer.classList.remove('hidden');
    requestAnimationFrame(function () {
      overlay.classList.add('open');
      drawer.classList.add('open');
    });
  }
  function closeDrawer() {
    overlay.classList.remove('open');
    drawer.classList.remove('open');
    setTimeout(function () {
      overlay.classList.add('hidden');
      drawer.classList.add('hidden');
    }, 250);
  }
  burger.addEventListener('click', openDrawer);
  if (closeBtn) closeBtn.addEventListener('click', closeDrawer);
  overlay.addEventListener('click', closeDrawer);
  document.addEventListener('keydown', function(e) { if (e.key === 'Escape') closeDrawer(); });
})();

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

/* ── Logged-in detection — swap "Connexion" for "Mon profil" ─────────── */
try {
  const cached = localStorage.getItem('bwr_user');
  if (cached) {
    const user = JSON.parse(cached);
    const loginLink = document.getElementById('navLogin');
    if (loginLink) {
      loginLink.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/></svg> ' + (user.name?.split(' ')[0] || 'Profil');
      loginLink.href = 'profile';
    }
    const mobileLogin = document.querySelector('.nav-mobile a[href="login"]');
    if (mobileLogin) {
      mobileLogin.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/></svg> Mon profil';
      mobileLogin.href = 'profile';
    }
  }
} catch {}

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
    if (e.key === 'ArrowRight') next();
    if (e.key === 'ArrowLeft')  prev();
  });

  render();
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
    attributionControl: false,
    touchZoom: false,
    doubleClickZoom: false,
  });

  window.addEventListener('load', function () { map.invalidateSize(); });

  const _homeTiles = L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
    // maxNativeZoom 15 + crossOrigin: mirror js/map.js so this homepage map reuses
    // the offline-downloaded forest tiles (cached z10–15) instead of going blank.
    maxNativeZoom: 15, maxZoom: 17, subdomains: ['a', 'b', 'c'], crossOrigin: true,
  });
  // Self-heal grey tiles: re-request any tile OpenTopoMap rate-limits (429/403)
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

  fetch(API_URL + '/api/paths')
    .then(r => { if (!r.ok) throw new Error('paths ' + r.status); return r.json(); })
    .then(paths => {
      if (!Array.isArray(paths)) return;

      // Draw map paths
      paths.forEach(path => {
        if (!path.coordinates || path.coordinates.length < 2) return;
        const color = (STATUS_COLORS && STATUS_COLORS[path.status]) || '#22c55e';
        L.polyline(path.coordinates, {
          color,
          weight: 3,
          opacity: 0.85,
          lineJoin: 'round',
        }).addTo(map);
      });

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
    .catch(() => {});
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
    status.textContent = `Impossible de joindre le serveur. Écris directement à ${CONTACT_EMAIL}.`;
    status.style.color = '#fca5a5';
  } finally {
    btn.textContent = 'Envoyer le message';
    btn.disabled = false;
  }
});
