// routes-embed.js — the planner now lives INSIDE the Carte page, as a slide-out
// "Planifier" drawer (see js/map-planner.js). routes.html is still the page that
// holds the planner, but it is only ever shown inside that drawer's <iframe>.
//
// Loaded in <head> of routes.html, before everything else:
//   • opened directly (bookmark, old link, /routes?share=…) → redirect to
//     map?plan=1 and forward the query string, so the drawer opens with the
//     same deep-link (share / lat+lng best tour / start address).
//   • opened inside the drawer → tag <html> with .bwr-embed (CSS hides the page
//     header / bottom nav), make every link open in the top window, add a close
//     button, and keep the map view in sync with the Carte page.
(function () {
  var embedded = false;
  try { embedded = window.self !== window.top; } catch (e) { embedded = true; }

  if (!embedded) {
    var qs = location.search.replace(/^\?/, '');
    location.replace('map?plan=1' + (qs ? '&' + qs : ''));
    return;
  }

  document.documentElement.classList.add('bwr-embed');

  // Links inside the planner (Pro upsell, profile…) must navigate the whole
  // app, not just the drawer.
  var base = document.createElement('base');
  base.target = '_top';
  document.head.appendChild(base);

  function send(msg) {
    try { window.parent.postMessage(msg, location.origin); } catch (e) {}
  }

  // `map` is the planner's Leaflet map (a top-level `let` in routes.js). It is
  // read at call time, once the planner has booted. Until routes.js has run,
  // the bare name resolves to the <div id="map"> element (window named access),
  // hence the setView check.
  function plannerMap() {
    try {
      return (typeof map !== 'undefined' && map && typeof map.setView === 'function') ? map : null;
    } catch (e) { return null; }
  }
  function currentView() {
    var m = plannerMap();
    if (!m) return null;
    var c = m.getCenter();
    return { lat: c.lat, lng: c.lng, zoom: m.getZoom() };
  }

  // Initial view handed over by the Carte page (?c=lat,lng,zoom). Skipped when a
  // deep-link (share / best tour) positions the map itself.
  var params = new URLSearchParams(location.search);
  var c = (params.get('c') || '').split(',').map(Number);
  var deepLink = params.has('share') || params.has('lat');
  if (!deepLink && c.length === 3 && c.every(isFinite)) {
    var tries = 0;
    var t = setInterval(function () {
      var m = plannerMap();
      if (m) { clearInterval(t); m.setView([c[0], c[1]], c[2]); }
      else if (++tries > 200) clearInterval(t); // give up after ~10 s
    }, 50);
  }

  window.addEventListener('message', function (e) {
    if (e.origin !== location.origin || !e.data) return;
    if (e.data.type === 'bwr-planner-opened') {
      var m = plannerMap();
      if (m) setTimeout(function () { m.invalidateSize(); }, 50);
      // Replay the slide-in each time the drawer is re-opened.
      var sb = document.querySelector('.planner-sidebar');
      if (sb) { sb.style.animation = 'none'; void sb.offsetWidth; sb.style.animation = ''; }
    }
  });

  function close() { send({ type: 'bwr-planner-close', view: currentView() }); }

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') close();
  });

  document.addEventListener('DOMContentLoaded', function () {
    var sidebar = document.querySelector('.planner-sidebar');
    if (!sidebar) return;
    var bar = document.createElement('div');
    bar.className = 'embed-bar';
    bar.innerHTML =
      '<span class="embed-bar-title">🧭 Planifier un trajet</span>' +
      '<button type="button" class="embed-bar-close" aria-label="Fermer le planificateur" title="Fermer (Échap)">✕</button>';
    bar.querySelector('button').addEventListener('click', close);
    sidebar.insertBefore(bar, sidebar.firstChild);
  });
})();
