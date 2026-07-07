// profile-stats.js — the engagement gadgets on the profile page: activity
// heatmap, streak banner, personal records, monthly challenge, recent saved
// routes and (Gold) forest trail health.
// Split out of profile.js. Classic (deferred) script loaded before js/profile.js.
// Only declarations here; each render function is called from renderPlanAndProgress
// (profile-plan.js) during the entry boot IIFE. The small helpers it relies on
// (fmtKm / escapeHtml / utcDayKey / todayUtcMs) live in the entry file js/profile.js.

// ── Activity heatmap (GitHub-style, 53 weeks, Monday-first, UTC) ──────────────
function renderActivityHeatmap(stats) {
  const grid    = document.getElementById('heatGrid');
  const caption = document.getElementById('heatCaption');
  const empty   = document.getElementById('heatEmpty');
  if (!grid) return;

  const dailyLog = (stats && stats.dailyLog) || {};
  empty.style.display = Object.keys(dailyLog).length ? 'none' : '';

  const DAY_MS  = 86400000;
  const todayMs = todayUtcMs();
  const dow     = (new Date(todayMs).getUTCDay() + 6) % 7;  // Mon=0 … Sun=6
  const endMs   = todayMs + (6 - dow) * DAY_MS;             // Sunday closing this week
  const startMs = endMs - (53 * 7 - 1) * DAY_MS;            // 53 weeks back, a Monday

  const levelOf = km => km <= 0 ? 0 : km < 2 ? 1 : km < 5 ? 2 : km < 10 ? 3 : 4;

  let html = '';
  for (let weekMs = startMs; weekMs <= endMs; weekMs += 7 * DAY_MS) {
    html += '<div class="heat-col">';
    for (let d = 0; d < 7; d++) {
      const ms = weekMs + d * DAY_MS;
      if (ms > todayMs) { html += '<span class="heat-cell heat-future"></span>'; continue; }
      const dayKm = dailyLog[utcDayKey(ms)] || 0;
      const dateLabel = new Date(ms).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
      const title = dayKm > 0 ? `${fmtKm(dayKm)} le ${dateLabel}` : `Aucune sortie le ${dateLabel}`;
      html += `<span class="heat-cell heat-l${levelOf(dayKm)}" title="${title}"></span>`;
    }
    html += '</div>';
  }
  grid.innerHTML = html;

  const fmtMonth = ms => new Date(ms).toLocaleDateString('fr-FR', { month: 'short', year: 'numeric', timeZone: 'UTC' });
  caption.textContent = `${fmtMonth(startMs)} – ${fmtMonth(todayMs)}`;
}

// ── Streak banner ───────────────────────────────────────────────────────────
function renderStreakBanner(stats) {
  const banner = document.getElementById('streakBanner');
  if (!banner) return;
  const streak = (stats && stats.streak) || 0;
  const last   = stats && stats.lastRouteDate;
  const best   = (stats && stats.bestStreak) || streak;

  const todayMs  = todayUtcMs();
  const todayKey = utcDayKey(todayMs);
  const yestKey  = utcDayKey(todayMs - 86400000);
  const active   = last === todayKey || last === yestKey;

  if (!active || streak < 2) { banner.style.display = 'none'; return; }

  const recordTxt = best > streak ? ` · Record : ${best} j` : (streak === best ? ' · Record personnel ! 🏅' : '');
  banner.style.display = '';
  banner.innerHTML = last === todayKey
    ? `<span class="streak-flame">🔥</span><span><strong>${streak} jours d'affilée</strong> — continue sur ta lancée !${recordTxt}</span>`
    : `<span class="streak-flame">🔥</span><span>Série de <strong>${streak} jours</strong> — sors aujourd'hui pour ne pas la perdre !${recordTxt}</span>`;
}

