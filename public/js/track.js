/* ──────────────────────────────────────────────────────────────────────────
   Anonymous visitor + per-page dwell tracking.

   For each page the visitor opens we measure how long they actually *look* at
   it (visible time, to the second — the timer pauses while the tab is hidden so
   a forgotten background tab never inflates the number) and, when they leave the
   page, send { vid, page, seconds } to the server. The server accumulates this
   into a per-browser record so the admin panel can show which pages people visit
   and how long they spend on each.

   Privacy: no personal data is stored — only a random per-browser id (used to
   count each visitor at most once per calendar month) and the page path. A
   visitor is only *counted* as real once they've spent at least 10 s on the
   site in total, so search-engine bots and instant bounces are excluded. Pages
   where the visitor stayed less than a few seconds (a mis-click, an instant
   bounce) are never reported.
   ────────────────────────────────────────────────────────────────────────── */
(function () {
  var API = (typeof API_URL !== 'undefined' && API_URL)
    ? API_URL
    : 'https://bwrmaps.com';

  // Never count the admin's own browsing. If an admin session is (or ever was)
  // active on this browser, set a persistent opt-out flag and stop tracking —
  // so the admin's PC stays excluded from the visitor list even after logout.
  try {
    if (localStorage.getItem('bwr_notrack') === '1') return;
    var cachedUser = JSON.parse(localStorage.getItem('bwr_user') || 'null');
    if (cachedUser && cachedUser.role === 'admin') {
      localStorage.setItem('bwr_notrack', '1');
      return;
    }
  } catch (_) { /* storage disabled — fall through and track normally */ }

  var MIN_SECONDS = 3; // don't report a blink (mis-click / instant bounce)

  // Persistent, non-identifying browser id (used only for per-month dedup).
  var vid = null;
  try {
    vid = localStorage.getItem('bwr_vid');
    if (!vid) {
      vid = (window.crypto && crypto.randomUUID)
        ? crypto.randomUUID()
        : String(Date.now()) + '-' + Math.random().toString(36).slice(2);
      localStorage.setItem('bwr_vid', vid);
    }
  } catch (_) { /* private mode / storage disabled — still track, just no dedup */ }

  // Which page this is. Path only (no query/hash) so distinct pages stay bounded.
  var page = (location.pathname || '/').toLowerCase().slice(0, 80);

  // Precise *visible* time on this page. We accumulate the time the tab is
  // actually shown and pause the clock whenever it goes into the background.
  var activeMs  = 0;
  var visible   = (typeof document.visibilityState === 'undefined')
    || document.visibilityState === 'visible';
  var startedAt = visible ? Date.now() : 0;

  function tick() { // fold the elapsed visible stretch into the accumulator
    if (visible && startedAt) {
      var t = Date.now();
      activeMs += t - startedAt;
      startedAt = t;
    }
  }
  document.addEventListener('visibilitychange', function () {
    tick();
    visible   = document.visibilityState === 'visible';
    startedAt = visible ? Date.now() : 0;
  });

  function seconds() { tick(); return Math.round(activeMs / 1000); }

  var sent = false;
  function flush() {
    if (sent) return;
    var secs = seconds();
    sent = true;
    if (secs < MIN_SECONDS) return; // too short to be a real page view
    try {
      // text/plain keeps it a CORS-simple request (no preflight) on preview
      // origins; the Worker parses the JSON body regardless of content type.
      // Include the auth token when signed in so the server can drop the visit if
      // it belongs to an admin session — a backstop for the per-browser opt-out
      // above, which misses origins where no admin login was ever cached.
      var token = null;
      try { token = localStorage.getItem('bwr_token'); } catch (_) {}
      var payload = { vid: vid, page: page, seconds: secs };
      if (token) payload.token = token;
      var body = JSON.stringify(payload);
      var url  = API + '/api/track/visit';
      if (navigator.sendBeacon) {
        navigator.sendBeacon(url, new Blob([body], { type: 'text/plain' }));
      } else {
        fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain' },
          body: body,
          keepalive: true,
        }).catch(function () {});
      }
    } catch (_) { /* analytics must never break the page */ }
  }

  // Terminal event for the page — fires when the tab is closed and when the
  // visitor navigates to another page, so each page reports its own dwell time.
  window.addEventListener('pagehide', flush);
})();
