/* ── BWR onboarding ───────────────────────────────────────────────────────────
 * First-visit experience for newly-signed-up users:
 *   • A welcome / quick-start modal (#3) shown once after the first login.
 *   • An interactive coach-mark tour (#1) that spotlights the real UI controls.
 *
 * Auto-runs on the map page when a logged-in user has never seen it. Can be
 * replayed from anywhere via the nav-drawer "Revoir le tutoriel" link or the
 * guide page — those navigate to `map?tour=1` (tour) or `map?tour=welcome`.
 *
 * No build step, no dependencies. Exposes window.BWRTour for replay.
 * ──────────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  var SEEN_KEY = 'bwr_tutorial_seen';

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
      title: 'Filtrez les chemins',
      body: 'Affichez ou masquez les sentiers selon leur difficulté, et basculez entre la carte IGN et la vue satellite.',
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
      target: '.bnav-item[href="routes"], .header-nav-links a[href="routes"]',
      title: 'Planifiez un trajet',
      body: 'Le cœur de BWR : indiquez un départ et une distance, et l’app génère une boucle ou un A→B en forêt, avec dénivelé et export GPX.',
      placement: 'top'
    },
    {
      target: '.bnav-item[href="profile"], .header-nav-links a[href="profile"]',
      title: 'Votre profil',
      body: 'Suivez vos kilomètres, débloquez des badges, fixez-vous des objectifs et tournez la roue du jour.',
      placement: 'top'
    },
    {
      target: '#btnNavMenu',
      title: 'Tout le reste',
      body: 'Le menu donne accès au classement, aux meilleures balades, aux cartes hors-ligne et au guide complet.',
      placement: 'bottom'
    }
  ];

  var els = {};      // overlay / spot / tip / blocker references
  var order = [];    // resolved steps (with live elements) for the current run
  var idx = 0;

  function seen() {
    try { return localStorage.getItem(SEEN_KEY) === '1'; } catch (e) { return false; }
  }
  function markSeen() {
    try { localStorage.setItem(SEEN_KEY, '1'); } catch (e) {}
  }
  function loggedIn() {
    try { return !!localStorage.getItem('bwr_token'); } catch (e) { return false; }
  }
  function onMapPage() { return !!document.getElementById('map'); }

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

    var dots = order.map(function (_, i) {
      return '<span class="bwr-tip-dot' + (i === idx ? ' active' : '') + '"></span>';
    }).join('');

    els.tip.innerHTML =
      '<button class="bwr-tip-skip" id="bwrTipSkip">Passer ✕</button>' +
      '<div class="bwr-tip-step">Étape ' + (idx + 1) + ' / ' + order.length + '</div>' +
      '<h3>' + def.title + '</h3>' +
      '<p>' + def.body + '</p>' +
      '<div class="bwr-tip-foot">' +
        '<div class="bwr-tip-dots">' + dots + '</div>' +
        '<div class="bwr-tip-nav">' +
          (idx > 0 ? '<button class="bwr-tut-btn bwr-tut-btn-ghost bwr-tut-btn-sm" id="bwrTipPrev">Précédent</button>' : '') +
          '<button class="bwr-tut-btn bwr-tut-btn-primary bwr-tut-btn-sm" id="bwrTipNext">' +
            (isLast ? 'Terminer ✓' : 'Suivant →') +
          '</button>' +
        '</div>' +
      '</div>';

    els.tip.querySelector('#bwrTipSkip').addEventListener('click', function () { teardown(false); });
    els.tip.querySelector('#bwrTipNext').addEventListener('click', function () { go(1); });
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

    if (placement === 'top' && r.top - th - gap < 8) placement = 'bottom';
    if (placement === 'bottom' && r.bottom + th + gap > vh - 8) placement = 'top';

    if (placement === 'top') top = r.top - th - gap;
    else top = r.bottom + gap;

    left = r.left + r.width / 2 - tw / 2;
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

  // ── Public API (replay) ────────────────────────────────────────────────────
  window.BWRTour = {
    start: startTour,
    welcome: showWelcome,
    reset: function () { try { localStorage.removeItem(SEEN_KEY); } catch (e) {} }
  };

  // ── Boot ───────────────────────────────────────────────────────────────────
  function boot() {
    var params = new URLSearchParams(window.location.search);
    var requested = params.get('tour');

    if (requested) {
      // Clean the URL so a refresh doesn't relaunch the tour.
      params.delete('tour');
      var qs = params.toString();
      history.replaceState(null, '', window.location.pathname + (qs ? '?' + qs : ''));
      // Wait a beat for the map controls to render.
      setTimeout(requested === 'welcome' ? showWelcome : startTour, 600);
      return;
    }

    if (onMapPage() && loggedIn() && !seen()) {
      setTimeout(showWelcome, 900);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
