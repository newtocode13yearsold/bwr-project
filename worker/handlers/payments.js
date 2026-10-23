import { getUser, putUser, listItems } from '../kv.js';
import { getUserFromToken } from '../auth-utils.js';
import { grantPlanReward } from './quests.js';

// Pro by bank transfer. No card processor: a signed-in member asks to go Pro,
// the site instantly shows the bank details + a unique reference to put in the
// transfer's label, and the admin clicks "Payé" in the admin panel once the money
// shows up in the bank. That click switches the member to Pro for the paid period
// (reusing the planExpiresAt/planBase revert path in /api/auth/me).
//
// Bank details come from env vars (wrangler vars / dashboard), never the code:
//   BANK_IBAN, BANK_BIC, BANK_HOLDER
//
// KV:
//   payreq:{ref}          → JSON { ref, userId, name, email, period, amountCents,
//                                  status:'pending'|'paid'|'cancelled', createdAt, paidAt?, paidUntil? }
//                           (kept after payment — it's the accounting record)
//   payreqopen:{userId}   → ref of that member's one open request (so re-opening the
//                           form shows the same reference instead of piling up new ones)

export const PERIODS = {
  monthly: { amountCents: 299,  days: 31,  label: 'mensuel' },
  annual:  { amountCents: 2691, days: 365, label: 'annuel' },
};

// No 0/O/1/I so a reference typed by hand into a bank app can't be misread.
const REF_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function makeRef() {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return 'BWR-' + [...bytes].map(b => REF_ALPHABET[b % REF_ALPHABET.length]).join('');
}

export function formatEuros(cents) {
  return (cents / 100).toFixed(2).replace('.', ',') + ' €';
}

function bankDetails(env) {
  if (!env.BANK_IBAN) return null;
  return { iban: env.BANK_IBAN, bic: env.BANK_BIC || '', holder: env.BANK_HOLDER || '' };
}

/** What the member sees: the request + where to send the money. */
function publicView(req, bank) {
  return {
    ref: req.ref,
    period: req.period,
    amountCents: req.amountCents,
    amount: formatEuros(req.amountCents),
    status: req.status,
    createdAt: req.createdAt,
    ...bank,
  };
}

async function getReq(env, ref) {
  const raw = await env.BWR_KV.get(`payreq:${ref}`);
  return raw ? JSON.parse(raw) : null;
}

async function alertNewRequest(req) {
  try {
    await fetch('https://ntfy.sh/bwr-ciril8596', {
      method: 'POST',
      headers: { 'Title': `BWR - Virement attendu ${req.ref}`, 'Tags': 'moneybag', 'Content-Type': 'text/plain; charset=utf-8' },
      body: `${req.name} <${req.email}>\nPro ${PERIODS[req.period].label} : ${formatEuros(req.amountCents)}\nRéférence : ${req.ref}`,
    });
  } catch { /* alerting is best-effort */ }
}

async function sendPaidInbox(env, user, req) {
  const id = crypto.randomUUID();
  const until = new Date(req.paidUntil).toLocaleDateString('fr-FR');
  const message = {
    id,
    createdAt: new Date().toISOString(),
    subject: 'Paiement reçu, merci !',
    body: `Nous avons bien reçu votre virement de ${formatEuros(req.amountCents)} (référence ${req.ref}). Votre abonnement Pro est actif jusqu'au ${until}.`,
    target: user.id,
    targetName: user.name || '',
    senderName: 'BWR',
  };
  await env.BWR_KV.put(`inboxmsg:${String(Date.now()).padStart(13, '0')}:${id}`, JSON.stringify(message));
}

/**
 * Bank-transfer payment endpoints.
 *   POST   /api/payments/request   { period } → my open request + bank details (auth)
 *   GET    /api/payments           → every request, newest first (admin)
 *   POST   /api/payments/:ref/paid → money received: activate Pro (admin)
 *   DELETE /api/payments/:ref      → cancel an unpaid request (admin)
 * @returns {Promise<Response|null>}
 */
