import { getUser, putUser } from '../kv.js';
import { unsubscribeToken } from '../notify.js';

/** Tiny standalone HTML page (no app shell needed) shown after an unsubscribe click. */
function page(title, message, cors) {
  const html = `<!doctype html><html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} — BWR</title></head>
<body style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;background:#f0fdf4;margin:0;padding:48px 16px;color:#1f2937">
<div style="max-width:460px;margin:0 auto;background:#fff;border-radius:16px;padding:32px;text-align:center;box-shadow:0 4px 24px rgba(0,0,0,.06)">
<h1 style="color:#15803d;font-size:22px;margin:0 0 12px">${title}</h1>
<p style="line-height:1.5;margin:0 0 24px">${message}</p>
<a href="https://bwrmaps.com/profile" style="display:inline-block;background:#16a34a;color:#fff;text-decoration:none;padding:11px 22px;border-radius:8px;font-weight:600">Gérer mes préférences</a>
</div></body></html>`;
  return new Response(html, { status: 200, headers: { ...cors, 'Content-Type': 'text/html; charset=utf-8' } });
}

/**
 * One-click unsubscribe from notification emails (forum replies + route hazards).
 * Reached from the List-Unsubscribe header / email footer link. GET renders a
 * confirmation page; POST supports RFC 8058 one-click unsubscribe. The token is
 * derived from the user id + salt (see notify.unsubscribeToken), so no session is
 * needed and it can't be forged.
 *
 * @param {Request} request
 * @param {import('../kv.js').Env} env
 * @param {{ pathname: string, url: URL, cors: Object }} ctx
 * @returns {Promise<Response|null>}
 */
export async function handleNotify(request, env, { pathname, url, cors }) {
  if (pathname !== '/api/notify/unsubscribe') return null;
  if (request.method !== 'GET' && request.method !== 'POST') return null;

  const uid = url.searchParams.get('uid') || '';
  const token = url.searchParams.get('token') || '';
  const user = uid ? await getUser(env, uid) : null;

  if (!user || token !== await unsubscribeToken(user)) {
    return page('Lien invalide', 'Ce lien de désabonnement est invalide ou a expiré.', cors);
  }

  if (user.emailNotifications !== false) {
    await putUser(env, { ...user, emailNotifications: false });
  }

  return page(
    'Désabonnement confirmé',
    'Tu ne recevras plus d\'emails de notification (réponses au forum et obstacles sur tes trajets). Tu peux les réactiver à tout moment depuis ton profil.',
    cors,
  );
}
