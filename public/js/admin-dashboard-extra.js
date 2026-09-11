// admin-dashboard-extra.js — dashboard-only cards split out of admin.js to keep
// that shared file under the CI bundle-size cap. Loaded ONLY by admin-panel.html,
// before admin.js, so initDashboard() (in admin.js) can call these via window.
// Relies on globals from config.js (API_URL), auth.js (authHeader) and admin.js
// (escapeHtml) — all loaded on the same page.

// ── Member contribution chips — small non-zero-only badges for a member row ───
// Called from loadMembers() in admin.js.
function memberStatsChips(stats) {
  const s = stats || {};
  const chips = [];
  if (s.km)         chips.push(`🚶 ${Number(s.km).toFixed(1)} km`);
  if (s.routes)     chips.push(`🧭 ${s.routes} trajet${s.routes > 1 ? 's' : ''}`);
  if (s.reports)    chips.push(`📣 ${s.reports} signalement${s.reports > 1 ? 's' : ''}`);
  if (s.pathGrades) chips.push(`🎨 ${s.pathGrades} noté${s.pathGrades > 1 ? 's' : ''}`);
  if (!chips.length) return '';
  return `<div style="margin-top:4px;display:flex;gap:6px;flex-wrap:wrap">${chips.map(c =>
    `<span style="font-size:0.72rem;color:#475569;background:#eef2f7;border-radius:999px;padding:2px 8px">${c}</span>`).join('')}</div>`;
}

// ── Error breakdown strip — which pages & devices are worst hit (by count) ────
// Called from loadErrors() in admin.js; fills #errBreakdown.
function renderErrorBreakdown(errors) {
  const bd = document.getElementById('errBreakdown');
  if (!bd) return;
  if (!errors || !errors.length) { bd.style.display = 'none'; return; }
  const tally = (key) => {
    const m = {};
    errors.forEach(e => { const v = e[key] || '—'; m[v] = (m[v] || 0) + (e.count || 1); });
    return Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, 4);
  };
  const chip = (label, n) => `<span style="background:#fff;border:1px solid #fecaca;border-radius:999px;padding:2px 9px;color:#991b1b">${escapeHtml(String(label))} <strong>${n}</strong></span>`;
  const pages   = tally('page').map(([p, n]) => chip(p, n)).join(' ');
  const devices = tally('device').map(([d, n]) => chip(d, n)).join(' ');
  bd.style.display = 'flex';
  bd.innerHTML =
    `<div><div style="font-weight:700;color:var(--text-muted);margin-bottom:4px">📄 Pages touchées</div><div style="display:flex;gap:6px;flex-wrap:wrap">${pages || '—'}</div></div>` +
    `<div><div style="font-weight:700;color:var(--text-muted);margin-bottom:4px">📱 Appareils</div><div style="display:flex;gap:6px;flex-wrap:wrap">${devices || '—'}</div></div>`;
}

// ── Small stat-tile helper (shared by content + engagement cards) ─────────────
// Returns one compact tile: a big value, a label under it, and an optional accent.
function statTile(value, label, accent) {
  const color = accent || 'var(--text-strong)';
  return `<div style="background:var(--surface-1,#f9fafb);border:1px solid var(--border);border-radius:12px;padding:14px;text-align:center">
    <div style="font-size:1.5rem;font-weight:800;color:${color};line-height:1.1">${value}</div>
    <div style="font-size:0.72rem;color:var(--text-muted);margin-top:4px;font-weight:500">${label}</div>
  </div>`;
}

