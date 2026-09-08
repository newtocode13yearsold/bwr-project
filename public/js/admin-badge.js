/* ──────────────────────────────────────────────────────────────────────────
   Admin-only "unresolved JS errors" nav badge.

   Shows a small red count on the "Panneau admin" menu entry the moment an admin
   opens any page, so client-side crashes surface without having to open the
   admin panel. Non-admins never fetch anything. Self-contained (creates its own
   badge element + styles, reads the cached user/token from localStorage) so it
   needs no markup changes across the site and no shared state.
   ────────────────────────────────────────────────────────────────────────── */
(function () {
  try {
    // config.js sets API_URL to '' (same-origin) in dev/preview and to the
    // canonical host in prod; only fall back when it's genuinely undefined.
    var API = (typeof API_URL !== 'undefined') ? API_URL : 'https://bwrmaps.com';

    var user = null, token = null;
    try { user = JSON.parse(localStorage.getItem('bwr_user') || 'null'); } catch (_) {}
    try { token = localStorage.getItem('bwr_token'); } catch (_) {}
    if (!user || user.role !== 'admin' || !token) return; // admins only

    function paint(count) {
      // The "Panneau admin" entry carries an id on most pages; on the panel page
      // itself it's the active link addressed by href — match either.
      var link = document.getElementById('navDrawerAdminPanel')
        || document.querySelector('a.nav-drawer-item[href="admin-panel"]');
      if (!link) return;
      var badge = document.getElementById('navErrBadge');
      if (!badge) {
        badge = document.createElement('span');
        badge.id = 'navErrBadge';
        badge.style.cssText = 'margin-left:auto;min-width:20px;height:20px;padding:0 6px;' +
          'display:none;align-items:center;justify-content:center;background:#dc2626;color:#fff;' +
          'font-size:0.72rem;font-weight:700;border-radius:999px;line-height:1';
        badge.title = 'Erreurs JS non résolues';
        link.appendChild(badge);
      }
      if (count > 0) {
        badge.textContent = count > 99 ? '99+' : String(count);
        badge.style.display = 'inline-flex';
      } else {
        badge.style.display = 'none';
      }
    }

    function refresh() {
      fetch(API + '/api/errors/count', { headers: { Authorization: 'Bearer ' + token } })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (d) { if (d && typeof d.count === 'number') paint(d.count); })
        .catch(function () { /* a badge must never break the page */ });
    }

    // Let the admin panel refresh the badge after resolving errors in place.
    window.__bwrRefreshErrBadge = refresh;

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', refresh);
    } else {
      refresh();
    }
  } catch (_) { /* never break the page */ }
})();
