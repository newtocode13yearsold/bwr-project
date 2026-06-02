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
  activationIcon.textContent  = plan === 'gold' ? '🥇' : '🥈';
  activationTitle.textContent = plan === 'gold' ? 'Activation du plan Or' : 'Activation du plan Argent';
  afPlan.value   = plan;
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

  const planLabel   = plan === 'gold' ? 'Or (7,99€/mois)' : 'Argent (3,99€/mois)';
  const periodLabel = period === 'annual' ? 'annuel (-15 %)' : 'mensuel';
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
      body: JSON.stringify({ name, email, message: formatted, subject: `[ACTIVATION ${plan.toUpperCase()}]` }),
    });
    if (!res.ok) throw new Error();
    document.getElementById('activationForm').reset();
    afStatus.innerHTML = '<strong>✓ Demande envoyée !</strong> Vous recevrez les instructions par email sous 24h.';
    afStatus.style.color = 'var(--forest-700)';
    setTimeout(closeActivation, 3500);
  } catch {
    afStatus.textContent = 'Erreur d\'envoi. Écrivez-moi directement à ${CONTACT_EMAIL}';
    afStatus.style.color = 'var(--danger)';
  } finally {
    btn.textContent = 'Envoyer la demande';
    btn.disabled = false;
  }
});

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