// ── Content overview — platform-wide totals from the public/admin endpoints ───
async function loadContentStats() {
  const box = document.getElementById('contentStats');
  if (!box) return;
  try {
    const [pathsR, reportsR, poisR, ratingR, topicsR, usersR] = await Promise.all([
      fetch(`${API_URL}/api/paths`).catch(() => null),
      fetch(`${API_URL}/api/reports`).catch(() => null),
      fetch(`${API_URL}/api/pois`).catch(() => null),
      fetch(`${API_URL}/api/rating`).catch(() => null),
      fetch(`${API_URL}/api/forum/topics`, { headers: authHeader() }).catch(() => null),
      fetch(`${API_URL}/api/users`, { headers: authHeader() }).catch(() => null),
    ]);
    const paths   = pathsR?.ok   ? await pathsR.json()   : [];
    const reports = reportsR?.ok ? await reportsR.json() : [];
    const pois    = poisR?.ok    ? await poisR.json()    : [];
    const rating  = ratingR?.ok  ? await ratingR.json()  : {};
    const topicsD = topicsR?.ok  ? await topicsR.json()  : {};
    const users   = usersR?.ok   ? await usersR.json()   : [];

    const pathArr   = Array.isArray(paths) ? paths : [];
    const reportArr = Array.isArray(reports) ? reports : [];
    const poiArr    = Array.isArray(pois) ? pois : [];
    const topics    = Array.isArray(topicsD) ? topicsD : (topicsD.topics || []);
    const memberCount = (Array.isArray(users) ? users : []).filter(u => u.role !== 'admin').length;

    // Path difficulty breakdown
    const byStatus = {};
    pathArr.forEach(p => { byStatus[p.status] = (byStatus[p.status] || 0) + 1; });
    const openReports = reportArr.filter(r => r.status === 'open').length;

    const tiles = [
      statTile(pathArr.length, 'Chemins cartographiés'),
      statTile(`${openReports}/${reportArr.length}`, 'Signalements ouverts / total', openReports ? '#f97316' : undefined),
      statTile(poiArr.length, 'Points d\'intérêt'),
      statTile(topics.length, 'Sujets du forum'),
      statTile(rating.count || 0, `Avis (${(rating.avg || 0).toFixed(1)}★)`),
      statTile(memberCount, 'Membres (hors admin)'),
    ];
    box.innerHTML = tiles.join('');

    // Difficulty breakdown line under the tiles
    const labels = { easy: '🟢 Facile', medium: '🟠 Moyen', hard: '🔴 Difficile', not_passable: '⚪ Impraticable', no_bike: '🚫 Vélo interdit' };
    const parts = Object.entries(byStatus)
      .sort((a, b) => b[1] - a[1])
      .map(([st, n]) => `${labels[st] || st} ${n}`);
    if (parts.length) {
      box.insertAdjacentHTML('afterend',
        `<div id="contentBreakdown" style="grid-column:1/-1;font-size:0.78rem;color:var(--text-muted);margin-top:2px">
           Difficulté des chemins — ${parts.join(' · ')}
         </div>`);
      // avoid duplicate on reload
      const dup = box.parentElement.querySelectorAll('#contentBreakdown');
      if (dup.length > 1) dup[0].remove();
    }
  } catch {
    box.innerHTML = '<p style="color:red;font-size:0.85rem">Erreur de chargement.</p>';
  }
}

