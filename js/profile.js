let currentUser = null;

const AVATAR_COLORS = [
  { bg: '#1e4d14', fg: '#a3e635', name: 'Forêt' },
  { bg: '#166534', fg: '#86efac', name: 'Sapin' },
  { bg: '#1d4ed8', fg: '#bfdbfe', name: 'Océan' },
  { bg: '#7c3aed', fg: '#ddd6fe', name: 'Violette' },
  { bg: '#b45309', fg: '#fde68a', name: 'Automne' },
  { bg: '#be123c', fg: '#fecdd3', name: 'Framboise' },
  { bg: '#0f766e', fg: '#99f6e4', name: 'Menthe' },
  { bg: '#374151', fg: '#e5e7eb', name: 'Ardoise' },
];

function getAvatarColor() {
  const saved = localStorage.getItem('bwr_avatar_color');
  return saved ? JSON.parse(saved) : AVATAR_COLORS[0];
}

function saveAvatarColor(color) {
  localStorage.setItem('bwr_avatar_color', JSON.stringify(color));
}

function initials(name) {
  return name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);
}

function renderAvatar(user, color) {
  const ring  = document.getElementById('avatarRing');
  const big   = document.getElementById('avatarBig');
  ring.style.borderColor = color.bg;
  big.style.background   = color.bg;
  big.style.color        = color.fg;
  big.textContent        = initials(user.name);

  // also update header avatar
  const headerAvatar = document.querySelector('.user-avatar');
  if (headerAvatar) {
    headerAvatar.style.background = color.bg;
    headerAvatar.style.color      = color.fg;
  }
}

