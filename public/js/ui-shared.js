/* Shared UI bootstrap: SW registration, site header, nav drawer, offline pill.
 * Loaded on every page that shows the site header (app pages, landing, blog,
 * guide, legal, changelog…). The header markup is the same everywhere — see
 * css/header.css — and this file fills it: quick links, bell, avatar menu.
 * All hrefs it writes are root-absolute so they also work under /blog/….
 *
 * SINGLE SOURCE OF TRUTH FOR THE MENU
 * -----------------------------------
 * The hamburger nav drawer is built here, from the NAV_ITEMS list below, so
 * every page shows the exact same menu (same links, order, icons). Any page
 * that has a `#btnNavMenu` button gets the canonical drawer injected/rebuilt
 * at load — the per-page drawer markup in the HTML is only a fallback and is
 * overwritten. To change the menu everywhere, edit NAV_ITEMS (nothing else). */
(function () {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').then(function (reg) {
      // Proactively check for a newer worker on every load.
      if (reg && reg.update) { try { Promise.resolve(reg.update()).catch(function () {}); } catch (e) {} }
    }).catch(function () {});
  }

  /* ── Canonical menu definition ──────────────────────────────────────────
   * One list, used by every page. `icon` is the inner SVG of the item. */
  var IC = {
    map:      '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="3 6 9 3 15 6 21 3 21 18 15 21 9 18 3 21"/><line x1="9" x2="9" y1="3" y2="18"/><line x1="15" x2="15" y1="6" y2="21"/></svg>',
    routes:   '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76"/></svg>',
    tours:    '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 11l19-9-9 19-2-8-8-2z"/></svg>',
    activities:'<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z"/></svg>',
    profile:  '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/></svg>',
    leaderboard:'<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"/><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18"/><path d="M4 22h16"/><path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22"/><path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22"/><path d="M18 2H6v7a6 6 0 0 0 12 0V2Z"/></svg>',
    quests:   '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/></svg>',
    forum:    '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
    friends:  '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
    inbox:    '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/></svg>',
    news:     '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 22h16a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2H8a2 2 0 0 0-2 2v16a2 2 0 0 1-2 2Zm0 0a2 2 0 0 1-2-2v-9c0-1.1.9-2 2-2h2"/><path d="M18 14h-8"/><path d="M15 18h-5"/><path d="M10 6h8v4h-8V6Z"/></svg>',
    blog:     '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/><line x1="9" x2="15" y1="7" y2="7"/><line x1="9" x2="13" y1="11" y2="11"/></svg>',
    plans:    '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>',
    changelog:'<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="8" y="2" width="8" height="4" rx="1" ry="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="M9 12h6"/><path d="M9 16h6"/></svg>',
    guide:    '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" x2="12.01" y1="17" y2="17"/></svg>',
    download: '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="3" y2="15"/></svg>',
    gear:     '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>'
  };

  // Items are grouped into labelled sections. A { type:'section' } entry renders
  // a non-clickable header; the links that follow belong to it (until the next
  // section). Reorder within a section freely — just keep each link under the
  // header it belongs to.
  var NAV_ITEMS = [
    { type: 'section', label: 'Explorer' },
    { href: 'map',         label: 'Carte',                 icon: IC.map },
    { href: 'map?plan=1',  label: 'Planifier un trajet',   icon: IC.routes },
    { href: 'best-tours',  label: 'Meilleures balades',    icon: IC.tours },

    { type: 'section', label: 'Ma progression' },
    { href: 'activities',  label: 'Mes sorties',           icon: IC.activities },
    { href: 'profile',     label: 'Mon profil',            icon: IC.profile },
    { href: 'leaderboard', label: 'Classement',            icon: IC.leaderboard },
    { href: 'quests',      label: 'Quêtes',                icon: IC.quests },

    { type: 'section', label: 'Communauté' },
    { href: 'forum',       label: 'Forum',                 icon: IC.forum },
    { href: 'friends',     label: 'Communauté',            icon: IC.friends },
    { href: 'inbox',       label: 'Messages',              icon: IC.inbox },

    { type: 'section', label: 'À propos & aide' },
    { href: 'news',        label: 'Actualités',            icon: IC.news },
    { href: 'blog',        label: 'Blog',                  icon: IC.blog },
    { href: 'plans',       label: 'Plans & abonnements',   icon: IC.plans },
    { href: 'changelog',   label: 'Changelog',             icon: IC.changelog },
    { href: 'guide',       label: 'Guide & aide',          icon: IC.guide },
    { href: 'map?offline=1', label: 'Cartes hors-ligne',   icon: IC.download },
    { type: 'theme' },
    { type: 'install' },

    { type: 'section', label: 'Administration', admin: true },
    { href: 'admin',       label: 'Carte admin',   icon: IC.map,  admin: true, id: 'navDrawerAdmin' },
    { href: 'admin-panel', label: 'Panneau admin', icon: IC.gear, admin: true, id: 'navDrawerAdminPanel' }
  ];

  /* ── Canonical top-bar links ────────────────────────────────────────────
   * The compact links shown in the desktop header bar (`.header-nav-links`).
   * Centralized here so every page shows the SAME set, in the same order —
   * the per-page markup in each HTML file is a fallback and is overwritten
   * at load (same pattern as the drawer above). Full navigation lives in the
   * hamburger drawer; this is just the quick-access strip. To change the top
   * bar everywhere, edit HEADER_LINKS (nothing else). */
  var HEADER_LINKS = [
    { href: 'map',    label: 'Carte' },
    { href: 'news',   label: 'Actualités' },
    { href: 'blog',   label: 'Blog' },
    { href: 'plans',  label: 'Plan' }
  ];

  // Root-absolute href ("map" -> "/map"): the same header is used on nested
  // pages (/blog/foret-laigue), where a relative "map" would 404.
  function abs(href) { return /^(\/|https?:)/.test(href) ? href : '/' + href; }

  // Current page slug, e.g. "/map.html" -> "map", "/" -> "".
  // Nested content pages highlight their section: /blog/… -> "blog",
  // /balade/… -> "best-tours".
  function currentSlug() {
    var path = location.pathname;
    if (/^\/blog\//.test(path)) return 'blog';
    if (/^\/balade\//.test(path)) return 'best-tours';
    var p = path.replace(/\/+$/, '').split('/').pop() || '';
    return p.replace(/\.html$/, '');
  }

  function isAdmin() {
    try {
      var raw = localStorage.getItem('bwr_user');
      return !!raw && JSON.parse(raw).role === 'admin';
    } catch (e) { return false; }
  }

  function itemHTML(it, slug) {
    if (it.type === 'section') {
      var scls = 'nav-drawer-section';
      if (it.admin) scls += ' nav-drawer-admin' + (isAdmin() ? '' : ' hidden');
      return '<div class="' + scls + '">' + it.label + '</div>';
    }
    if (it.type === 'theme') {
      // Global dark/light toggle. The menu is the ONLY place it lives — the
      // old header "Thème" button was removed from every page.
      // Icon reflects the theme already applied by theme.js in <head>; clicks
      // are handled by theme.js's delegated listener (matches .js-theme-toggle).
      var dark = document.documentElement.getAttribute('data-theme') === 'dark';
      return '<button type="button" class="nav-drawer-item js-theme-toggle">' +
        '<span class="nav-drawer-icon theme-toggle-icon">' + (dark ? '<i class="ic" data-ic="sun"></i>' : '<i class="ic" data-ic="moon"></i>') + '</span>' +
        '<span>Mode sombre / clair</span></button>';
    }
    if (it.type === 'install') {
      return '<button class="nav-drawer-item" id="btnInstallApp" style="display:none">' +
        '<span class="nav-drawer-icon">' + IC.download + '</span>' +
        '<span>Installer l\'application</span></button>';
    }
    var cls = 'nav-drawer-item';
    if (it.admin) cls += ' nav-drawer-admin' + (isAdmin() ? '' : ' hidden');
    if (it.href === slug) cls += ' active';
    return '<a href="' + abs(it.href) + '" class="' + cls + '"' + (it.id ? ' id="' + it.id + '"' : '') + '>' +
      '<span class="nav-drawer-icon">' + it.icon + '</span>' +
      '<span>' + it.label + '</span></a>';
  }

  // Rebuild the top-bar quick links from HEADER_LINKS, marking the current
  // page active. No-op on pages without a `.header-nav-links` strip.
  function buildHeaderNav() {
    var nav = document.querySelector('.header-nav-links');
    if (!nav) return;
    var slug = currentSlug();
    nav.innerHTML = HEADER_LINKS.map(function (l) {
      return '<a href="' + abs(l.href) + '"' + (l.href === slug ? ' class="active"' : '') +
        '>' + l.label + '</a>';
    }).join('');
  }

  function escHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // Make the right side of the top bar identical on every page:
  //   ☰ Menu · (page tools, if any) · bell · user menu.
  // - The "Installer" button lives in the drawer only (the header copy duplicated its id).
  // - The bell is added (and js/notif.js loaded) on pages that lacked it.
  // - The user menu is filled on pages whose own script never renders it.
  function buildHeaderRight() {
    var right = document.querySelector('.header .header-right');
    if (!right) return;

    var hdrInstall = right.querySelector('#btnInstallApp');
    if (hdrInstall) hdrInstall.remove();

    // Every header ends with the avatar menu — add the slot if a page forgot it.
    var menu = right.querySelector('#userMenu');
    if (!menu) {
      menu = document.createElement('div');
      menu.id = 'userMenu';
      menu.className = 'user-menu';
      right.appendChild(menu);
    }
    // The bell needs API_URL (js/config.js); content pages that don't load it
    // skip the bell (it only ever shows when there's an unread event anyway).
    if (!document.getElementById('notifBell') && typeof API_URL !== 'undefined') {
      var bell = document.createElement('div');
      bell.id = 'notifBell';
      bell.className = 'notif-bell-wrap';
      right.insertBefore(bell, menu || null);
      if (!document.querySelector('script[src$="js/notif.js"]')) {
        var s = document.createElement('script');
        s.src = 'js/notif.js';
        document.body.appendChild(s);
      }
    }

    renderUserMenu(menu);
  }

  // The ONE avatar menu — page scripts no longer draw their own. Signed-out
  // visitors get a "Connexion" button in the same slot.
  function renderUserMenu(menuEl) {
    var user = null;
    try { user = JSON.parse(localStorage.getItem('bwr_user') || 'null'); } catch (e) {}
    if (!user || !user.name) {
      menuEl.innerHTML = '<a href="/login" class="btn-icon" style="text-decoration:none">' +
        '<span class="btn-emoji">' + IC.profile + '</span><span class="btn-label">Connexion</span></a>';
      return;
    }
    var initials = user.name.split(' ').map(function (w) { return w[0]; }).join('').toUpperCase().slice(0, 2);
    menuEl.innerHTML =
      '<button class="user-btn" id="userBtn">' +
        '<div class="user-avatar">' + escHtml(initials) + '</div>' +
        '<span class="btn-label">' + escHtml(user.name.split(' ')[0]) + '</span>' +
      '</button>' +
      '<div class="user-dropdown hidden" id="userDropdown">' +
        '<span class="dropdown-name">' + escHtml(user.name) + '</span>' +
        '<a href="/"><i class="ic" data-ic="home"></i> Accueil</a>' +
        '<a href="/map"><i class="ic" data-ic="map"></i> Voir la carte</a>' +
        '<a href="/profile"><i class="ic" data-ic="user"></i> Mon profil</a>' +
        (user.role === 'admin' ? '<a href="/admin"><i class="ic" data-ic="map"></i> Carte admin</a><a href="/admin-panel"><i class="ic" data-ic="gear"></i> Panneau admin</a>' : '') +
        '<button class="dropdown-logout" id="btnLogout">Se déconnecter</button>' +
      '</div>';
    var dd = menuEl.querySelector('#userDropdown');
    menuEl.querySelector('#userBtn').addEventListener('click', function () { dd.classList.toggle('hidden'); });
    menuEl.querySelector('#btnLogout').addEventListener('click', function () {
      if (typeof logout === 'function') return logout();
      // Content pages don't load js/auth.js — drop the cached session locally
      // and let the login page take it from there.
      try { localStorage.removeItem('bwr_token'); localStorage.removeItem('bwr_user'); } catch (e) {}
      location.href = '/login';
    });
    document.addEventListener('click', function (e) {
      if (!menuEl.contains(e.target)) dd.classList.add('hidden');
    });
  }

  // Build (or rebuild) the canonical drawer + overlay + burger. Runs on any
  // page that has (or should have) the hamburger button.
  function buildMenu() {
    var burger = document.getElementById('btnNavMenu');
    if (!burger) return; // page not set up for the app menu — leave it alone.

    var slug = currentSlug();

    // Overlay
    var overlay = document.getElementById('navDrawerOverlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'navDrawerOverlay';
      overlay.className = 'nav-drawer-overlay hidden';
      document.body.appendChild(overlay);
    }

    // Drawer shell
    var drawer = document.getElementById('navDrawer');
    if (!drawer) {
      drawer = document.createElement('div');
      drawer.id = 'navDrawer';
      drawer.className = 'nav-drawer hidden';
      drawer.setAttribute('role', 'dialog');
      drawer.setAttribute('aria-label', 'Navigation');
      document.body.appendChild(drawer);
    }
    drawer.innerHTML =
      '<div class="nav-drawer-header">' +
        '<span class="nav-drawer-logo">BWR</span>' +
        '<button class="nav-drawer-close" id="btnNavDrawerClose" aria-label="Fermer"><i class="ic" data-ic="x"></i></button>' +
      '</div>' +
      '<nav class="nav-drawer-links">' +
        NAV_ITEMS.map(function (it) { return itemHTML(it, slug); }).join('') +
      '</nav>';
  }

  document.addEventListener('DOMContentLoaded', function () {
    buildMenu();
    buildHeaderNav();
    buildHeaderRight();

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