// ── Personal records ──────────────────────────────────────────────────────────
function renderRecords(stats) {
  const dailyLog = (stats && stats.dailyLog) || {};
  const days = Object.keys(dailyLog);

  let bestDay = 0;
  for (const k of days) if (dailyLog[k] > bestDay) bestDay = dailyLog[k];

  let bestWeek = 0;
  for (const k of days) {
    const baseMs = Date.parse(k + 'T00:00:00Z');
    let sum = 0;
    for (let i = 0; i < 7; i++) sum += dailyLog[utcDayKey(baseMs - i * 86400000)] || 0;
    if (sum > bestWeek) bestWeek = sum;
  }

  const longest    = (stats && stats.longestRoute) || 0;
  const bestStreak = (stats && stats.bestStreak) || (stats && stats.streak) || 0;

  const set = (id, txt) => { const el = document.getElementById(id); if (el) el.textContent = txt; };
  set('recBestDay',    bestDay    > 0 ? fmtKm(bestDay)  : '—');
  set('recBestWeek',   bestWeek   > 0 ? fmtKm(bestWeek) : '—');
  set('recLongest',    longest    > 0 ? fmtKm(longest)  : '—');
  set('recBestStreak', bestStreak > 0 ? `${bestStreak} j` : '—');
}

// ── Monthly challenge ───────────────────────────────────────────────────────
const MONTHLY_CHALLENGES = [
  { icon: '❄️',  name: 'Défi hivernal',         target: 20 },
  { icon: '🌨️',  name: 'Braver le froid',       target: 20 },
  { icon: '🌱',  name: 'Renouveau printanier',  target: 30 },
  { icon: '🌸',  name: 'Floraison',             target: 35 },
  { icon: '🌿',  name: 'Forêt verdoyante',      target: 40 },
  { icon: '☀️',  name: 'Longues journées',      target: 50 },
  { icon: '🌳',  name: 'Plein été',             target: 50 },
  { icon: '🏞️',  name: 'Évasion estivale',      target: 45 },
  { icon: '🍂',  name: "Couleurs d'automne",    target: 40 },
  { icon: '🍄',  name: 'Saison des champignons', target: 30 },
  { icon: '🌫️',  name: 'Brumes de novembre',    target: 25 },
  { icon: '🎄',  name: "Défi de fin d'année",   target: 20 },
];

async function renderMonthlyChallenge(stats) {
  const box = document.getElementById('monthlyChallenge');
  if (!box) return;
  const dailyLog = (stats && stats.dailyLog) || {};

  const now    = new Date();
  const month  = now.getUTCMonth();
  const year   = now.getUTCFullYear();
  const prefix = `${year}-${String(month + 1).padStart(2, '0')}`;

  // Try fetching admin-configured challenge; fall back to built-in default
  let ch = MONTHLY_CHALLENGES[month];
  try {
    const res = await fetch(`${API_URL}/api/challenge`);
    if (res.ok) {
      const custom = await res.json();
      if (custom && custom.name && custom.target) ch = custom;
    }
  } catch {}

  let done = 0;
  for (const k of Object.keys(dailyLog)) if (k.startsWith(prefix)) done += dailyLog[k];
  done = parseFloat(done.toFixed(1));

  const pct       = Math.min(100, (done / ch.target) * 100);
  const reached   = done >= ch.target;
  const monthName = new Date(Date.UTC(year, month, 1)).toLocaleDateString('fr-FR', { month: 'long', timeZone: 'UTC' });
  const remaining = Math.max(0, parseFloat((ch.target - done).toFixed(1)));

  box.innerHTML = `
    <div class="challenge-card ${reached ? 'is-done' : ''}">
      <div class="challenge-top">
        <span class="challenge-emoji">${ch.icon}</span>
        <div class="challenge-info">
          <strong class="challenge-name">${escapeHtml(ch.name)}</strong>
          <span class="challenge-target">Objectif : ${ch.target} km en ${monthName}</span>
        </div>
        ${reached ? '<span class="challenge-medal">✓ Réussi</span>' : ''}
      </div>
      <div class="xp-bar"><div class="xp-fill" style="width:${pct}%"></div></div>
      <p class="challenge-prog">${fmtKm(done)} / ${ch.target} km${reached ? ' — bravo ! 🎉' : ` · ${fmtKm(remaining)} restants`}</p>
    </div>`;
}

// ── Recent saved routes (Silver+) ─────────────────────────────────────────────
const DIFFICULTY_COLORS = { easy: '#22c55e', medium: '#f97316', hard: '#ef4444', impassable: '#9ca3af' };

