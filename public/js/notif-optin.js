/* ── BWR first-run notification opt-in banner ──────────────────────────────
 * The first time a signed-in member reaches a core app page — right after
 * sign-up — a friendly, dismissible banner asks whether they want to turn on
 * browser notifications for obstacle alerts on their saved routes. It makes
 * clear the choice can be changed later from the profile.
 *
 * Shown at most ONCE per browser, and only when the browser hasn't already
 * been asked (Notification.permission === 'default'), so it never nags. It is
 * inherently per-device because a notification permission is per-device.
 *
 *   • Silver / Gold  → tapping "Activer" requests permission AND registers the
 *                      web-push subscription (same flow as the profile toggle),
 *                      so obstacle alerts start working immediately.
 *   • Free           → tapping "Activer" only captures the browser permission
 *                      (obstacle alerts are an Argent feature); we set that
 *                      expectation instead of hitting the Silver-gated
 *                      /api/push/subscribe endpoint and failing.
 *
 * Self-contained: no build step, no deps beyond the config.js (API_URL) global.
 * Styles: css/notif-optin.css. Kept external because the site CSP forbids
 * inline <script>.
 * ────────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  var SEEN_KEY = 'bwr_notif_optin_seen';

  function seen() {
    try { return localStorage.getItem(SEEN_KEY) === '1'; } catch (e) { return false; }
  }
  function markSeen() {
    try { localStorage.setItem(SEEN_KEY, '1'); } catch (e) {}
  }
  function token() {
    try { return localStorage.getItem('bwr_token') || ''; } catch (e) { return ''; }
  }
  function loggedIn() { return !!token(); }
  function apiBase() {
    return (typeof API_URL !== 'undefined' && API_URL != null) ? API_URL : '';
  }
  function cachedUser() {
    try { return JSON.parse(localStorage.getItem('bwr_user') || '{}') || {}; } catch (e) { return {}; }
  }
  function cachedPlan() {
    var u = cachedUser();
    if (u.role === 'admin') return 'gold';
    return u.plan || 'free';
  }
  // Silver+ (or admin) unlocks the obstacle-alert push feature. Mirrors the
  // profile's `BWR.can('path_alerts', plan)` gate, with a safe manual fallback.
  function isSilverPlus() {
    var plan = cachedPlan();
    try {
      if (window.BWR && typeof BWR.can === 'function') return !!BWR.can('path_alerts', plan);
    } catch (e) {}
    return plan === 'silver' || plan === 'gold';
  }

  var PUSH_SUPPORTED = ('serviceWorker' in navigator) &&
                       ('PushManager' in window) &&
                       ('Notification' in window);

  // The map page runs its own one-time onboarding tour; never stack this banner
  // on top of it. On the map we defer until onboarding is over (the tour flips
  // the cached user's `onboarded` to true when it first appears); on every other
  // page onboarding never runs, so we show right away.
  function onMapPage() { return !!document.getElementById('map'); }
  function onboardingActive() {
    if (document.querySelector('.bwr-tut-overlay, .bwr-tip, .bwr-tut-blocker')) return true;
    return cachedUser().onboarded === false;
  }

  // ── VAPID key decode + server subscribe (permission is requested by caller) ──
  function urlB64ToUint8Array(base64) {
    var padding = '='.repeat((4 - (base64.length % 4)) % 4);
    var b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
    var raw = atob(b64);
    var out = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }
  async function subscribeServer() {
    var base = apiBase();
    var keyRes = await fetch(base + '/api/push/vapid-public-key');
    var payload = await keyRes.json().catch(function () { return {}; });
    if (!payload.key) throw new Error('Service de notifications indisponible.');

    var reg = await navigator.serviceWorker.ready;
    var sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlB64ToUint8Array(payload.key),
      });
    }
    var res = await fetch(base + '/api/push/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token() },
      body: JSON.stringify({ subscription: sub.toJSON() }),
    });
    if (!res.ok) {
      var j = await res.json().catch(function () { return {}; });
      throw new Error(j.error || 'Enregistrement impossible.');
    }
  }

  // ── UI ──────────────────────────────────────────────────────────────────────
  function toast(msg) {
    var t = document.createElement('div');
    t.className = 'notif-optin-toast';
    t.setAttribute('role', 'status');
    t.textContent = msg;
    document.body.appendChild(t);
    requestAnimationFrame(function () { t.classList.add('notif-optin-show'); });
    setTimeout(function () {
      t.classList.remove('notif-optin-show');
      setTimeout(function () { t.remove(); }, 320);
    }, 3600);
  }

  function show() {
    var banner = document.createElement('div');
    banner.className = 'notif-optin';
    banner.setAttribute('role', 'region');
    banner.setAttribute('aria-label', 'Activer les notifications');
    banner.innerHTML =
      '<span class="notif-optin-emoji" aria-hidden="true">🔔</span>' +
      '<div class="notif-optin-body">' +
        '<p><strong>Activer les notifications&nbsp;?</strong> Soyez prévenu dès qu’un obstacle ' +
          '(arbre tombé, inondation…) est signalé sur l’un de vos trajets enregistrés.</p>' +
        '<span class="notif-optin-hint">Vous pourrez changer ce choix à tout moment dans votre profil.</span>' +
        '<div class="notif-optin-actions">' +
          '<button class="notif-optin-btn notif-optin-primary" id="notifOptinYes">Activer</button>' +
          '<button class="notif-optin-btn notif-optin-ghost" id="notifOptinNo">Plus tard</button>' +
        '</div>' +
      '</div>' +
      '<button class="notif-optin-close" id="notifOptinClose" aria-label="Fermer">✕</button>';
    document.body.appendChild(banner);
    requestAnimationFrame(function () { banner.classList.add('notif-optin-show'); });

    function dismiss() {
      markSeen();
      banner.classList.remove('notif-optin-show');
      setTimeout(function () { banner.remove(); }, 320);
    }

    async function activate() {
      var yes = banner.querySelector('#notifOptinYes');
      var no  = banner.querySelector('#notifOptinNo');
      yes.disabled = true; no.disabled = true;
      var perm = 'denied';
      try { perm = await Notification.requestPermission(); } catch (e) {}

      if (perm !== 'granted') {
        toast('Pas de souci — vous pourrez les activer depuis votre profil.');
        dismiss();
        return;
      }

      if (isSilverPlus()) {
        try {
          await subscribeServer();
          // Keep the cached user in sync so the profile toggle reflects "on".
          try {
            var u = cachedUser();
            u.alertsEnabled = true;
            localStorage.setItem('bwr_user', JSON.stringify(u));
          } catch (e) {}
          toast('🔔 Notifications activées ! Vous serez prévenu des obstacles.');
        } catch (e) {
          toast('Autorisation accordée ✓ — gérez vos alertes dans votre profil.');
        }
      } else {
        // Free tier: permission captured; obstacle alerts unlock with Argent.
        toast('✅ Autorisation accordée — les alertes obstacles arrivent avec le plan Argent.');
      }
      dismiss();
    }

    banner.querySelector('#notifOptinYes').addEventListener('click', activate);
    banner.querySelector('#notifOptinNo').addEventListener('click', dismiss);
    banner.querySelector('#notifOptinClose').addEventListener('click', dismiss);
  }

  function boot() {
    if (!loggedIn() || seen()) return;
    // Only where web push can actually work, and only if the browser hasn't
    // already been asked (granted/denied) — otherwise we'd nag pointlessly.
    if (!PUSH_SUPPORTED || Notification.permission !== 'default') return;
    // Don't fight the first-run onboarding tour on the map page.
    if (onMapPage() && onboardingActive()) return;
    // Let the page settle first (mirrors the grade-banner cadence).
    setTimeout(show, 1400);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
