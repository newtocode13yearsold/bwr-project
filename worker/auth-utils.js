import { getUser } from './kv.js';

// CNIL-recommended complexity: 8+ chars, at least one uppercase, one digit, one special char.
export const PASSWORD_REGEX = /^(?=.*[A-Z])(?=.*[0-9])(?=.*[^A-Za-z0-9]).{8,}$/;
export const PASSWORD_REQUIREMENTS_MSG = 'Le mot de passe doit faire au moins 8 caractères et contenir une majuscule, un chiffre et un caractère spécial.';

/** SHA-256 hash used by pre-PBKDF2 accounts. Only called during login migration. */
export async function hashPasswordLegacy(password, salt) {
  const encoder = new TextEncoder();
  const data = encoder.encode(password + salt);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// PBKDF2-SHA-256 avec 100 000 itérations — résistant au bruteforce (Web Crypto natif, sans dépendances)
export async function hashPassword(password, salt) {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    { name: 'PBKDF2' },
    false,
    ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: encoder.encode(salt), iterations: 100_000 },
    keyMaterial,
    256
  );
  return Array.from(new Uint8Array(bits)).map(b => b.toString(16).padStart(2, '0')).join('');
}

/** Extracts the Bearer token from the request, validates the session in KV, and returns the user or null. */
export async function getUserFromToken(env, request) {
  const auth = request.headers.get('Authorization');
  if (!auth || !auth.startsWith('Bearer ')) return null;
  const token = auth.slice(7);
  const raw = await env.BWR_KV.get(`session:${token}`);
  if (!raw) return null;
  const session = JSON.parse(raw);
  if (new Date(session.expiresAt) < new Date()) {
    await env.BWR_KV.delete(`session:${token}`);
    return null;
  }
  const user = await getUser(env, session.userId);
  if (!user) return null;
  if (user.sessionsInvalidatedAt && session.issuedAt &&
      new Date(session.issuedAt) < new Date(user.sessionsInvalidatedAt)) {
    await env.BWR_KV.delete(`session:${token}`);
    return null;
  }
  return user;
}

/** Returns the ISO date string (YYYY-MM-DD) of the Monday that starts the week containing `d`. */
export function isoMonday(d = new Date()) {
  const day = (d.getDay() + 6) % 7; // 0 = Monday
  const monday = new Date(d);
  monday.setDate(d.getDate() - day);
  monday.setHours(0, 0, 0, 0);
  return monday.toISOString().slice(0, 10);
}

// Generic fixed-window rate limiter
// KV key: ratelimit:{scope}:{key} → { count, resetAt }  (resetAt = window end, epoch ms)
// Returns true when the request is allowed, false when the limit is exceeded.
/**
 * Fixed-window rate limiter backed by KV.
 *
 * The window's end time (`resetAt`) is stored INSIDE the value and the count is
 * reset once that time has passed. We do NOT rely on the KV key expiring to reset
 * the window: KV treats `expirationTtl: undefined` as "no expiry at all", so a key
 * first written with a TTL and later re-`put` without one would live forever and
 * ban the caller permanently. Storing `resetAt` makes the reset explicit and
 * independent of KV's TTL behaviour.
 *
 * @returns true when the request is allowed, false when the limit is exceeded.
 */
export async function checkRateLimit(env, scope, key, maxCount, windowSeconds) {
  const kvKey = `ratelimit:${scope}:${key}`;
  const now = Date.now();
  const raw = await env.BWR_KV.get(kvKey);
  let count = 0;
  let resetAt = now + windowSeconds * 1000;
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && parsed.resetAt > now) {
        // Still inside the current window — keep counting toward it.
        count = parsed.count || 0;
        resetAt = parsed.resetAt;
      }
      // else: window elapsed (or unparseable shape) → start a fresh window.
    } catch {
      // Legacy bare-integer value from the old format → start a fresh window.
    }
  }
  if (count >= maxCount) return false;
  // TTL keeps KV tidy (expires a little after the window ends); the authoritative
  // reset is resetAt, re-sent on every write so the key can never outlive its window.
  const ttl = Math.max(60, Math.ceil((resetAt - now) / 1000));
  await env.BWR_KV.put(kvKey, JSON.stringify({ count: count + 1, resetAt }), {
    expirationTtl: ttl,
  });
  return true;
}

export const LOGIN_MAX_ATTEMPTS = 10;
export const LOGIN_LOCKOUT_SECONDS = 600; // 10 minutes

export async function getLoginAttempts(env, email) {
  const raw = await env.BWR_KV.get(`loginattempts:${email}`);
  return raw ? JSON.parse(raw) : { count: 0, lockedUntil: null };
}

