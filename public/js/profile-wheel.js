// profile-wheel.js — the daily "roue de la chance" canvas roulette and its prize
// table for the profile page.
// Split out of profile.js. Classic (deferred) script loaded before js/profile.js
// (the entry file whose boot IIFE runs last). Only function declarations + const
// data here — nothing executes at load — so ordering among the profile modules is
// irrelevant; they are all defined by the time the boot IIFE calls them.

const TRAIL_TIPS = [
  'Essayez le Carrefour du Puits du Roi aujourd\'hui !',
  'Observez la faune au lever du jour.',
  'Sortie automnale parfaite pour les couleurs.',
  '10 km en boucle, ça vous tente ?',
  'Découvrez les vieux chênes des Beaux Monts.',
  'Profitez de la lumière dorée du matin.',
  'Tentez un nouveau sentier inconnu.',
  'Ouvrez l\'œil pour les champignons.',
  'Restez silencieux, vous verrez peut-être un renard.',
  'Mont Saint-Pierre — panorama garanti !',
  'Sortie courte mais intense : 5 km en 1h.',
  'Sortie crépusculaire pour écouter la chouette.',
  'Prenez le sentier des Grands Monts pour croiser des sangliers.',
  'Après la pluie, les rus de la forêt reprennent vie.',
  'Saison idéale pour les photos en sous-bois.',
];

// Badges de collection remportés à la roue. Stockés comme un tableau d'ids dans
// localStorage ('bwr_collectible_badges'). Partagé avec profile-plan.js (chargé
// après celui-ci) qui les rend dans la grille de badges du profil.
const COLLECTIBLE_BADGES = [
  { id: 'cb_chene',      icon: 'tree-round', label: 'Vieux Chêne' },
  { id: 'cb_cerf',       icon: 'deer', label: 'Cerf Majestueux' },
  { id: 'cb_renard',     icon: 'fox', label: 'Renard Rusé' },
  { id: 'cb_chouette',   icon: 'owl', label: 'Chouette Nocturne' },
  { id: 'cb_champignon', icon: 'mushroom', label: 'Cueilleur de Champignons' },
  { id: 'cb_sanglier',   icon: 'paw', label: 'Sanglier des Grands Monts' },
];

function ownedCollectibles() {
  try { return JSON.parse(localStorage.getItem('bwr_collectible_badges') || '[]'); }
  catch { return []; }
}

// ── Canvas roulette wheel ──────────────────────────────────────────────────────
const WHEEL_SIZE = 260; // logical px (CSS pixels)
// Restrained, brand-aligned two-tone palette (deep forest ↔ warm parchment)
// instead of a rainbow — reads far more premium. The array alternates a dark
// and a light tone so adjacent segments always contrast; each segment picks its
// own label colour from `light` so text stays legible either way.
const WHEEL_SEGMENT_STYLES = [
  { fill: '#14532d', light: false }, // deep forest
  { fill: '#f4efe2', light: true  }, // warm parchment
  { fill: '#1f6b45', light: false }, // pine
  { fill: '#e8e0cd', light: true  }, // sand
];
const WHEEL_RIM   = '#0f3d21'; // dark green rim / hub
const WHEEL_GOLD  = '#c8a04a'; // slim accent line

let _wheelRotation = 0;   // current cumulative rotation (radians)
let _wheelSegments = null; // built once per plan on render

