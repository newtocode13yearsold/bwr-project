// map-planner.js — the "Planifier" drawer on the Carte page.
//
// The route planner used to be its own page (routes.html). It now opens as a
// slide-out drawer over the map: the whole planner (AI planner, quick loop,
// steps 1-4, GPS tracker, GPX import, results, saved routes) is loaded into an
// <iframe> that covers the map area, so it keeps its own map + scripts and none
// of its globals clash with the map page's. js/routes-embed.js, loaded inside
// the frame, hides the planner's own header and talks back to us via
// postMessage (close button / Échap → hand the map view back).
//
// Entry points: the "Planifier" tab on the map, and every "Planifier" link
// in the app, which now points at `map?plan=1` (intercepted here so the drawer
// opens without a page reload). Deep-link params (share, lat/lng best tour,
// start) are forwarded to the planner.
(function () {
  var FORWARD = ['share', 'lat', 'lng', 'distance', 'mode', 'type', 'diff', 'start'];

  var drawer = null;
  var frame = null;
  var isOpen = false;

  function build() {
    if (drawer) return;
    drawer = document.createElement('div');
    drawer.className = 'planner-drawer';
    drawer.id = 'plannerDrawer';
    drawer.setAttribute('role', 'dialog');
    drawer.setAttribute('aria-label', 'Planifier un trajet');
    drawer.innerHTML = '<div class="planner-drawer-loading">Chargement du planificateur…</div>';
    document.body.appendChild(drawer);
  }

  function placeDrawer() {
    if (!drawer) return;
    var header = document.querySelector('.header');
    var top = header ? Math.max(0, header.getBoundingClientRect().bottom) : 0;
    drawer.style.top = top + 'px';
  }

  function plannerUrl() {
    var src = new URLSearchParams(location.search);
    var out = new URLSearchParams();
    out.set('embed', '1');
    FORWARD.forEach(function (k) { if (src.has(k)) out.set(k, src.get(k)); });
    if (typeof map !== 'undefined' && map && map.getCenter) {
      var c = map.getCenter();
      out.set('c', c.lat.toFixed(5) + ',' + c.lng.toFixed(5) + ',' + map.getZoom());
    }
    return 'routes?' + out.toString();
  }

  // Strip plan=1 + forwarded params from the address bar (or add plan=1).
  function setUrl(open) {
    try {
      var p = new URLSearchParams(location.search);
      if (open) p.set('plan', '1');
      else { p.delete('plan'); FORWARD.forEach(function (k) { p.delete(k); }); }
      var qs = p.toString();
      history.replaceState(history.state, '', location.pathname + (qs ? '?' + qs : '') + location.hash);
    } catch (e) {}
  }

  // Header strip + bottom nav: highlight "Planifier"/"Trajets" while the drawer
  // is open, "Carte" otherwise.
  function markNav(open) {
    document.querySelectorAll('.header-nav-links a, .bottom-nav a').forEach(function (a) {
      var href = a.getAttribute('href');
      var on;
      if (href === 'map?plan=1') on = open;
      else if (href === 'map') on = !open;
      else return;
      a.classList.toggle('active', on);
      if (on) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    });
  }

  function goLogin() {
    try {
      sessionStorage.setItem('bwr_redirect', new URL('map?plan=1', location.href).href);
      sessionStorage.setItem('bwr_login_notice', 'Le planificateur nécessite un compte gratuit.');
    } catch (e) {}
    location.href = 'login?signup=1';
  }

  function open() {
    var token = null;
    try { token = localStorage.getItem('bwr_token'); } catch (e) {}
    if (!token) { goLogin(); return; }

    build();
    placeDrawer();
    if (!frame) {
      frame = document.createElement('iframe');
      frame.className = 'planner-drawer-frame';
      frame.title = 'Planificateur de trajet';
      frame.setAttribute('allow', 'geolocation');
      frame.addEventListener('load', onFrameLoad);
      frame.src = plannerUrl();
      drawer.appendChild(frame);
    } else {
      notifyFrame();
    }
    isOpen = true;
    drawer.classList.add('open');
    document.body.classList.add('planner-open');
    document.querySelectorAll('.js-open-planner').forEach(function (b) { b.setAttribute('aria-expanded', 'true'); });
    setUrl(true);
    markNav(true);
  }

  function close(view) {
    if (!isOpen) return;
    isOpen = false;
    drawer.classList.remove('open');
    document.body.classList.remove('planner-open');
    document.querySelectorAll('.js-open-planner').forEach(function (b) { b.setAttribute('aria-expanded', 'false'); });
    setUrl(false);
    markNav(false);
    // Land the Carte where the user was looking in the planner.
    if (view && typeof map !== 'undefined' && map && isFinite(view.lat) && isFinite(view.lng)) {
      map.setView([view.lat, view.lng], view.zoom, { animate: false });
    }
    if (typeof map !== 'undefined' && map) setTimeout(function () { map.invalidateSize(); }, 50);
  }

  function notifyFrame() {
    try { frame.contentWindow.postMessage({ type: 'bwr-planner-opened' }, location.origin); } catch (e) {}
  }

  function onFrameLoad() {
    drawer.classList.add('loaded');
    // The planner can bounce itself elsewhere (expired session → login page).
    // Follow it in the top window instead of showing that page in the drawer.
    try {
      var path = frame.contentWindow.location.pathname.replace(/\.html$/, '');
      if (!/\/routes$/.test(path)) {
        if (/\/login$/.test(path)) { goLogin(); return; }
        location.href = frame.contentWindow.location.href;
        return;
      }
    } catch (e) {}
    notifyFrame();
  }

  window.addEventListener('message', function (e) {
    if (e.origin !== location.origin || !e.data) return;
    if (e.data.type === 'bwr-planner-close') close(e.data.view);
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && isOpen) close(null);
  });
  window.addEventListener('resize', placeDrawer);

  // Every "Planifier" link (header, bottom nav, menu drawer) → open in place.
  document.addEventListener('click', function (e) {
    var a = e.target.closest && e.target.closest('a[href^="map?plan=1"], a[href^="/map?plan=1"]');
    if (!a || e.ctrlKey || e.metaKey || e.shiftKey || e.button === 1) return;
    e.preventDefault();
    document.getElementById('navDrawer')?.classList.add('hidden');
    document.getElementById('navDrawerOverlay')?.classList.add('hidden');
    document.getElementById('navDrawerOverlay')?.classList.remove('open');
    if (isOpen) close(null); else open();
  });

  // The on-map "Planifier" tab.
  var tab = document.createElement('button');
  tab.type = 'button';
  tab.className = 'planner-tab js-open-planner';
  tab.setAttribute('aria-expanded', 'false');
  tab.setAttribute('aria-controls', 'plannerDrawer');
  tab.title = 'Planifier un trajet';
  tab.innerHTML = '<span aria-hidden="true"><i class="ic" data-ic="compass"></i></span><span class="planner-tab-label">Planifier</span>';
  tab.addEventListener('click', function () { if (isOpen) close(null); else open(); });
  document.body.appendChild(tab);

  // Deep link: map?plan=1 opens the drawer as soon as the map is ready.
  if (new URLSearchParams(location.search).get('plan') === '1') {
    if (document.readyState === 'complete') open();
    else window.addEventListener('load', open);
  }

  window.BWRPlanner = { open: open, close: close };
})();
