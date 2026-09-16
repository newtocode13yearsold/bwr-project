/* Whole-site rating widget ("comme un avis Google").
 * Injects a public "★ 4,7 · 128 avis" block + a "Donner mon avis" button into
 * the page footer, and a star+comment modal for submitting/updating a review.
 *
 * Self-contained on purpose: it derives its own API base and auth token so it
 * runs on every footer page (index.html included) whether or not config.js /
 * auth.js are also loaded. Individual comments are NOT shown here — they are
 * admin-only (Panneau admin "Avis" tab). */
(function () {
  'use strict';

  // ── API base + token (independent of config.js / auth.js) ──────────────────
  var API = (typeof API_URL === 'string')
    ? API_URL
    : (function () {
        var h = location.hostname;
        if (h === 'localhost' || h === '127.0.0.1') return '';
        if (h.endsWith('.workers.dev')) return '';
        return 'https://bwrmaps.com';
      })();
  function token() { try { return localStorage.getItem('bwr_token'); } catch (e) { return null; } }

  var STAR = '★';
  var summary = { avg: 0, count: 0, dist: {} };
  var mine = null;

  // ── Styles (scoped by .bwr-rating* class names) ────────────────────────────
  function injectStyles() {
    if (document.getElementById('bwr-rating-styles')) return;
    var css = ''
      + '.footer-rating{display:flex;align-items:center;gap:16px;flex-wrap:wrap;margin-top:6px}'
      + '.footer-rating__label{display:inline-flex;align-items:center;gap:10px;flex-wrap:wrap}'
      + '.footer-rating__score{display:inline-flex;align-items:center;gap:7px;font-weight:700;color:#fff;white-space:nowrap}'
      + '.footer-rating__stars{color:#f59e0b;letter-spacing:2px;font-size:1.05rem;position:relative;display:inline-block;line-height:1}'
      + '.footer-rating__stars i{font-style:normal;color:rgba(255,255,255,.25)}'
      + '.footer-rating__stars b{position:absolute;left:0;top:0;overflow:hidden;white-space:nowrap;color:#f59e0b;font-weight:400;letter-spacing:2px}'
      + '.footer-rating__count{color:rgba(255,255,255,.6);font-weight:500;font-size:.9rem;white-space:nowrap}'
      + '.footer-rating__btn{border:1px solid rgba(255,255,255,.35);background:transparent;color:#fff;'
      + 'border-radius:999px;padding:6px 14px;font:inherit;font-size:.85rem;font-weight:600;cursor:pointer;transition:background .15s,border-color .15s}'
      + '.footer-rating__btn:hover{background:rgba(255,255,255,.12);border-color:rgba(255,255,255,.7)}'
      + '.bwr-rating-backdrop{position:fixed;inset:0;background:rgba(6,26,8,.55);display:flex;align-items:center;justify-content:center;'
      + 'padding:20px;z-index:5000;opacity:0;transition:opacity .18s}'
      + '.bwr-rating-backdrop.show{opacity:1}'
      + '.bwr-rating-modal{background:var(--surface-0,#fff);color:var(--text,#1f2937);border-radius:20px;max-width:420px;width:100%;'
      + 'padding:28px 26px;box-shadow:0 24px 48px -20px rgba(11,36,16,.4);text-align:center;transform:translateY(8px);transition:transform .18s}'
      + '.bwr-rating-backdrop.show .bwr-rating-modal{transform:translateY(0)}'
      + '.bwr-rating-modal h3{font-size:1.3rem;margin:0 0 4px;color:var(--text-strong,#0b2410)}'
      + '.bwr-rating-modal p{margin:0 0 18px;color:var(--text-muted,#6b7280);font-size:.9rem}'
      + '.bwr-rating-picker{display:inline-flex;gap:6px;margin-bottom:18px;font-size:2.3rem;line-height:1;cursor:pointer}'
      + '.bwr-rating-picker span{color:rgba(120,120,120,.3);transition:color .1s,transform .1s}'
      + '.bwr-rating-picker span.on{color:#f59e0b}'
      + '.bwr-rating-picker span:hover{transform:scale(1.12)}'
      + '.bwr-rating-modal textarea{width:100%;box-sizing:border-box;min-height:80px;border:1px solid var(--border,#e2e8da);'
      + 'border-radius:12px;padding:10px 12px;font:inherit;font-size:.9rem;resize:vertical;margin-bottom:16px;background:var(--surface-1,#fafbf7);color:inherit}'
      + '.bwr-rating-actions{display:flex;gap:10px}'
      + '.bwr-rating-actions button{flex:1;border-radius:999px;padding:10px;font:inherit;font-weight:700;cursor:pointer;border:1px solid transparent}'
      + '.bwr-rating-submit{background:var(--forest-600,#2d6b1f);color:#fff}'
      + '.bwr-rating-submit:hover{background:var(--forest-700,#1e4d14)}'
      + '.bwr-rating-submit:disabled{opacity:.5;cursor:default}'
      + '.bwr-rating-cancel{background:transparent;border-color:var(--border,#e2e8da);color:var(--text,#1f2937)}'
      + '.bwr-rating-note{font-size:.82rem;color:var(--text-muted,#6b7280);margin-top:12px;min-height:1em}'
      // Floating "rate us" prompt (bottom-right; bottom-center is taken by the offline banner)
      + '.bwr-rating-fab{position:fixed;right:18px;bottom:18px;z-index:4500;max-width:min(320px,92vw);'
      + 'display:flex;align-items:center;gap:12px;background:var(--card,#fff);color:var(--text,#1f2937);'
      + 'border:1px solid var(--border,#e2e8da);border-radius:14px;padding:12px 14px;'
      + 'box-shadow:0 12px 32px -12px rgba(11,36,16,.35);font-size:.88rem;line-height:1.35;'
      + 'transform:translateY(140%);opacity:0;transition:transform .28s ease,opacity .28s ease}'
      + '.bwr-rating-fab.show{transform:translateY(0);opacity:1}'
      + '.bwr-rating-fab__stars{color:#f59e0b;letter-spacing:1px;font-size:1rem}'
      + '.bwr-rating-fab__txt{flex:1;min-width:0}'
      + '.bwr-rating-fab__txt strong{display:block;color:var(--text-strong,#0b2410);font-size:.92rem}'
      + '.bwr-rating-fab__cta{border:none;background:var(--forest-600,#2d6b1f);color:#fff;border-radius:999px;'
      + 'padding:7px 14px;font:inherit;font-size:.82rem;font-weight:700;cursor:pointer;white-space:nowrap}'
      + '.bwr-rating-fab__cta:hover{background:var(--forest-700,#1e4d14)}'
      + '.bwr-rating-fab__close{position:absolute;top:4px;right:8px;border:none;background:transparent;'
      + 'color:var(--text-muted,#9ca3af);font-size:1.1rem;line-height:1;cursor:pointer;padding:2px}';
    var el = document.createElement('style');
    el.id = 'bwr-rating-styles';
    el.textContent = css;
    document.head.appendChild(el);
  }

  // ── Footer block ───────────────────────────────────────────────────────────
  function starsHtml(avg) {
    var pct = Math.max(0, Math.min(100, (avg / 5) * 100));
    return '<span class="footer-rating__stars" aria-hidden="true">'
      + '<i>' + STAR + STAR + STAR + STAR + STAR + '</i>'
      + '<b style="width:' + pct + '%">' + STAR + STAR + STAR + STAR + STAR + '</b></span>';
  }

  function renderFooter() {
    var host = document.querySelector('.footer-inner, .blog-footer');
    if (!host) return;
    var block = document.getElementById('bwr-footer-rating');
    if (!block) {
      block = document.createElement('div');
      block.id = 'bwr-footer-rating';
      block.className = 'footer-rating';
      host.appendChild(block);
    }
    var label, aria;
    if (summary.count > 0) {
      label = '<span class="footer-rating__score">' + starsHtml(summary.avg)
        + ' ' + summary.avg.toFixed(1).replace('.', ',') + '</span>'
        + '<span class="footer-rating__count">' + summary.count + ' avis</span>';
      aria = 'Note du site : ' + summary.avg.toFixed(1) + ' sur 5, ' + summary.count + ' avis';
    } else {
      label = '<span class="footer-rating__count">Soyez le premier à noter BWR</span>';
      aria = 'Aucun avis pour le moment';
    }
    var btnLabel = mine ? 'Modifier mon avis' : 'Donner mon avis';
    block.innerHTML = '<span class="footer-rating__label" role="img" aria-label="' + aria + '">' + label + '</span>'
      + '<button type="button" class="footer-rating__btn" id="bwr-rating-open">' + btnLabel + '</button>';
    var btn = document.getElementById('bwr-rating-open');
    if (btn) btn.addEventListener('click', openModal);
  }

  // ── Modal ────────────────────────────────────────────────────────────────
  function openModal() {
    if (!token()) {
      // Not logged in — send them to login, then back here.
      location.href = 'login?next=' + encodeURIComponent(location.pathname);
      return;
    }
    var picked = mine ? mine.stars : 0;

    var back = document.createElement('div');
    back.className = 'bwr-rating-backdrop';
    back.setAttribute('role', 'dialog');
    back.setAttribute('aria-modal', 'true');
    back.setAttribute('aria-label', 'Noter BWR');
    back.innerHTML =
      '<div class="bwr-rating-modal">'
      + '<h3>Vous aimez BWR ?</h3>'
      + '<p>Votre note nous aide à améliorer l\'appli.</p>'
      + '<div class="bwr-rating-picker" role="radiogroup" aria-label="Note en étoiles">'
      +   '<span data-v="1" role="radio">' + STAR + '</span>'
      +   '<span data-v="2" role="radio">' + STAR + '</span>'
      +   '<span data-v="3" role="radio">' + STAR + '</span>'
      +   '<span data-v="4" role="radio">' + STAR + '</span>'
      +   '<span data-v="5" role="radio">' + STAR + '</span>'
      + '</div>'
      + '<textarea id="bwr-rating-comment" maxlength="1000" placeholder="Un commentaire ? (optionnel, visible par l\'équipe)"></textarea>'
      + '<div class="bwr-rating-actions">'
      +   '<button type="button" class="bwr-rating-cancel">Annuler</button>'
      +   '<button type="button" class="bwr-rating-submit" disabled>Envoyer</button>'
      + '</div>'
      + '<div class="bwr-rating-note" role="status"></div>'
      + '</div>';
    document.body.appendChild(back);
    requestAnimationFrame(function () { back.classList.add('show'); });

    var picker = back.querySelectorAll('.bwr-rating-picker span');
    var submit = back.querySelector('.bwr-rating-submit');
    var note = back.querySelector('.bwr-rating-note');
    var comment = back.querySelector('#bwr-rating-comment');
    if (mine && mine.comment) comment.value = mine.comment;

    function paint(n) {
      for (var i = 0; i < picker.length; i++) {
        picker[i].classList.toggle('on', (i + 1) <= n);
        picker[i].setAttribute('aria-checked', (i + 1) === n ? 'true' : 'false');
      }
      submit.disabled = !(n >= 1 && n <= 5);
    }
    paint(picked);

    Array.prototype.forEach.call(picker, function (s) {
      s.addEventListener('mouseenter', function () { paint(Number(s.getAttribute('data-v'))); });
      s.addEventListener('click', function () { picked = Number(s.getAttribute('data-v')); paint(picked); });
    });
    back.querySelector('.bwr-rating-picker').addEventListener('mouseleave', function () { paint(picked); });

    function close() {
      back.classList.remove('show');
      setTimeout(function () { if (back.parentNode) back.parentNode.removeChild(back); }, 200);
    }
    back.querySelector('.bwr-rating-cancel').addEventListener('click', close);
    back.addEventListener('click', function (e) { if (e.target === back) close(); });
    document.addEventListener('keydown', function esc(e) {
      if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc); }
    });

    submit.addEventListener('click', function () {
      if (!(picked >= 1 && picked <= 5)) return;
      submit.disabled = true;
      note.textContent = 'Envoi…';
      fetch(API + '/api/rating', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token() },
        body: JSON.stringify({ stars: picked, comment: comment.value }),
      })
        .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
        .then(function (res) {
          if (!res.ok) { note.textContent = (res.d && (res.d.error || res.d.message)) || 'Une erreur est survenue.'; submit.disabled = false; return; }
          summary = { avg: res.d.avg, count: res.d.count, dist: res.d.dist };
          mine = res.d.mine || { stars: picked, comment: comment.value };
          note.textContent = 'Merci pour votre avis ! 🌲';
          renderFooter();
          setTimeout(close, 900);
        })
        .catch(function () { note.textContent = 'Réseau indisponible, réessayez.'; submit.disabled = false; });
    });
  }

  // ── Floating "rate us" prompt ──────────────────────────────────────────────
  // A gentle, dismissible nudge that reaches engaged users on pages without a
  // footer (map, routes, profile…). Shows once per browser, only for a signed-in
  // user who hasn't rated yet, after a little engagement — never nags again once
  // dismissed or once a rating is left.
  var PROMPT_KEY = 'bwr_rating_prompt_done';
  function promptDone() { try { return localStorage.getItem(PROMPT_KEY) === '1'; } catch (e) { return false; } }
  function markPromptDone() { try { localStorage.setItem(PROMPT_KEY, '1'); } catch (e) {} }

  function maybeShowPrompt() {
    if (promptDone()) return;              // already dismissed / already rated before
    if (!token()) return;                  // rating needs an account — don't nag anonymous visitors
    if (mine) { markPromptDone(); return; } // they've already rated
    if (document.getElementById('bwr-rating-fab')) return;

    var shown = false;
    function show() {
      if (shown || promptDone() || mine) return;
      shown = true;
      cleanup();
      var fab = document.createElement('div');
      fab.id = 'bwr-rating-fab';
      fab.className = 'bwr-rating-fab';
      fab.setAttribute('role', 'dialog');
      fab.setAttribute('aria-label', 'Donner votre avis sur BWR');
      fab.innerHTML =
        '<button type="button" class="bwr-rating-fab__close" aria-label="Fermer">×</button>'
        + '<span class="bwr-rating-fab__stars" aria-hidden="true">' + STAR + STAR + STAR + STAR + STAR + '</span>'
        + '<span class="bwr-rating-fab__txt"><strong>Vous aimez BWR ?</strong>'
        + 'Notez le site en un clic, ça nous aide beaucoup.</span>'
        + '<button type="button" class="bwr-rating-fab__cta">Noter</button>';
      document.body.appendChild(fab);
      requestAnimationFrame(function () { fab.classList.add('show'); });

      function dismiss(rememberDone) {
        if (rememberDone) markPromptDone();
        fab.classList.remove('show');
        setTimeout(function () { if (fab.parentNode) fab.parentNode.removeChild(fab); }, 300);
      }
      fab.querySelector('.bwr-rating-fab__close').addEventListener('click', function () { dismiss(true); });
      fab.querySelector('.bwr-rating-fab__cta').addEventListener('click', function () { dismiss(true); openModal(); });
    }
    function cleanup() {
      clearTimeout(timer);
      window.removeEventListener('scroll', onScroll);
    }
    function onScroll() {
      var h = document.documentElement;
      var scrolled = (h.scrollTop || document.body.scrollTop);
      var max = (h.scrollHeight - h.clientHeight) || 1;
      if (scrolled / max > 0.35) show();
    }
    // Show after ~25 s of engagement, or once the visitor scrolls a bit — whichever first.
    var timer = setTimeout(show, 25000);
    window.addEventListener('scroll', onScroll, { passive: true });
  }

  // ── Boot ─────────────────────────────────────────────────────────────────
  function boot() {
    var hasFooter = !!document.querySelector('.footer-inner, .blog-footer');
    if (!hasFooter && !token()) return; // no footer and can't rate → nothing to do
    injectStyles();
    var headers = {};
    var t = token();
    if (t) headers.Authorization = 'Bearer ' + t;
    fetch(API + '/api/rating', { headers: headers })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (d) { summary = { avg: d.avg, count: d.count, dist: d.dist }; mine = d.mine || null; }
        if (hasFooter) renderFooter();
        maybeShowPrompt();
      })
      .catch(function () { if (hasFooter) renderFooter(); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
