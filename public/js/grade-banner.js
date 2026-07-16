/* ── BWR grade-help banner ─────────────────────────────────────────────────
 * The very first time a logged-in user opens the map OR the route-planner
 * page, show a friendly, dismissible banner asking them to help grade the
 * difficulty of the paths they know, with a link to the guide section that
 * explains how. Shown once per browser (shared key across both pages), then
 * never again once seen or dismissed.
 *
 * No build step, no deps. Styles: css/grade-banner.css. Kept external because
 * the site CSP forbids inline <script>.
 * ────────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  var SEEN_KEY = 'bwr_grade_banner_seen';

  function seen() {
    try { return localStorage.getItem(SEEN_KEY) === '1'; } catch (e) { return false; }
  }
  function markSeen() {
    try { localStorage.setItem(SEEN_KEY, '1'); } catch (e) {}
  }
  function loggedIn() {
    try { return !!localStorage.getItem('bwr_token'); } catch (e) { return false; }
  }
  // Only the map (#map) and planner (.routes-body) pages load this file, but
  // guard anyway so it stays inert anywhere else.
  function onEligiblePage() {
    return !!document.getElementById('map') ||
           document.body.classList.contains('routes-body');
  }

  function show() {
    var banner = document.createElement('div');
    banner.className = 'grade-banner';
    banner.setAttribute('role', 'region');
    banner.setAttribute('aria-label', 'Aidez à noter les chemins');
    banner.innerHTML =
      '<span class="grade-banner-emoji" aria-hidden="true">🎨</span>' +
      '<div class="grade-banner-body">' +
        '<p>J’ai besoin de votre aide&nbsp;! Notez la <strong>difficulté</strong> des chemins que vous connaissez pour aider toute la communauté.</p>' +
        '<a class="grade-banner-cta" href="guide#noter">Comment noter un chemin →</a>' +
      '</div>' +
      '<button class="grade-banner-close" aria-label="Fermer">✕</button>';
    document.body.appendChild(banner);
    requestAnimationFrame(function () { banner.classList.add('grade-banner-show'); });

    function dismiss() {
      markSeen();
      banner.classList.remove('grade-banner-show');
      setTimeout(function () { banner.remove(); }, 300);
    }
    banner.querySelector('.grade-banner-close').addEventListener('click', dismiss);
    // Following the guide link also counts as seen — no need to nag again.
    banner.querySelector('.grade-banner-cta').addEventListener('click', markSeen);
  }

  function boot() {
    if (!onEligiblePage() || !loggedIn() || seen()) return;
    // Give the page (map controls / planner UI) a beat to settle first.
    setTimeout(show, 1100);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
