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

function getAvatarColor(userId) {
  const key = userId ? `bwr_avatar_color_${userId}` : 'bwr_avatar_color';
  const saved = localStorage.getItem(key);
  return saved ? JSON.parse(saved) : AVATAR_COLORS[0];
}

function saveAvatarColor(color, userId) {
  const key = userId ? `bwr_avatar_color_${userId}` : 'bwr_avatar_color';
  localStorage.setItem(key, JSON.stringify(color));
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
  const current   = getAvatarColor(user.id);
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
      saveAvatarColor(color, user.id);
      renderAvatar(user, color);
      container.querySelectorAll('.swatch').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
  });
}

let _toastQueue = [];
let _toastRunning = false;

function showBadgeToast(badge) {
  _toastQueue.push(badge);
  if (!_toastRunning) _drainToastQueue();
}

function _drainToastQueue() {
  if (!_toastQueue.length) { _toastRunning = false; return; }
  _toastRunning = true;
  const badge = _toastQueue.shift();

  let el = document.getElementById('badgeToast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'badgeToast';
    el.className = 'badge-toast';
    document.body.appendChild(el);
  }
  el.textContent = `🎉 Nouveau badge débloqué : ${badge.icon} ${badge.label}`;
  el.classList.add('show');

  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(_drainToastQueue, 300);
  }, 3200);
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

  // One-time migration: km previously counted from route generation are invalid.
  // Reset local and server km to 0 so only GPS-tracked km count going forward.
  if (!localStorage.getItem('bwr_km_gps_only_v1')) {
    localStorage.setItem('bwr_km_total', '0');
    if (getToken()) {
      await fetch(`${API_URL}/api/auth/stats`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeader() },
        body: JSON.stringify({ resetKm: true }),
      }).catch(() => {});
    }
    localStorage.setItem('bwr_km_gps_only_v1', '1');
    // Reload user data after reset so the page shows fresh stats
    const res = await fetch(`${API_URL}/api/auth/me`, { headers: authHeader() });
    if (res.ok) currentUser = await res.json();
  }

  initUserMenu();
  populatePage(currentUser);
  buildColorSwatches(currentUser);
  renderAvatar(currentUser, getAvatarColor(currentUser.id));
  loadPathCount();
})();