function _buildWheelSegments(plan) {
  const prizes = WHEEL_PRIZES[BWR.normalisePlan(plan)] || WHEEL_PRIZES.free;
  const total  = prizes.reduce((s, p) => s + p.weight, 0);
  const segs   = [];
  let angle = 0;
  prizes.forEach((p, i) => {
    const sweep = (p.weight / total) * Math.PI * 2;
    const style = WHEEL_SEGMENT_STYLES[i % WHEEL_SEGMENT_STYLES.length];
    segs.push({ prize: p, startAngle: angle, sweep, color: style.fill, light: style.light });
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

// Line icons drawn on the canvas: the icon SVG (js/icons.js) loaded as an
// image, cached per icon + colour. The wheel redraws once an image arrives.
const _wheelIconCache = {};
function _wheelIconImg(v, color) {
  const name = window.bwrIconName && bwrIconName(v);
  if (!name) return null;
  const key = name + color;
  let img = _wheelIconCache[key];
  if (!img) {
    img = new Image();
    img.onload = () => _drawWheelCanvas(_wheelRotation);
    // width/height give the SVG an intrinsic size (else naturalWidth is 0)
    img.src = 'data:image/svg+xml,' + encodeURIComponent(
      bwrIcon(name).replace('<svg ', '<svg width="48" height="48" ').replace(/currentColor/g, color));
    _wheelIconCache[key] = img;
  }
  return img.complete && img.naturalWidth ? img : null;
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
  const r  = cx - 10;

  // ── Outer bezel: solid dark rim with a slim gold accent line ──
  ctx.beginPath();
  ctx.arc(cx, cy, r + 8, 0, Math.PI * 2);
  ctx.fillStyle = WHEEL_RIM;
  ctx.fill();
  ctx.beginPath();
  ctx.arc(cx, cy, r + 4, 0, Math.PI * 2);
  ctx.strokeStyle = WHEEL_GOLD;
  ctx.lineWidth   = 1.5;
  ctx.stroke();

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

    // Subtle depth: gentle darkening toward the rim, no glare
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, r, startA, endA);
    ctx.closePath();
    ctx.clip();
    const grad = ctx.createRadialGradient(cx, cy, r * 0.3, cx, cy, r);
    grad.addColorStop(0, 'rgba(255,255,255,0.05)');
    grad.addColorStop(1, 'rgba(0,0,0,0.12)');
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.restore();

    // ── Icon + label (colour adapts to the segment tone) ──
    const ink = seg.light ? WHEEL_RIM : '#f6f1e5';
    ctx.save();
    ctx.translate(cx + Math.cos(midA) * r * 0.66, cy + Math.sin(midA) * r * 0.66);
    ctx.rotate(midA + Math.PI / 2);
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    const isz = seg.sweep > 0.9 ? 18 : 14;
    const img = _wheelIconImg(seg.prize.icon, ink);
    if (img) ctx.drawImage(img, -isz / 2, -isz / 2 - 2, isz, isz);

    if (seg.sweep > 0.6) {
      ctx.font      = `600 ${seg.sweep > 1.1 ? 9 : 7.5}px system-ui, sans-serif`;
      ctx.fillStyle = ink;
      const line = seg.prize.label.length > 13 ? seg.prize.label.slice(0, 12) + '…' : seg.prize.label;
      ctx.fillText(line, 0, 14);
    }
    ctx.restore();
  });

  // ── Pass 2 : hairline dividers between segments ──
  ctx.strokeStyle = 'rgba(15,61,33,0.28)';
  ctx.lineWidth   = 1;
  _wheelSegments.forEach(seg => {
    const angle = seg.startAngle + rotation - Math.PI / 2;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(angle) * r, cy + Math.sin(angle) * r);
    ctx.stroke();
  });

  // Inner rim line
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(15,61,33,0.35)';
  ctx.lineWidth   = 1;
  ctx.stroke();

  // ── Center hub ──
  ctx.beginPath();
  ctx.arc(cx, cy, 24, 0, Math.PI * 2);
  ctx.fillStyle = WHEEL_RIM;
  ctx.fill();
  ctx.strokeStyle = WHEEL_GOLD;
  ctx.lineWidth   = 1.5;
  ctx.stroke();

  ctx.font = '14px serif';
  ctx.textAlign    = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#f6f1e5';
  ctx.fillText('★', cx, cy);
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
//
// The wheel is itself a Pro perk and Pro is the only paid plan, so there is no
// longer a tier above the wheel's own gate to win: plan upgrades were retired
// with the Or tier and the wheel now hands out badges, collectibles and trail
// tips. The `free` list is a defensive fallback - a free account never reaches
// the wheel (FEATURES.daily_wheel is false for it).
//
// Total weight pool = 840 (LCM of 120 and 70) so that:
//   1 in 120 -> weight 7 ; 1 in 70 -> weight 12
const WHEEL_PRIZES = {
  free: [
    { id: 'bonus_route',  icon: 'ticket', label: '+1 trajet bonus',      desc: 'Un trajet supplémentaire cette semaine',    type: 'bonus_route',                           weight: 228 },
    { id: 'lucky_badge',  icon: 'clover', label: 'Badge Chanceux',       desc: 'Badge exclusif de la roue de la chance',   type: 'badge',                                weight: 189 },
    { id: 'collectible',  icon: 'medal', label: 'Badge Nature',        desc: 'Un badge de collection de la forêt',       type: 'collectible',                          weight: 195 },
    { id: 'trail_tip',    icon: 'tree', label: 'Conseil sentier',       desc: 'Une suggestion pour votre prochaine sortie',  type: 'tip',                                  weight: 228 },
  ],
  pro: [
    { id: 'exclusive_badge', icon: 'sparkles', label: 'Badge exclusif',      desc: 'Badge animé réservé aux membres Pro',     type: 'badge',                                weight: 12  },
    { id: 'lucky_badge',  icon: 'clover', label: 'Badge Chanceux',        desc: 'Badge exclusif de la roue de la chance',  type: 'badge',                                weight: 144 },
    { id: 'collectible',  icon: 'medal', label: 'Badge Nature',         desc: 'Un badge de collection de la forêt',      type: 'collectible',                          weight: 182 },
    { id: 'collectible2', icon: 'medal', label: 'Badge Forêt',          desc: 'Un badge de collection de la forêt',      type: 'collectible',                          weight: 228 },
    { id: 'trail_tip',    icon: 'tree', label: 'Conseil sentier',        desc: 'Une suggestion pour votre prochaine sortie', type: 'tip',                                  weight: 274 },
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
      _renderWheelText(wheelText, JSON.parse(saved));
    } catch {
      wheelText.textContent = saved || 'Vous avez déjà tourné la roue aujourd\'hui — revenez demain !';
    }
    wheelBtn.disabled = true;
    wheelBtn.textContent = '✓ Effectué';
  } else {
    _wheelRotation = 0;
    _drawWheelCanvas(0);
    wheelBtn.disabled = false;
    wheelBtn.onclick = () => spinWheel(plan);
  }
}

