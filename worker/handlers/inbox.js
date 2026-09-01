import { listItems, listKeys } from '../kv.js';
import { getUserFromToken } from '../auth-utils.js';

// In-app message inbox. ONLY the admin can send a message; every signed-in user
// has an inbox where they read the messages addressed to them.
//
// A message is either a broadcast (target 'all' — delivered to every account) or
// a direct message (target = a userId). Read state is tracked per-user so the
// same broadcast can be unread for one member and read for another.
//
// KV keys:
//   inboxmsg:{paddedTs}:{id} → JSON { id, createdAt, subject, body, target,
//                                     targetName, senderName }
//                              (ts in the key keeps messages ordered, newest last)
//   inboxread:{userId}:{msgId} → ISO timestamp string (existence = the user read it)

const SUBJECT_MAX = 140;
const BODY_MAX    = 5000;

/** Loads every message, newest first. */
async function loadMessagesSorted(env) {
  const keys = await listKeys(env, 'inboxmsg:');
  if (!keys.length) return [];
  const values = await Promise.all(keys.map(k => env.BWR_KV.get(k.name)));
  const msgs = values.filter(Boolean).map(v => JSON.parse(v));
  msgs.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  return msgs;
}

/** True when a message is addressed to the given user (broadcast or direct). */
function isForUser(msg, userId) {
  return msg.target === 'all' || msg.target === userId;
}

/**
 * In-app inbox endpoints.
 * @param {Request} request
 * @param {import('../kv.js').Env} env
 * @param {{ pathname: string, json: Function, fail: Function }} ctx
 * @returns {Promise<Response|null>}
 */
export async function handleInbox(request, env, { pathname, json, fail }) {
  if (!pathname.startsWith('/api/inbox')) return null;

  // ── My inbox: messages addressed to me, newest first, with read state ──
  if (pathname === '/api/inbox' && request.method === 'GET') {
    const user = await getUserFromToken(env, request);
    if (!user) return fail('Non authentifié.', 401);

    const all = await loadMessagesSorted(env);
    const mine = all.filter(m => isForUser(m, user.id));

    const readKeys = await listKeys(env, `inboxread:${user.id}:`);
    const readSet = new Set(readKeys.map(k => k.name.slice(`inboxread:${user.id}:`.length)));

    let unread = 0;
    const messages = mine.map(m => {
      const read = readSet.has(m.id);
      if (!read) unread++;
      return {
        id: m.id,
        createdAt: m.createdAt,
        subject: m.subject,
        body: m.body,
        senderName: m.senderName || 'Administrateur',
        direct: m.target !== 'all',
        read,
      };
    });

    return json({ messages, unread, isAdmin: user.role === 'admin' });
  }

  // ── Unread count only (cheap poll for the nav badge) ──
  if (pathname === '/api/inbox/unread' && request.method === 'GET') {
    const user = await getUserFromToken(env, request);
    if (!user) return fail('Non authentifié.', 401);

    const all = await loadMessagesSorted(env);
    const mine = all.filter(m => isForUser(m, user.id));
    const readKeys = await listKeys(env, `inboxread:${user.id}:`);
    const readSet = new Set(readKeys.map(k => k.name.slice(`inboxread:${user.id}:`.length)));
    const unread = mine.reduce((n, m) => n + (readSet.has(m.id) ? 0 : 1), 0);
    return json({ unread });
  }

  // ── Mark every message read ──
  if (pathname === '/api/inbox/read-all' && request.method === 'POST') {
    const user = await getUserFromToken(env, request);
    if (!user) return fail('Non authentifié.', 401);

    const all = await loadMessagesSorted(env);
    const mine = all.filter(m => isForUser(m, user.id));
    const now = new Date().toISOString();
    await Promise.all(mine.map(m =>
      env.BWR_KV.put(`inboxread:${user.id}:${m.id}`, now)));
    return json({ ok: true });
  }

  // ── Admin: list every message I have sent (with recipient info) ──
  if (pathname === '/api/inbox/sent' && request.method === 'GET') {
    const admin = await getUserFromToken(env, request);
    if (!admin || admin.role !== 'admin') return fail('Accès refusé.', 403);

    const all = await loadMessagesSorted(env);
    const sent = all.map(m => ({
      id: m.id,
      createdAt: m.createdAt,
      subject: m.subject,
      body: m.body,
      target: m.target,
      targetName: m.targetName || '',
    }));
    return json({ sent });
  }

  // ── Admin: send a message (broadcast or to one user) ──
  if (pathname === '/api/inbox' && request.method === 'POST') {
    const admin = await getUserFromToken(env, request);
    if (!admin || admin.role !== 'admin')
      return fail('Seul l\'administrateur peut envoyer un message.', 403);

    const body = await request.json().catch(() => ({}));
    const subject = String(body.subject || '').trim();
    const text    = String(body.body || '').trim();
    const target  = String(body.target || 'all').trim();
    if (subject.length < 1) return fail('Le sujet ne peut pas être vide.');
    if (text.length < 1)    return fail('Le message ne peut pas être vide.');

    // Resolve a direct recipient (anything but 'all') to confirm it exists.
    let targetName = '';
    if (target !== 'all') {
      const raw = await env.BWR_KV.get(`user:${target}`);
      if (!raw) return fail('Destinataire introuvable.', 404);
      targetName = JSON.parse(raw).name || '';
    }

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const message = {
      id,
      createdAt: now,
      subject: subject.slice(0, SUBJECT_MAX),
      body: text.slice(0, BODY_MAX),
      target,
      targetName,
      senderName: admin.name || 'Administrateur',
    };
    await env.BWR_KV.put(`inboxmsg:${String(Date.now()).padStart(13, '0')}:${id}`,
      JSON.stringify(message));
    return json({ ok: true, id }, 201);
  }

  // ── Message-scoped routes: /api/inbox/:id  and  /api/inbox/:id/read ──
  const readMatch = pathname.match(/^\/api\/inbox\/([^/]+)\/read$/);
  if (readMatch && request.method === 'POST') {
    const user = await getUserFromToken(env, request);
    if (!user) return fail('Non authentifié.', 401);

    const msgId = decodeURIComponent(readMatch[1]);
    const all = await loadMessagesSorted(env);
    const msg = all.find(m => m.id === msgId);
    if (!msg || !isForUser(msg, user.id)) return fail('Message introuvable.', 404);

    await env.BWR_KV.put(`inboxread:${user.id}:${msgId}`, new Date().toISOString());
    return json({ ok: true });
  }

  const idMatch = pathname.match(/^\/api\/inbox\/([^/]+)$/);
  if (idMatch && request.method === 'DELETE') {
    const admin = await getUserFromToken(env, request);
    if (!admin || admin.role !== 'admin') return fail('Accès refusé.', 403);

    const msgId = decodeURIComponent(idMatch[1]);
    const keys = await listKeys(env, 'inboxmsg:');
    const key = keys.find(k => k.name.endsWith(`:${msgId}`));
    if (!key) return fail('Message introuvable.', 404);

    // Delete the message plus every per-user read marker for it.
    const readKeys = await listKeys(env, 'inboxread:');
    await Promise.all([
      env.BWR_KV.delete(key.name),
      ...readKeys.filter(k => k.name.endsWith(`:${msgId}`)).map(k => env.BWR_KV.delete(k.name)),
    ]);
    return json({ ok: true });
  }

  return null;
}
