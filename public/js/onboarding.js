/* ── BWR onboarding ───────────────────────────────────────────────────────────
 * ONE-TIME post-signup experience, shown exactly once per account and never
 * again — there is deliberately no replay:
 *   • It arms on the map page for a brand-new account and launches only when the
 *     user first touches/clicks the map — never on a timer, nothing auto-plays.
 *   • A welcome / quick-start modal, then an interactive coach-mark tour that
 *     spotlights the real UI controls — including opening the real navigation
 *     drawer to walk through the menu.
 *
 * Gating is server-side: a brand-new account carries `onboarded:false` (set at
 * email verification); the flag is flipped to `true` the instant the tour first
 * appears, via POST /api/auth/onboarded — a one-way switch with no reset path.
 * This makes it survive across devices and impossible to redo. A localStorage
 * flag is kept only as a same-device anti-flicker guard. Legacy accounts (no
 * `onboarded` field) map to `true` server-side, so they never see it.
 *
 * No build step, no dependencies.
 * ──────────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  var SEEN_KEY = 'bwr_tutorial_seen';
  var GUEST_SEEN_KEY = 'bwr_guest_tour_seen'; // logged-out visitors (per browser)
  var guestRun = false;                       // true when the current run is a guest tour

  // Steps target elements that exist on the map page. Missing targets are
  // skipped gracefully so the tour never dead-ends if the markup changes.
  var STEPS = [
    {
      target: '#mapSearchWrap',
      title: 'Trouvez un lieu',
      body: 'Tapez le nom d’une ville, d’une forêt ou d’une adresse pour vous y rendre directement sur la carte.',
      placement: 'bottom'
    },
    {
      target: '#toggleFilters',
      title: 'Changez de carte',
      body: 'Basculez entre le plan OpenStreetMap, la carte IGN topographique et la vue satellite.',
      placement: 'bottom'
    },
    {
      target: '#btnLocate',
      title: 'Où suis-je ?',
      body: 'Activez votre position GPS pour vous repérer sur la carte, même en pleine forêt.',
      placement: 'top'
    },
    {
      target: '#btnSelectPath',
      title: 'Mon chemin',
      body: 'Affichez le chemin sous vos pieds : son état, sa difficulté, et signalez un obstacle (arbre tombé, inondation…).',
      placement: 'top'
    },
    {
      target: '#btnGpsTracker',
      title: 'Enregistrez votre balade',
      body: 'Lancez le suivi GPS avant de partir : BWR compte vos kilomètres et votre dénivelé, puis vous propose de sauvegarder la sortie dans votre journal pour la rejouer plus tard.',
      placement: 'top'
    },
    {
      target: '.bnav-item[href="routes"], .header-nav-links a[href="routes"]',
      title: 'Planifiez un trajet',
      body: 'Le cœur de BWR : indiquez un départ et une distance, et l’app génère une boucle ou un A→B en forêt, avec dénivelé et export GPX.',
      placement: 'bottom'
    },
    {
      // Special step: opens the real navigation drawer so the newcomer sees the
      // actual menu, not just the ☰ button.
      target: '#navDrawer',
      openDrawer: true,
      title: 'Le menu, tout le reste',
      body: 'Voici le menu complet : <strong>Mon profil</strong> (kilomètres, badges, objectifs), <strong>Mes sorties</strong> (votre journal de balades), la <strong>Communauté</strong> et le <strong>Forum</strong> pour échanger, les <strong>Quêtes</strong> et le <strong>Classement</strong>, les <strong>meilleures balades</strong>, les <strong>cartes hors-ligne</strong> et le <strong>guide complet</strong>. Tout est ici, à portée de clic.',
      placement: 'right'
    }
  ];

  var els = {};      // overlay / spot / tip / blocker references
  var order = [];    // resolved steps (with live elements) for the current run
  var idx = 0;

  function seen() {
    try { return localStorage.getItem(SEEN_KEY) === '1'; } catch (e) { return false; }
  }
  function guestSeen() {
    try { return localStorage.getItem(GUEST_SEEN_KEY) === '1'; } catch (e) { return false; }
  }
  // One-way: burn the tour for good. Sets the same-device guard immediately, then
  // best-effort persists the permanent server flag so it never returns anywhere.
  var marked = false;
  function markSeen() {
    if (marked) return;
    marked = true;
    // Guest run: only a per-browser flag, no account to persist against.
    if (guestRun) {
      try { localStorage.setItem(GUEST_SEEN_KEY, '1'); } catch (e) {}
      return;
    }
    try { localStorage.setItem(SEEN_KEY, '1'); } catch (e) {}
    // Reflect it in the cached user so a mid-session /api/auth/me refresh in
    // another script doesn't momentarily reopen the gate.
    try {
      var raw = localStorage.getItem('bwr_user');
      if (raw) {
        var u = JSON.parse(raw);
        u.onboarded = true;
        localStorage.setItem('bwr_user', JSON.stringify(u));
      }
    } catch (e) {}
    try {
      var token = localStorage.getItem('bwr_token');
      var base = (typeof API_URL !== 'undefined' && API_URL != null) ? API_URL : '';
      if (token) {
        fetch(base + '/api/auth/onboarded', {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + token },
          keepalive: true
        }).catch(function () {});
      }
    } catch (e) {}
  }
  function loggedIn() {
    try { return !!localStorage.getItem('bwr_token'); } catch (e) { return false; }
  }
  // Brand-new signup only: the account must explicitly carry onboarded===false.
  // Legacy accounts (field absent → server sends true) and anyone who already
  // saw it never qualify.
  function isNewSignup() {
    try {
      var raw = localStorage.getItem('bwr_user');
      if (!raw) return false;
      return JSON.parse(raw).onboarded === false;
    } catch (e) { return false; }
  }
  function onMapPage() { return !!document.getElementById('map'); }

  // ── Nav-drawer control (for the "explain the menu" step) ────────────────────
  // We drive the drawer directly instead of clicking the ☰ button so the tour
  // fully controls when it opens and closes. The overlay is left hidden: the
  // tour's own spotlight already dims the page, and a second backdrop would just
  // fight it.
  var drawerOpened = false;
  function openNavDrawer() {
    var drawer = document.getElementById('navDrawer');
    if (!drawer) return;
    drawer.classList.remove('hidden');
    drawer.getBoundingClientRect();           // force reflow so the slide-in animates
    drawer.classList.add('open');
    drawerOpened = true;
  }
  function closeNavDrawer() {
    if (!drawerOpened) return;
    var drawer = document.getElementById('navDrawer');
    if (drawer) { drawer.classList.remove('open'); drawer.classList.add('hidden'); }
    drawerOpened = false;
  }

  // Resolve a step's CSS selector to the first *visible* match. A selector may
  // list several candidates (e.g. desktop header link + mobile bottom-nav link);
  // only one is shown at a given viewport, so plain querySelector would often
  // pick the hidden 0×0 one and spotlight nothing.
  function resolve(selector) {
    var nodes = document.querySelectorAll(selector);
    for (var i = 0; i < nodes.length; i++) {
      var r = nodes[i].getBoundingClientRect();
      if (nodes[i].offsetParent !== null && r.width > 0 && r.height > 0) return nodes[i];
    }
    return nodes[0] || null;
  }

  function el(tag, cls, html) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html;
    return n;
  }

  // ── Welcome / quick-start modal ───────────────────────────────────────────
  function showWelcome() {
    // Burn it the instant it appears: closing, skipping ("Plus tard") or even a
    // refresh must never bring it back. This is the "only once" guarantee.
    markSeen();
    var overlay = el('div', 'bwr-tut-overlay bwr-tut-dim');
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'Bienvenue sur BWR');
    overlay.innerHTML =
      '<div class="bwr-tut-welcome">' +
        '<div class="bwr-tut-welcome-badge">🌲</div>' +
        '<h2>Bienvenue sur BWR&nbsp;!</h2>' +
        '<p class="bwr-tut-lead">Les cartes qui vous simplifient la balade. Voici l’essentiel en 30&nbsp;secondes.</p>' +
        '<ul class="bwr-tut-bullets">' +
          '<li><span class="bwr-tut-emoji">🗺️</span><span><strong>Explorez</strong> tous les chemins vérifiés des forêts de l’Oise.</span></li>' +
          '<li><span class="bwr-tut-emoji">🧭</span><span><strong>Planifiez</strong> une boucle ou un A→B sur mesure, à pied ou à vélo.</span></li>' +
          '<li><span class="bwr-tut-emoji">🏅</span><span><strong>Progressez</strong> : kilomètres, badges et objectifs sur votre profil.</span></li>' +
        '</ul>' +
        '<div class="bwr-tut-welcome-actions">' +
          '<button class="bwr-tut-btn bwr-tut-btn-primary" id="bwrTutStart">Faire la visite guidée →</button>' +
          '<button class="bwr-tut-btn bwr-tut-btn-ghost" id="bwrTutSkip">Plus tard</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(overlay);
    requestAnimationFrame(function () { overlay.classList.add('bwr-tut-show'); });

    function close() {
      overlay.classList.remove('bwr-tut-show');
      setTimeout(function () { overlay.remove(); }, 240);
    }
    overlay.querySelector('#bwrTutStart').addEventListener('click', function () {
      close();
      setTimeout(startTour, 220);
    });
    overlay.querySelector('#bwrTutSkip').addEventListener('click', function () {
      markSeen();
      close();
    });
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) { markSeen(); close(); }
    });
  }

  // ── Coach-mark tour ───────────────────────────────────────────────────────
  function buildTourDom() {
    els.blocker = el('div', 'bwr-tut-blocker');
    els.spot = el('div', 'bwr-spot');
    els.tip = el('div', 'bwr-tip');
    document.body.appendChild(els.blocker);
    document.body.appendChild(els.spot);
    document.body.appendChild(els.tip);
    // Block interaction with the page underneath while the tour is open.
    els.blocker.addEventListener('click', function (e) { e.stopPropagation(); });
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    document.addEventListener('keydown', onKey, true);
  }

  function teardown(completed) {
    window.removeEventListener('resize', reposition);
    window.removeEventListener('scroll', reposition, true);
    document.removeEventListener('keydown', onKey, true);
    ['blocker', 'spot', 'tip'].forEach(function (k) {
      if (els[k]) { els[k].remove(); els[k] = null; }
    });
    closeNavDrawer();
    markSeen();
    if (completed) finishToast();
  }

  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); teardown(false); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); go(1); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); go(-1); }
  }

  function startTour() {
    if (els.tip) return; // already running
    // On mobile the locate / "Mon point" pills live behind a collapsed FAB — open
    // it so those steps spotlight the real (visible) buttons instead of a 0×0 box.
    try { window.BWRMapFab && window.BWRMapFab.open(); } catch (e) {}
    order = STEPS.map(function (s) {
      return { def: s, node: resolve(s.target) };
    }).filter(function (s) { return s.node; });
    if (!order.length) { markSeen(); return; }
    idx = 0;
    buildTourDom();
    render();
  }

  function go(delta) {
    var next = idx + delta;
    if (next < 0) return;
    if (next >= order.length) { teardown(true); return; }
    idx = next;
    render();
  }

  function render() {
    var step = order[idx];
    var def = step.def;
    var isLast = idx === order.length - 1;

    // Open (or close) the real navigation drawer for menu steps.
    if (def.openDrawer) openNavDrawer(); else closeNavDrawer();

    var dots = order.map(function (_, i) {
      return '<span class="bwr-tip-dot' + (i === idx ? ' active' : '') + '"></span>';
    }).join('');

    // On the last step of a guest tour, swap the "Terminer" button for a clear
    // sign-up / log-in choice — the whole point of showing the tour to visitors.
    // The two CTAs stack full-width below so they never squeeze on one row.
    var footHtml;
    if (isLast && guestRun) {
      footHtml =
        '<div class="bwr-tip-foot">' +
          '<div class="bwr-tip-dots">' + dots + '</div>' +
          (idx > 0 ? '<button class="bwr-tut-btn bwr-tut-btn-ghost bwr-tut-btn-sm" id="bwrTipPrev">Précédent</button>' : '') +
        '</div>' +
        '<div class="bwr-tip-cta">' +
          '<button class="bwr-tut-btn bwr-tut-btn-primary" id="bwrTipSignup">Créer un compte gratuit</button>' +
          '<button class="bwr-tut-btn bwr-tut-btn-ghost" id="bwrTipLogin">J’ai déjà un compte — se connecter</button>' +
        '</div>';
    } else {
      footHtml =
        '<div class="bwr-tip-foot">' +
          '<div class="bwr-tip-dots">' + dots + '</div>' +
          '<div class="bwr-tip-nav">' +
            (idx > 0 ? '<button class="bwr-tut-btn bwr-tut-btn-ghost bwr-tut-btn-sm" id="bwrTipPrev">Précédent</button>' : '') +
            '<button class="bwr-tut-btn bwr-tut-btn-primary bwr-tut-btn-sm" id="bwrTipNext">' +
              (isLast ? 'Terminer ✓' : 'Suivant →') +
            '</button>' +
          '</div>' +
        '</div>';
    }

    els.tip.innerHTML =
      '<button class="bwr-tip-skip" id="bwrTipSkip">Passer ✕</button>' +
      '<div class="bwr-tip-step">Étape ' + (idx + 1) + ' / ' + order.length + '</div>' +
      '<h3>' + def.title + '</h3>' +
      '<p>' + def.body + '</p>' +
      footHtml;

    els.tip.querySelector('#bwrTipSkip').addEventListener('click', function () { teardown(false); });
    var nextBtn = els.tip.querySelector('#bwrTipNext');
    if (nextBtn) nextBtn.addEventListener('click', function () { go(1); });
    var signupBtn = els.tip.querySelector('#bwrTipSignup');
    if (signupBtn) signupBtn.addEventListener('click', function () { markSeen(); window.location.href = 'login?signup=1'; });
    var loginBtn = els.tip.querySelector('#bwrTipLogin');
    if (loginBtn) loginBtn.addEventListener('click', function () { markSeen(); window.location.href = 'login'; });
    var prev = els.tip.querySelector('#bwrTipPrev');
    if (prev) prev.addEventListener('click', function () { go(-1); });

    // Bring the target into view, then position the spotlight + tooltip.
    // Instant (not smooth) scroll — a running smooth-scroll animation fires the
    // scroll listener continuously and can leave the spotlight chasing a moving
    // target between steps.
    try { step.node.scrollIntoView({ block: 'center', behavior: 'auto' }); } catch (e) {}
    requestAnimationFrame(function () {
      reposition();
      requestAnimationFrame(function () {
        els.spot.style.opacity = '1';
        els.tip.classList.add('bwr-tip-show');
      });
    });
    // The drawer slides in over ~250ms; re-measure once it has settled so the
    // spotlight and tooltip land on its final position, not a mid-animation one.
    if (def.openDrawer) setTimeout(reposition, 300);
  }

  function reposition() {
    if (!els.tip || !order[idx]) return;
    var node = order[idx].node;
    var r = node.getBoundingClientRect();
    var pad = 8;
    var vw = window.innerWidth, vh = window.innerHeight;

    // Spotlight box around the target.
    els.spot.style.top = (r.top - pad) + 'px';
    els.spot.style.left = (r.left - pad) + 'px';
    els.spot.style.width = (r.width + pad * 2) + 'px';
    els.spot.style.height = (r.height + pad * 2) + 'px';

    // Tooltip placement: prefer the step's hint, flip if it would overflow.
    var tipRect = els.tip.getBoundingClientRect();
    var tw = tipRect.width || 320, th = tipRect.height || 180;
    var gap = 16;
    var placement = order[idx].def.placement || 'bottom';
    var top, left;

    // 'right' is used for the side nav drawer: sit the tooltip beside it. If
    // there isn't room (narrow / mobile viewport where the drawer eats most of
    // the width), fall back to a bottom-centred card.
    if (placement === 'right') {
      if (r.right + tw + gap <= vw - 8) {
        left = r.right + gap;
        top = r.top + r.height / 2 - th / 2;
      } else {
        left = vw / 2 - tw / 2;
        top = vh - th - 16;
      }
    } else {
      if (placement === 'top' && r.top - th - gap < 8) placement = 'bottom';
      if (placement === 'bottom' && r.bottom + th + gap > vh - 8) placement = 'top';

      if (placement === 'top') top = r.top - th - gap;
      else top = r.bottom + gap;

      left = r.left + r.width / 2 - tw / 2;
    }

    left = Math.max(12, Math.min(left, vw - tw - 12));
    top = Math.max(12, Math.min(top, vh - th - 12));

    els.tip.style.top = top + 'px';
    els.tip.style.left = left + 'px';
  }

  function finishToast() {
    var t = el('div', 'bwr-tut-toast', '🎉 C’est parti — bonne balade&nbsp;!');
    document.body.appendChild(t);
    requestAnimationFrame(function () { t.classList.add('bwr-tut-show'); });
    setTimeout(function () {
      t.classList.remove('bwr-tut-show');
      setTimeout(function () { t.remove(); }, 300);
    }, 2600);
  }

  // ── Boot ───────────────────────────────────────────────────────────────────
  // Fully user-driven: nothing appears on its own. For a brand-new signup on the
  // map page we simply wait for the user to actually engage with the map (tap /
  // click / pan); that first interaction — and only that — launches the welcome.
  // From there the user advances each step themselves (Next / Previous / Skip);
  // no step auto-advances and there is no timed pop-up. No replay entry point
  // exists by design — the tour cannot be triggered again once seen.
  function boot() {
    if (!onMapPage()) return;

    // Two audiences, each shown the tour exactly once:
    //  • a brand-new signed-in member (server `onboarded:false`), or
    //  • a logged-out visitor who has never seen the guest tour on this browser.
    var isNewMember = loggedIn() && !seen() && isNewSignup();
    var isGuestNew  = !loggedIn() && !guestSeen();
    if (!isNewMember && !isGuestNew) return;
    guestRun = isGuestNew;

    var map = document.getElementById('map');
    if (!map) return;

    var launched = false;
    function launch() {
      if (launched) return;
      launched = true;
      map.removeEventListener('pointerdown', launch, true);
      map.removeEventListener('touchstart', launch, true);
      showWelcome();
    }
    // The first interaction with the map surface is what starts it — never a timer.
    map.addEventListener('pointerdown', launch, true);
    map.addEventListener('touchstart', launch, true);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