async function spinWheel(plan) {
  const today      = new Date().toISOString().slice(0, 10);
  // Copy: the prize is mutated below (collectible label, tip text) and must not
  // leak back into the shared WHEEL_PRIZES table.
  const prize      = { ...pickPrize(plan) };
  const wheelBtn   = document.getElementById('wheelSpinBtn');
  const wheelText  = document.getElementById('wheelText');
  const prizes     = WHEEL_PRIZES[BWR.normalisePlan(plan)] || WHEEL_PRIZES.free;
  const prizeIndex = prizes.findIndex(p => p.id === prize.id);

  wheelBtn.disabled    = true;
  wheelBtn.textContent = 'Tirage en cours…';
  wheelText.textContent = '';

  // Ask for the AI tip while the wheel is still turning, so the reveal is instant.
  const tipPromise = prize.type === 'tip' ? _fetchTrailTip() : null;

  // ── 1. Spin the wheel visually ───────────────────────────────────────────────
  await new Promise(resolve => _animateWheelSpin(prizeIndex, resolve));

  // Save the final rotation so we can restore it on page reload
  localStorage.setItem('bwr_wheel_rot', String(_wheelRotation));

  // ── 2. Apply prize effects ────────────────────────────────────────────
  // NB: there is no `type: 'plan'` prize any more - Pro is the top tier, so the
  // wheel can't upgrade the very members who are allowed to spin it.
  if (prize.type === 'bonus_route') {
    const w = BWR.readWeekly();
    w.count = Math.max(0, w.count - 1);
    localStorage.setItem('bwr_routes_week', JSON.stringify(w));
  } else if (prize.type === 'collectible') {
    // Ajoute un badge de collection encore non possédé. Collection complète → repli sur un conseil.
    const owned     = ownedCollectibles();
    const remaining = COLLECTIBLE_BADGES.filter(b => !owned.includes(b.id));
    if (remaining.length) {
      const won = remaining[Math.floor(Math.random() * remaining.length)];
      owned.push(won.id);
      localStorage.setItem('bwr_collectible_badges', JSON.stringify(owned));
      prize.icon  = won.icon;
      prize.label = `Badge ${won.label}`;
      prize.desc  = 'Ajouté à votre collection de badges de la forêt !';
    } else {
      prize.icon  = 'tree';
      prize.label = 'Conseil sentier';
      prize.type  = 'tip';
      prize.desc  = _randomTip();
    }
  } else if (prize.type === 'badge') {
    if (prize.id === 'exclusive_badge') {
      localStorage.setItem('bwr_exclusive_badge', '1');
    } else {
      localStorage.setItem('bwr_lucky_badge', '1');
    }
  } else if (prize.type === 'tip') {
    prize.desc = await tipPromise;
  }
  if (prize.type === 'tip') {
    const [voice, intro] = TIP_INTROS[Math.floor(Math.random() * TIP_INTROS.length)];
    prize.voice = voice;
    prize.intro = intro;
  }

  // ── 3. Show result ────────────────────────────────────────────────────────────
  _renderWheelText(wheelText, prize);
  localStorage.setItem('bwr_wheel_last', today);
  localStorage.setItem('bwr_wheel_result', JSON.stringify({
    icon: prize.icon, label: prize.label, desc: prize.desc, intro: prize.intro, voice: prize.voice,
  }));
  wheelBtn.textContent = '✓ Effectué';
  _showWinReveal(prize);
}

