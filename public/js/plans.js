/* ── Billing toggle ─────────────────────────────────────────────────── */
const billingToggles = document.querySelectorAll('.bt-opt');
let currentPeriod = 'monthly';

billingToggles.forEach(btn => {
  btn.addEventListener('click', () => {
    billingToggles.forEach(b => { b.classList.remove('active'); b.setAttribute('aria-selected', 'false'); });
    btn.classList.add('active');
    btn.setAttribute('aria-selected', 'true');
    currentPeriod = btn.dataset.period;

    document.querySelectorAll('.pc-amount, .pc-period').forEach(el => {
      const val = el.dataset[currentPeriod];
      if (val) el.textContent = val;
    });

    // Annual-only note: total billed per year + savings vs full price
    document.querySelectorAll('.pc-annual-note').forEach(el => {
      el.textContent = currentPeriod === 'annual' ? (el.dataset.annual || '') : '';
    });
  });
});

/* ── Focus trap helper ───────────────────────────────────────────────── */
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

/* ── Activation modal ───────────────────────────────────────────────── */
const activationModal = document.getElementById('activationModal');
const activationIcon  = document.getElementById('activationIcon');
const activationTitle = document.getElementById('activationTitle');
const afPlan          = document.getElementById('afPlan');
const afPeriod        = document.getElementById('afPeriod');
const afStatus        = document.getElementById('afStatus');
let _activationTrigger = null;
let _activationTrapRelease = null;

function openActivation(plan, triggerEl) {
  if (plan === 'gold') return;
  if (plan === 'visitor') {
    const u = (typeof getCachedUser === 'function') ? getCachedUser() : null;
    if (u && (u.visitorPlanCount || 0) >= 2) return;
  }
  const META = {
    visitor: { icon: '🎫', title: 'Passe Visiteur 7 jours' },
    silver:  { icon: '🥈', title: 'Activation du plan Argent' },
  };
  const m = META[plan] || META.silver;
  activationIcon.textContent  = m.icon;
  activationTitle.textContent = m.title;
  afPlan.value = plan;
  // Visitor is a one-time 7-day pass — hide the monthly/annual period selector.
  const periodRow = document.getElementById('afPeriodRow');
  if (periodRow) periodRow.style.display = plan === 'visitor' ? 'none' : '';
  afPeriod.value = currentPeriod;
  activationModal.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  _activationTrigger = triggerEl || null;
  _activationTrapRelease = trapFocus(activationModal);
  setTimeout(() => document.getElementById('afName').focus(), 80);
}
function closeActivation() {
  activationModal.classList.add('hidden');
  document.body.style.overflow = '';
  afStatus.textContent = '';
  if (_activationTrapRelease) { _activationTrapRelease(); _activationTrapRelease = null; }
  if (_activationTrigger) { _activationTrigger.focus(); _activationTrigger = null; }
}
document.querySelectorAll('[data-plan]').forEach(el => {
  el.addEventListener('click', e => openActivation(el.dataset.plan, e.currentTarget));
});
document.getElementById('activationClose').addEventListener('click', closeActivation);
activationModal.addEventListener('click', e => { if (e.target === activationModal) closeActivation(); });
activationModal.addEventListener('keydown', e => { if (e.key === 'Escape') closeActivation(); });