function initUserMenu() {
  const menuEl = document.getElementById('userMenu');
  const color  = getAvatarColor(currentUser.id);
  const ini    = initials(currentUser.name);
  menuEl.innerHTML = `
    <button class="user-btn" id="userBtn">
      <div class="user-avatar" style="background:${color.bg};color:${color.fg}">${ini}</div>
      <span class="btn-label">${currentUser.name.split(' ')[0]}</span>
    </button>
    <div class="user-dropdown hidden" id="userDropdown">
      <span class="dropdown-name">${currentUser.name}</span>
      <a href="/">🏠 Accueil</a>
      <a href="map">🗺 Voir la carte</a>
      <a href="routes">🧭 Planifier un trajet</a>
      ${currentUser.role === 'admin' ? '<a href="admin">⚙️ Admin</a>' : ''}
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

// ── Canvas roulette wheel ──────────────────────────────────────────────────────
const WHEEL_SIZE = 260; // logical px (CSS pixels)
const WHEEL_COLORS = [
  '#16a34a', // green
  '#d97706', // amber
  '#2563eb', // blue
  '#9333ea', // purple
  '#dc2626', // red
  '#0891b2', // cyan
  '#ea580c', // orange
  '#65a30d', // lime
];

let _wheelRotation = 0;   // current cumulative rotation (radians)
let _wheelSegments = null; // built once per plan on render

function _buildWheelSegments(plan) {
  const prizes = WHEEL_PRIZES[BWR.normalisePlan(plan)] || WHEEL_PRIZES.free;
  const total  = prizes.reduce((s, p) => s + p.weight, 0);
  const segs   = [];
  let angle = 0;
  prizes.forEach((p, i) => {
    const sweep = (p.weight / total) * Math.PI * 2;
    segs.push({ prize: p, startAngle: angle, sweep, color: WHEEL_COLORS[i % WHEEL_COLORS.length] });
    angle += sweep;
  });
  return segs;
}

function _initWheelCanvas() {
  const canvas = document.getElementById('wheelCanvas');
  if (!canvas) return null;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width  = WHEEL_SIZE * dpr;
  canvas.height = WHEEL_SIZE * dpr;
  canvas.style.width  = WHEEL_SIZE + 'px';
  canvas.style.height = WHEEL_SIZE + 'px';
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  return ctx;
}

function _drawWheelCanvas(rotation) {
  const canvas = document.getElementById('wheelCanvas');
  if (!canvas || !_wheelSegments) return;
  const ctx = canvas.getContext('2d');
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const cx = WHEEL_SIZE / 2;
  const cy = WHEEL_SIZE / 2;
  const r  = cx - 8;

  // ── Outer decorative ring ──
  ctx.beginPath();
  ctx.arc(cx, cy, r + 7, 0, Math.PI * 2);
  ctx.fillStyle = '#14532d';
  ctx.fill();

  // ── Pass 1 : filled segments ──
  _wheelSegments.forEach(seg => {
    const startA = seg.startAngle + rotation - Math.PI / 2;
    const endA   = startA + seg.sweep;
    const midA   = startA + seg.sweep / 2;

    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, r, startA, endA);
    ctx.closePath();
    ctx.fillStyle = seg.color;
    ctx.fill();

    // Radial highlight
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, r, startA, endA);
    ctx.closePath();
    ctx.clip();
    const grad = ctx.createRadialGradient(cx, cy, r * 0.25, cx, cy, r);
    grad.addColorStop(0,   'rgba(255,255,255,0.20)');
    grad.addColorStop(0.6, 'rgba(255,255,255,0.04)');
    grad.addColorStop(1,   'rgba(0,0,0,0.15)');
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.restore();

    // ── Icon ──
    ctx.save();
    ctx.translate(cx + Math.cos(midA) * r * 0.68, cy + Math.sin(midA) * r * 0.68);
    ctx.rotate(midA + Math.PI / 2);
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = seg.sweep > 0.9 ? '17px serif' : '13px serif';
    ctx.fillText(seg.prize.icon, 0, 0);

    if (seg.sweep > 0.6) {
      ctx.font        = `bold ${seg.sweep > 1.1 ? 9 : 7.5}px system-ui, sans-serif`;
      ctx.fillStyle   = '#fff';
      ctx.shadowColor = 'rgba(0,0,0,0.7)';
      ctx.shadowBlur  = 3;
      const line = seg.prize.label.length > 13 ? seg.prize.label.slice(0, 12) + '…' : seg.prize.label;
      ctx.fillText(line, 0, 14);
    }
    ctx.restore();
  });

  // ── Pass 2 : thick white spokes drawn over everything ──
  ctx.strokeStyle = '#fff';
  ctx.lineWidth   = 4;
  _wheelSegments.forEach(seg => {
    const angle = seg.startAngle + rotation - Math.PI / 2;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(angle) * r, cy + Math.sin(angle) * r);
    ctx.stroke();
  });

  // Outer rim
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(255,255,255,0.5)';
  ctx.lineWidth   = 2;
  ctx.stroke();

  // ── Center hub ──
  ctx.beginPath();
  ctx.arc(cx, cy, 22, 0, Math.PI * 2);
  ctx.fillStyle = '#14532d';
  ctx.fill();
  ctx.strokeStyle = '#fff';
  ctx.lineWidth   = 2.5;
  ctx.stroke();

  ctx.font = '15px serif';
  ctx.textAlign    = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#fff';
  ctx.fillText('⭐', cx, cy);
}

function _animateWheelSpin(prizeIndex, onDone) {
  const seg    = _wheelSegments[prizeIndex];
  const midSeg = seg.startAngle + seg.sweep / 2;

  // Jitter: land anywhere in the middle 60 % of the segment
  const jitter = (Math.random() - 0.5) * seg.sweep * 0.6;
  // For the top pointer (angle 0 in rotated frame), we need: midSeg + rotation = 0
  let targetRot = -(midSeg + jitter);

  // Bring targetRot into the range [_wheelRotation, _wheelRotation + 2π]
  while (targetRot < _wheelRotation) targetRot += Math.PI * 2;
  while (targetRot > _wheelRotation + Math.PI * 2) targetRot -= Math.PI * 2;

  // Add 5–7 full extra spins for drama
  const extraSpins = 5 + Math.floor(Math.random() * 3);
  targetRot += extraSpins * Math.PI * 2;

  const startRot   = _wheelRotation;
  const totalDelta = targetRot - startRot;
  const duration   = 3800; // ms – feels snappy yet satisfying

  function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }

  const t0 = performance.now();
  function frame(now) {
    const t      = Math.min(1, (now - t0) / duration);
    const eased  = easeOutCubic(t);
    _wheelRotation = startRot + totalDelta * eased;
    _drawWheelCanvas(_wheelRotation);
    if (t < 1) {
      requestAnimationFrame(frame);
    } else {
      _wheelRotation = targetRot;
      _drawWheelCanvas(_wheelRotation);
      onDone();
    }
  }
  requestAnimationFrame(frame);
}

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
    { id: 'exclusive_badge', icon: '✨', label: 'Badge Or exclusif', desc: 'Badge animé réservé aux membres Or',       type: 'badge',                                weight: 10 },
    { id: 'double_xp_48',    icon: '⭐', label: 'Double XP 48h',     desc: 'Progression doublée pendant 48 heures',   type: 'double_xp',   hours: 48,                weight: 15 },
    { id: 'xp_bonus_500',    icon: '🎯', label: '+500 XP bonus',     desc: 'Bonus d\'expérience immédiat',             type: 'xp_bonus',    xp: 500,                  weight: 25 },
    { id: 'trail_tip',       icon: '🌲', label: 'Conseil sentier VIP', desc: 'Suggestion exclusive pour membres Or',   type: 'tip',                                  weight: 50 },
  ],
};

function pickPrize(plan) {
  const prizes = WHEEL_PRIZES[BWR.normalisePlan(plan)] || WHEEL_PRIZES.free;
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

  // ── Weekly route quota strip (free users only) ──
  renderQuotaStrip(plan);
  const level  = Math.floor(km / 5) + 1;
  const xpIn   = km - (level - 1) * 5;
  const xpPct  = Math.min(100, (xpIn / 5) * 100);
  document.getElementById('levelNum').textContent = `Niveau ${level}`;
  document.getElementById('levelXp').textContent  = `${xpIn.toFixed(1)} / 5 km`;
  document.getElementById('xpFill').style.width   = `${xpPct}%`;

  // Badges — for free users, show locked silhouettes for higher-tier badges
  const streak = user.stats?.streak || 0;
  const stats = { routes, km, streak };

  const tierVisible = { free: ['free'], silver: ['free', 'silver'], gold: ['free', 'silver', 'gold'] };

  // Detect newly earned badges and notify with a toast
  const accessibleBadges = BADGES.filter(b => tierVisible[plan].includes(b.tier));
  const nowEarned = new Set(accessibleBadges.filter(b => b.test(stats)).map(b => b.id));
  const prevEarned = new Set(JSON.parse(localStorage.getItem('bwr_earned_badges') || '[]'));
  const cachedForPush = getCachedUser();
  accessibleBadges.forEach(b => {
    if (nowEarned.has(b.id) && !prevEarned.has(b.id)) {
      showBadgeToast(b);
      localStorage.setItem(`bwr_badge_date_${b.id}`, new Date().toISOString());
      if (cachedForPush?.alertsEnabled && cachedForPush?.alertsChannel) {
        fetch(`https://ntfy.sh/${cachedForPush.alertsChannel}`, {
          method: 'POST',
          headers: { Title: 'BWR — Badge débloqué !', Tags: 'trophy', 'Content-Type': 'text/plain; charset=utf-8' },
          body: `${b.icon} ${b.label} — ${b.desc}`,
        }).catch(() => {});
      }
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

    // Gold-exclusive blocks
    const show = isGold ? '' : 'none';
    document.getElementById('goalBlock').style.display  = BWR.can('custom_goals', plan) ? '' : 'none';
    document.getElementById('weatherBlock').style.display = show;