// ── Win reveal ────────────────────────────────────────────────────────────────
// A "conseil" is delivered by a character of the forest, not a dry label.
// [icon of who speaks, how they say it]
const TIP_INTROS = [
  ['owl', 'La vieille chouette du carrefour ouvre un œil et vous glisse un secret…'],
  ['tree-round', 'Un chêne de 300 ans se penche vers vous et murmure…'],
  ['fox', 'Un renard a laissé ce petit mot sous une feuille morte…'],
  ['mushroom', 'Les champignons ont tenu conseil toute la nuit. Leur verdict :'],
  ['deer', 'Le grand cerf s\'arrête au milieu de l\'allée et vous confie…'],
  ['squirrel', 'Un écureuil pressé vous lance ce conseil entre deux noisettes…'],
  ['compass', 'Votre boussole s\'affole… puis pointe vers cette sagesse :'],
  ['wind', 'Le vent se lève dans les hêtres et chuchote à votre oreille…'],
  ['paw', 'Un sanglier bougon grommelle, mais il a raison :'],
  ['moon', 'Les étoiles au-dessus de Compiègne s\'alignent pour vous dire…'],
];

const WIN_TITLES = ['Gagné !', 'Bravo !', 'Jackpot forestier !', 'La roue a parlé !'];

function _randomTip() {
  return TRAIL_TIPS[Math.floor(Math.random() * TRAIL_TIPS.length)];
}

async function _fetchTrailTip() {
  try {
    const res = await fetch(`${API_URL}/api/ai-tip`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeader() },
    });
    if (res.ok) { const d = await res.json(); if (d.tip) return d.tip; }
  } catch { /* fall through to a local tip */ }
  return _randomTip();
}

// Line-icon element for an icon name (or a legacy emoji from an older saved
// result) — see js/icons.js.
function _ic(v) {
  const n = document.createElement('i');
  n.className = 'ic';
  const name = window.bwrIconName && bwrIconName(v);
  if (name) n.dataset.ic = name;
  return n;
}

function _el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

// Small result line under the wheel. Built with textContent: the tip comes
// from the AI endpoint and must never be parsed as HTML.
function _renderWheelText(el, prize) {
  el.textContent = '';
  if (prize.intro) {
    const intro = _el('span', 'wheel-tip-intro', ` ${prize.intro}`);
    intro.prepend(_ic(prize.voice || 'tree'));
    el.append(intro);
    el.append(_el('span', 'wheel-tip-quote', `« ${prize.desc} »`));
    return;
  }
  el.append(_ic(prize.icon), ' ', _el('strong', null, prize.label), ` — ${prize.desc}`);
}

