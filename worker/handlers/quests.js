import { putUser, listKeys } from '../kv.js';
import { getUserFromToken } from '../auth-utils.js';
import { sendPush } from '../webpush.js';

// Quest rewards ("hauts faits"). The daily / weekly / monthly quests only grant
// XP (evaluated purely client-side from user.stats). The one-time achievements
// carry a REAL prize — a temporary plan upgrade and/or an exclusive badge — and
// THIS module actually grants it, records the claim so it can't be claimed twice,
// and notifies the winner (in-app inbox message + best-effort web-push).
//
// The definitions below are the server-side source of truth for what each
// achievement is worth. They mirror public/data/quests.json (`oneTime`) — the
// `metric` maps to a cumulative `user.stats` field and `target` is the threshold.
// A client can only ask to claim a known quest id; the server re-checks the stat.
//
// KV / user fields written:
//   user.questClaims   → { [questId]: ISO timestamp }   (claimed-once guard)
//   user.questBadges   → [{ id, icon, label, earnedAt }] (exclusive quest badges)
//   inboxmsg:{ts}:{id} → the win notification, delivered to the user's inbox

const ONE_TIME_QUESTS = {
  o1: { metric: 'pathGrades', target: 200, title: 'Grand cartographe',    label: '1 mois de Gold offert 🥇',        plan: 'gold',   days: 30 },
  o2: { metric: 'reports',    target: 100, title: 'Gardien de la forêt',  label: '1 semaine de Silver + badge 🥈',  plan: 'silver', days: 7,
        badge: { id: 'quest_guardian', icon: '🚧', label: 'Gardien de la forêt' } },
  o3: { metric: 'km',         target: 500, title: 'Marcheur infatigable', label: 'Badge exclusif 🏅',
        badge: { id: 'quest_walker',    icon: '🏅', label: 'Marcheur infatigable' } },
  o4: { metric: 'routes',     target: 100, title: 'Explorateur assidu',   label: 'Badge Explorateur 🗺️',
        badge: { id: 'quest_explorer',  icon: '🗺️', label: 'Explorateur assidu' } },
  o5: { metric: 'bestStreak', target: 30,  title: 'Assidu légendaire',    label: '2 semaines de Gold offertes 🥇',  plan: 'gold',   days: 14 },
};

const RANK = { free: 0, visitor: 1, silver: 2, gold: 3 };

/**
 * Works out how to apply a temporary plan reward without ever DOWNGRADING the
 * winner. Returns the plan fields to merge onto the user, or null when the
 * reward can't improve their current standing (admin, or already permanently on
 * an equal-or-better plan). If a temporary plan of the same-or-higher tier is
 * already running, the reward STACKS on top of its expiry so days aren't lost.
 */
function grantPlanReward(user, plan, days) {
  if (user.role === 'admin') return null;
  const now = Date.now();
  const curPlan = user.plan || 'free';
  const curExp = user.planExpiresAt ? new Date(user.planExpiresAt).getTime() : 0;
  const hasActiveTemp = curExp > now;

  // Permanently on an equal/better plan → nothing to add.
  if (!hasActiveTemp && RANK[curPlan] >= RANK[plan]) return null;

  // Revert target when this reward lapses: keep an existing temp base, else the
  // plan they stand on right now.
  const base = hasActiveTemp ? (user.planBase || 'free') : curPlan;
  // Stack on top of an active same-or-higher temp plan; otherwise start now.
  const start = (hasActiveTemp && RANK[curPlan] >= RANK[plan]) ? curExp : now;
  const expiresAt = new Date(start + days * 86400000).toISOString();
  return { plan, planExpiresAt: expiresAt, planBase: base };
}