// ── Engagement & contribution — aggregate member activity + funnel + top list ─
async function loadEngagement() {
  const statsBox  = document.getElementById('engageStats');
  const funnelBox = document.getElementById('engageFunnel');
  const topBox    = document.getElementById('engageTop');
  if (!statsBox) return;
  try {
    const [usersR, eventsR] = await Promise.all([
      fetch(`${API_URL}/api/users`, { headers: authHeader() }).catch(() => null),
      fetch(`${API_URL}/api/analytics/events`, { headers: authHeader() }).catch(() => null),
    ]);
    const users  = usersR?.ok  ? await usersR.json()  : [];
    const events = eventsR?.ok ? await eventsR.json() : {};
    const members = (Array.isArray(users) ? users : []).filter(u => u.role !== 'admin');

    let totalKm = 0, totalRoutes = 0, totalReports = 0, totalGrades = 0;
    let onboarded = 0, trialUsed = 0, contributors = 0;
    members.forEach(u => {
      const s = u.stats || {};
      totalKm      += Number(s.km) || 0;
      totalRoutes  += s.routes || 0;
      totalReports += s.reports || 0;
      totalGrades  += s.pathGrades || 0;
      if (u.onboarded) onboarded++;
      if (u.silverTrialUsed) trialUsed++;
      if ((s.reports || 0) + (s.pathGrades || 0) > 0) contributors++;
    });
    const n = members.length || 1;

    statsBox.innerHTML = [
      statTile(`${totalKm.toFixed(0)} km`, 'Distance cumulée'),
      statTile(totalRoutes, 'Trajets planifiés'),
      statTile(totalReports, 'Signalements postés', '#f97316'),
      statTile(totalGrades, 'Chemins notés', '#16a34a'),
      statTile(`${Math.round(contributors / n * 100)}%`, 'Membres contributeurs', '#9333ea'),
      statTile(`${(totalKm / n).toFixed(1)} km`, 'Distance moy. / membre'),
    ].join('');

    // Onboarding funnel: signups → onboarded (tour vu) → trial used → contributors
    if (funnelBox) {
      const signups = events.totalSignups || members.length;
      const rows = [
        { label: 'Inscrits (total)', value: signups, color: '#0284c7' },
        { label: 'Membres actuels', value: members.length, color: '#16a34a' },
        { label: 'Tour d\'accueil vu', value: onboarded, color: '#15803d' },
        { label: 'Essai Argent utilisé', value: trialUsed, color: '#f59e0b' },
        { label: 'Ont contribué', value: contributors, color: '#9333ea' },
      ];
      const max = Math.max(1, ...rows.map(r => r.value));
      funnelBox.innerHTML =
        `<div style="font-weight:700;font-size:0.82rem;color:#6b7280;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:10px">Tunnel d'engagement</div>` +
        rows.map(r => `
          <div style="display:flex;align-items:center;gap:10px;margin-bottom:6px">
            <div style="flex:0 0 140px;font-size:0.8rem;color:var(--text-muted)">${r.label}</div>
            <div style="flex:1;background:var(--surface-1,#f1f5f9);border-radius:999px;height:20px;overflow:hidden">
              <div style="width:${Math.round(r.value / max * 100)}%;min-width:${r.value ? 22 : 0}px;height:100%;background:${r.color};border-radius:999px"></div>
            </div>
            <div style="flex:0 0 auto;font-size:0.82rem;font-weight:700;color:var(--text-strong)">${r.value}</div>
          </div>`).join('');
    }

    // Top contributors by XP (reports + grades×2, matching the leaderboard formula)
    if (topBox) {
      const ranked = members
        .map(u => ({ name: u.name, xp: (u.stats?.reports || 0) + (u.stats?.pathGrades || 0) * 2,
                     reports: u.stats?.reports || 0, grades: u.stats?.pathGrades || 0 }))
        .filter(u => u.xp > 0)
        .sort((a, b) => b.xp - a.xp)
        .slice(0, 5);
      if (!ranked.length) {
        topBox.innerHTML = '<p style="color:var(--text-muted);font-size:0.85rem">Aucune contribution pour l\'instant.</p>';
      } else {
        const medal = ['🥇', '🥈', '🥉'];
        topBox.innerHTML = ranked.map((u, i) => `
          <div style="display:flex;align-items:center;gap:10px;padding:8px 12px;background:var(--surface-1,#f9fafb);border:1px solid var(--border);border-radius:10px">
            <span style="font-size:1rem;width:22px;text-align:center">${medal[i] || (i + 1)}</span>
            <div style="flex:1;min-width:0;font-weight:600;font-size:0.88rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(u.name)}</div>
            <div style="font-size:0.74rem;color:var(--text-muted)">📣 ${u.reports} · 🎨 ${u.grades}</div>
            <span style="flex:none;font-size:0.78rem;font-weight:800;color:#15803d">${u.xp} XP</span>
          </div>`).join('');
      }
    }
  } catch {
    statsBox.innerHTML = '<p style="color:red;font-size:0.85rem">Erreur de chargement.</p>';
  }
}
