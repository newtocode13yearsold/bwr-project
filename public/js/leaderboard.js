/* leaderboard.js — Leaderboard page */

const LEAGUES = [
  { key: 'legende',    name: 'Légende',    icon: '👑', min: 300, color: '#92400e', bg: '#fffbeb', border: '#fde68a' },
  { key: 'forestier',  name: 'Forestier',  icon: '🌲', min: 100, color: '#15803d', bg: '#f0fdf4', border: '#86efac' },
  { key: 'gardien',    name: 'Gardien',    icon: '🦌', min: 50,  color: '#1e40af', bg: '#eff6ff', border: '#bfdbfe' },
  { key: 'randonneur', name: 'Randonneur', icon: '🌱', min: 20,  color: '#166534', bg: '#f0fdf4', border: '#bbf7d0' },
  { key: 'promeneur',  name: 'Promeneur',  icon: '🪵', min: 0,   color: '#374151', bg: '#f3f4f6', border: '#d1d5db' },
];

function getLeague(points) {
  return LEAGUES.find(l => points >= l.min) || LEAGUES[LEAGUES.length - 1];
}

function initials(name) {
  return (name || '?').split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);
}

function renderLeaguesLegend() {
  const grid = document.getElementById('leaguesGrid');
  if (!grid) return;
  grid.innerHTML = [...LEAGUES].reverse().map(l => `
    <div class="league-pill league-${l.key}">
      <span class="league-icon">${l.icon}</span>
      <span class="league-name">${l.name}</span>
      <span class="league-pts">${l.min === 0 ? '0+' : l.min + '+'} pts</span>
    </div>
  `).join('');
}

function renderMyRank(entries, myId, period) {
  const card = document.getElementById('myRankCard');
  if (!card || !myId) { card && card.classList.add('hidden'); return; }

  const idx = entries.findIndex(e => e.id === myId);
  if (idx === -1) { card.classList.add('hidden'); return; }

  const me = entries[idx];
  const league = getLeague(me.points);
  const rank = idx + 1;

  document.getElementById('myRankNum').textContent = '#' + rank;
  document.getElementById('myRankName').textContent = me.name;
  document.getElementById('myRankLeague').textContent = league.icon + ' ' + league.name;
  document.getElementById('myRankReports').textContent = me.reports;
  document.getElementById('myRankGrades').textContent = me.pathGrades;
  document.getElementById('myRankPoints').textContent = me.points;

  // Forest coverage is a cumulative, all-time figure — hide it on the periodic boards.
  const covBlock = document.getElementById('myRankCoverageBlock');
  if (covBlock) covBlock.style.display = period === 'all' ? '' : 'none';
  const covEl = document.getElementById('myRankCoverage');
  if (covEl && period === 'all') covEl.textContent = (me.forestCoverage || 0) + '%';

  card.classList.remove('hidden');
}

