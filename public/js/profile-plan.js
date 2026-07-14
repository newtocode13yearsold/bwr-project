// profile-plan.js — the badge catalogue, "Mon abonnement & progression" panel
// (plan pill, XP/level, badges, premium sections), the Silver trial, the weekly
// quota strip, custom goals, weather widget, push alerts and the header stat
// counters for the profile page.
// Split out of profile.js. Classic (deferred) script loaded before js/profile.js.
// Only declarations here; every function is invoked later from the entry boot IIFE
// (renderPlanAndProgress fans out to the wheel/stats modules at call time).

const BADGES = [
  // Free tier badges
  { id: 'first_route',  icon: '🌱', label: 'Première sortie',  tier: 'free',   desc: 'Complète ta première balade en forêt',   test: s => s.routes >= 1 },
  { id: 'hiker',        icon: '🥾', label: 'Randonneur',       tier: 'free',   desc: 'Effectue 5 balades',                     test: s => s.routes >= 5 },
  { id: 'explorer',     icon: '🌲', label: 'Explorateur',      tier: 'free',   desc: 'Effectue 10 balades',                    test: s => s.routes >= 10 },
  { id: 'forest_friend',icon: '🦌', label: 'Ami forêt',        tier: 'free',   desc: 'Effectue 25 balades',                    test: s => s.routes >= 25 },
  { id: 'marathoner',   icon: '🏃', label: 'Marathonien',      tier: 'free',   desc: 'Parcours 25 km au total',                test: s => s.km >= 25 },
  { id: 'adventurer',   icon: '🗻', label: 'Aventurier',       tier: 'free',   desc: 'Parcours 50 km au total',                test: s => s.km >= 50 },
  { id: 'legend',       icon: '🏆', label: 'Légende',          tier: 'free',   desc: 'Parcours 100 km au total',               test: s => s.km >= 100 },
  { id: 'champion',     icon: '👑', label: 'Champion',         tier: 'free',   desc: 'Parcours 250 km au total',               test: s => s.km >= 250 },
  // Silver tier badges
  { id: 'tree_lover',   icon: '🌳', label: 'Amoureux arbres',  tier: 'silver', desc: 'Effectue 50 balades',                    test: s => s.routes >= 50 },
  { id: 'compass',      icon: '🧭', label: 'Boussole',         tier: 'silver', desc: 'Effectue 75 balades',                    test: s => s.routes >= 75 },
  { id: 'tent',         icon: '⛺', label: 'Campeur',          tier: 'silver', desc: 'Parcours 150 km au total',               test: s => s.km >= 150 },
  { id: 'mountain',     icon: '⛰️', label: 'Sommet',           tier: 'silver', desc: 'Parcours 200 km au total',               test: s => s.km >= 200 },
  { id: 'leaf',         icon: '🍃', label: 'Naturaliste',      tier: 'silver', desc: 'Effectue 100 balades',                   test: s => s.routes >= 100 },
  { id: 'mushroom',     icon: '🍄', label: 'Cueilleur',        tier: 'silver', desc: 'Effectue 30 balades',                    test: s => s.routes >= 30 },
  { id: 'fire',         icon: '🔥', label: 'Endurance',        tier: 'silver', desc: 'Parcours 75 km au total',                test: s => s.km >= 75 },
  { id: 'star',         icon: '⭐', label: 'Étoile montante',  tier: 'silver', desc: 'Effectue 15 balades',                    test: s => s.routes >= 15 },
  { id: 'compass2',     icon: '🎯', label: 'Précision',        tier: 'silver', desc: 'Effectue 40 balades',                    test: s => s.routes >= 40 },
  { id: 'sunrise',      icon: '🌅', label: 'Aube',             tier: 'silver', desc: 'Effectue 20 balades',                    test: s => s.routes >= 20 },
  { id: 'fox',          icon: '🦊', label: 'Rusé renard',      tier: 'silver', desc: 'Parcours 125 km au total',               test: s => s.km >= 125 },
  { id: 'rabbit',       icon: '🐇', label: 'Rapide',           tier: 'silver', desc: 'Effectue 60 balades',                    test: s => s.routes >= 60 },
  { id: 'owl',          icon: '🦉', label: 'Sage chouette',    tier: 'silver', desc: 'Parcours 175 km au total',               test: s => s.km >= 175 },
  // Gold tier badges
  { id: 'crown',        icon: '👑', label: 'Couronne d\'or',   tier: 'gold',   desc: 'Parcours 500 km au total',               test: s => s.km >= 500 },
  { id: 'medal',        icon: '🏅', label: 'Médaillé',         tier: 'gold',   desc: 'Effectue 150 balades',                   test: s => s.routes >= 150 },
  { id: 'rocket',       icon: '🚀', label: 'Fusée',            tier: 'gold',   desc: 'Parcours 300 km au total',               test: s => s.km >= 300 },
  { id: 'diamond',      icon: '💎', label: 'Diamant',          tier: 'gold',   desc: 'Parcours 1 000 km au total',             test: s => s.km >= 1000 },
  { id: 'dragon',       icon: '🐉', label: 'Dragon',           tier: 'gold',   desc: 'Effectue 200 balades',                   test: s => s.routes >= 200 },
  { id: 'phoenix',      icon: '🔥', label: 'Phénix',           tier: 'gold',   desc: 'Parcours 750 km au total',               test: s => s.km >= 750 },
  { id: 'wolf',         icon: '🐺', label: 'Loup alpha',       tier: 'gold',   desc: 'Effectue 250 balades',                   test: s => s.routes >= 250 },
  { id: 'eagle',        icon: '🦅', label: 'Aigle royal',      tier: 'gold',   desc: 'Parcours 400 km au total',               test: s => s.km >= 400 },
  // Streak badges
  { id: 'streak_3',  icon: '🔥', label: '3 jours de suite',   tier: 'free',   desc: 'Effectue une balade 3 jours consécutifs',   test: s => s.streak >= 3 },
  { id: 'streak_7',  icon: '⚡', label: '7 jours de suite',   tier: 'silver', desc: 'Effectue une balade 7 jours consécutifs',   test: s => s.streak >= 7 },
  { id: 'streak_30', icon: '💫', label: '30 jours de suite',  tier: 'gold',   desc: 'Effectue une balade 30 jours consécutifs',  test: s => s.streak >= 30 },
  // Roue de la chance — badges exclusifs
  { id: 'lucky_badge',    icon: '🍀', label: 'Badge Chanceux',    tier: 'free',   desc: 'Remporté en tournant la roue de la chance',   test: () => localStorage.getItem('bwr_lucky_badge') === '1' },
  { id: 'exclusive_badge', icon: '✨', label: 'Badge Or Exclusif', tier: 'gold',   desc: 'Badge animé exclusif gagné à la roue de la chance', test: () => localStorage.getItem('bwr_exclusive_badge') === '1' },
];

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
  const plan = BWR.normalisePlan(user.plan);
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
  // Sync any offline surplus to server (covers routes completed offline or on another device)
  const deltaRoutes = localRoutes - serverRoutes;
  const deltaKm     = localKm - serverKm;
  if (deltaRoutes > 0 || deltaKm > 0) {
    fetch(`${API_URL}/api/auth/stats`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeader() },
      body: JSON.stringify({ routes: Math.max(0, deltaRoutes), km: Math.max(0, parseFloat(deltaKm.toFixed(2))) }),
    }).catch(() => {});
  }

  // Sync server's weekly quota to localStorage so renderQuotaStrip() is accurate on any device
  if (user.stats && user.stats.weekStart) {
    const localWeekly = BWR.readWeekly();
    if (user.stats.weekStart === localWeekly.weekStart) {
      const serverWeekly = user.stats.weeklyRoutes || 0;
      if (serverWeekly > localWeekly.count) {
        localStorage.setItem('bwr_routes_week', JSON.stringify({
          weekStart: localWeekly.weekStart,
          count: serverWeekly,
        }));
      }
    }
  }

  // ── Level / XP — earned through community contributions, not distance ──
  // XP = 2 per report + 1 per graded path (same formula as the leaderboard points),
  // so the level here matches a member's standing in the classement.
  const xp    = BWR.xpFromStats(user.stats);
  const prog  = BWR.levelProgress(xp);
  const level = prog.level;

  // ── Weekly route quota strip (free users only) — includes the level bonus ──
  renderQuotaStrip(plan, level);

  document.getElementById('levelNum').textContent = `Niveau ${level}`;
  document.getElementById('levelXp').textContent  = `${prog.xpIn} / ${prog.span} XP`;
  document.getElementById('xpFill').style.width   = `${prog.pct}%`;

  // Next-reward teaser + full reward ladder
  renderRewardLadder(level, prog);

  // Badges — for free users, show locked silhouettes for higher-tier badges
  const streak = user.stats?.streak || 0;
  const stats = { routes, km, streak };

  const tierVisible = { free: ['free'], silver: ['free', 'silver'], gold: ['free', 'silver', 'gold'] };

  // Detect newly earned badges and notify with a toast
  const accessibleBadges = BADGES.filter(b => tierVisible[plan].includes(b.tier));
  const nowEarned = new Set(accessibleBadges.filter(b => b.test(stats)).map(b => b.id));
  const prevEarned = new Set(JSON.parse(localStorage.getItem('bwr_earned_badges') || '[]'));
  accessibleBadges.forEach(b => {
    if (nowEarned.has(b.id) && !prevEarned.has(b.id)) {
      showBadgeToast(b);
      localStorage.setItem(`bwr_badge_date_${b.id}`, new Date().toISOString());
    }
  });
  localStorage.setItem('bwr_earned_badges', JSON.stringify([...nowEarned]));

  const grid  = document.getElementById('badgesGrid');
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
    const rawDate = earned ? localStorage.getItem(`bwr_badge_date_${b.id}`) : null;
    const dateStr = rawDate
      ? new Date(rawDate).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' })
      : null;
    const extraClass = b.id === 'exclusive_badge' ? ' badge-exclusive' : '';
    return `<div class="badge-item ${earned ? 'earned' : 'locked'} tier-${b.tier}${extraClass}" title="${b.label}">
      <span class="badge-icon">${b.icon}</span>
      <span class="badge-label">${b.label}</span>
      <span class="badge-desc">${b.desc}</span>
      ${dateStr ? `<span class="badge-date">Obtenu le ${dateStr}</span>` : ''}
    </div>`;
  }).join('');

  // Next-badge progress teaser (closest accessible, not-yet-earned badge)
  renderNextBadge(stats, plan);

  // Locked badges hint
  const lockedHint = document.getElementById('badgesLockedHint');
  if (plan === 'free') {
    const silverCount = BADGES.filter(b => b.tier === 'silver').length;
    const goldCount   = BADGES.filter(b => b.tier === 'gold').length;
    lockedHint.innerHTML =
      `🔒 <strong>${silverCount + goldCount} badges supplémentaires</strong> à débloquer · <a href="plans">Voir les plans →</a>`;
    lockedHint.style.display = '';
  } else if (plan === 'silver') {
    const goldCount = BADGES.filter(b => b.tier === 'gold').length;
    lockedHint.innerHTML =
      `🔒 <strong>${goldCount} badges Or exclusifs</strong> (dont un badge animé) · <a href="plans">Passer à Or →</a>`;
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
  if (BWR.can('daily_wheel', plan)) {
    const premiumSection = document.getElementById('premiumSection');
    premiumSection.style.display = '';
    const isGold = plan === 'gold';
    document.getElementById('premiumIcon').textContent = isGold ? '🥇' : '🥈';
    document.getElementById('premiumTitle').textContent = isGold ? 'Privilèges Or' : 'Fonctionnalités premium';

    renderDailyWheel(plan);
    renderPrizeList(plan);

    // Premium blocks — gated per-feature so Argent unlocks what it's entitled to.
    document.getElementById('goalBlock').style.display  = BWR.can('custom_goals', plan) ? '' : 'none';
    document.getElementById('weatherBlock').style.display = BWR.can('weather', plan) ? '' : 'none';
    document.getElementById('supportBlock').style.display = BWR.can('priority_support', plan) ? '' : 'none';
    document.getElementById('pushAlertsBlock').style.display = BWR.can('path_alerts', plan) ? '' : 'none';
    document.getElementById('trailHealthBlock').style.display = isGold ? '' : 'none';

    if (BWR.can('custom_goals', plan)) renderGoals();
    if (BWR.can('weather', plan)) renderWeather();
    if (BWR.can('path_alerts', plan)) renderPushAlerts();
    renderEmailNotif();
    if (isGold) renderTrailHealth();
  } else {
    document.getElementById('premiumSection').style.display = 'none';
  }

  // Free-user upsell card (only for free users — Silver/Gold hide it)
  const upsellCard = document.getElementById('upsellCard');
  if (upsellCard) upsellCard.style.display = (plan === 'free') ? '' : 'none';

  // One-time free 7-day Silver trial — offered to free users who haven't used it yet.
  const trialBtn  = document.getElementById('startTrialBtn');
  const trialNote = document.getElementById('trialNote');
  if (trialBtn) {
    const eligible = plan === 'free' && !user.silverTrialUsed;
    trialBtn.style.display  = eligible ? '' : 'none';
    if (trialNote) trialNote.style.display = eligible ? '' : 'none';
    if (eligible) trialBtn.addEventListener('click', startSilverTrial, { once: true });
  }

  // ── Engagement gadgets (all tiers; recent routes gated inside) ──
  renderActivityHeatmap(user.stats);
  renderRecords(user.stats);
  renderStreakBanner(user.stats);
  renderMonthlyChallenge(user.stats);
  renderRecentRoutes(plan);
}