function buildColorSwatches(user) {
  const container = document.getElementById('colorSwatches');
  const current   = getAvatarColor();
  container.innerHTML = AVATAR_COLORS.map((c, i) => `
    <button
      class="swatch ${c.bg === current.bg ? 'active' : ''}"
      title="${c.name}"
      data-i="${i}"
      style="background:${c.bg}"
    ></button>
  `).join('');

  container.querySelectorAll('.swatch').forEach(btn => {
    btn.addEventListener('click', () => {
      const color = AVATAR_COLORS[+btn.dataset.i];
      saveAvatarColor(color);
      renderAvatar(user, color);
      container.querySelectorAll('.swatch').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
  });
}

function showMsg(id, text, type = 'error') {
  const el = document.getElementById(id);
  el.innerHTML = `<div class="${type === 'error' ? 'form-error' : 'form-success'}">${text}</div>`;
  setTimeout(() => { el.innerHTML = ''; }, 5000);
}

// ── Boot ──────────────────────────────────────────────────────────────────────
(async () => {
  currentUser = await requireAuth();
  if (!currentUser) return;

  initUserMenu();
  populatePage(currentUser);
  buildColorSwatches(currentUser);
  renderAvatar(currentUser, getAvatarColor());
  loadPathCount();
})();

function initUserMenu() {
  const menuEl = document.getElementById('userMenu');
  const color  = getAvatarColor();
  const ini    = initials(currentUser.name);
  menuEl.innerHTML = `
    <button class="user-btn" id="userBtn">
      <div class="user-avatar" style="background:${color.bg};color:${color.fg}">${ini}</div>
      ${currentUser.name.split(' ')[0]}
    </button>
    <div class="user-dropdown hidden" id="userDropdown">
      <span class="dropdown-name">${currentUser.name}</span>
      <a href="index.html">🏠 Accueil</a>
      <a href="map.html">🗺 Voir la carte</a>
      <a href="routes.html">🧭 Planifier un trajet</a>
      ${currentUser.role === 'admin' ? '<a href="admin.html">⚙️ Admin</a>' : ''}
      <button class="dropdown-logout" id="btnLogout">Se déconnecter</button>
    </div>
  `;
  document.getElementById('userBtn').addEventListener('click', () =>
    document.getElementById('userDropdown').classList.toggle('hidden'));
  document.getElementById('btnLogout').addEventListener('click', logout);
  document.addEventListener('click', e => {
    if (!menuEl.contains(e.target)) document.getElementById('userDropdown')?.classList.add('hidden');
  });
}

const BADGES = [
  // Free tier badges
  { id: 'first_route',  icon: '🌱', label: 'Première sortie',  tier: 'free',   test: s => s.routes >= 1 },
  { id: 'hiker',        icon: '🥾', label: 'Randonneur',       tier: 'free',   test: s => s.routes >= 5 },
  { id: 'explorer',     icon: '🌲', label: 'Explorateur',      tier: 'free',   test: s => s.routes >= 10 },
  { id: 'forest_friend',icon: '🦌', label: 'Ami forêt',        tier: 'free',   test: s => s.routes >= 25 },
  { id: 'marathoner',   icon: '🏃', label: 'Marathonien',      tier: 'free',   test: s => s.km >= 25 },
  { id: 'adventurer',   icon: '🗻', label: 'Aventurier',       tier: 'free',   test: s => s.km >= 50 },
  { id: 'legend',       icon: '🏆', label: 'Légende',          tier: 'free',   test: s => s.km >= 100 },
  { id: 'champion',     icon: '👑', label: 'Champion',         tier: 'free',   test: s => s.km >= 250 },
  // Silver tier badges
  { id: 'tree_lover',   icon: '🌳', label: 'Amoureux arbres',  tier: 'silver', test: s => s.routes >= 50 },
  { id: 'compass',      icon: '🧭', label: 'Boussole',         tier: 'silver', test: s => s.routes >= 75 },
  { id: 'tent',         icon: '⛺', label: 'Campeur',          tier: 'silver', test: s => s.km >= 150 },
  { id: 'mountain',     icon: '⛰️', label: 'Sommet',           tier: 'silver', test: s => s.km >= 200 },
  { id: 'leaf',         icon: '🍃', label: 'Naturaliste',      tier: 'silver', test: s => s.routes >= 100 },
  { id: 'mushroom',     icon: '🍄', label: 'Cueilleur',        tier: 'silver', test: s => s.routes >= 30 },
  { id: 'fire',         icon: '🔥', label: 'Endurance',        tier: 'silver', test: s => s.km >= 75 },
  { id: 'star',         icon: '⭐', label: 'Étoile montante',  tier: 'silver', test: s => s.routes >= 15 },
  { id: 'compass2',     icon: '🎯', label: 'Précision',        tier: 'silver', test: s => s.routes >= 40 },
  { id: 'sunrise',      icon: '🌅', label: 'Aube',             tier: 'silver', test: s => s.routes >= 20 },
  { id: 'fox',          icon: '🦊', label: 'Rusé renard',      tier: 'silver', test: s => s.km >= 125 },
  { id: 'rabbit',       icon: '🐇', label: 'Rapide',           tier: 'silver', test: s => s.routes >= 60 },
  { id: 'owl',          icon: '🦉', label: 'Sage chouette',    tier: 'silver', test: s => s.km >= 175 },
  // Gold tier badges
  { id: 'crown',        icon: '👑', label: 'Couronne d\'or',   tier: 'gold',   test: s => s.km >= 500 },
  { id: 'medal',        icon: '🏅', label: 'Médaillé',         tier: 'gold',   test: s => s.routes >= 150 },
  { id: 'rocket',       icon: '🚀', label: 'Fusée',            tier: 'gold',   test: s => s.km >= 300 },
  { id: 'diamond',      icon: '💎', label: 'Diamant',          tier: 'gold',   test: s => s.km >= 1000 },
  { id: 'dragon',       icon: '🐉', label: 'Dragon',           tier: 'gold',   test: s => s.routes >= 200 },
  { id: 'phoenix',      icon: '🔥', label: 'Phoenix',          tier: 'gold',   test: s => s.km >= 750 },
  { id: 'wolf',         icon: '🐺', label: 'Loup alpha',       tier: 'gold',   test: s => s.routes >= 250 },
  { id: 'eagle',        icon: '🦅', label: 'Aigle royal',      tier: 'gold',   test: s => s.km >= 400 },
];

const TRAIL_TIPS = [
  '🌲 Essaye le Carrefour du Puits du Roi aujourd\'hui !',
  '🦌 Observe la faune au lever du jour.',
  '🍂 Sortie automnale parfaite pour les couleurs.',
  '🥾 10 km en boucle, ça te tente ?',
  '🌳 Découvre les vieux chênes des Beaux Monts.',
  '🌅 Profite de la lumière dorée du matin.',
  '🏞️ Tente un nouveau sentier inconnu.',
  '🍄 Ouvre l\'œil pour les champignons.',
  '🦊 Reste silencieux, tu verras peut-être un renard.',
  '⛰️ Mont Saint-Pierre — panorama garanti !',
  '🌿 Sortie courte mais intense : 5 km en 1h.',
  '🦉 Sortie crépusculaire pour écouter la chouette.',
  '🐗 Prends le sentier des Grands Monts pour croiser des sangliers.',
  '🌊 Après la pluie, les rus de la forêt reprennent vie.',
  '🍁 Saison idéale pour les photos en sous-bois.',
];

// Prizes by tier.
// Total weight pool = 840 (LCM of 120 and 70) so that:
//   1 month  → weight 7  → probability 7/840 = 1/120
//   1 week   → weight 12 → probability 12/840 = 1/70
const WHEEL_PRIZES = {
  free: [
    { id: 'silver_month', icon: '🥈', label: '1 mois Argent !',    desc: 'Abonnement Argent offert pendant 30 jours',  type: 'plan',        plan: 'silver', days: 30, weight: 7   },
    { id: 'silver_week',  icon: '🥈', label: '7 jours Argent',      desc: 'Accès Argent pendant 7 jours',              type: 'plan',        plan: 'silver', days: 7,  weight: 12  },
    { id: 'bonus_route',  icon: '🎫', label: '+1 trajet bonus',      desc: 'Un trajet supplémentaire cette semaine',    type: 'bonus_route',                           weight: 228 },
    { id: 'lucky_badge',  icon: '🍀', label: 'Badge Chanceux',       desc: 'Badge exclusif de la roue de la chance',   type: 'badge',                                weight: 182 },
    { id: 'double_xp',    icon: '⭐', label: 'Double XP 24h',        desc: 'Progression doublée pendant 24 heures',    type: 'double_xp',   hours: 24,                weight: 183 },
    { id: 'trail_tip',    icon: '🌲', label: 'Conseil sentier',       desc: 'Une suggestion pour ta prochaine sortie',  type: 'tip',                                  weight: 228 },
  ],
  silver: [
    { id: 'gold_month',   icon: '🥇', label: '1 mois Or !',          desc: 'Abonnement Or offert pendant 30 jours',    type: 'plan',        plan: 'gold',   days: 30, weight: 7   },
    { id: 'gold_week',    icon: '🥇', label: '7 jours Or',            desc: 'Accès Or pendant 7 jours',                type: 'plan',        plan: 'gold',   days: 7,  weight: 12  },
    { id: 'lucky_badge',  icon: '🍀', label: 'Badge Chanceux',        desc: 'Badge exclusif de la roue de la chance',  type: 'badge',                                weight: 137 },
    { id: 'double_xp',    icon: '⭐', label: 'Double XP 24h',         desc: 'Progression doublée pendant 24 heures',   type: 'double_xp',   hours: 24,                weight: 182 },
    { id: 'xp_bonus',     icon: '🎯', label: '+200 XP bonus',         desc: 'Bonus d\'expérience immédiat',             type: 'xp_bonus',    xp: 200,                  weight: 228 },
    { id: 'trail_tip',    icon: '🌲', label: 'Conseil sentier',        desc: 'Une suggestion pour ta prochaine sortie', type: 'tip',                                  weight: 274 },
  ],
  gold: [
    { id: 'exclusive_badge', icon: '👑', label: 'Badge Or exclusif', desc: 'Badge animé réservé aux membres Or',       type: 'badge',                                weight: 10 },
    { id: 'double_xp_48',    icon: '⭐', label: 'Double XP 48h',     desc: 'Progression doublée pendant 48 heures',   type: 'double_xp',   hours: 48,                weight: 15 },
    { id: 'xp_bonus_500',    icon: '🎯', label: '+500 XP bonus',     desc: 'Bonus d\'expérience immédiat',             type: 'xp_bonus',    xp: 500,                  weight: 25 },
    { id: 'trail_tip',       icon: '🌲', label: 'Conseil sentier VIP', desc: 'Suggestion exclusive pour membres Or',   type: 'tip',                                  weight: 50 },
  ],
};

function pickPrize(plan) {
  const prizes = WHEEL_PRIZES[normalisePlan(plan)] || WHEEL_PRIZES.free;
  const total = prizes.reduce((s, p) => s + p.weight, 0);
  let r = Math.random() * total;
  for (const prize of prizes) {
    r -= prize.weight;
    if (r <= 0) return prize;
  }
  return prizes[prizes.length - 1];
}

function populatePage(user) {
  document.getElementById('heroName').textContent  = user.name;
  document.getElementById('inputName').value       = user.name;
  document.getElementById('inputEmail').value      = user.email;

  const roleMap = { admin: '👑 Administrateur', free: '🌲 Membre' };
  const roleEl  = document.getElementById('roleBadge');
  roleEl.textContent  = roleMap[user.role] || user.role;
  roleEl.className    = `role-badge role-${user.role}`;

  const since = user.createdAt
    ? new Date(user.createdAt).toLocaleDateString('fr-FR', { year: 'numeric', month: 'long', day: 'numeric' })
    : '';
  if (since) document.getElementById('heroSince').textContent = `Membre depuis le ${since}`;

  renderPlanAndProgress(user);
}

function renderPlanAndProgress(user) {
  const plan = normalisePlan(user.plan);
  const planMap = {
    free:   { label: '🌿 Gratuit',  cls: 'plan-free' },
    silver: { label: '🥈 Argent',   cls: 'plan-silver' },
    gold:   { label: '🥇 Or',       cls: 'plan-gold' },
  };
  const p = planMap[plan];
  const pill = document.getElementById('planPill');
  pill.textContent = p.label;
  pill.className   = `plan-pill ${p.cls}`;
  if (plan !== 'free') document.getElementById('planUpgradeLink').style.display = 'none';

  // Apply plan styling to avatar ring
  document.getElementById('avatarRing').classList.add(`ring-${plan}`);

  // ── Weekly route quota strip (free users only) ──
  renderQuotaStrip(plan);

  // Stats: server is authoritative; localStorage is cache. Take max during migration.
  const serverRoutes = (user.stats && user.stats.routes) || 0;
  const serverKm     = (user.stats && user.stats.km) || 0;
  const localRoutes  = parseInt(localStorage.getItem('bwr_route_count') || '0');
  const localKm      = parseFloat(localStorage.getItem('bwr_km_total') || '0');
  const routes = Math.max(serverRoutes, localRoutes);
  const km     = Math.max(serverKm, localKm);
  // Keep localStorage in sync for offline use
  if (routes > localRoutes) localStorage.setItem('bwr_route_count', String(routes));
  if (km > localKm) localStorage.setItem('bwr_km_total', km.toFixed(2));
  // One-time migration: push localStorage surplus to server if server has no data yet
  if (serverRoutes === 0 && routes > 0 && !localStorage.getItem('bwr_stats_synced')) {
    localStorage.setItem('bwr_stats_synced', '1');
    fetch(`${API_URL}/api/auth/stats`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeader() },
      body: JSON.stringify({ routes, km }),
    }).catch(() => {});
  }
  const level  = Math.floor(km / 5) + 1;
  const xpIn   = km - (level - 1) * 5;
  const xpPct  = Math.min(100, (xpIn / 5) * 100);
  document.getElementById('levelNum').textContent = `Niveau ${level}`;
  document.getElementById('levelXp').textContent  = `${xpIn.toFixed(1)} / 5 km`;
  document.getElementById('xpFill').style.width   = `${xpPct}%`;

  // Badges — for free users, show locked silhouettes for higher-tier badges
  const stats = { routes, km };
  const grid  = document.getElementById('badgesGrid');
  const tierVisible = { free: ['free'], silver: ['free', 'silver'], gold: ['free', 'silver', 'gold'] };
  grid.innerHTML = BADGES.map(b => {
    const accessible = tierVisible[plan].includes(b.tier);
    if (!accessible) {
      // locked silhouette with tier badge for upsell
      return `<div class="badge-item tier-${b.tier} badge-tier-locked" title="Disponible avec ${b.tier === 'gold' ? 'Or' : 'Argent'}">
        <span class="badge-icon">🔒</span>
        <span class="badge-label">${b.tier === 'gold' ? '👑 Or' : '🥈 Argent'}</span>
      </div>`;
    }
    const earned = b.test(stats);
    return `<div class="badge-item ${earned ? 'earned' : 'locked'} tier-${b.tier}" title="${b.label}">
      <span class="badge-icon">${b.icon}</span>
      <span class="badge-label">${b.label}</span>
    </div>`;
  }).join('');

  // Locked badges hint
  const lockedHint = document.getElementById('badgesLockedHint');
  if (plan === 'free') {
    const silverCount = BADGES.filter(b => b.tier === 'silver').length;
    const goldCount   = BADGES.filter(b => b.tier === 'gold').length;
    lockedHint.innerHTML =
      `🔒 <strong>${silverCount + goldCount} badges supplémentaires</strong> à débloquer · <a href="plans.html">Voir les plans →</a>`;
    lockedHint.style.display = '';
  } else if (plan === 'silver') {
    const goldCount = BADGES.filter(b => b.tier === 'gold').length;
    lockedHint.innerHTML =
      `🔒 <strong>${goldCount} badges Or animés</strong> exclusifs · <a href="plans.html">Passer à Or →</a>`;
    lockedHint.style.display = '';
  } else {
    lockedHint.style.display = 'none';
  }

  // Plan expiry banner
  if (user.planExpiresAt) {
    const expDate = new Date(user.planExpiresAt).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
    const pill = document.getElementById('planPill');
    pill.title = `Expire le ${expDate}`;
    const upgLink = document.getElementById('planUpgradeLink');
    if (upgLink) {
      upgLink.style.display = '';
      upgLink.textContent = `⏳ Expire le ${expDate}`;
      upgLink.style.color = '#f97316';
      upgLink.removeAttribute('href');
    }
  }

  // Premium section (Silver + Gold unified)
  if (can('daily_wheel', plan)) {
    const premiumSection = document.getElementById('premiumSection');
    premiumSection.style.display = '';
    const isGold = plan === 'gold' || plan === 'admin';
    document.getElementById('premiumIcon').textContent = isGold ? '🥇' : '🥈';
    document.getElementById('premiumTitle').textContent = isGold ? 'Privilèges Or' : 'Fonctionnalités premium';

    renderDailyWheel(plan);
    renderPrizeList(plan);

    // Gold-exclusive blocks
    const show = isGold ? '' : 'none';
    document.getElementById('goalBlock').style.display  = can('custom_goals', plan) ? '' : 'none';
    document.getElementById('weatherBlock').style.display = show;
    document.getElementById('discordBlock').style.display = show;
    document.getElementById('supportBlock').style.display = show;
    document.getElementById('pushAlertsBlock').style.display = show;

    // AI suggestions: Silver (weekly cadence) or Gold (daily)
    const suggCadence = can('ai_suggestions', plan);
    if (suggCadence) {
      const suggBlock = document.getElementById('suggestionBlock');
      if (suggBlock) suggBlock.style.display = '';
      renderDailySuggestion(plan);
    }

    if (can('custom_goals', plan)) renderGoals();
    if (can('weather', plan)) renderWeather();
    if (isGold) renderPushAlerts();
  } else {
    document.getElementById('premiumSection').style.display = 'none';
  }

  // Free-user upsell card (only for free users — Silver/Gold hide it)
  const upsellCard = document.getElementById('upsellCard');
  if (upsellCard) upsellCard.style.display = (plan === 'free') ? '' : 'none';
}