export async function handlePayments(request, env, { pathname, json, fail, waitUntil }) {
  if (!pathname.startsWith('/api/payments')) return null;

  const user = await getUserFromToken(env, request);
  if (!user) return fail('Non authentifié.', 401);

  if (pathname === '/api/payments/request' && request.method === 'POST') {
    const bank = bankDetails(env);
    if (!bank) return fail('Le paiement par virement n\'est pas encore configuré.', 503);

    const body = await request.json().catch(() => ({}));
    const period = PERIODS[body.period] ? body.period : 'monthly';

    // One open request per member: hand back the same reference (switching the
    // period if they changed their mind) instead of creating a new one.
    const openRef = await env.BWR_KV.get(`payreqopen:${user.id}`);
    const open = openRef ? await getReq(env, openRef) : null;
    if (open && open.status === 'pending') {
      if (open.period !== period) {
        open.period = period;
        open.amountCents = PERIODS[period].amountCents;
        await env.BWR_KV.put(`payreq:${open.ref}`, JSON.stringify(open));
      }
      return json(publicView(open, bank));
    }

    let ref = makeRef();
    while (await env.BWR_KV.get(`payreq:${ref}`)) ref = makeRef();
    const req = {
      ref,
      userId: user.id,
      name: user.name || '',
      email: user.email || '',
      period,
      amountCents: PERIODS[period].amountCents,
      status: 'pending',
      createdAt: new Date().toISOString(),
    };
    await env.BWR_KV.put(`payreq:${ref}`, JSON.stringify(req));
    await env.BWR_KV.put(`payreqopen:${user.id}`, ref);
    if (waitUntil) waitUntil(alertNewRequest(req));
    return json(publicView(req, bank), 201);
  }

  // ── Admin only below ──
  if (user.role !== 'admin') return fail('Accès refusé.', 403);

  if (pathname === '/api/payments' && request.method === 'GET') {
    const all = await listItems(env, 'payreq:');
    all.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return json({ payments: all.map(p => ({ ...p, amount: formatEuros(p.amountCents) })) });
  }

  const paidMatch = pathname.match(/^\/api\/payments\/(BWR-[A-Z0-9]+)\/paid$/);
  if (paidMatch && request.method === 'POST') {
    const req = await getReq(env, paidMatch[1]);
    if (!req) return fail('Demande introuvable.', 404);
    if (req.status !== 'pending') return fail('Cette demande n\'est plus en attente.', 409);
    const member = await getUser(env, req.userId);
    if (!member) return fail('Membre introuvable (compte supprimé ?).', 404);

    const grant = grantPlanReward(member, 'pro', PERIODS[req.period].days);
    if (grant) await putUser(env, { ...member, ...grant });

    req.status = 'paid';
    req.paidAt = new Date().toISOString();
    req.paidUntil = grant ? grant.planExpiresAt : (member.planExpiresAt || null);
    await env.BWR_KV.put(`payreq:${req.ref}`, JSON.stringify(req));
    await env.BWR_KV.delete(`payreqopen:${req.userId}`);
    if (req.paidUntil) await sendPaidInbox(env, member, req);
    return json({ ok: true, ref: req.ref, planExpiresAt: req.paidUntil });
  }

  const refMatch = pathname.match(/^\/api\/payments\/(BWR-[A-Z0-9]+)$/);
  if (refMatch && request.method === 'DELETE') {
    const req = await getReq(env, refMatch[1]);
    if (!req) return fail('Demande introuvable.', 404);
    if (req.status !== 'pending') return fail('Seule une demande en attente peut être annulée.', 409);
    req.status = 'cancelled';
    await env.BWR_KV.put(`payreq:${req.ref}`, JSON.stringify(req));
    await env.BWR_KV.delete(`payreqopen:${req.userId}`);
    return json({ ok: true });
  }

  return null;
}
