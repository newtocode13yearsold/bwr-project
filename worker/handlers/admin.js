import { listItems, putUser } from '../kv.js';
import { getUserFromToken, hashPassword } from '../auth-utils.js';

/**
 * Admin-only endpoints: one-time setup/migration, user list, contact messages.
 * @param {Request} request
 * @param {import('../kv.js').Env} env
 * @param {{ pathname: string, json: Function, fail: Function }} ctx
 * @returns {Promise<Response|null>}
 */
export async function handleAdmin(request, env, { pathname, json, fail }) {
  if (pathname === '/api/migrate' && request.method === 'POST') {
    const admin = await getUserFromToken(env, request);
    if (!admin || admin.role !== 'admin') return fail('Accès refusé.', 403);

    const results = { users: 0, paths: 0, reports: 0, contacts: 0 };

    const usersRaw = await env.BWR_KV.get('users');
    if (usersRaw) {
      const users = JSON.parse(usersRaw);
      await Promise.all(users.map(u => Promise.all([
        env.BWR_KV.put(`user:${u.id}`, JSON.stringify(u)),
        env.BWR_KV.put(`uemail:${u.email.toLowerCase()}`, u.id),
      ])));
      results.users = users.length;
    }

    const pathsRaw = await env.BWR_KV.get('paths');
    if (pathsRaw) {
      const paths = JSON.parse(pathsRaw);
      await Promise.all(paths.map(p => env.BWR_KV.put(`path:${p.id}`, JSON.stringify(p))));
      results.paths = paths.length;
    }

    const reportsRaw = await env.BWR_KV.get('reports');
    if (reportsRaw) {
      const reports = JSON.parse(reportsRaw);
      await Promise.all(reports.map(r => env.BWR_KV.put(`report:${r.id}`, JSON.stringify(r))));
      results.reports = reports.length;
    }

    const contactRaw = await env.BWR_KV.get('contact_messages');
    if (contactRaw) {
      const contacts = JSON.parse(contactRaw);
      await Promise.all(contacts.map(c => env.BWR_KV.put(`contact:${c.id}`, JSON.stringify(c))));
      results.contacts = contacts.length;
    }

    return json({ success: true, migrated: results });
  }

  if (pathname === '/api/setup' && request.method === 'POST') {
    const existing = await env.BWR_KV.list({ prefix: 'user:', limit: 1 });
    if (!existing.list_complete || existing.keys.length > 0) return fail('Setup already completed.', 403);

    const body = await request.json();
    if (!body.password) return fail('Password required.');

    const salt = crypto.randomUUID();
    const passwordHash = await hashPassword(body.password, salt);

    const adminName = env.ADMIN_NAME;
    const adminEmail = env.ADMIN_EMAIL;
    if (!adminName || !adminEmail) return fail('ADMIN_NAME and ADMIN_EMAIL env vars must be set.');

    const admin = {
      id: crypto.randomUUID(),
      name: adminName,
      email: adminEmail,
      passwordHash,
      salt,
      hashVersion: 2,
      role: 'admin',
      createdAt: new Date().toISOString(),
    };

    await Promise.all([
      putUser(env, admin),
      env.BWR_KV.put(`uemail:${admin.email}`, admin.id),
    ]);
    return json({ message: 'Admin created successfully' }, 201);
  }

  if (pathname === '/api/users' && request.method === 'GET') {
    const admin = await getUserFromToken(env, request);
    if (!admin || admin.role !== 'admin') return fail('Accès refusé.', 403);

    const allUsers = await listItems(env, 'user:');
    const safe = allUsers.map(u => ({
      id: u.id, name: u.name, email: u.email, role: u.role,
      plan: u.plan || 'free',
      planExpiresAt: u.planExpiresAt || null,
      planBase: u.planBase || null,
      createdAt: u.createdAt || null,
    }));
    return json(safe);
  }

  if (pathname === '/api/contacts' && request.method === 'GET') {
    const admin = await getUserFromToken(env, request);
    if (!admin || admin.role !== 'admin') return fail('Accès refusé.', 403);
    const messages = await listItems(env, 'contact:');
    messages.sort((a, b) => new Date(b.date) - new Date(a.date));
    return json(messages);
  }

  if (pathname.startsWith('/api/contacts/') && request.method === 'DELETE') {
    const admin = await getUserFromToken(env, request);
    if (!admin || admin.role !== 'admin') return fail('Accès refusé.', 403);
    const id = pathname.split('/')[3];
    await env.BWR_KV.delete(`contact:${id}`);
    return json({ success: true });
  }

  return null;
}
