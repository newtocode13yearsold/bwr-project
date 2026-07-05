/* Shared UI bootstrap: SW registration, nav drawer, offline pill.
 * Loaded on every app page (all pages except index.html and verify.html). */
(function () {
  if ('serviceWorker' in navigator) {
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

/* ── Accessibility: focus management for dialogs ───────────────────────────
 * Any element with role="dialog" (modals + the nav drawer, across every page)
 * automatically gets:
 *   • focus moved inside when it opens (first focusable, or the dialog itself),
 *   • Tab / Shift+Tab trapped within it (keyboard users can't escape into the
 *     page behind the backdrop),
 *   • focus restored to whatever was focused before it opened, on close.
 * Visibility is detected from computed style, so it works regardless of whether
 * a page toggles `.hidden`, the `[hidden]` attribute, or an inline style. */
(function () {
  var FOCUSABLE = [
    'a[href]', 'button:not([disabled])', 'input:not([disabled])',
    'select:not([disabled])', 'textarea:not([disabled])',
    '[tabindex]:not([tabindex="-1"])'
  ].join(',');

  var activeDialog = null;   // dialog currently trapping focus
  var lastFocus = null;      // element focused before the dialog opened
  var scanQueued = false;

  function isVisible(el) {
    if (!el || el.hasAttribute('hidden')) return false;
    var s = window.getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden') return false;
    return el.getClientRects().length > 0;
  }

  function focusables(dialog) {
    return Array.prototype.filter.call(dialog.querySelectorAll(FOCUSABLE), isVisible);
  }

  function onKeydown(e) {
    if (!activeDialog || e.key !== 'Tab') return;
    var items = focusables(activeDialog);
    if (!items.length) { e.preventDefault(); activeDialog.focus(); return; }
    var first = items[0], last = items[items.length - 1];
    var cur = document.activeElement;
    if (e.shiftKey) {
      if (cur === first || !activeDialog.contains(cur)) { e.preventDefault(); last.focus(); }
    } else {
      if (cur === last || !activeDialog.contains(cur)) { e.preventDefault(); first.focus(); }
    }
  }

  function activate(dialog) {
    activeDialog = dialog;
    lastFocus = document.activeElement;
    if (!dialog.hasAttribute('tabindex')) dialog.setAttribute('tabindex', '-1');
    var target = dialog.querySelector('[autofocus]') || focusables(dialog)[0] || dialog;
    // Defer so the opening mutation batch settles before we grab focus.
    // setTimeout (not rAF) so it still runs while the tab is backgrounded.
    setTimeout(function () {
      if (activeDialog === dialog) { try { target.focus(); } catch (err) {} }
    }, 0);
  }

  function deactivate() {
    activeDialog = null;
    if (lastFocus && document.contains(lastFocus)) { try { lastFocus.focus(); } catch (err) {} }
    lastFocus = null;
  }

  function scan() {
    scanQueued = false;
    var dialogs = document.querySelectorAll('[role="dialog"]');
    var open = null;
    for (var i = 0; i < dialogs.length; i++) {
      if (isVisible(dialogs[i])) { open = dialogs[i]; break; }
    }
    if (open && open !== activeDialog) activate(open);
    else if (!open && activeDialog) deactivate();
  }

  function queueScan() {
    if (scanQueued) return;
    scanQueued = true;
    setTimeout(scan, 0);
  }

  document.addEventListener('keydown', onKeydown, true);

  document.addEventListener('DOMContentLoaded', function () {
    scan();
    if (!('MutationObserver' in window) || !document.body) return;
    new MutationObserver(queueScan).observe(document.body, {
      attributes: true, attributeFilter: ['class', 'hidden', 'style'],
      subtree: true, childList: true
    });
  });
})();