/* ── Activation form submit ─────────────────────────────────────────── */
document.getElementById('activationForm').addEventListener('submit', async e => {
  e.preventDefault();
  const name    = document.getElementById('afName').value.trim();
  const email   = document.getElementById('afEmail').value.trim();
  const plan    = afPlan.value;
  const period  = afPeriod.value;
  const message = document.getElementById('afMessage').value.trim();
  const btn     = document.getElementById('afSubmit');

  if (!name || !email) {
    afStatus.textContent = 'Nom et email sont obligatoires.';
    afStatus.style.color = 'var(--danger)';
    return;
  }

  btn.textContent = 'Envoi…';
  btn.disabled = true;

  const planLabel   = plan === 'visitor' ? 'Visiteur (1,10€ / 7 jours)' : plan === 'gold' ? 'Or (6,99€/mois)' : 'Argent (2,99€/mois)';
  const periodLabel = plan === 'visitor' ? 'paiement unique' : period === 'annual' ? 'annuel (-25 %)' : 'mensuel';
  const formatted = `=== Demande d'activation BWR ===
Plan : ${planLabel}
Période : ${periodLabel}

Nom : ${name}
Email : ${email}

Message : ${message || '(aucun)'}
`;

  try {
    const res = await fetch(`${API_URL}/api/contact`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, email, message: formatted, subject: `[ACTIVATION ${plan === 'visitor' ? 'VISITEUR 7J' : plan.toUpperCase()}]` }),
    });
    if (!res.ok) throw new Error();
    document.getElementById('activationForm').reset();
    afStatus.innerHTML = '<strong>✓ Demande envoyée !</strong> Vous recevrez les instructions par email sous 24h.';
    afStatus.style.color = 'var(--forest-700)';
    setTimeout(closeActivation, 3500);
  } catch {
    afStatus.textContent = `Erreur d'envoi. Écrivez-moi directement à ${CONTACT_EMAIL}`;
    afStatus.style.color = 'var(--danger)';
  } finally {
    btn.textContent = 'Envoyer la demande';
    btn.disabled = false;
  }
});

/* ── Visitor plan limit gate ─────────────────────────────────────────── */
// Once the user data is available, disable the visitor CTA if they've used
// the pass twice (max lifetime limit).
(function applyVisitorLimit() {
  const btn = document.querySelector('.cta-visitor');
  if (!btn) return;

  function check() {
    const u = (typeof getCachedUser === 'function') ? getCachedUser() : null;
    if (!u) return;
    if ((u.visitorPlanCount || 0) >= 2) {
      btn.disabled = true;
      btn.textContent = 'Limite atteinte (2/2)';
      btn.style.opacity = '0.5';
      btn.style.cursor  = 'not-allowed';
      const footnote = btn.nextElementSibling;
      if (footnote) footnote.textContent = 'Vous avez déjà utilisé ce passe 2 fois. Passez à Argent pour continuer.';
    }
  }

  // getCachedUser may not be populated yet — retry briefly after page load.
  check();
  window.addEventListener('bwr:auth-ready', check);
  setTimeout(check, 1500);
})();

/* ── Free 7-day Silver trial CTA ─────────────────────────────────────── */
// Self-service trial on the Silver card. Logged-out visitors are sent to login;
// logged-in free users (who haven't used it) activate it instantly. Anyone who
// already used the trial, or is already Silver/Gold, doesn't see the button.
(function applySilverTrial() {
  const btn = document.getElementById('silverTrialCta');
  if (!btn) return;

  function loggedIn() { return typeof getToken === 'function' && !!getToken(); }

  function refresh() {
    if (!loggedIn()) { btn.style.display = ''; return; } // invite visitors to sign up
    const u = (typeof getCachedUser === 'function') ? getCachedUser() : null;
    if (!u) return; // wait for auth-ready
    const eligible = (u.plan || 'free') === 'free' && !u.silverTrialUsed;
    btn.style.display = eligible ? '' : 'none';
  }

  btn.addEventListener('click', async () => {
    if (!loggedIn()) { location.href = 'login'; return; }
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
      if (cached) setSession(getToken(), { ...cached, plan: 'silver', planExpiresAt: data.planExpiresAt, silverTrialUsed: true });
      alert('🎉 Essai Argent activé ! Vous profitez de toutes les fonctionnalités pendant 7 jours.');
      location.href = 'profile';
    } catch (err) {
      btn.disabled = false;
      btn.textContent = original;
      alert('Impossible d\'activer l\'essai : ' + err.message);
    }
  });

  refresh();
  window.addEventListener('bwr:auth-ready', refresh);
  setTimeout(refresh, 1500);
})();

/* ── Sticky nav shadow on scroll ─────────────────────────────────────── */
const plansNav = document.getElementById('plansNav');
if (plansNav) {
  window.addEventListener('scroll', () => {
    plansNav.classList.toggle('scrolled', window.scrollY > 12);
  });
}

