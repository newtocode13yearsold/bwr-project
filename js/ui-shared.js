/* Shared UI bootstrap: SW registration, nav drawer, offline pill.
 * Loaded on every app page (all pages except index.html and verify.html). */
(function () {
  if ('serviceWorker' in navigator) {
    // Auto-update: when a new service worker takes control (it calls skipWaiting +
    // clients.claim on install/activate), reload once so the page swaps to the fresh
    // HTML/JS instead of being stuck on the previously cached version.
    var refreshing = false;
    navigator.serviceWorker.addEventListener('controllerchange', function () {
      if (refreshing) return;
      refreshing = true;
      window.location.reload();
    });
    navigator.serviceWorker.register('/sw.js').then(function (reg) {
      // Proactively check for a newer worker on every load.
      if (reg && reg.update) { try { reg.update(); } catch (e) {} }
    }).catch(function () {});
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
      document.addEventListener('keydown', function(e) { if (e.key === 'Escape') closeDrawer(); });
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
