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
      loginLink.href = 'profile.html';
    }
    const mobileLogin = document.querySelector('.nav-mobile a[href="login.html"]');
    if (mobileLogin) {
      mobileLogin.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/></svg> Mon profil';
      mobileLogin.href = 'profile.html';
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

/* ── Hero live map ───────────────────────────────────────────────────── */
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

  L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
    maxZoom: 17,
  }).addTo(map);

  fetch(API_URL + '/api/paths')
    .then(r => r.ok ? r.json() : [])
    .then(paths => {
      if (!Array.isArray(paths)) return;
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
    })
    .catch(() => {});
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
    status.style.color = '#dc2626';
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
        status.textContent = data.error || 'Erreur serveur. Réessaye ou écris directement à ciril8596@gmail.com.';
      }
      status.style.color = '#dc2626';
      return;
    }
    form.reset();
    status.textContent = '✅ Message envoyé — merci !';
    status.style.color = '#1e4d14';
  } catch {
    status.textContent = 'Impossible de joindre le serveur. Écris directement à ciril8596@gmail.com.';
    status.style.color = '#dc2626';
  } finally {
    btn.textContent = 'Envoyer le message';
    btn.disabled = false;
  }
});
