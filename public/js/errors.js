/* ──────────────────────────────────────────────────────────────────────────
   Client-side error monitoring (homegrown, Sentry-lite).

   Catches every uncaught error and unhandled promise rejection anywhere in the
   app and beacons it to the server (POST /api/track/error), which groups
   identical errors, keeps a small log, and pushes the admin a notification the
   first time a new error appears. This turns "a user emails me that it broke"
   into "I get an alert with the exact error line".

   Loaded early (right after config.js, before the app's own scripts) so it can
   catch errors thrown by everything that runs after it. It must NEVER throw or
   interfere with the page — monitoring that breaks the thing it monitors is
   worse than no monitoring — so the whole file is defensive.
   ────────────────────────────────────────────────────────────────────────── */
(function () {
  // config.js sets API_URL to '' (same-origin) on localhost / *.workers.dev and
  // to the canonical host elsewhere. '' is falsy but VALID (same-origin), so we
  // only fall back to the canonical host when API_URL is genuinely absent —
  // otherwise a dev/preview page would beacon its errors to production.
  var API = (typeof API_URL !== 'undefined') ? API_URL : 'https://bwrmaps.com';

  var page      = (location.pathname || '/').toLowerCase().slice(0, 120);
  var seen      = {};   // signatures already reported this page-load (dedup)
  var sentCount = 0;    // hard cap so a tight error loop can't flood the server
  var MAX_SENDS = 12;

  // Errors from browser extensions / injected third-party scripts aren't our
  // bugs — don't report them.
  function isForeign(src) {
    return /^(chrome-extension|moz-extension|safari-extension|webkit-masked-url):/i.test(src || '');
  }

  function report(fields) {
    try {
      if (sentCount >= MAX_SENDS) return;

      var message = String(fields.message || '').slice(0, 500);
      if (!message) return;
      var source = String(fields.source || '').slice(0, 300);
      if (isForeign(source)) return;

      // A cross-origin "Script error." with no stack/source is opaque noise
      // (browsers hide details of errors from other origins) — skip it.
      if (message === 'Script error.' && !fields.stack && !source) return;

      var line = (typeof fields.line === 'number' && isFinite(fields.line)) ? Math.round(fields.line) : null;
      var col  = (typeof fields.col  === 'number' && isFinite(fields.col))  ? Math.round(fields.col)  : null;
      var kind = fields.kind === 'unhandledrejection' ? 'unhandledrejection' : 'error';

      var key = kind + '|' + message + '|' + source + '|' + line;
      if (seen[key]) return;   // already reported this exact error this page-load
      seen[key] = true;
      sentCount++;

      var payload = {
        kind: kind,
        message: message,
        stack: String(fields.stack || '').slice(0, 4000),
        source: source,
        line: line,
        col: col,
        page: page,
      };
      var body = JSON.stringify(payload);
      var url  = API + '/api/track/error';

      // text/plain keeps it a CORS-simple request (no preflight); the Worker
      // parses the JSON body regardless of content type. keepalive/sendBeacon
      // so the report survives a page that's crashing or navigating away.
      if (navigator.sendBeacon) {
        navigator.sendBeacon(url, new Blob([body], { type: 'text/plain' }));
      } else {
        fetch(url, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: body, keepalive: true })
          .catch(function () {});
      }
    } catch (_) { /* monitoring must never break the page */ }
  }

  window.addEventListener('error', function (e) {
    // Resource load failures (a missing <img>/<script>) also fire "error" but
    // have no e.error/message — ignore them, they're not JS exceptions.
    if (!e || (!e.message && !e.error)) return;
    var err = e.error;
    report({
      kind: 'error',
      message: (err && err.message) || e.message || 'Erreur inconnue',
      stack: err && err.stack,
      source: e.filename,
      line: e.lineno,
      col: e.colno,
    });
  });

  window.addEventListener('unhandledrejection', function (e) {
    var r = e && e.reason;
    var message, stack;
    if (r instanceof Error) { message = r.message; stack = r.stack; }
    else if (typeof r === 'string') { message = r; }
    else { try { message = JSON.stringify(r); } catch (_) { message = String(r); } }
    report({ kind: 'unhandledrejection', message: message || 'Promesse rejetée', stack: stack });
  });
})();