export async function recordFailedLogin(env, email) {
  const attempts = await getLoginAttempts(env, email);
  attempts.count += 1;
  if (attempts.count >= LOGIN_MAX_ATTEMPTS) {
    attempts.lockedUntil = new Date(Date.now() + LOGIN_LOCKOUT_SECONDS * 1000).toISOString();
  }
  await env.BWR_KV.put(`loginattempts:${email}`, JSON.stringify(attempts), { expirationTtl: LOGIN_LOCKOUT_SECONDS });
  return attempts;
}

// ── Admin account hardening ───────────────────────────────────────────────────
// The session token IS the admin panel: anything that can read it (a borrowed
// laptop, a stale localStorage on a shared machine, an XSS one day) owns the
// site for as long as the token lives. A normal member's 30-day session is a
// convenience trade-off; for the admin it is an unacceptable blast radius, so
// admin sessions expire in hours and every admin sign-in is announced.
export const ADMIN_SESSION_SECONDS = 3 * 60 * 60;         // 3 hours
export const DEFAULT_SESSION_SECONDS = 30 * 24 * 60 * 60; // 30 days

/** Session lifetime for a user, in seconds. Admins get a deliberately short one. */
export function sessionSecondsFor(user) {
  return user && user.role === 'admin' ? ADMIN_SESSION_SECONDS : DEFAULT_SESSION_SECONDS;
}

// Admin second password ("deuxième mot de passe"). This is a second *knowledge*
// factor, not a true second factor: it does not protect against someone watching
// you type. What it does buy is that a leaked, guessed or reused main password —
// by far the most common way accounts fall — is no longer enough on its own, and
// unlike an authenticator app it cannot be lost with a broken phone.
//
// It is enforced ONLY once one has been set (see the login route), so enabling
// this feature can never lock the owner out of a site that does not have one yet.
export const SECOND_LOGIN_TTL = 300; // 5 min to answer the second prompt
export const SECOND_MAX_TRIES = 3;   // wrong answers before the attempt is burned

// Per-IP login limit. The existing lockout is keyed by *email*, so it does
// nothing against someone spraying one password across many accounts, and it
// lets anyone who knows the admin address lock that address out on purpose.
// This second limit is keyed by IP and caps the whole attack from one source.
export const LOGIN_IP_MAX_ATTEMPTS = 20;
export const LOGIN_IP_WINDOW = 900; // 15 minutes

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/**
 * Best-effort security alert when someone signs in — or fails to — on an admin
 * account: ntfy push plus an email to ADMIN_EMAIL. Detection, not prevention:
 * it can't stop a thief with the right password, but it means you find out in
 * seconds instead of when the damage shows up.
 *
 * Failure alerts are throttled per IP so a brute-force run can't flood the
 * phone. Never throws — alerting must never break the login flow.
 */
export async function alertAdminLogin(env, { ok, email, ip, device, place, at }) {
  try {
    if (!ok && !await checkRateLimit(env, 'adminloginalert', ip || 'unknown', 3, 3600)) return;

    // ntfy Title travels as an HTTP header, so keep it ASCII-only.
    const title = ok ? 'BWR - connexion admin' : 'BWR - ECHEC connexion admin';
    const lines = [
      `Compte : ${email}`,
      `Quand : ${at}`,
      `IP : ${ip || 'inconnue'}`,
      device ? `Appareil : ${device}` : null,
      place ? `Lieu : ${place}` : null,
      ok
        ? "Si ce n'est pas vous : changez le mot de passe admin immediatement."
        : "Quelqu'un tente de deviner le mot de passe admin.",
    ].filter(Boolean);

    await Promise.allSettled([
      fetch('https://ntfy.sh/bwr-ciril8596', {
        method: 'POST',
        headers: { Title: title, Priority: ok ? 'default' : 'high', Tags: 'lock' },
        body: lines.join('\n'),
      }),
      env.ADMIN_EMAIL
        ? sendEmail(env, {
            to: env.ADMIN_EMAIL,
            subject: ok ? 'Connexion à votre compte admin BWR' : 'Échec de connexion admin BWR',
            html: `<p>${lines.map(escapeHtml).join('<br>')}</p>`,
          })
        : Promise.resolve(),
    ]);
  } catch {
    /* alerting must never break auth */
  }
}

export const PENDING_TTL = 86400; // 24 hours
export const RESEND_COOLDOWN = 300; // 5 minutes between resend requests
export const RESET_TTL = 3600; // 1 hour — password-reset link lifetime
export const RESET_COOLDOWN = 300; // 5 minutes between forgot-password emails per address

/**
 * Sends a generic email via Resend. Silently no-ops if RESEND_API_KEY is unset (dev).
 * Throws on a Resend error so callers can log it — wrap in try/catch for
 * fire-and-forget notification emails that must never break the request.
 * @param {import('./kv.js').Env} env
 * @param {{ to: string, subject: string, html: string, headers?: Record<string,string> }} msg
 */
