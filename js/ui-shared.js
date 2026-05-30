/* Shared UI bootstrap: SW registration, nav drawer, offline pill.
 * Loaded on every app page (all pages except index.html and verify.html). */
(function () {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(function () {});
  }

  document.addEventListener('DOMContentLoaded', function () {
    var overlay  = document.getElementById('navDrawerOverlay');
    var drawer   = document.getElementById('navDrawer');
    var burger   = document.getElementById('btnNavMenu');
    var closeBtn = document.getElementById('btnNavDrawerClose');

    if (overlay && drawer && burger) {
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
    }

    var pill = document.getElementById('offline-pill');
    if (pill) {
      function updatePill() { pill.classList.toggle('visible', !navigator.onLine); }
      window.addEventListener('online', updatePill);
      window.addEventListener('offline', updatePill);
      updatePill();
    }
  });
})();
