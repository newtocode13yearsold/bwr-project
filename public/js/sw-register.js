/* Standalone service-worker registration.
 *
 * The full registration lives in js/ui-shared.js, but the two pages almost
 * every new visitor sees first — index.html (homepage) and login.html — do NOT
 * load ui-shared.js (it also rebuilds the app nav drawer, which those marketing
 * pages don't use). Without this, offline support and the install prompt only
 * started working once a visitor reached a deeper app page. This tiny module
 * registers the SW on those entry pages too, with the same update-on-load check.
 * It is a no-op on pages that already register via ui-shared.js — the browser
 * dedupes registration of the same scope. */
(function () {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').then(function (reg) {
      if (reg && reg.update) { try { reg.update(); } catch (e) {} }
    }).catch(function () {});
  }
})();