export async function sendEmail(env, { to, subject, html, headers }) {
  if (!env.RESEND_API_KEY) return; // skip in dev if key not set
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: env.RESEND_FROM || 'BWR <noreply@bwr.ciril8596.workers.dev>',
      to,
      subject,
      html,
      ...(headers ? { headers } : {}),
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.error(`Resend email failed for ${to}: ${res.status} ${body}`);
    throw new Error(`Resend error ${res.status}: ${body}`);
  }
}

/** Sends the account-activation email via Resend. Silently no-ops if RESEND_API_KEY is unset (dev). */
export async function sendVerificationEmail(env, origin, email, name, token) {
  if (!env.RESEND_API_KEY) return; // skip in dev if key not set
  const verifyUrl = `${origin}/verify?token=${token}`;
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: env.RESEND_FROM || 'BWR <noreply@bwr.ciril8596.workers.dev>',
      to: email,
      subject: 'Vérifiez votre adresse email — BWR',
      html: `<p>Bonjour ${name},</p>
<p>Cliquez sur le lien ci-dessous pour activer votre compte BWR. Ce lien expire dans 24 heures.</p>
<p><a href="${verifyUrl}">${verifyUrl}</a></p>
<p>Si vous n'avez pas créé de compte, ignorez cet email.</p>`,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.error(`Resend verification email failed for ${email}: ${res.status} ${body}`);
    // Notify admin via ntfy so email failures are visible in production.
    // Must be awaited: on Workers an un-awaited fetch is killed once the handler throws.
    await fetch('https://ntfy.sh/bwr-ciril8596', {
      method: 'POST',
      headers: { Title: 'BWR - email verification FAILED', Priority: 'high', Tags: 'email' },
      body: `Resend rejected email to ${email}. Status: ${res.status}. Details: ${body}`,
    }).catch(() => {});
    throw new Error(`Resend error ${res.status}: ${body}`);
  }
}

/**
 * Sends the "confirm your new email address" link when a signed-in user changes
 * their account email. The link lands on the new address (proving ownership)
 * before the change is applied. Silently no-ops if RESEND_API_KEY is unset (dev).
 */
export async function sendEmailChangeVerification(env, origin, newEmail, name, token) {
  if (!env.RESEND_API_KEY) return; // skip in dev if key not set
  const confirmUrl = `${origin}/verify-email?token=${token}`;
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: env.RESEND_FROM || 'BWR <noreply@bwr.ciril8596.workers.dev>',
      to: newEmail,
      subject: 'Confirmez votre nouvelle adresse email — BWR',
      html: `<p>Bonjour ${name},</p>
<p>Vous avez demandé à utiliser cette adresse comme nouvel email de connexion pour votre compte BWR. Cliquez sur le lien ci-dessous pour confirmer le changement. Ce lien expire dans 24 heures.</p>
<p><a href="${confirmUrl}">${confirmUrl}</a></p>
<p>Tant que vous n'avez pas cliqué, votre ancienne adresse reste active. Si vous n'êtes pas à l'origine de cette demande, ignorez cet email.</p>`,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.error(`Resend email-change verification failed for ${newEmail}: ${res.status} ${body}`);
    await fetch('https://ntfy.sh/bwr-ciril8596', {
      method: 'POST',
      headers: { Title: 'BWR - email change verification FAILED', Priority: 'high', Tags: 'email' },
      body: `Resend rejected email-change email to ${newEmail}. Status: ${res.status}. Details: ${body}`,
    }).catch(() => {});
    throw new Error(`Resend error ${res.status}: ${body}`);
  }
}

/** Sends the password-reset email via Resend. Silently no-ops if RESEND_API_KEY is unset (dev). */
export async function sendPasswordResetEmail(env, origin, email, name, token) {
  if (!env.RESEND_API_KEY) return; // skip in dev if key not set
  const resetUrl = `${origin}/reset?token=${token}`;
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: env.RESEND_FROM || 'BWR <noreply@bwr.ciril8596.workers.dev>',
      to: email,
      subject: 'Réinitialisation de votre mot de passe — BWR',
      html: `<p>Bonjour ${name},</p>
<p>Vous avez demandé à réinitialiser votre mot de passe BWR. Cliquez sur le lien ci-dessous pour en choisir un nouveau. Ce lien expire dans 1 heure.</p>
<p><a href="${resetUrl}">${resetUrl}</a></p>
<p>Si vous n'êtes pas à l'origine de cette demande, ignorez cet email : votre mot de passe restera inchangé.</p>`,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.error(`Resend password reset email failed for ${email}: ${res.status} ${body}`);
    // Notify admin via ntfy so email failures are visible in production.
    // Must be awaited: on Workers an un-awaited fetch is killed once the handler throws.
    await fetch('https://ntfy.sh/bwr-ciril8596', {
      method: 'POST',
      headers: { Title: 'BWR - password reset email FAILED', Priority: 'high', Tags: 'email' },
      body: `Resend rejected reset email to ${email}. Status: ${res.status}. Details: ${body}`,
    }).catch(() => {});
    throw new Error(`Resend error ${res.status}: ${body}`);
  }
}
