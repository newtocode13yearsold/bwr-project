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

const DAILY_TIPS = [
  '🌲 Aujourd\'hui : essaye le Carrefour du Puits du Roi !',
  '🦌 Aujourd\'hui : observe la faune au lever du jour.',
  '🍂 Aujourd\'hui : sortie automnale parfaite pour les couleurs.',
  '🥾 Aujourd\'hui : 10 km en boucle, ça te tente ?',
  '🌳 Aujourd\'hui : découvre les vieux chênes des Beaux Monts.',
  '🌅 Aujourd\'hui : profite de la lumière dorée du matin.',
  '🏞️ Aujourd\'hui : tente un nouveau sentier inconnu.',
  '🍄 Aujourd\'hui : ouvre l\'œil pour les champignons.',
  '🦊 Aujourd\'hui : reste silencieux, tu verras peut-être un renard.',
  '⛰️ Aujourd\'hui : Mont Saint-Pierre, panorama garanti !',
  '🌿 Aujourd\'hui : sortie courte mais intense — fais 5 km en 1h.',
  '🦉 Aujourd\'hui : sortie crépusculaire pour écouter la chouette.',
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
  // Plan pill
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

  // Level & XP — every 5 km is a level
  const routes = parseInt(localStorage.getItem('bwr_route_count') || '0');
  const km     = parseFloat(localStorage.getItem('bwr_km_total') || '0');
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

  // Silver/Gold features — daily wheel + custom goals
  if (can('daily_wheel', plan)) {
    document.getElementById('silverGoldSection').style.display = '';
    renderDailyWheel();
    if (can('custom_goals', plan)) {
      document.getElementById('goalBlock').style.display = '';
      renderGoals();
    } else {
      // Silver doesn't get custom goals
      const goalBlock = document.getElementById('goalBlock');
      if (goalBlock) goalBlock.style.display = 'none';
    }
  } else {
    document.getElementById('silverGoldSection').style.display = 'none';
  }

  // Gold-only features
  if (can('weather', plan)) {
    renderWeather();
    document.getElementById('goldOnlySection').style.display = '';
  } else {
    document.getElementById('goldOnlySection').style.display = 'none';
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
function renderDailyWheel() {
  const today = new Date().toISOString().slice(0, 10);
  const lastSpin = localStorage.getItem('bwr_wheel_last');
  const wheelBtn  = document.getElementById('wheelSpinBtn');
  const wheelText = document.getElementById('wheelText');

  if (lastSpin === today) {
    const saved = localStorage.getItem('bwr_wheel_tip');
    wheelText.textContent = saved || 'Tu as déjà tourné la roue aujourd\'hui — reviens demain !';
    wheelBtn.disabled = true;
    wheelBtn.textContent = '✓ Tournée';
  } else {
    wheelBtn.disabled = false;
    wheelBtn.onclick = () => {
      const tip = DAILY_TIPS[Math.floor(Math.random() * DAILY_TIPS.length)];
      wheelText.textContent = tip;
      localStorage.setItem('bwr_wheel_last', today);
      localStorage.setItem('bwr_wheel_tip', tip);
      wheelBtn.disabled = true;
      wheelBtn.textContent = '✓ Tournée';
      document.getElementById('wheelEmoji').classList.add('spin');
    };
  }
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

async function loadPathCount() {
  try {
    const res = await fetch(`${API_URL}/api/paths`);
    const paths = await res.json();
    document.getElementById('statPaths').textContent = paths.length;
  } catch {}
  // Routes and km are stored locally per session (no persistent history in the backend)
  const routes = parseInt(localStorage.getItem('bwr_route_count') || '0');
  const km     = parseFloat(localStorage.getItem('bwr_km_total') || '0');
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