// ── Weekly route quota strip ─────────────────────────────────────────────────
function renderQuotaStrip(plan) {
  const strip = document.getElementById('quotaStrip');
  if (!strip) return;
  const limit = limitOf('routes_per_week', plan);
  if (limit === Infinity) { strip.style.display = 'none'; return; }
  const { count } = readWeekly();
  const remaining = Math.max(0, limit - count);
  const pct = Math.min(100, (count / limit) * 100);
  const overLimit = count >= limit;
  strip.style.display = '';
  strip.className = `profile-quota-strip ${overLimit ? 'is-full' : ''}`;
  strip.innerHTML = `
    <div class="pqs-row">
      <span class="pqs-icon">${overLimit ? '🔒' : '⏳'}</span>
      <div class="pqs-text">
        <strong>${count} / ${limit}</strong> trajets cette semaine
        <span>${overLimit ? 'Limite atteinte · réinitialisation lundi' : `${remaining} restant${remaining > 1 ? 's' : ''}`}</span>
      </div>
      <a href="plans.html" class="pqs-cta">Passer à illimité →</a>
    </div>
    <div class="pqs-bar"><div class="pqs-fill" style="width:${pct}%"></div></div>
  `;
}

// ── Daily wheel ───────────────────────────────────────────────────────────────
function renderDailyWheel(plan) {
  const today    = new Date().toISOString().slice(0, 10);
  const lastSpin = localStorage.getItem('bwr_wheel_last');
  const wheelBtn  = document.getElementById('wheelSpinBtn');
  const wheelText = document.getElementById('wheelText');

  if (lastSpin === today) {
    const saved = localStorage.getItem('bwr_wheel_result');
    try {
      const prize = JSON.parse(saved);
      wheelText.innerHTML = `${prize.icon} <strong>${prize.label}</strong> — ${prize.desc}`;
    } catch {
      wheelText.textContent = saved || 'Tu as déjà tourné la roue aujourd\'hui — reviens demain !';
    }
    wheelBtn.disabled = true;
    wheelBtn.textContent = '✓ Tournée';
  } else {
    wheelBtn.disabled = false;
    wheelBtn.onclick = () => spinWheel(plan);
  }
}

