// ── Retention notification emails ─────────────────────────────────────────────
// Two low-effort, high-leverage emails that pull a member back into the app:
//   1. someone replied to a forum topic they started
//   2. an obstacle was reported on one of their saved routes
// Both reuse the generic Resend sender (auth-utils.sendEmail) and are strictly
// best-effort — a failed send must never break the reply POST or the report POST.
//
// Every email carries a one-click unsubscribe link (List-Unsubscribe header +
// visible footer) that flips the recipient's `emailNotifications` flag off, so we
// stay CAN-SPAM/RGPD-clean and out of spam folders.

import { getUser } from './kv.js';
import { sendEmail } from './auth-utils.js';

// Canonical public origin — background sends have no request Origin to read from.
const APP_ORIGIN = 'https://bwrmaps.com';

const TYPE_LABELS = {
  fallen_tree: 'Arbre tombé', flooded: 'Chemin inondé', muddy: 'Boueux',
  rutted: 'Ornières', broken_sign: 'Carrefour cassé', closed: 'Chemin fermé',
  danger: 'Danger', other: 'Obstacle',
};

/** Minimal HTML escape for interpolated, user-supplied text (titles, names, notes). */
function esc(s) {
  return String(s || '').replace(/[&<>"]/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]
  ));
}

/**
 * Stable, unguessable unsubscribe token for a user. Derived from the user id and
 * their password salt (a server-only value), so it needs no extra stored state
 * and can't be forged without reading KV.
 */
export async function unsubscribeToken(user) {
  const buf = await crypto.subtle.digest(
    'SHA-256', new TextEncoder().encode(`bwr-unsub:${user.id}:${user.salt || ''}`));
  return [...new Uint8Array(buf)].slice(0, 16).map(b => b.toString(16).padStart(2, '0')).join('');
}

/** Wraps body content in a simple, inline-styled shell with a CTA button + unsubscribe footer. */
function shell({ heading, intro, quote, ctaUrl, ctaLabel, unsubUrl }) {
  return `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:520px;margin:0 auto;color:#1f2937">
  <h2 style="color:#15803d;margin:0 0 12px">${heading}</h2>
  <p style="margin:0 0 16px;line-height:1.5">${intro}</p>
  ${quote ? `<blockquote style="margin:0 0 20px;padding:12px 16px;background:#f0fdf4;border-left:4px solid #22c55e;border-radius:4px;line-height:1.5">${quote}</blockquote>` : ''}
  <p style="margin:0 0 24px">
    <a href="${ctaUrl}" style="display:inline-block;background:#16a34a;color:#fff;text-decoration:none;padding:11px 22px;border-radius:8px;font-weight:600">${ctaLabel}</a>
  </p>
  <hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0 12px">
  <p style="font-size:12px;color:#9ca3af;line-height:1.5;margin:0">
    Tu reçois cet email parce que tu es membre de BWR — Balades en Forêt de Compiègne.<br>
    <a href="${unsubUrl}" style="color:#9ca3af">Se désabonner de ces notifications</a>
  </p>
</div>`;
}

/**
 * True unless the user has explicitly turned notification emails off. Absent flag
 * (legacy accounts) counts as opted-in.
 */
function wantsEmail(user) {
  return !!(user && user.email && user.emailNotifications !== false);
}

/**
 * Emails the topic author that someone replied to their thread. No-op when the
 * replier is the author, the author opted out, or has no email. Best-effort.
 *
 * @param {import('./kv.js').Env} env
 * @param {{ topic: object, reply: { userId: string, authorName?: string, body?: string } }} args
 */
export async function notifyForumReply(env, { topic, reply }) {
  try {
    if (!topic || !topic.userId) return;
    if (reply.userId === topic.userId) return; // don't email yourself
    const author = await getUser(env, topic.userId);
    if (!wantsEmail(author)) return;

    const token = await unsubscribeToken(author);
    const unsubUrl = `${APP_ORIGIN}/api/notify/unsubscribe?uid=${encodeURIComponent(author.id)}&token=${token}`;
    const topicUrl = `${APP_ORIGIN}/forum#t/${encodeURIComponent(topic.id)}`;

    const snippet = String(reply.body || '').replace(/\s+/g, ' ').trim().slice(0, 240);
    const html = shell({
      heading: 'Quelqu\'un a répondu à ton sujet 💬',
      intro: `<strong>${esc(reply.authorName || 'Un membre')}</strong> a répondu à ton sujet « ${esc(topic.title)} » sur le forum BWR.`,
      quote: snippet ? esc(snippet) : '',
      ctaUrl: topicUrl,
      ctaLabel: 'Voir la réponse',
      unsubUrl,
    });

    await sendEmail(env, {
      to: author.email,
      subject: `Nouvelle réponse à « ${topic.title} » — BWR`,
      html,
      headers: { 'List-Unsubscribe': `<${unsubUrl}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
    });
  } catch (e) {
    console.error('notifyForumReply failed:', e && e.message);
  }
}

/**
 * Emails a saved-route owner that an obstacle was reported on their route.
 * Called from the hazard fan-out with a user already known to match. Best-effort.
 *
 * @param {import('./kv.js').Env} env
 * @param {object} user               the route owner (full user object)
 * @param {string} routeName          the matched saved-route name
 * @param {{ id: string, type?: string, note?: string }} report
 */
export async function notifyRouteHazardEmail(env, user, routeName, report) {
  try {
    if (!wantsEmail(user)) return;

    const token = await unsubscribeToken(user);
    const unsubUrl = `${APP_ORIGIN}/api/notify/unsubscribe?uid=${encodeURIComponent(user.id)}&token=${token}`;
    const mapUrl = `${APP_ORIGIN}/map`;
    const label = TYPE_LABELS[report.type] || TYPE_LABELS.other;

    const html = shell({
      heading: '🌲 Nouvel obstacle sur ton trajet',
      intro: `<strong>${esc(label)}</strong> vient d'être signalé près de ton trajet enregistré « ${esc(routeName)} ». Vérifie avant de partir.`,
      quote: report.note ? esc(String(report.note).slice(0, 240)) : '',
      ctaUrl: mapUrl,
      ctaLabel: 'Voir sur la carte',
      unsubUrl,
    });

    await sendEmail(env, {
      to: user.email,
      subject: `⚠️ Obstacle signalé sur « ${routeName} » — BWR`,
      html,
      headers: { 'List-Unsubscribe': `<${unsubUrl}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
    });
  } catch (e) {
    console.error('notifyRouteHazardEmail failed:', e && e.message);
  }
}
