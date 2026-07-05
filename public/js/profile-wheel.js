// profile-wheel.js — the daily "roue de la chance" canvas roulette and its prize
// table for the profile page.
// Split out of profile.js. Classic (deferred) script loaded before js/profile.js
// (the entry file whose boot IIFE runs last). Only function declarations + const
// data here — nothing executes at load — so ordering among the profile modules is
// irrelevant; they are all defined by the time the boot IIFE calls them.

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