async function spinWheel(plan) {
  const today   = new Date().toISOString().slice(0, 10);
  const prize   = pickPrize(plan);
  const wheelBtn  = document.getElementById('wheelSpinBtn');
  const wheelText = document.getElementById('wheelText');
  const emoji   = document.getElementById('wheelEmoji');

  wheelBtn.disabled = true;
  wheelBtn.textContent = '🎡 En cours…';
  emoji.classList.add('spin');

  // Apply prize effects
  if (prize.type === 'plan') {
    try {
      const res = await fetch(`${API_URL}/api/auth/wheel-prize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeader() },
        body: JSON.stringify({ prizeType: 'plan', plan: prize.plan, days: prize.days }),
      });
      const data = await res.json();
      if (!res.ok) {
        // Server rejected (cooldown) — swap to a tip instead
        const fallback = TRAIL_TIPS[Math.floor(Math.random() * TRAIL_TIPS.length)];
        wheelText.textContent = `🌲 ${fallback}`;
        localStorage.setItem('bwr_wheel_last', today);
        localStorage.setItem('bwr_wheel_result', JSON.stringify({ icon: '🌲', label: 'Conseil sentier', desc: fallback }));
        wheelBtn.textContent = '✓ Tournée';
        return;
      }
      // Update cached user plan so page reflects upgrade immediately
      const cached = getCachedUser();
      if (cached) setSession(localStorage.getItem('bwr_token'), { ...cached, plan: prize.plan, planExpiresAt: data.expiresAt });
    } catch {
      wheelText.textContent = '❌ Erreur réseau — réessaie.';
      wheelBtn.disabled = false;
      wheelBtn.textContent = '🎡 Tourner la roue';
      return;
    }
  } else if (prize.type === 'bonus_route') {
    const w = readWeekly();
    w.count = Math.max(0, w.count - 1);
    localStorage.setItem('bwr_routes_week', JSON.stringify(w));
  } else if (prize.type === 'xp_bonus') {
    const km = parseFloat(localStorage.getItem('bwr_km_total') || '0');
    const bonusKm = (prize.xp || 0) / 20;
    localStorage.setItem('bwr_km_total', (km + bonusKm).toFixed(2)); // 1 XP ≈ 0.05 km
    fetch(`${API_URL}/api/auth/stats`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeader() },
      body: JSON.stringify({ routes: 0, km: bonusKm }),
    }).catch(() => {});
  } else if (prize.type === 'double_xp') {
    const expires = Date.now() + (prize.hours || 24) * 3600000;
    localStorage.setItem('bwr_double_xp_until', expires);
  } else if (prize.type === 'badge') {
    localStorage.setItem('bwr_lucky_badge', '1');
  } else if (prize.type === 'tip') {
    prize.desc = TRAIL_TIPS[Math.floor(Math.random() * TRAIL_TIPS.length)];
  }

  wheelText.innerHTML = `${prize.icon} <strong>${prize.label}</strong> — ${prize.desc}`;
  localStorage.setItem('bwr_wheel_last', today);
  localStorage.setItem('bwr_wheel_result', JSON.stringify({ icon: prize.icon, label: prize.label, desc: prize.desc }));
  wheelBtn.textContent = '✓ Tournée';

  // If plan upgraded, reload page to show new privileges
  if (prize.type === 'plan') {
    setTimeout(() => window.location.reload(), 1800);
  }
}

function renderPrizeList(plan) {
  const el = document.getElementById('wheelPrizesList');
  if (!el) return;
  const prizes = WHEEL_PRIZES[normalisePlan(plan)] || WHEEL_PRIZES.free;
  const rare = prizes.filter(p => p.weight <= 8);
  const common = prizes.filter(p => p.weight > 8);
  el.innerHTML = `
    <p class="prizes-title">Ce que tu peux gagner :</p>
    <div class="prizes-grid">
      ${[...rare, ...common].map(p => `
        <div class="prize-chip ${p.weight <= 2 ? 'prize-epic' : p.weight <= 8 ? 'prize-rare' : ''}">
          <span class="prize-icon">${p.icon}</span>
          <span class="prize-label">${p.label}</span>
          ${p.weight <= 2 ? '<span class="prize-rarity">Épique</span>' : p.weight <= 8 ? '<span class="prize-rarity">Rare</span>' : ''}
        </div>
      `).join('')}
    </div>
  `;
}

// ── Goals ─────────────────────────────────────────────────────────────────────
function renderGoals() {
  const goal = parseFloat(localStorage.getItem('bwr_goal_km') || '20');
  const km   = parseFloat(localStorage.getItem('bwr_km_total') || '0');
  const pct  = Math.min(100, (km / goal) * 100);
  document.getElementById('goalKm').textContent = `${km.toFixed(1)} / ${goal} km`;
  document.getElementById('goalFill').style.width = `${pct}%`;
  document.getElementById('goalInput').value = goal;

  document.getElementById('goalSave').onclick = () => {
    const v = parseFloat(document.getElementById('goalInput').value);
    if (v > 0) {
      localStorage.setItem('bwr_goal_km', v);
      renderGoals();
    }
  };
}

// ── Weather (Open-Meteo, free, no key) ────────────────────────────────────────
async function renderWeather() {
  try {
    const res = await fetch('https://api.open-meteo.com/v1/forecast?latitude=49.35&longitude=2.90&current=temperature_2m,weather_code,wind_speed_10m&timezone=Europe/Paris');
    const data = await res.json();
    const c = data.current;
    const codeMap = {
      0:['☀️','Ensoleillé'], 1:['🌤','Peu nuageux'], 2:['⛅','Nuageux'], 3:['☁️','Couvert'],
      45:['🌫','Brouillard'], 48:['🌫','Brouillard givrant'],
      51:['🌦','Bruine légère'], 53:['🌦','Bruine'], 55:['🌧','Bruine forte'],
      61:['🌧','Pluie légère'], 63:['🌧','Pluie'], 65:['🌧','Forte pluie'],
      71:['🌨','Neige'], 73:['🌨','Neige modérée'], 75:['❄️','Forte neige'],
      80:['🌦','Averses'], 81:['🌧','Averses'], 82:['⛈','Violentes averses'],
      95:['⛈','Orage'], 96:['⛈','Orage + grêle'], 99:['⛈','Orage violent'],
    };
    const [icon, label] = codeMap[c.weather_code] || ['🌤', 'Variable'];
    document.getElementById('weatherIcon').textContent = icon;
    document.getElementById('weatherTemp').textContent = `${Math.round(c.temperature_2m)}°C`;
    document.getElementById('weatherLabel').textContent = label;
    document.getElementById('weatherWind').textContent = `Vent : ${Math.round(c.wind_speed_10m)} km/h`;
  } catch {
    document.getElementById('weatherIcon').textContent = '❌';
    document.getElementById('weatherLabel').textContent = 'Météo indisponible';
  }
}

// ── Daily AI suggestion ───────────────────────────────────────────────────────
async function renderDailySuggestion(plan) {
  const textEl = document.getElementById('suggestionText');
  const btnEl  = document.getElementById('suggestionBtn');
  if (!textEl || !btnEl) return;

  // Silver: one suggestion per week; Gold: every day
  const isGold   = normalisePlan(plan) === 'gold';
  const storageKey = isGold ? 'bwr_sugg_day' : 'bwr_sugg_week';
  const todayKey   = isGold
    ? new Date().toISOString().slice(0, 10)
    : new Date().toISOString().slice(0, 7) + '-W' + Math.ceil(new Date().getDate() / 7);

  const cached = localStorage.getItem('bwr_sugg_cache');
  const cacheDate = localStorage.getItem(storageKey);
  if (cacheDate === todayKey && cached) {
    textEl.innerHTML = cached;
    return;
  }

  let weatherCode = 0, temp = 15, wind = 10;
  try {
    const res  = await fetch('https://api.open-meteo.com/v1/forecast?latitude=49.35&longitude=2.90&current=temperature_2m,weather_code,wind_speed_10m&timezone=Europe/Paris');
    const data = await res.json();
    weatherCode = data.current.weather_code;
    temp        = data.current.temperature_2m;
    wind        = data.current.wind_speed_10m;
  } catch {}

  const month  = new Date().getMonth();
  const season = month < 3 ? 'winter' : month < 6 ? 'spring' : month < 9 ? 'summer' : 'autumn';
  const km     = parseFloat(localStorage.getItem('bwr_km_total') || '0');
  const suggestKm = km < 5 ? 4 : km < 25 ? 7 : km < 50 ? 12 : 15;

  const seasonTips = {
    winter: '❄️ Paysage hivernal — habillez-vous chaud et profitez du calme absolu de la forêt.',
    spring: '🌸 Les bourgeons s\'ouvrent — sortie parfaite pour observer la renaissance de la forêt.',
    summer: '☀️ Partez tôt le matin avant la chaleur — la forêt est magnifique à l\'aube.',
    autumn: '🍂 Couleurs d\'automne — emportez un appareil photo pour les sous-bois.',
  };

  let icon, advice;
  if (weatherCode >= 61 && weatherCode <= 82) {
    icon = '🌧️'; advice = `Pluie prévue — optez pour une courte exploration de 3-4 km avec un imperméable, ou remettez à demain.`;
    btnEl.href = `routes.html?dist=4&mode=loop`;
  } else if (wind > 30) {
    icon = '💨'; advice = `Vent fort (${Math.round(wind)} km/h) — évitez les zones boisées denses. Boucle courte de 5 km recommandée.`;
    btnEl.href = `routes.html?dist=5&mode=loop`;
  } else if (weatherCode >= 95) {
    icon = '⛈️'; advice = `Orages signalés — restez en sécurité, ne sortez pas en forêt aujourd'hui.`;
    btnEl.textContent = 'Pas de sortie conseillée';
    btnEl.removeAttribute('href');
    btnEl.style.opacity = '0.5';
  } else if (weatherCode <= 3) {
    icon = '✅'; advice = `Conditions idéales ! ${seasonTips[season]} Objectif suggéré : ${suggestKm} km en boucle.`;
    btnEl.href = `routes.html?dist=${suggestKm}&mode=loop`;
  } else {
    icon = '⛅'; advice = `Ciel variable mais praticable. ${seasonTips[season]} Sortie de ${Math.max(3, suggestKm - 3)} km conseillée.`;
    btnEl.href = `routes.html?dist=${Math.max(3, suggestKm - 3)}&mode=loop`;
  }

  const html = `
    <span style="font-size:1.6rem;flex-shrink:0">${icon}</span>
    <div>
      <p style="margin:0 0 4px;font-size:0.88rem;color:#1e293b">${advice}</p>
      <p style="margin:0;font-size:0.78rem;color:#6b7280">Temp : ${Math.round(temp)}°C · Vent : ${Math.round(wind)} km/h</p>
    </div>`;
  textEl.innerHTML = html;
  localStorage.setItem('bwr_sugg_cache', html);
  localStorage.setItem(storageKey, todayKey);
}

// ── Push alerts via ntfy.sh ───────────────────────────────────────────────────
async function renderPushAlerts() {
  const block  = document.getElementById('pushAlertsBlock');
  const status = document.getElementById('pushAlertsStatus');
  const setup  = document.getElementById('pushAlertsSetup');
  const btn    = document.getElementById('btnToggleAlerts');
  const chanEl = document.getElementById('ntfyChannel');
  if (!block || !btn) return;

  // Read current state from cached user
  const cached = getCachedUser();
  let alertsEnabled = !!(cached?.alertsEnabled);
  let alertsChannel = cached?.alertsChannel || null;

  function render() {
    if (alertsEnabled && alertsChannel) {
      status.innerHTML = `<span style="color:#16a34a;font-weight:600">🔔 Alertes activées</span>`;
      chanEl.textContent = alertsChannel;
      setup.style.display = '';
      btn.textContent = '🔕 Désactiver les alertes';
    } else {
      status.innerHTML = `<span style="color:#6b7280">Alertes désactivées</span>`;
      setup.style.display = 'none';
      btn.textContent = '🔔 Activer les alertes';
    }
  }

  render();

  btn.addEventListener('click', async () => {
    btn.disabled = true;
    try {
      if (alertsEnabled) {
        const res = await fetch(`${API_URL}/api/push/unsubscribe`, { method: 'POST', headers: authHeader() });
        if (!res.ok) throw new Error();
        alertsEnabled = false;
        alertsChannel = null;
        const c = getCachedUser();
        setSession(localStorage.getItem('bwr_token'), { ...c, alertsEnabled: false, alertsChannel: null });
      } else {
        const res  = await fetch(`${API_URL}/api/push/subscribe`, { method: 'POST', headers: authHeader() });
        if (!res.ok) throw new Error((await res.json()).error || 'Erreur');
        const data = await res.json();
        alertsEnabled = true;
        alertsChannel = data.channel;
        const c = getCachedUser();
        setSession(localStorage.getItem('bwr_token'), { ...c, alertsEnabled: true, alertsChannel: data.channel });
      }
      render();
    } catch (err) {
      status.innerHTML = `<span style="color:#dc2626">Erreur : ${err.message || 'réessaye'}</span>`;
    } finally { btn.disabled = false; }
  });
}

async function loadPathCount() {
  try {
    const res = await fetch(`${API_URL}/api/paths`);
    const paths = await res.json();
    document.getElementById('statPaths').textContent = paths.length;
  } catch {}
  const serverRoutes = (currentUser?.stats?.routes) || 0;
  const serverKm     = (currentUser?.stats?.km) || 0;
  const routes = Math.max(serverRoutes, parseInt(localStorage.getItem('bwr_route_count') || '0'));
  const km     = Math.max(serverKm, parseFloat(localStorage.getItem('bwr_km_total') || '0'));
  document.getElementById('statRoutes').textContent = routes;
  document.getElementById('statKm').textContent     = km > 0 ? `${km.toFixed(0)} km` : '—';
}

// ── Form: update name / email ──────────────────────────────────────────────────
document.getElementById('formInfo').addEventListener('submit', async e => {
  e.preventDefault();
  const name  = document.getElementById('inputName').value.trim();
  const email = document.getElementById('inputEmail').value.trim().toLowerCase();
  if (!name || !email) return showMsg('infoMsg', 'Tous les champs sont obligatoires.');

  const btn = e.target.querySelector('button[type=submit]');
  btn.textContent = 'Enregistrement…';
  btn.disabled = true;

  try {
    const res = await fetch(`${API_URL}/api/auth/profile`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...authHeader() },
      body: JSON.stringify({ name, email }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Erreur serveur');

    // Update cached user
    const cached = getCachedUser();
    setSession(localStorage.getItem('bwr_token'), { ...cached, name, email });
    currentUser.name  = name;
    currentUser.email = email;
    document.getElementById('heroName').textContent = name;
    showMsg('infoMsg', 'Profil mis à jour avec succès !', 'success');
  } catch (err) {
    showMsg('infoMsg', err.message);
  } finally {
    btn.textContent = 'Enregistrer les modifications';
    btn.disabled = false;
  }
});

// ── Form: change password ─────────────────────────────────────────────────────
document.getElementById('formPassword').addEventListener('submit', async e => {
  e.preventDefault();
  const oldPw     = document.getElementById('inputOldPw').value;
  const newPw     = document.getElementById('inputNewPw').value;
  const confirmPw = document.getElementById('inputConfirmPw').value;

  if (!oldPw || !newPw || !confirmPw) return showMsg('pwMsg', 'Tous les champs sont obligatoires.');
  if (newPw.length < 6)  return showMsg('pwMsg', 'Le nouveau mot de passe doit faire au moins 6 caractères.');
  if (newPw !== confirmPw) return showMsg('pwMsg', 'Les mots de passe ne correspondent pas.');

  const btn = e.target.querySelector('button[type=submit]');
  btn.textContent = 'Modification…';
  btn.disabled = true;

  try {
    const res = await fetch(`${API_URL}/api/auth/password`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...authHeader() },
      body: JSON.stringify({ oldPassword: oldPw, newPassword: newPw }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Erreur serveur');

    e.target.reset();
    showMsg('pwMsg', 'Mot de passe changé avec succès !', 'success');
  } catch (err) {
    showMsg('pwMsg', err.message);
  } finally {
    btn.textContent = 'Changer le mot de passe';
    btn.disabled = false;
  }
});

// ── Logout ────────────────────────────────────────────────────────────────────
document.getElementById('btnLogoutProfile').addEventListener('click', logout);

// ── Delete account ────────────────────────────────────────────────────────────
const deleteModal  = document.getElementById('deleteModal');
document.getElementById('btnDelete').addEventListener('click', () => {
  if (currentUser.role === 'admin') {
    alert('Le compte administrateur ne peut pas être supprimé.');
    return;
  }
  deleteModal.classList.remove('hidden');
});
document.getElementById('btnCancelDelete').addEventListener('click', () =>
  deleteModal.classList.add('hidden'));

document.getElementById('btnConfirmDelete').addEventListener('click', async () => {
  const btn = document.getElementById('btnConfirmDelete');
  btn.textContent = 'Suppression…';
  btn.disabled = true;

  try {
    const res = await fetch(`${API_URL}/api/auth/account`, {
      method: 'DELETE',
      headers: authHeader(),
    });
    if (!res.ok) {
      const d = await res.json();
      throw new Error(d.error || 'Erreur serveur');
    }
    clearSession();
    window.location.href = 'login.html';
  } catch (err) {
    alert('Erreur : ' + err.message);
    btn.textContent = 'Oui, supprimer';
    btn.disabled = false;
  }
});