function fmtDuration(seconds) {
  const min = Math.round((seconds || 0) / 60);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60), m = min % 60;
  return m ? `${h} h ${m}` : `${h} h`;
}

async function renderRecentRoutes(plan) {
  const card = document.getElementById('recentRoutesCard');
  const list = document.getElementById('recentRoutesList');
  if (!card || !list) return;
  if (!BWR.can('route_history', plan)) { card.style.display = 'none'; return; }

  card.style.display = '';
  list.innerHTML = '<p class="rr-empty">Chargement…</p>';

  try {
    const res = await fetch(`${API_URL}/api/savedroutes`, { headers: authHeader() });
    if (!res.ok) throw new Error();
    const routes = await res.json();

    if (!routes.length) {
      list.innerHTML = `<p class="rr-empty">Aucun trajet sauvegardé pour l'instant — <a href="routes">planifie ta première boucle →</a></p>`;
      return;
    }

    list.innerHTML = routes.slice(0, 3).map(r => {
      const color = DIFFICULTY_COLORS[r.difficulty] || '#9ca3af';
      const km    = fmtKm((r.meters || 0) / 1000);
      const dur   = fmtDuration(r.seconds);
      const date  = r.savedAt ? new Date(r.savedAt).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' }) : '';
      const icon  = r.pathType === 'bike' ? '🚴' : '🥾';
      const href  = r.shareToken ? `routes?share=${encodeURIComponent(r.shareToken)}` : 'routes';
      const name  = escapeHtml(r.name || 'Trajet sans nom');
      return `
        <a class="recent-route" href="${href}">
          <span class="rr-dot" style="background:${color}"></span>
          <span class="rr-main">
            <span class="rr-name">${icon} ${name}</span>
            <span class="rr-meta">📏 ${km} · ⏱ ${dur}${date ? ` · 🗓 ${date}` : ''}</span>
          </span>
          <span class="rr-go">→</span>
        </a>`;
    }).join('');
  } catch {
    list.innerHTML = `<p class="rr-empty">Impossible de charger tes trajets.</p>`;
  }
}

// ── Forest trail health (Gold) ────────────────────────────────────────────────
const REPORT_TYPE_LABELS = {
  fallen_tree: ['🪵', 'Arbre tombé'],
  flooded:     ['💧', 'Inondé'],
  muddy:       ['🟤', 'Boueux'],
  rutted:      ['🛞', 'Ornières'],
  broken_sign: ['🪧', 'Panneau cassé'],
  closed:      ['🚫', 'Fermé'],
  danger:      ['⚠️', 'Danger'],
  other:       ['📝', 'Autre'],
};

async function renderTrailHealth() {
  const list = document.getElementById('thList');
  if (!list) return;
  list.innerHTML = '<p class="th-empty">Chargement…</p>';

  try {
    const [paths, reports] = await Promise.all([
      fetch(`${API_URL}/api/paths`).then(r => r.ok ? r.json() : []),
      fetch(`${API_URL}/api/reports`).then(r => r.ok ? r.json() : []),
    ]);

    document.getElementById('thPaths').textContent = paths.length;
    document.getElementById('thOpen').textContent  = reports.length;

    const weekAgo = Date.now() - 7 * 86400000;
    const recent  = reports.filter(r => r.date && new Date(r.date).getTime() >= weekAgo).length;
    document.getElementById('thWeek').textContent = recent;

    if (!reports.length) {
      list.innerHTML = `<p class="th-ok">✅ Aucun problème signalé — la forêt est en pleine forme !</p>`;
      return;
    }

    const counts = {};
    for (const r of reports) counts[r.type] = (counts[r.type] || 0) + 1;
    list.innerHTML = Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .map(([type, n]) => {
        const [icon, label] = REPORT_TYPE_LABELS[type] || ['❓', type];
        return `<span class="th-chip"><span class="th-chip-ico">${icon}</span>${label} <strong>${n}</strong></span>`;
      }).join('');
  } catch {
    list.innerHTML = `<p class="th-empty">État des chemins indisponible.</p>`;
  }
}