document.getElementById('supportBlock').style.display = show;
    document.getElementById('pushAlertsBlock').style.display = show;
    document.getElementById('trailHealthBlock').style.display = show;

    if (BWR.can('custom_goals', plan)) renderGoals();
    if (BWR.can('weather', plan)) renderWeather();
    if (isGold) renderPushAlerts();
    if (isGold) renderTrailHealth();
  } else {
    document.getElementById('premiumSection').style.display = 'none';
  }

  // Free-user upsell card (only for free users — Silver/Gold hide it)
  const upsellCard = document.getElementById('upsellCard');
  if (upsellCard) upsellCard.style.display = (plan === 'free') ? '' : 'none';

  // ── Engagement gadgets (all tiers; recent routes gated inside) ──
  renderActivityHeatmap(user.stats);
  renderRecords(user.stats);
  renderStreakBanner(user.stats);
  renderMonthlyChallenge(user.stats);
  renderRecentRoutes(plan);
}

// ── Small helpers ─────────────────────────────────────────────────────────────
function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// Distance formatter — French decimal comma, max 1 decimal ("6,5 km", "8 km")
function fmtKm(n) {
  return `${(n || 0).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} km`;
}

// UTC date key 'YYYY-MM-DD' from epoch-ms (matches server dailyLog keys, avoids TZ drift)
function utcDayKey(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

// Midnight-UTC epoch ms for "today"
function todayUtcMs() {
  const n = new Date();
  return Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate());
}

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
  fallen_tree: ['🌲', 'Arbre tombé'],
  flooded:     ['🌊', 'Inondé'],
  muddy:       ['💧', 'Boueux'],
  rutted:      ['🚧', 'Ornières'],
  broken_sign: ['🪧', 'Panneau cassé'],
  closed:      ['⛔', 'Fermé'],
  danger:      ['⚠️', 'Danger'],
  other:       ['❓', 'Autre'],
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

