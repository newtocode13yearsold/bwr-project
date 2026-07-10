// quests.js — renders the BWR quest catalogue and AUTO-DETECTS completion from
// the signed-in user's real stats (GET /api/auth/me → user.stats). No manual
// checking: each quest shows a live progress bar and a ✓ once its metric target
// is reached. Loaded as an external file (site CSP blocks inline scripts).
(function () {
  var SUBTITLES = {
    daily:   "Quêtes du jour — mesurées sur la journée (heure UTC), remises à zéro chaque jour.",
    weekly:  'Quêtes de la semaine — mesurées depuis lundi.',
    monthly: 'Quêtes du mois — mesurées sur le mois en cours.',
    oneTime: 'Hauts faits — objectifs cumulés sur toute ta progression, à débloquer une fois.'
  };

  var state = { scope: 'daily', data: null, metrics: null, loggedIn: false };
  var grid = document.getElementById('questGrid');
  var subtitle = document.getElementById('subtitle');
  var hallHint = document.getElementById('hallHint');

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  // ── Date helpers (UTC, to match how the server keys stats.dailyLog) ──────────
  function dayKey(ms) { return new Date(ms).toISOString().slice(0, 10); }
  function todayMs() {
    var n = new Date();
    return Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate());
  }
  function mondayMs() {
    var t = todayMs();
    var dow = (new Date(t).getUTCDay() + 6) % 7; // Mon=0 … Sun=6
    return t - dow * 86400000;
  }

  // ── Turn user.stats into the metrics the quests reference ────────────────────
  function computeMetrics(stats) {
    stats = stats || {};
    var log = stats.dailyLog || {};
    var tMs = todayMs();
    var tKey = dayKey(tMs);
    var monMs = mondayMs();

    var kmWeek = 0, daysWeek = 0;
    for (var ms = monMs; ms <= tMs; ms += 86400000) {
      var v = log[dayKey(ms)] || 0;
      kmWeek += v;
      if (v > 0) daysWeek += 1;
    }

    var monthPrefix = tKey.slice(0, 7); // YYYY-MM
    var kmMonth = 0, daysMonth = 0;
    Object.keys(log).forEach(function (k) {
      if (k.slice(0, 7) === monthPrefix) {
        kmMonth += log[k] || 0;
        if (log[k] > 0) daysMonth += 1;
      }
    });

    // Weekly route counter is only meaningful within its own week.
    var mondayKey = dayKey(monMs);
    var routesWeek = (stats.weekStart === mondayKey) ? (stats.weeklyRoutes || 0) : 0;

    // A streak only "counts" if the last active day is today or yesterday.
    var last = stats.lastRouteDate;
    var yKey = dayKey(tMs - 86400000);
    var streak = (last === tKey || last === yKey) ? (stats.streak || 0) : 0;

    return {
      active_today:      (log[tKey] || 0) > 0 ? 1 : 0,
      km_today:          log[tKey] || 0,
      km_week:           kmWeek,
      km_month:          kmMonth,
      km_total:          stats.km || 0,
      active_days_week:  daysWeek,
      active_days_month: daysMonth,
      routes_week:       routesWeek,
      routes_total:      stats.routes || 0,
      reports_total:     stats.reports || 0,
      grades_total:      stats.pathGrades || 0,
      streak:            streak,
      best_streak:       stats.bestStreak || 0
    };
  }

  function fmt(v, unit) {
    if (unit === 'km') return (Math.round(v * 10) / 10).toLocaleString('fr-FR') + ' km';
    return String(Math.floor(v));
  }

  function render() {
    var list = (state.data && state.data[state.scope]) || [];
    subtitle.textContent = SUBTITLES[state.scope];
    hallHint.style.display = state.scope === 'oneTime' ? 'block' : 'none';

    var html = '';
    for (var i = 0; i < list.length; i++) {
      var q = list[i];
      var cur = state.metrics ? (state.metrics[q.metric] || 0) : 0;
      var done = state.loggedIn && cur >= q.target;
      var pct = Math.max(0, Math.min(100, (cur / q.target) * 100));
      var reward = q.reward
        ? '<span class="q-reward perk">🎁 ' + esc(q.reward) + '</span>'
        : '<span class="q-reward xp">+' + q.xp + ' XP</span>';

      var progress = state.loggedIn
        ? '<div class="q-progress"><div class="q-bar"><div class="q-fill" style="width:' + pct + '%"></div></div>'
          + '<span class="q-prog-txt">' + esc(fmt(cur, q.unit)) + ' / ' + esc(fmt(q.target, q.unit)) + '</span></div>'
        : '<div class="q-progress q-locked">🔒 Connecte-toi pour suivre ta progression</div>';

      html += '<div class="quest' + (done ? ' collected' : '') + '" data-id="' + q.id + '">'
        + '<div class="q-check">' + (done ? '✓' : '') + '</div>'
        + '<div class="q-emoji">' + q.emoji + '</div>'
        + '<div class="q-body">'
        + '<div class="q-title">' + esc(q.title) + '</div>'
        + '<div class="q-desc">' + esc(q.description) + '</div>'
        + progress
        + reward
        + '</div></div>';
    }
    grid.innerHTML = html;
  }

  document.querySelectorAll('.tab').forEach(function (t) {
    t.addEventListener('click', function () {
      document.querySelectorAll('.tab').forEach(function (x) { x.classList.remove('active'); });
      t.classList.add('active');
      state.scope = t.getAttribute('data-scope');
      render();
    });
  });

  // ── Load quests, then the user's stats to auto-evaluate them ─────────────────
  function loadStats() {
    var hasAuth = typeof getToken === 'function' && getToken();
    if (!hasAuth || typeof API_URL === 'undefined') { render(); return; }
    fetch(API_URL + '/api/auth/me', { headers: (typeof authHeader === 'function' ? authHeader() : {}) })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (u) {
        if (u && u.stats) { state.loggedIn = true; state.metrics = computeMetrics(u.stats); }
        render();
      })
      .catch(function () { render(); });
  }

  fetch('data/quests.json')
    .then(function (r) { return r.json(); })
    .then(function (d) {
      state.data = {
        daily: d.daily || [], weekly: d.weekly || [],
        monthly: d.monthly || [], oneTime: d.oneTime || []
      };
      render();
      loadStats();
    })
    .catch(function () {
      grid.innerHTML = '<p style="color:var(--text-2)">Impossible de charger les quêtes (data/quests.json).</p>';
    });

  var tt = document.getElementById('btnThemeToggle');
  if (tt) tt.addEventListener('click', function () {
    var root = document.documentElement;
    var next = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    root.setAttribute('data-theme', next);
    try { localStorage.setItem('bwr-theme', next); } catch (e) {}
  });
})();