function renderTable(entries, myId, period) {
  const wrap = document.getElementById('lbTableWrap');
  if (!wrap) return;

  // Forest coverage is cumulative, so it only makes sense on the all-time board.
  const showCoverage = period === 'all';

  if (entries.length === 0) {
    const when = period === 'week' ? 'cette semaine' : period === 'month' ? 'ce mois-ci' : '';
    wrap.innerHTML = `
      <div class="lb-empty">
        <div class="lb-empty-icon">🏆</div>
        <div class="lb-empty-text">Aucun participant ${when ? when + ' ' : ''}pour l'instant.<br>Signalez un problème ou notez un chemin pour apparaître ici !</div>
      </div>`;
    return;
  }

  const medals = ['🥇', '🥈', '🥉'];

  const rows = entries.map((e, i) => {
    const rank = i + 1;
    const league = getLeague(e.points);
    const isMe = e.id === myId;
    const rankClass = rank <= 3 ? `rank-${rank}` : '';
    const medalOrNum = rank <= 3 ? `<span class="lb-medal">${medals[rank - 1]}</span>` : `#${rank}`;

    const coverage = e.forestCoverage || 0;
    const coverageBar = `<div class="lb-cov-bar"><div class="lb-cov-fill" style="width:${Math.min(100, coverage)}%"></div></div>`;
    const coverageCell = showCoverage ? `
        <td class="lb-cov-cell hide-mobile">
          <div class="lb-cov-wrap">${coverageBar}<span class="lb-cov-pct">${coverage}%</span></div>
        </td>` : '';

    return `
      <tr class="${isMe ? 'is-me' : ''}">
        <td><span class="lb-rank-cell ${rankClass}">${medalOrNum}</span></td>
        <td>
          <div class="lb-user-cell">
            <div class="lb-avatar" style="background:${league.bg};color:${league.color}">${initials(e.name)}</div>
            <div>
              <span class="lb-name">${escHtml(e.name)}</span>${isMe ? '<span class="lb-name-you">Vous</span>' : ''}
              <div>
                <span class="lb-league-tag" style="background:${league.bg};color:${league.color};border:1px solid ${league.border}">
                  ${league.icon} ${league.name}
                </span>
              </div>
            </div>
          </div>
        </td>
        <td class="lb-stat-cell hide-mobile">${e.reports}</td>
        <td class="lb-stat-cell hide-mobile">${e.pathGrades}</td>${coverageCell}
        <td class="lb-points-cell">${e.points} pts</td>
      </tr>`;
  }).join('');

  wrap.innerHTML = `
    <table class="lb-table">
      <thead>
        <tr>
          <th>#</th>
          <th>Membre</th>
          <th class="hide-mobile" style="text-align:center">Signalements</th>
          <th class="hide-mobile" style="text-align:center">Chemins notés</th>
          ${showCoverage ? '<th class="hide-mobile">Forêt explorée</th>' : ''}
          <th>Points</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function escHtml(s) {
  return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

let currentPeriod = 'week';

async function loadLeaderboard(period = currentPeriod) {
  currentPeriod = period;
  const wrap = document.getElementById('lbTableWrap');
  if (wrap) wrap.innerHTML = '<div class="lb-loading">Chargement du classement…</div>';

  try {
    const [lbRes, meUser] = await Promise.all([
      fetch(`${API_URL}/api/leaderboard?period=${period}`),
      fetchCurrentUser(),
    ]);

    const entries = lbRes.ok ? await lbRes.json() : [];
    const myId = meUser?.id || null;

    renderMyRank(entries, myId, period);
    renderTable(entries, myId, period);
  } catch {
    const wrap = document.getElementById('lbTableWrap');
    if (wrap) wrap.innerHTML = '<div class="lb-loading">Impossible de charger le classement.</div>';
  }
}

function initPeriodTabs() {
  const tabs = [...document.querySelectorAll('.lb-tab')];
  tabs.forEach(tab => tab.addEventListener('click', () => {
    if (tab.classList.contains('active')) return;
    tabs.forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    loadLeaderboard(tab.dataset.period);
  }));
}

document.addEventListener('DOMContentLoaded', () => {
  // Nav drawer
  const btnMenu = document.getElementById('btnNavMenu');
  const drawer = document.getElementById('navDrawer');
  const overlay = document.getElementById('navDrawerOverlay');
  const btnClose = document.getElementById('btnNavDrawerClose');
  const closeDrawer = () => { drawer?.classList.add('hidden'); overlay?.classList.add('hidden'); };
  if (btnMenu) btnMenu.addEventListener('click', () => { drawer.classList.remove('hidden'); overlay.classList.remove('hidden'); });
  if (btnClose) btnClose.addEventListener('click', closeDrawer);
  if (overlay) overlay.addEventListener('click', closeDrawer);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeDrawer(); });

  // User menu
  const user = getCachedUser();
  const userMenu = document.getElementById('userMenu');
  if (userMenu && user) {
    userMenu.innerHTML = `<a href="profile" class="btn-icon" style="text-decoration:none"><span class="btn-emoji">👤</span><span class="btn-label">${escHtml(user.name.split(' ')[0])}</span></a>`;
    if (user.role === 'admin') {
      const navAdmin = document.getElementById('navDrawerAdmin');
      if (navAdmin) navAdmin.classList.remove('hidden');
    }
  }

  renderLeaguesLegend();
  initPeriodTabs();
  loadLeaderboard('week');
});