// ── Weekly route quota strip ─────────────────────────────────────────────────
function renderQuotaStrip(plan) {
  const strip = document.getElementById('quotaStrip');
  if (!strip) return;
  const limit = BWR.limitOf('routes_per_week', plan);
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

// ── Daily wheel ───────────────────────────────────────────────────────────────
function renderDailyWheel(plan) {
  const today    = new Date().toISOString().slice(0, 10);
  const lastSpin = localStorage.getItem('bwr_wheel_last');
  const wheelBtn  = document.getElementById('wheelSpinBtn');
  const wheelText = document.getElementById('wheelText');

  // Build segments for this plan
  _wheelSegments = _buildWheelSegments(plan);
  _initWheelCanvas();

  if (lastSpin === today) {
    // Restore wheel at the saved winning angle so it looks "landed"
    _wheelRotation = parseFloat(localStorage.getItem('bwr_wheel_rot') || '0');
    _drawWheelCanvas(_wheelRotation);

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
    _wheelRotation = 0;
    _drawWheelCanvas(0);
    wheelBtn.disabled = false;
    wheelBtn.onclick = () => spinWheel(plan);
  }
}

async function spinWheel(plan) {
  const today      = new Date().toISOString().slice(0, 10);
  const prize      = pickPrize(plan);
  const wheelBtn   = document.getElementById('wheelSpinBtn');
  const wheelText  = document.getElementById('wheelText');
  const prizes     = WHEEL_PRIZES[BWR.normalisePlan(plan)] || WHEEL_PRIZES.free;
  const prizeIndex = prizes.findIndex(p => p.id === prize.id);

  wheelBtn.disabled    = true;
  wheelBtn.textContent = '🎡 En cours…';
  wheelText.textContent = '';

  // ── 1. Spin the wheel visually ───────────────────────────────────────────────
  await new Promise(resolve => _animateWheelSpin(prizeIndex, resolve));

  // Save the final rotation so we can restore it on page reload
  localStorage.setItem('bwr_wheel_rot', String(_wheelRotation));

  // ── 2. Apply prize effects ───────────────────────────────────────────────────
  if (prize.type === 'plan') {
    try {
      const res  = await fetch(`${API_URL}/api/auth/wheel-prize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeader() },
        body: JSON.stringify({ prizeType: 'plan', plan: prize.plan, days: prize.days }),
      });
      const data = await res.json();
      if (!res.ok) {
        // Server rejected (cooldown) — downgrade to a trail tip
        let fallback = TRAIL_TIPS[Math.floor(Math.random() * TRAIL_TIPS.length)];
        try {
          const tipRes = await fetch(`${API_URL}/api/ai-tip`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...authHeader() },
          });
          if (tipRes.ok) fallback = (await tipRes.json()).tip;
        } catch {}
        wheelText.textContent = `🌲 ${fallback}`;
        localStorage.setItem('bwr_wheel_last', today);
        localStorage.setItem('bwr_wheel_result', JSON.stringify({ icon: '🌲', label: 'Conseil sentier', desc: fallback }));
        wheelBtn.textContent = '✓ Tournée';
        return;
      }
      const cached = getCachedUser();
      if (cached) setSession(localStorage.getItem('bwr_token'), { ...cached, plan: prize.plan, planExpiresAt: data.expiresAt });
    } catch {
      wheelText.textContent = '❌ Erreur réseau — réessaie.';
      wheelBtn.disabled    = false;
      wheelBtn.textContent = '🎡 Tourner la roue';
      return;
    }
  } else if (prize.type === 'bonus_route') {
    const w = BWR.readWeekly();
    w.count = Math.max(0, w.count - 1);
    localStorage.setItem('bwr_routes_week', JSON.stringify(w));
  } else if (prize.type === 'xp_bonus') {
    const km      = parseFloat(localStorage.getItem('bwr_km_total') || '0');
    const bonusKm = (prize.xp || 0) / 20;
    localStorage.setItem('bwr_km_total', (km + bonusKm).toFixed(2));
    fetch(`${API_URL}/api/auth/stats`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeader() },
      body: JSON.stringify({ routes: 0, km: bonusKm }),
    }).catch(() => {});
  } else if (prize.type === 'double_xp') {
    const expires = Date.now() + (prize.hours || 24) * 3600000;
    localStorage.setItem('bwr_double_xp_until', expires);
  } else if (prize.type === 'badge') {
    if (prize.id === 'exclusive_badge') {
      localStorage.setItem('bwr_exclusive_badge', '1');
    } else {
      localStorage.setItem('bwr_lucky_badge', '1');
    }
  } else if (prize.type === 'tip') {
    try {
      const res = await fetch(`${API_URL}/api/ai-tip`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeader() },
      });
      if (res.ok) { const d = await res.json(); prize.desc = d.tip; }
      else          prize.desc = TRAIL_TIPS[Math.floor(Math.random() * TRAIL_TIPS.length)];
    } catch {
      prize.desc = TRAIL_TIPS[Math.floor(Math.random() * TRAIL_TIPS.length)];
    }
  }

  // ── 3. Show result ────────────────────────────────────────────────────────────
  wheelText.innerHTML = `${prize.icon} <strong>${prize.label}</strong> — ${prize.desc}`;
  localStorage.setItem('bwr_wheel_last', today);
  localStorage.setItem('bwr_wheel_result', JSON.stringify({ icon: prize.icon, label: prize.label, desc: prize.desc }));
  wheelBtn.textContent = '✓ Tournée';

  if (prize.type === 'plan') {
    setTimeout(() => window.location.reload(), 1800);
  }
}

function renderPrizeList(plan) {
  const el = document.getElementById('wheelPrizesList');
  if (!el) return;
  const prizes = WHEEL_PRIZES[BWR.normalisePlan(plan)] || WHEEL_PRIZES.free;
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
    const statPaths = document.getElementById('statPaths');
    statPaths.classList.remove('skeleton');
    statPaths.textContent = paths.length;
  } catch {
    document.getElementById('statPaths').classList.remove('skeleton');
  }
  const serverRoutes = (currentUser?.stats?.routes) || 0;
  const serverKm     = (currentUser?.stats?.km) || 0;
  const routes = Math.max(serverRoutes, parseInt(localStorage.getItem('bwr_route_count') || '0'));
  const km     = Math.max(serverKm, parseFloat(localStorage.getItem('bwr_km_total') || '0'));
  const earnedBadges = JSON.parse(localStorage.getItem('bwr_earned_badges') || '[]').length;
  const statRoutes = document.getElementById('statRoutes');
  const statKm     = document.getElementById('statKm');
  statRoutes.classList.remove('skeleton');
  statKm.classList.remove('skeleton');
  statRoutes.textContent = routes;
  statKm.textContent     = earnedBadges > 0 ? `${earnedBadges} / ${BADGES.length}` : '—';
}

// ── Form: update name / email ─────────────────────────────────────────────────
document.getElementById('formInfo').addEventListener('submit', async e => {
  e.preventDefault();
  const name        = document.getElementById('inputName').value.trim();
  const email       = document.getElementById('inputEmail').value.trim().toLowerCase();
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
    currentUser.name        = name;
    currentUser.email       = email;
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
  if (newPw.length < 8)  return showMsg('pwMsg', 'Le nouveau mot de passe doit faire au moins 8 caractères.');
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

// ── Focus trap helper ─────────────────────────────────────────────────────────
function trapFocus(container) {
  const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
  function handler(e) {
    const els = [...container.querySelectorAll(FOCUSABLE)];
    if (!els.length) return;
    const first = els[0], last = els[els.length - 1];
    if (e.key === 'Tab') {
      if (e.shiftKey) { if (document.activeElement === first) { e.preventDefault(); last.focus(); } }
      else            { if (document.activeElement === last)  { e.preventDefault(); first.focus(); } }
    }
  }
  container.addEventListener('keydown', handler);
  return () => container.removeEventListener('keydown', handler);
}

// ── Delete account ────────────────────────────────────────────────────────────
const deleteModal  = document.getElementById('deleteModal');
let _deleteTrigger = null;
let _deleteTrapRelease = null;

function openDeleteModal() {
  deleteModal.classList.remove('hidden');
  _deleteTrapRelease = trapFocus(deleteModal);
  document.getElementById('btnCancelDelete').focus();
}
function closeDeleteModal() {
  deleteModal.classList.add('hidden');
  if (_deleteTrapRelease) { _deleteTrapRelease(); _deleteTrapRelease = null; }
  if (_deleteTrigger) { _deleteTrigger.focus(); _deleteTrigger = null; }
}

document.getElementById('btnDelete').addEventListener('click', e => {
  if (currentUser.role === 'admin') {
    alert('Le compte administrateur ne peut pas être supprimé.');
    return;
  }
  _deleteTrigger = e.currentTarget;
  openDeleteModal();
});
document.getElementById('btnCancelDelete').addEventListener('click', closeDeleteModal);
deleteModal.addEventListener('keydown', e => { if (e.key === 'Escape') closeDeleteModal(); });

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
    window.location.href = 'login';
  } catch (err) {
    alert('Erreur : ' + err.message);
    btn.textContent = 'Oui, supprimer';
    btn.disabled = false;
  }
});
