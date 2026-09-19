// admin-pro.js — "Nouveau" professional executive view for the admin panel.
// Loaded ONLY by admin-panel.html, before admin.js. Two responsibilities:
//   1. Wire the "Ancien / Nouveau" segmented toggle (persisted in localStorage).
//   2. Render a polished executive dashboard into #adminProView, lazily on the
//      first switch to the new view (and refreshable via window.__initProDashboard).
// Self-contained: relies only on globals from config.js (API_URL), auth.js
// (authHeader) and the Chart.js UMD bundle already loaded on the page. It defines
// its own price/escape helpers so it never couples to admin.js load order.
(function () {
  'use strict';

  const PRICE = { free: 0, silver: 2.99, gold: 6.99 };
  const VIEW_KEY = 'bwr_admin_view';

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  const fmt = n => new Intl.NumberFormat('fr-FR').format(n);

  let _rendered = false;
  let _growthChart = null;
  let _visitsChart = null;

  // ── Toggle wiring ───────────────────────────────────────────────────────
  function applyView(view) {
    const dash = document.getElementById('adminDashboard');
    if (!dash) return;
    const isNew = view === 'new';
    dash.classList.toggle('view-new', isNew);
    document.querySelectorAll('.admin-view-btn').forEach(b =>
      b.classList.toggle('active', b.dataset.view === view));
    try { localStorage.setItem(VIEW_KEY, view); } catch { /* private mode */ }
    if (isNew && !_rendered) renderPro();
  }

  function wireToggle() {
    const btns = document.querySelectorAll('.admin-view-btn');
    if (!btns.length) return;
    btns.forEach(b => b.addEventListener('click', () => applyView(b.dataset.view)));
    let saved = 'old';
    try { saved = localStorage.getItem(VIEW_KEY) || 'old'; } catch { /* ignore */ }
    applyView(saved);
  }

  // ── Data + render ─────────────────────────────────────────────────────────
  async function renderPro() {
    _rendered = true; // optimistic: avoid double-render races on rapid toggling
    try {
      const [usersR, eventsR, pathsR, reportsR, poisR, ratingR, topicsR] = await Promise.all([
        fetch(`${API_URL}/api/users`, { headers: authHeader() }).catch(() => null),
        fetch(`${API_URL}/api/analytics/events`, { headers: authHeader() }).catch(() => null),
        fetch(`${API_URL}/api/paths`).catch(() => null),
        fetch(`${API_URL}/api/reports`).catch(() => null),
        fetch(`${API_URL}/api/pois`).catch(() => null),
        fetch(`${API_URL}/api/rating`).catch(() => null),
        fetch(`${API_URL}/api/forum/topics`, { headers: authHeader() }).catch(() => null),
      ]);

      const users   = usersR?.ok   ? await usersR.json()   : [];
      const events  = eventsR?.ok  ? await eventsR.json()  : {};
      const paths   = pathsR?.ok   ? await pathsR.json()   : [];
      const reports = reportsR?.ok ? await reportsR.json() : [];
      const pois    = poisR?.ok    ? await poisR.json()    : [];
      const rating  = ratingR?.ok  ? await ratingR.json()  : {};
      const topicsD = topicsR?.ok  ? await topicsR.json()  : {};

      const memberArr = (Array.isArray(users) ? users : []).filter(u => u.role !== 'admin');
      const pathArr   = Array.isArray(paths) ? paths : [];
      const reportArr = Array.isArray(reports) ? reports : [];
      const poiArr    = Array.isArray(pois) ? pois : [];
      const topics    = Array.isArray(topicsD) ? topicsD : (topicsD.topics || []);

      // Plan split + revenue (comped subscriptions excluded from revenue)
      const counts = { free: 0, silver: 0, gold: 0 };
      const comped = { silver: 0, gold: 0 };
      memberArr.forEach(u => {
        const plan = u.plan || 'free';
        counts[plan] = (counts[plan] || 0) + 1;
        if (u.comped && (plan === 'silver' || plan === 'gold')) comped[plan]++;
      });
      const paySilver = counts.silver - comped.silver;
      const payGold   = counts.gold   - comped.gold;
      const paying    = paySilver + payGold;
      const total     = memberArr.length;
      const mrr       = paySilver * PRICE.silver + payGold * PRICE.gold;
      const conv      = total ? Math.round(paying / total * 100) : 0;

      // Contributions
      let totalReports = 0, totalGrades = 0, totalKm = 0;
      memberArr.forEach(u => {
        const s = u.stats || {};
        totalReports += s.reports || 0;
        totalGrades  += s.pathGrades || 0;
        totalKm      += Number(s.km) || 0;
      });
      const openReports = reportArr.filter(r => r.status === 'open').length;

      const visitsThisMonth = events.visitsThisMonth || events.monthlyVisits || 0;
      const totalSignups    = events.totalSignups || total;
      const totalLogins     = events.totalLogins || 0;

      // ── KPI hero ──────────────────────────────────────────────────────────
      const kpi = (label, value, hint) =>
        `<div class="pro-kpi"><div class="k-label">${label}</div>
           <div class="k-value">${value}</div>
           <div class="k-hint">${hint}</div></div>`;
      const kbox = document.getElementById('proKpis');
      if (kbox) kbox.innerHTML = [
        kpi('Membres', fmt(total), `${fmt(totalSignups)} inscription${totalSignups > 1 ? 's' : ''}`),
        kpi('MRR estimé', `${mrr.toFixed(2)} €`, 'revenus mensuels récurrents'),
        kpi('Abonnés payants', fmt(paying), `${conv} % de conversion`),
        kpi('Visites ce mois', fmt(visitsThisMonth), `${fmt(totalLogins)} connexion${totalLogins > 1 ? 's' : ''}`),
        kpi('Chemins', fmt(pathArr.length), `${fmt(openReports)} signalement${openReports > 1 ? 's' : ''} ouvert${openReports > 1 ? 's' : ''}`),
      ].join('');

      // ── Plan distribution bars ─────────────────────────────────────────────
      // Comped (offered) Silver/Gold don't count as paying subscribers — they are
      // shown on their own "Offerts" row, excluded from the Argent/Or tally.
      const compedTot = comped.silver + comped.gold;
      const barBox = document.getElementById('proPlanBars');
      if (barBox) {
        const rows = [
          { label: 'Gratuit',  n: counts.free, color: '#9ca3af' },
          { label: 'Argent 🥈', n: paySilver,   color: '#64748b' },
          { label: 'Or 🥇',     n: payGold,     color: '#d97706' },
        ];
        if (compedTot) rows.push({ label: '🎁 Offerts', n: compedTot, color: '#c4b5fd', note: 'hors décompte' });
        const max = Math.max(1, total);
        barBox.innerHTML = rows.map(r => `
          <div class="pro-bar-row">
            <div class="b-label">${r.label}</div>
            <div class="pro-bar-track"><div class="pro-bar-fill" style="width:${Math.round(r.n / max * 100)}%;background:${r.color}"></div></div>
            <div class="b-val">${r.n}${r.note ? ` · ${r.note}` : ` · ${total ? Math.round(r.n / total * 100) : 0}%`}</div>
          </div>`).join('');
      }

      // ── Platform snapshot ───────────────────────────────────────────────────
      const snapTile = (val, lab) =>
        `<div class="pro-snap-tile"><div class="s-val">${val}</div><div class="s-lab">${lab}</div></div>`;
      const snap = document.getElementById('proSnap');
      if (snap) snap.innerHTML = [
        snapTile(fmt(poiArr.length), 'Points d\'intérêt'),
        snapTile(fmt(topics.length), 'Sujets du forum'),
        snapTile(fmt(totalReports), 'Signalements postés'),
        snapTile(fmt(totalGrades), 'Chemins notés'),
      ].join('');

      const traffic = document.getElementById('proTraffic');
      if (traffic) traffic.innerHTML = [
        snapTile(fmt(visitsThisMonth), 'Visiteurs ce mois'),
        snapTile(`${(rating.avg || 0).toFixed(1)}★`, `${fmt(rating.count || 0)} avis`),
        snapTile(`${totalKm.toFixed(0)} km`, 'Distance cumulée'),
        snapTile(`${conv}%`, 'Taux de conversion'),
      ].join('');

      // ── Growth chart : cumulative members over the last 12 months ──────────
      renderGrowthChart(memberArr);
      // ── Monthly visits bar chart ────────────────────────────────────────────
      renderVisitsChart(events.monthlyVisits || {});

    } catch {
      const kbox = document.getElementById('proKpis');
      if (kbox) kbox.innerHTML = '<p style="opacity:0.85;font-size:0.85rem;margin:0">Erreur de chargement des données.</p>';
      _rendered = false; // let a later toggle retry
    }
  }

  function renderGrowthChart(members) {
    const canvas = document.getElementById('proGrowthChart');
    if (!canvas || typeof Chart === 'undefined') return;

    // 12 monthly buckets ending this month
    const start = new Date(); start.setDate(1); start.setHours(0, 0, 0, 0);
    start.setMonth(start.getMonth() - 11);
    const labels = [], monthly = new Array(12).fill(0);
    for (let i = 0; i < 12; i++) {
      const d = new Date(start); d.setMonth(d.getMonth() + i);
      labels.push(d.toLocaleDateString('fr-FR', { month: 'short', year: '2-digit' }));
    }
    // Members created before the window count into the starting baseline
    let baseline = 0;
    members.forEach(u => {
      if (!u.createdAt) return;
      const ts = new Date(u.createdAt).getTime();
      if (isNaN(ts)) return;
      const d = new Date(ts), s = start;
      const idx = (d.getFullYear() - s.getFullYear()) * 12 + (d.getMonth() - s.getMonth());
      if (idx < 0) baseline++;
      else if (idx < 12) monthly[idx]++;
    });
    let running = baseline;
    const cumulative = monthly.map(m => (running += m));

    const isDark    = document.documentElement.getAttribute('data-theme') === 'dark';
    const textColor = isDark ? '#d1d5db' : '#374151';
    const gridColor = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.07)';

    const ctx = canvas.getContext('2d');
    const grad = ctx.createLinearGradient(0, 0, 0, 200);
    grad.addColorStop(0, 'rgba(22,163,74,0.30)');
    grad.addColorStop(1, 'rgba(22,163,74,0.02)');

    if (_growthChart) _growthChart.destroy();
    _growthChart = new Chart(canvas, {
      type: 'line',
      data: {
        labels,
        datasets: [{
          label: 'Membres cumulés',
          data: cumulative,
          borderColor: '#16a34a',
          backgroundColor: grad,
          borderWidth: 2.5,
          pointRadius: 0,
          pointHoverRadius: 5,
          pointBackgroundColor: '#16a34a',
          pointBorderColor: '#fff',
          pointBorderWidth: 2,
          pointHitRadius: 12,
          fill: true,
          tension: 0.35,
        }]
      },
      options: {
        responsive: true,
        interaction: { mode: 'index', intersect: false },
        scales: {
          x: { ticks: { color: textColor, font: { size: 10 }, maxRotation: 45 }, grid: { color: gridColor } },
          y: { beginAtZero: true, ticks: { color: textColor, precision: 0 }, grid: { color: gridColor } }
        },
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: c => ` ${fmt(c.raw)} membre${c.raw !== 1 ? 's' : ''} au total` } }
        }
      }
    });
  }

  function renderVisitsChart(monthlyVisits) {
    const canvas = document.getElementById('proVisitsChart');
    if (!canvas || typeof Chart === 'undefined') return;

    // monthlyVisits is { 'YYYY-MM': count }; keep the last 12 months in order.
    const keys = Object.keys(monthlyVisits).sort().slice(-12);
    const labels = keys.map(k => {
      const [y, m] = k.split('-');
      return new Date(Number(y), Number(m) - 1, 1)
        .toLocaleDateString('fr-FR', { month: 'short', year: '2-digit' });
    });
    const data = keys.map(k => Number(monthlyVisits[k]) || 0);

    const isDark    = document.documentElement.getAttribute('data-theme') === 'dark';
    const textColor = isDark ? '#d1d5db' : '#374151';
    const gridColor = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.07)';

    if (_visitsChart) _visitsChart.destroy();
    _visitsChart = new Chart(canvas, {
      type: 'bar',
      data: {
        labels,
        datasets: [{
          label: 'Visiteurs',
          data,
          backgroundColor: 'rgba(37,99,235,0.75)',
          borderColor: '#2563eb',
          borderWidth: 1,
          borderRadius: 6,
          borderSkipped: false,
          maxBarThickness: 44,
        }]
      },
      options: {
        responsive: true,
        scales: {
          x: { ticks: { color: textColor, font: { size: 10 }, maxRotation: 45 }, grid: { display: false } },
          y: { beginAtZero: true, ticks: { color: textColor, precision: 0 }, grid: { color: gridColor } }
        },
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: c => ` ${fmt(c.raw)} visiteur${c.raw !== 1 ? 's' : ''}` } }
        }
      }
    });
  }

  // Re-render on demand (called from initDashboard so a data refresh reaches the
  // pro view too); only does the fetch work when the new view is actually shown.
  window.__initProDashboard = function () {
    const dash = document.getElementById('adminDashboard');
    if (dash && dash.classList.contains('view-new')) { _rendered = false; renderPro(); }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wireToggle);
  } else {
    wireToggle();
  }
})();