function _showWinReveal(prize) {
  document.querySelector('.win-reveal')?.remove();
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const isTip = !!prize.intro;

  const overlay = _el('div', 'win-reveal' + (isTip ? ' win-reveal--tip' : ''));
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');

  // Burst of leaves / sparkles flying out from the centre
  if (!reduced) {
    const bits = isTip ? ['leaf', 'leaf', 'sprout', 'sparkles'] : ['leaf', 'sparkles', 'leaf', 'star', 'sparkles', 'sprout'];
    for (let i = 0; i < 28; i++) {
      const p = _el('span', 'win-particle');
      p.append(_ic(bits[i % bits.length]));
      const angle = (i / 28) * Math.PI * 2 + Math.random() * 0.4;
      const dist  = 140 + Math.random() * 180;
      p.style.setProperty('--dx', `${Math.cos(angle) * dist}px`);
      p.style.setProperty('--dy', `${Math.sin(angle) * dist}px`);
      p.style.setProperty('--rot', `${Math.random() * 720 - 360}deg`);
      p.style.animationDelay = `${Math.random() * 0.15}s`;
      overlay.append(p);
    }
  }

  const card = _el('div', 'win-card');
  card.append(_el('div', 'win-rays'));
  const winIcon = _el('div', 'win-icon');
  winIcon.append(_ic(isTip ? (prize.voice || 'tree') : prize.icon));
  card.append(winIcon);

  let typeTarget = null;
  if (isTip) {
    card.append(_el('p', 'win-kicker', 'Conseil du jour'));
    card.append(_el('p', 'win-intro', prize.intro));
    const scroll = _el('blockquote', 'win-scroll');
    typeTarget = _el('span', 'win-scroll-text', reduced ? prize.desc : '');
    scroll.append(typeTarget);
    scroll.append(_el('footer', 'win-sign', '— La forêt de Compiègne'));
    card.append(scroll);
  } else {
    card.append(_el('p', 'win-kicker', WIN_TITLES[Math.floor(Math.random() * WIN_TITLES.length)]));
    card.append(_el('h3', 'win-title', prize.label));
    card.append(_el('p', 'win-desc', prize.desc));
  }

  const btn = _el('button', 'btn-save win-close', isTip ? 'Merci la forêt !' : 'Génial !');
  btn.type = 'button';
  card.append(btn);
  overlay.append(card);
  document.body.append(overlay);

  let typer = null;
  const close = () => {
    clearInterval(typer);
    document.removeEventListener('keydown', onKey);
    overlay.classList.add('win-reveal--out');
    setTimeout(() => overlay.remove(), reduced ? 0 : 250);
  };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  btn.addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', onKey);
  btn.focus({ preventScroll: true });

  // Typewriter: the tip "writes itself" on the parchment once the card lands
  if (typeTarget && !reduced) {
    const chars = [...prize.desc];
    let i = 0;
    setTimeout(() => {
      typer = setInterval(() => {
        typeTarget.textContent += chars[i++] || '';
        if (i >= chars.length) { clearInterval(typer); typeTarget.classList.add('is-done'); }
      }, 22);
    }, 650);
  }
}

function renderPrizeList(plan) {
  const el = document.getElementById('wheelPrizesList');
  if (!el) return;
  const prizes = WHEEL_PRIZES[BWR.normalisePlan(plan)] || WHEEL_PRIZES.free;
  const rare = prizes.filter(p => p.weight <= 8);
  const common = prizes.filter(p => p.weight > 8);
  el.innerHTML = `
    <p class="prizes-title">Ce que vous pouvez gagner :</p>
    <div class="prizes-grid">
      ${[...rare, ...common].map(p => `
        <div class="prize-chip ${p.weight <= 2 ? 'prize-epic' : p.weight <= 8 ? 'prize-rare' : ''}">
          <span class="prize-icon">${bwrIconFor(p.icon)}</span>
          <span class="prize-label">${p.label}</span>
          ${p.weight <= 2 ? '<span class="prize-rarity">Épique</span>' : p.weight <= 8 ? '<span class="prize-rarity">Rare</span>' : ''}
        </div>
      `).join('')}
    </div>
  `;
}