// Activates the one-time free 7-day Silver trial, then reloads so the page
// re-renders with the unlocked premium sections.
async function startSilverTrial(e) {
  const btn = e.currentTarget;
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Activation…';
  try {
    const res = await fetch(`${API_URL}/api/auth/start-trial`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeader() },
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Activation impossible.');
    const cached = getCachedUser();
    if (cached) {
      setSession(localStorage.getItem('bwr_token'),
        { ...cached, plan: 'silver', planExpiresAt: data.planExpiresAt, silverTrialUsed: true });
    }
    alert('🎉 Essai Argent activé ! Vous profitez de toutes les fonctionnalités pendant 7 jours.');
    location.reload();
  } catch (err) {
    btn.disabled = false;
    btn.textContent = original;
    alert('Impossible d\'activer l\'essai : ' + err.message);
  }
}

// ── Weekly route quota strip ─────────────────────────────────────────────────
function renderQuotaStrip(plan, level) {
  const strip = document.getElementById('quotaStrip');
  if (!strip) return;
  const limit = BWR.routeLimit(plan, level || 1);
  if (limit === Infinity) { strip.style.display = 'none'; return; }
  const { count } = BWR.readWeekly();
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
      <a href="plans" class="pqs-cta">Passer à illimité →</a>
    </div>
    <div class="pqs-bar"><div class="pqs-fill" style="width:${pct}%"></div></div>
  `;
}

// ── Level reward ladder ───────────────────────────────────────────────────────
// Renders the "next reward" teaser under the XP bar + the full paliers grid.
// Cosmetic/status rewards + one light functional perk (bonus weekly routes).
function renderRewardLadder(level, prog) {
  // Next-reward teaser under the XP bar
  const nextEl = document.getElementById('levelNext');
  if (nextEl) {
    const next = BWR.nextReward(level);
    if (next) {
      const need = prog.xpToNext; // XP left to reach the next level (matches the bar)
      nextEl.innerHTML =
        `Prochain palier : <strong>${next.icon} ${next.label}</strong> · encore <strong>${need} XP</strong> sur <strong>${prog.span} XP</strong> pour ce niveau (niveau ${next.level})`;
      nextEl.style.display = '';
    } else {
      nextEl.innerHTML = '🏆 Tous les paliers débloqués — bravo, tu es une légende !';
      nextEl.style.display = '';
    }
  }

  // Progression track: a bar with a milestone dot per palier, filled up to the
  // current level (+ the fraction of XP earned inside it).
  const track = document.getElementById('rewardsTrack');
  if (track) {
    const rewards = BWR.LEVEL_REWARDS;
    const maxLv = rewards[rewards.length - 1].level;
    // Continuous position from level 1 → maxLv, including partial in-level XP.
    const pos = Math.min(1, Math.max(0, ((level - 1) + prog.pct / 100) / (maxLv - 1)));
    const dots = rewards.map(r => {
      const done = r.level <= level;
      const isNext = r.level === level + 1;
      const at = ((r.level - 1) / (maxLv - 1)) * 100;
      return `<div class="rt-dot ${done ? 'done' : ''}${isNext ? ' is-next' : ''}" style="left:${at}%" title="Niv. ${r.level} — ${r.label}">
        <span class="rt-ic">${done ? r.icon : '🔒'}</span>
      </div>`;
    }).join('');
    track.innerHTML =
      `<div class="rt-rail"><div class="rt-fill" style="width:${pos * 100}%"></div>${dots}</div>`;
  }

  // Full ladder grid
  const ladder = document.getElementById('rewardsLadder');
  if (!ladder) return;
  ladder.innerHTML = BWR.LEVEL_REWARDS.map(r => {
    const unlocked = r.level <= level;
    const isNext   = r.level === level + 1;
    return `<div class="reward-item ${unlocked ? 'unlocked' : 'locked'}${isNext ? ' is-next' : ''}${r.frame ? ' reward-frame-' + r.frame : ''}">
      <span class="reward-lv">Niv. ${r.level}</span>
      <span class="reward-icon">${unlocked ? r.icon : '🔒'}</span>
      <span class="reward-label">${r.label}</span>
      <span class="reward-desc">${r.desc}</span>
    </div>`;
  }).join('');
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
const WEATHER_CODE_MAP = {
  0:['☀️','Ensoleillé'], 1:['🌤','Peu nuageux'], 2:['⛅','Nuageux'], 3:['☁️','Couvert'],
  45:['🌫','Brouillard'], 48:['🌫','Brouillard givrant'],
  51:['🌦','Bruine légère'], 53:['🌦','Bruine'], 55:['🌧','Bruine forte'],
  61:['🌧','Pluie légère'], 63:['🌧','Pluie'], 65:['🌧','Forte pluie'],
  71:['🌨','Neige'], 73:['🌨','Neige modérée'], 75:['❄️','Forte neige'],
  80:['🌦','Averses'], 81:['🌧','Averses'], 82:['⛈','Violentes averses'],
  95:['⛈','Orage'], 96:['⛈','Orage + grêle'], 99:['⛈','Orage violent'],
};

function weatherHikingSuitability(code, wind, precipProb) {
  if (code >= 95) return ['weather-suit--bad', '⛈ Pas de sortie'];
  if (code >= 61 && code <= 82) return ['weather-suit--bad', '🌧 Sortie déconseillée'];
  if (wind > 40) return ['weather-suit--bad', '💨 Vent dangereux'];
  if ((precipProb ?? 0) > 60 || wind > 25) return ['weather-suit--ok', '🌂 Sortie possible'];
  if (code >= 45 && code <= 48) return ['weather-suit--ok', '🌫 Brouillard'];
  return ['weather-suit--great', '✅ Idéal pour randonner'];
}

async function renderWeather() {
  try {
    const url = 'https://api.open-meteo.com/v1/forecast'
      + '?latitude=49.35&longitude=2.90'
      + '&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m,relative_humidity_2m,precipitation_probability'
      + '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max'
      + '&timezone=Europe%2FParis&forecast_days=4';
    const data = await (await fetch(url)).json();
    const c = data.current;
    const d = data.daily;

    const [icon, label] = WEATHER_CODE_MAP[c.weather_code] || ['🌤', 'Variable'];
    document.getElementById('weatherIcon').textContent = icon;
    document.getElementById('weatherTemp').textContent = `${Math.round(c.temperature_2m)}°C`;
    document.getElementById('weatherLabel').textContent = label;
    document.getElementById('weatherFeels').textContent = `Ressenti ${Math.round(c.apparent_temperature)}°C`;

    // Suitability badge
    const precipProb = c.precipitation_probability ?? (d.precipitation_probability_max?.[0] ?? 0);
    const [suitClass, suitText] = weatherHikingSuitability(c.weather_code, c.wind_speed_10m, precipProb);
    const suitEl = document.getElementById('weatherSuitability');
    suitEl.textContent = suitText;
    suitEl.className = `weather-suit ${suitClass}`;

    // Detail chips
    document.getElementById('wdWind').textContent = `💨 ${Math.round(c.wind_speed_10m)} km/h`;
    document.getElementById('wdHumidity').textContent = `💧 ${Math.round(c.relative_humidity_2m)} %`;
    document.getElementById('wdPrecip').textContent = `🌧 ${precipProb} %`;
    document.getElementById('weatherDetails').style.display = 'flex';

    // 4-day forecast strip
    const days = ['Dim','Lun','Mar','Mer','Jeu','Ven','Sam'];
    const forecastEl = document.getElementById('weatherForecast');
    forecastEl.innerHTML = d.time.map((iso, i) => {
      const name = i === 0 ? "Auj." : days[new Date(iso).getDay()];
      const [fi, fl] = WEATHER_CODE_MAP[d.weather_code[i]] || ['🌤', ''];
      const rain = d.precipitation_probability_max[i] ?? 0;
      return `<div class="weather-day">
        <span class="weather-day-name">${name}</span>
        <span class="weather-day-icon">${fi}</span>
        <span class="weather-day-temps"><b>${Math.round(d.temperature_2m_max[i])}°</b> / ${Math.round(d.temperature_2m_min[i])}°</span>
        ${rain > 10 ? `<span class="weather-day-rain">🌧 ${rain}%</span>` : ''}
      </div>`;
    }).join('');
  } catch {
    document.getElementById('weatherIcon').textContent = '❌';
    document.getElementById('weatherLabel').textContent = 'Météo indisponible';
  }
}

// ── Web Push alerts (native browser notifications) ────────────────────────────
// Fires when a new hazard report lands within ~150 m of one of the member's
// saved routes. Uses the Push API via js/push.js (BWRPush); the server-side
// subscription state also flips user.alertsEnabled, but the browser
// subscription is the source of truth we render from.
async function renderPushAlerts() {
  const block  = document.getElementById('pushAlertsBlock');
  const status = document.getElementById('pushAlertsStatus');
  const btn    = document.getElementById('btnToggleAlerts');
  if (!block || !btn) return;

  if (!window.BWRPush || !BWRPush.SUPPORTED) {
    status.innerHTML = `<span style="color:#6b7280">Notifications non supportées sur cet appareil.</span>`;
    btn.style.display = 'none';
    return;
  }

  let st = await BWRPush.status().catch(() => ({ subscribed: false }));

  function render() {
    if (st.subscribed) {
      status.innerHTML = `<span style="color:#16a34a;font-weight:600">🔔 Alertes activées</span>`;
      btn.textContent = '🔕 Désactiver les alertes';
    } else {
      status.innerHTML = `<span style="color:#6b7280">Alertes désactivées</span>`;
      btn.textContent = '🔔 Activer les alertes';
    }
  }

  render();

  btn.addEventListener('click', async () => {
    btn.disabled = true;
    try {
      if (st.subscribed) { await BWRPush.disable(); st = { subscribed: false }; }
      else               { await BWRPush.enable();  st = { subscribed: true  }; }
      const c = getCachedUser();
      if (c) setSession(localStorage.getItem('bwr_token'), { ...c, alertsEnabled: st.subscribed });
      render();
    } catch (err) {
      status.innerHTML = `<span style="color:#dc2626">Erreur : ${err.message || 'réessaye'}</span>`;
    } finally { btn.disabled = false; }
  });
}

// ── Email notification preference ─────────────────────────────────────────────
// Server-side flag (user.emailNotifications, default on) gating the forum-reply
// and route-hazard notification emails. Independent of the push toggle above —
// email is a separate channel that works without a push subscription.
async function renderEmailNotif() {
  const block  = document.getElementById('emailNotifBlock');
  const status = document.getElementById('emailNotifStatus');
  const btn    = document.getElementById('btnToggleEmailNotif');
  if (!block || !btn) return;

  let enabled = true;
  try {
    const res = await fetch(`${API_URL}/api/auth/me`, { headers: { ...authHeader() } });
    const me = await res.json();
    enabled = me.emailNotifications !== false;
  } catch { /* keep optimistic default */ }

  function render() {
    if (enabled) {
      status.innerHTML = `<span style="color:#16a34a;font-weight:600">✉️ Emails activés</span>`;
      btn.textContent = '🔕 Désactiver les emails';
    } else {
      status.innerHTML = `<span style="color:#6b7280">Emails désactivés</span>`;
      btn.textContent = '✉️ Activer les emails';
    }
  }
  render();

  btn.onclick = async () => {
    btn.disabled = true;
    const next = !enabled;
    try {
      const res = await fetch(`${API_URL}/api/auth/notifications`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...authHeader() },
        body: JSON.stringify({ emailNotifications: next }),
      });
      if (!res.ok) throw new Error();
      enabled = next;
      render();
    } catch {
      status.innerHTML = `<span style="color:#dc2626">Erreur — réessaye.</span>`;
    } finally { btn.disabled = false; }
  };
}

// ── Next-badge progress teaser ────────────────────────────────────────────────
// Finds the accessible badge the member is closest to unlocking and shows a
// progress bar toward it. Numeric thresholds are read from each badge's `test`
// source (e.g. `s => s.routes >= 25`), so no threshold data has to be duplicated;
// badges whose test isn't a simple numeric comparison (e.g. wheel badges) are
// skipped.
const TIER_VISIBLE = { free: ['free'], silver: ['free', 'silver'], gold: ['free', 'silver', 'gold'] };

function renderNextBadge(stats, plan) {
  const box = document.getElementById('nextBadge');
  if (!box) return;

  const parseThreshold = fn => {
    const m = /s\.(routes|km|streak)\s*>=\s*([\d.]+)/.exec(fn.toString());
    return m ? { metric: m[1], goal: parseFloat(m[2]) } : null;
  };

  let best = null;
  for (const b of BADGES) {
    if (!TIER_VISIBLE[plan].includes(b.tier)) continue;
    if (b.test(stats)) continue;                       // already earned
    const t = parseThreshold(b.test);
    if (!t || !(t.goal > 0)) continue;
    const cur = stats[t.metric] || 0;
    if (cur >= t.goal) continue;
    const pct = cur / t.goal;
    if (!best || pct > best.pct) best = { badge: b, cur, goal: t.goal, metric: t.metric, pct };
  }

  if (!best) { box.style.display = 'none'; return; }

  const fmtVal = v => best.metric === 'km' ? fmtKm(v) : best.metric === 'streak' ? `${v} j` : `${v}`;
  box.style.display = '';
  box.innerHTML = `
    <span class="nb-icon">${best.badge.icon}</span>
    <div class="nb-body">
      <div class="nb-top">
        <span class="nb-label">Prochain badge · <strong>${escapeHtml(best.badge.label)}</strong></span>
        <span class="nb-count">${fmtVal(best.cur)} / ${fmtVal(best.goal)}</span>
      </div>
      <div class="xp-bar"><div class="xp-fill" style="width:${Math.min(100, best.pct * 100)}%"></div></div>
      <span class="nb-desc">${escapeHtml(best.badge.desc)}</span>
    </div>`;
}

// "Mon activité" summary — four personal KPIs read straight from the user's
// stats + the locally cached badge set (no network needed). Server stats are
// authoritative; localStorage is a cache, so take the max where both exist.
function renderActivityStats() {
  const s = (currentUser && currentUser.stats) || {};
  const routes       = Math.max(s.routes || 0, parseInt(localStorage.getItem('bwr_route_count') || '0'));
  const earnedBadges = JSON.parse(localStorage.getItem('bwr_earned_badges') || '[]').length;
  const streak       = s.streak || 0;
  // Contribution points — same formula as the leaderboard / XP (report=2, grade=1)
  const points       = (s.reports || 0) * 2 + (s.pathGrades || 0);

  const set = (id, val) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.remove('skeleton');
    el.textContent = val;
  };
  set('statRoutes', routes);
  set('statBadges', `${earnedBadges} / ${BADGES.length}`);
  set('statStreak', streak > 0 ? `${streak} j` : '—');
  set('statPoints', points);
}