/* ── Fade-up on scroll ───────────────────────────────────────────────── */
const io = new IntersectionObserver(entries => {
  entries.forEach(e => { if (e.isIntersecting) e.target.classList.add('visible'); });
}, { threshold: 0.12 });
document.querySelectorAll('.plan-card, .testimonial, .faq-item, .trust-item, .compare-table-wrap').forEach(el => {
  el.classList.add('fade-up');
  io.observe(el);
});

/* ── Smooth scroll for anchor links ──────────────────────────────────── */
document.querySelectorAll('a[href^="#"]').forEach(a => {
  a.addEventListener('click', ev => {
    const tgt = document.querySelector(a.getAttribute('href'));
    if (tgt) { ev.preventDefault(); tgt.scrollIntoView({ behavior: 'smooth' }); }
  });
});

/* ── AI Revenue Forecast ─────────────────────────────────────────────────── */
(function () {
  const section = document.getElementById('aiRevenueForecast');
  if (!section) return;

  // Admin-only: internal business dashboard, never shown to visitors.
  const _u = (typeof getCachedUser === 'function') ? getCachedUser() : null;
  if (!_u || _u.role !== 'admin') { section.remove(); return; }
  section.hidden = false;

  let chartInstance = null;
  let initialized = false;
  let realData = null; // filled from the server: real subscribers, MRR and visitor history

  initForecast();

  function initForecast() {
    if (initialized) return;
    initialized = true;

    const sliderVisitors = document.getElementById('arfVisitors');
    const sliderQuality  = document.getElementById('arfQuality');
    const sliderTarget   = document.getElementById('arfTarget');
    const histInputs     = [0, 1, 2, 3].map(i => document.getElementById('hist' + i));

    /* Month labels */
    const now = new Date();
    const monthNames = ['Jan','Fév','Mar','Avr','Mai','Jun','Jul','Aoû','Sep','Oct','Nov','Déc'];
    [0, 1, 2, 3].forEach(i => {
      const d = new Date(now.getFullYear(), now.getMonth() - (4 - i), 1);
      const label = document.getElementById('histLabel' + i);
      if (label) label.textContent = monthNames[d.getMonth()] + ' ' + String(d.getFullYear()).slice(2);
    });

    /* Quality → conversion % lookup (index 0–10) */
    const QUALITY_CONV   = [0, 0.12, 0.25, 0.45, 0.72, 1.10, 1.62, 2.25, 2.95, 3.60, 4.25];
    const QUALITY_LABELS = ['', 'Très basique', 'Basique', 'Moyen-', 'Moyen', 'Acceptable', 'Bon', 'Très bon', 'Excellent', 'Exceptionnel', 'Parfait'];

    /* ARPU: 65 % Silver (2.99 €) + 35 % Gold (6.99 €) */
    const ARPU = 0.65 * 2.99 + 0.35 * 6.99;

    function lerp(a, b, t) { return a + (b - a) * t; }

    function convRate(quality) {
      const lo = Math.floor(quality), hi = Math.ceil(quality);
      return lerp(QUALITY_CONV[lo] || 0, QUALITY_CONV[hi] || 0, quality - lo);
    }

    function trendSlope(points) {
      const valid = points.filter(v => v !== null && !isNaN(v));
      if (valid.length < 2) return 0;
      const n = valid.length;
      const xMean = (n - 1) / 2;
      const yMean = valid.reduce((a, b) => a + b, 0) / n;
      let num = 0, den = 0;
      valid.forEach((y, x) => {
        num += (x - xMean) * (y - yMean);
        den += (x - xMean) ** 2;
      });
      return den === 0 ? 0 : num / den;
    }

    function probHit(mrr, target) {
      if (target <= 0) return 100;
      const ratio = mrr / target;
      return Math.max(1, Math.min(99, Math.round(100 / (1 + Math.exp(-7 * (ratio - 0.85))))));
    }

    function fmtEur(val) {
      return new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 }).format(Math.round(val)) + ' €';
    }
    function fmtNum(val) {
      return new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 1 }).format(val);
    }

    function forecastLabels() {
      const labels = [];
      for (let i = 0; i < 6; i++) {
        const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
        labels.push(monthNames[d.getMonth()] + ' ' + String(d.getFullYear()).slice(2));
      }
      return labels;
    }

    function buildChart(labels, data) {
      const ctx = document.getElementById('arfChart');
      if (!ctx || typeof Chart === 'undefined') return;
      if (chartInstance) { chartInstance.destroy(); chartInstance = null; }

      const upper = data.map((v, i) => v * (1 + 0.12 + i * 0.03));
      const lower = data.map((v, i) => Math.max(0, v * (1 - 0.12 - i * 0.03)));

      chartInstance = new Chart(ctx, {
        type: 'line',
        data: {
          labels,
          datasets: [
            {
              label: 'Borne haute',
              data: upper,
              borderColor: 'transparent',
              backgroundColor: 'rgba(163,230,53,0.10)',
              fill: '+1',
              pointRadius: 0,
              tension: 0.4,
            },
            {
              label: 'MRR estimé',
              data,
              borderColor: '#a3e635',
              backgroundColor: 'rgba(163,230,53,0.15)',
              borderWidth: 2.5,
              pointRadius: 4,
              pointBackgroundColor: '#a3e635',
              fill: false,
              tension: 0.4,
            },
            {
              label: 'Borne basse',
              data: lower,
              borderColor: 'transparent',
              backgroundColor: 'rgba(163,230,53,0.10)',
              fill: '-1',
              pointRadius: 0,
              tension: 0.4,
            },
          ]
        },
        options: {
          responsive: true,
          maintainAspectRatio: true,
          interaction: { mode: 'index', intersect: false },
          plugins: {
            legend: { display: false },
            tooltip: {
              backgroundColor: '#0e2a10',
              borderColor: 'rgba(163,230,53,0.3)',
              borderWidth: 1,
              titleColor: '#a3e635',
              bodyColor: '#bbf7d0',
              callbacks: {
                label: ctx => {
                  if (ctx.dataset.label === 'MRR estimé') return ' MRR : ' + fmtEur(ctx.raw);
                  if (ctx.dataset.label === 'Borne haute') return ' Max : ' + fmtEur(ctx.raw);
                  if (ctx.dataset.label === 'Borne basse') return ' Min : ' + fmtEur(ctx.raw);
                  return '';
                }
              }
            }
          },
          scales: {
            x: {
              grid: { color: 'rgba(255,255,255,0.05)' },
              ticks: { color: 'rgba(255,255,255,0.4)', font: { size: 11 } }
            },
            y: {
              grid: { color: 'rgba(255,255,255,0.05)' },
              ticks: {
                color: 'rgba(255,255,255,0.4)',
                font: { size: 11 },
                callback: v => fmtEur(v)
              },
              beginAtZero: true
            }
          }
        }
      });
    }

    function generateInsight(visitors, quality, mrr, slope, prob, target) {
      const rate = convRate(quality);
      const qualLabel = QUALITY_LABELS[Math.round(quality)] || 'Bon';
      const parts = [];

      if (quality < 5) {
        parts.push('La qualité actuelle du site (' + qualLabel + ') limite le taux de conversion à ' + fmtNum(rate) + ' %. Améliorer l\'UX et la vitesse de chargement pourrait doubler ce taux.');
      } else if (quality >= 8) {
        parts.push('Excellente qualité produit (' + qualLabel + ') — le taux de conversion de ' + fmtNum(rate) + ' % est dans les meilleurs 10 % du secteur.');
      } else {
        parts.push('Qualité ' + qualLabel + ' avec un taux de conversion de ' + fmtNum(rate) + ' %. Des optimisations ciblées (onboarding, SEO) pourraient le porter à ' + fmtNum(rate * 1.4) + ' %.');
      }

      if (visitors < 500) {
        parts.push('Le trafic (' + fmtNum(visitors) + ' vis./mois) est encore faible — prioriser l\'acquisition (SEO, réseaux sociaux) avant d\'optimiser la conversion.');
      } else if (visitors > 10000) {
        parts.push('Le volume de trafic (' + fmtNum(visitors) + ' vis./mois) est solide — le levier principal est maintenant l\'optimisation du taux de conversion.');
      }

      if (slope > visitors * 0.05) {
        parts.push('La tendance historique est fortement croissante (+' + fmtNum(Math.round(slope)) + ' vis./mois) — la trajectoire est favorable.');
      } else if (slope < -visitors * 0.05) {
        parts.push('Attention : la tendance décroissante (' + fmtNum(Math.round(slope)) + ' vis./mois) nécessite d\'analyser les sources de trafic perdues.');
      }

      if (prob >= 80) {
        parts.push('Probabilité élevée (' + prob + ' %) d\'atteindre l\'objectif de ' + fmtEur(target) + '.');
      } else if (prob < 30) {
        parts.push('L\'objectif de ' + fmtEur(target) + ' semble ambitieux à ce stade — un objectif intermédiaire de ' + fmtEur(mrr * 2) + ' serait plus atteignable.');
      }

      return parts.join(' ');
    }

    function update() {
      const visitors = parseInt(sliderVisitors.value, 10);
      const quality  = parseFloat(sliderQuality.value);
      const target   = parseInt(sliderTarget.value, 10);

      const histRaw = histInputs.map(el => {
        const v = parseInt(el.value, 10);
        return isNaN(v) || v < 0 ? null : v;
      });
      const histValid = histRaw.filter(v => v !== null);
      const slope = histValid.length >= 2 ? trendSlope(histValid) : 0;

      const modelRate = convRate(quality);
      // With real data loaded, the current KPIs show actual subscribers / MRR; the
      // quality slider then only drives the *projected* conversion of future traffic.
      const rate = realData ? realData.realConv    : modelRate;
      const subs = realData ? realData.payingUsers : visitors * (modelRate / 100);
      const mrr  = realData ? realData.realMRR      : subs * ARPU;

      // Conversion implied by real data (paying / visitors) drives the projection.
      const projRate = realData && visitors > 0
        ? (realData.payingUsers / visitors) * 100
        : modelRate;

      /* 6-month forecast: anchor month 0 on real MRR, grow with the visitor trend */
      const forecastMRR = Array.from({ length: 6 }, (_, i) => {
        if (i === 0 && realData) return realData.realMRR;
        const projVisitors = Math.max(0, visitors + slope * (i + 1));
        return projVisitors * (projRate / 100) * ARPU;
      });

      const prob = probHit(mrr, target);
      const circumference = 2 * Math.PI * 50;

      /* Update DOM values */
      document.getElementById('arfVisitorsVal').textContent  = fmtNum(visitors);
      document.getElementById('arfQualityVal').textContent   = fmtNum(quality) + ' / 10';
      document.getElementById('arfTargetVal').textContent    = fmtEur(target);
      document.getElementById('arfQualityHint').textContent  =
        (QUALITY_LABELS[Math.round(quality)] || 'Bon') + ' — conversion estimée : ' + fmtNum(modelRate) + ' %';

      document.getElementById('arfProbPct').textContent      = prob + '%';
      document.getElementById('arfMRR').textContent          = fmtEur(mrr);
      document.getElementById('arfSubs').textContent         = fmtNum(subs);
      document.getElementById('arfARR').textContent          = fmtEur(mrr * 12);
      document.getElementById('arfConvRate').textContent     = fmtNum(rate) + ' %';

      /* Probability ring color */
      const fill = document.getElementById('arfRingFill');
      fill.style.strokeDashoffset = circumference * (1 - prob / 100);
      fill.style.stroke = prob >= 70 ? '#a3e635' : prob >= 40 ? '#f97316' : '#ef4444';

      /* Trend badge */
      const trendEl   = document.getElementById('arfTrend');
      const trendIcon = document.getElementById('arfTrendIcon');
      const trendText = document.getElementById('arfTrendText');
      trendEl.className = 'arf-trend';
      if (slope > visitors * 0.03) {
        trendEl.classList.add('up');
        trendIcon.textContent = '↑';
        trendText.textContent = 'Croissante (+' + fmtNum(Math.round(slope)) + ' vis./mois)';
      } else if (slope < -visitors * 0.03) {
        trendEl.classList.add('down');
        trendIcon.textContent = '↓';
        trendText.textContent = 'Décroissante (' + fmtNum(Math.round(slope)) + ' vis./mois)';
      } else {
        trendIcon.textContent = '→';
        trendText.textContent = histValid.length < 2 ? 'Saisissez l\'historique pour la tendance' : 'Stable';
      }

      buildChart(forecastLabels(), forecastMRR);

      /* Reset insight to local model text whenever sliders change */
      document.getElementById('arfInsightText').textContent =
        generateInsight(visitors, quality, mrr, slope, prob, target);
    }

    /* ── "Analyser avec l'IA" button — calls Claude via the Worker ──── */
    const analyseBtn = document.getElementById('arfAnalyseBtn');
    const insightEl  = document.getElementById('arfInsight');

    analyseBtn.addEventListener('click', async () => {
      const visitors = parseInt(sliderVisitors.value, 10);
      const quality  = parseFloat(sliderQuality.value);
      const target   = parseInt(sliderTarget.value, 10);
      const histRaw  = histInputs.map(el => {
        const v = parseInt(el.value, 10);
        return isNaN(v) || v < 0 ? null : v;
      });
      const histValid = histRaw.filter(v => v !== null);
      const slope  = histValid.length >= 2
        ? (function trendSlope(pts) {
            const n = pts.length, xm = (n-1)/2;
            const ym = pts.reduce((a,b)=>a+b,0)/n;
            let num=0,den=0;
            pts.forEach((y,x)=>{num+=(x-xm)*(y-ym);den+=(x-xm)**2;});
            return den===0?0:num/den;
          })(histValid)
        : 0;

      const modelRate = (function convRate(q) {
        const T=[0,0.12,0.25,0.45,0.72,1.10,1.62,2.25,2.95,3.60,4.25];
        const lo=Math.floor(q),hi=Math.ceil(q),t=q-lo;
        return (T[lo]||0)*(1-t)+(T[hi]||0)*t;
      })(quality);

      const ARPU = 0.65*2.99+0.35*6.99;
      // Prefer real figures when loaded; fall back to the slider model otherwise.
      const rate = realData ? realData.realConv    : modelRate;
      const subs = realData ? realData.payingUsers : visitors*(modelRate/100);
      const mrr  = realData ? realData.realMRR      : subs*ARPU;
      const arr  = mrr*12;
      const prob = Math.max(1,Math.min(99,Math.round(100/(1+Math.exp(-7*(mrr/target-0.85))))));
      const history = realData ? realData.history : histRaw;
      const realFields = realData ? {
        silver: realData.silver, gold: realData.gold,
        compedSilver: realData.compedSilver, compedGold: realData.compedGold,
        totalUsers: realData.totalUsers, realConv: realData.realConv,
      } : {};

      analyseBtn.disabled = true;
      analyseBtn.textContent = '⏳ Analyse en cours…';
      insightEl.classList.add('loading');

      try {
        const res = await fetch(`${API_URL}/api/ai/revenue-forecast`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(typeof authHeader === 'function' ? authHeader() : {}) },
          body: JSON.stringify({ visitors, quality, rate, mrr, arr, subs, slope, target, prob, history, ...realFields }),
        });

        if (!res.ok) {
          document.getElementById('arfInsightText').textContent =
            'Erreur lors de la communication avec l\'IA. Vérifiez que ANTHROPIC_API_KEY est configurée.';
        } else {
          const { analysis } = await res.json();
          document.getElementById('arfInsightText').textContent = analysis || 'Aucune analyse retournée.';
        }
      } catch {
        document.getElementById('arfInsightText').textContent =
          'Impossible de joindre le serveur. Vérifiez votre connexion.';
      } finally {
        analyseBtn.disabled = false;
        analyseBtn.innerHTML = '<span class="arf-ai-btn-icon">✨</span> Analyser avec l\'IA';
        insightEl.classList.remove('loading');
      }
    });

    sliderVisitors.addEventListener('input', update);
    sliderQuality.addEventListener('input', update);
    sliderTarget.addEventListener('input', update);
    histInputs.forEach(el => el.addEventListener('input', update));

    update();
    loadRealData(); // auto-fill from real subscribers + visitor history (no manual entry)

    function relabel(valId, text) {
      const el = document.getElementById(valId);
      if (el && el.nextElementSibling) el.nextElementSibling.textContent = text;
    }

    /* Pull real subscribers, MRR and dwell-gated visitor history from the server
       and pre-fill the model so the owner never has to type the numbers. */
    async function loadRealData() {
      const hdr = (typeof authHeader === 'function') ? authHeader() : {};
      try {
        const [evRes, usRes] = await Promise.all([
          fetch(`${API_URL}/api/analytics/events`, { headers: hdr }),
          fetch(`${API_URL}/api/users`, { headers: hdr }),
        ]);
        const ev    = evRes.ok ? await evRes.json() : {};
        const users = usRes.ok ? await usRes.json() : [];

        // Real anonymous visitors (> 1 min) by month; fall back to activity if none.
        const monthlyVisits = (ev && ev.monthlyVisits) || {};
        const hasRealVisits = Object.values(monthlyVisits).some(v => v > 0);
        const activity = Array.isArray(ev) ? ev : (ev.events || []);
        const now = new Date();
        const monthKey = d => d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0');
        const slots = Array.from({ length: 5 }, (_, i) => {
          const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (4 - i), 1));
          return { key: monthKey(d), y: d.getUTCFullYear(), m: d.getUTCMonth(), count: 0 };
        });
        if (hasRealVisits) {
          slots.forEach(s => { s.count = monthlyVisits[s.key] || 0; });
        } else {
          activity.forEach(v => {
            const d = new Date(v.timestamp);
            const i = slots.findIndex(s => s.y === d.getUTCFullYear() && s.m === d.getUTCMonth());
            if (i >= 0) slots[i].count++;
          });
        }
        const history       = slots.slice(0, 4).map(s => s.count);
        const visitsCurrent = slots[4].count;

        // Real subscriber counts from the user list (comped = offered, excluded from MRR).
        const counts = { free: 0, silver: 0, gold: 0 };
        const comped = { silver: 0, gold: 0 };
        users.forEach(u => {
          if (u.role === 'admin') return;
          counts[u.plan || 'free'] = (counts[u.plan || 'free'] || 0) + 1;
          if (u.comped && (u.plan === 'silver' || u.plan === 'gold')) comped[u.plan]++;
        });
        const totalUsers  = counts.free + counts.silver + counts.gold;
        const payingUsers = (counts.silver - comped.silver) + (counts.gold - comped.gold);
        const realMRR     = (counts.silver - comped.silver) * 2.99 + (counts.gold - comped.gold) * 6.99;
        const realConv    = totalUsers > 0 ? (payingUsers / totalUsers * 100) : 0;

        realData = {
          visitors: visitsCurrent, history,
          silver: counts.silver, gold: counts.gold,
          compedSilver: comped.silver, compedGold: comped.gold,
          totalUsers, payingUsers, realMRR, realConv,
        };

        // Pre-fill the inputs with reality (still adjustable as a what-if).
        const maxV = parseInt(sliderVisitors.max, 10) || 30000;
        sliderVisitors.value = Math.min(maxV, Math.max(0, Math.round(visitsCurrent / 10) * 10));
        histInputs.forEach((el, i) => { el.value = history[i] != null ? history[i] : ''; });

        // These KPIs now show real figures — relabel them accordingly.
        relabel('arfMRR', 'MRR réel');
        relabel('arfSubs', 'Abonnés payants');

        update();
      } catch {
        /* Network/auth failure → keep the manual slider model. */
      }
    }
  }
})();
