/* ──────────────────────────────────────────────────────────────────────────
   Anonymous visitor tracking.

   A visit is only counted once the visitor has stayed on the site for more than
   one minute. Search-engine bots and instant bounces never wait that long, so
   they are excluded by design (this is exactly why raw page-view tracking was
   removed previously). No personal data is stored — only a random per-browser id
   used to count each visitor at most once per calendar month, server-side.
   ────────────────────────────────────────────────────────────────────────── */
(function () {
  var API = (typeof API_URL !== 'undefined' && API_URL)
    ? API_URL
    : 'https://bwrmaps.com';

  var DWELL_MS = 60 * 1000; // must stay > 1 min to be counted

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
  } catch (_) { /* private mode / storage disabled — still count, just no dedup */ }

  var sent = false;

  function sendVisit() {
    if (sent) return;
    sent = true;
    try {
      // text/plain keeps it a CORS-simple request (no preflight) on preview
      // origins; the Worker parses the JSON body regardless of content type.
      var body = JSON.stringify({ vid: vid });
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

  // Count after a full minute of presence. If the visitor leaves earlier, the
  // pending timer is cleared and nothing is recorded.
  var timer = setTimeout(sendVisit, DWELL_MS);
  window.addEventListener('pagehide', function () {
    if (!sent) clearTimeout(timer); // left before 1 min → do not count
  });
})();