/** Drops the win into the user's in-app inbox (a direct message from "Quêtes BWR"). */
async function sendQuestInbox(env, user, def, planApplied) {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  let body = `Félicitations ! Tu as débloqué le haut fait « ${def.title} » et remporté : ${def.label}.`;
  if (planApplied) {
    const until = new Date(planApplied.planExpiresAt).toLocaleDateString('fr-FR');
    const planName = planApplied.plan === 'gold' ? 'Gold' : 'Argent';
    body += ` Ton abonnement ${planName} est actif jusqu'au ${until}.`;
  }
  if (def.badge) body += ` Le badge « ${def.badge.icon} ${def.badge.label} » a été ajouté à ton profil.`;
  const message = {
    id,
    createdAt: now,
    subject: `🎉 Récompense débloquée : ${def.label}`,
    body,
    target: user.id,
    targetName: user.name || '',
    senderName: 'Quêtes BWR',
  };
  await env.BWR_KV.put(`inboxmsg:${String(Date.now()).padStart(13, '0')}:${id}`, JSON.stringify(message));
}

/** Best-effort web-push to every device the winner has subscribed. */
async function sendQuestPush(env, user, questId, def) {
  try {
    if (!user.alertsEnabled) return;
    const payload = {
      title: '🎉 Récompense BWR débloquée',
      body: `${def.title} — ${def.label}`,
      url: '/quests',
      tag: `quest-${questId}`,
    };
    const keys = await listKeys(env, `pushsub:${user.id}:`);
    for (const k of keys) {
      const raw = await env.BWR_KV.get(k.name);
      if (!raw) continue;
      try {
        const res = await sendPush(env, JSON.parse(raw), payload);
        if (res && res.gone) await env.BWR_KV.delete(k.name);
      } catch { /* one dead subscription must not stop the rest */ }
    }
  } catch { /* push is best-effort — never break the claim */ }
}

/**
 * Quest endpoints.
 *   GET  /api/quests/claims → { claims, badges } (what I've already claimed)
 *   POST /api/quests/claim  { questId } → grant the prize + notify, once.
 * @param {Request} request
 * @param {import('../kv.js').Env} env
 * @param {{ pathname: string, json: Function, fail: Function, waitUntil: Function }} ctx
 * @returns {Promise<Response|null>}
 */
export async function handleQuests(request, env, { pathname, json, fail, waitUntil }) {
  if (!pathname.startsWith('/api/quests')) return null;

  if (pathname === '/api/quests/claims' && request.method === 'GET') {
    const user = await getUserFromToken(env, request);
    if (!user) return fail('Non authentifié.', 401);
    return json({ claims: user.questClaims || {}, badges: user.questBadges || [] });
  }

  if (pathname === '/api/quests/claim' && request.method === 'POST') {
    const user = await getUserFromToken(env, request);
    if (!user) return fail('Non authentifié.', 401);

    const { questId } = await request.json().catch(() => ({}));
    const def = ONE_TIME_QUESTS[questId];
    if (!def) return fail('Quête inconnue.', 404);

    const claims = user.questClaims || {};
    if (claims[questId]) {
      return json({ ok: true, alreadyClaimed: true, questId, reward: def.label });
    }

    // Re-verify the achievement server-side — the client can't fake a prize.
    const stats = user.stats || {};
    const value = stats[def.metric] || 0;
    if (value < def.target) {
      return json({ ok: false, reason: 'incomplete', have: value, need: def.target }, 400);
    }

    let updated = { ...user, questClaims: { ...claims, [questId]: new Date().toISOString() } };

    let planApplied = null;
    if (def.plan) {
      const g = grantPlanReward(user, def.plan, def.days);
      if (g) { updated = { ...updated, ...g }; planApplied = g; }
    }

    if (def.badge) {
      const badges = Array.isArray(user.questBadges) ? user.questBadges.slice() : [];
      if (!badges.some(b => b.id === def.badge.id)) {
        badges.push({ ...def.badge, earnedAt: new Date().toISOString() });
      }
      updated.questBadges = badges;
    }

    await putUser(env, updated);

    // Notify the winner: inbox message now, web-push in the background.
    await sendQuestInbox(env, user, def, planApplied);
    waitUntil(sendQuestPush(env, user, questId, def));

    return json({
      ok: true,
      questId,
      reward: def.label,
      plan: planApplied ? planApplied.plan : null,
      planExpiresAt: planApplied ? planApplied.planExpiresAt : null,
      badge: def.badge || null,
    });
  }

  return null;
}
