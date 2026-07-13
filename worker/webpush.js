// ── Web Push (VAPID + aes128gcm) — self-contained WebCrypto ────────────────────
// The npm `web-push` package depends on Node's crypto and does not run on
// Cloudflare Workers, so we implement the two pieces of the spec we need with
// the WebCrypto API that Workers exposes:
//   • VAPID JWT (RFC 8292) — ES256-signed { aud, exp, sub }, identifies the sender.
//   • Message encryption (RFC 8291) — ECDH → HKDF → a single aes128gcm record
//     (RFC 8188) so the notification payload ships inside the push itself.
//
// Requires three env values (Cloudflare secrets):
//   VAPID_PUBLIC_KEY   base64url uncompressed P-256 point (65 bytes, 0x04…)
//   VAPID_PRIVATE_KEY  base64url raw P-256 private scalar (32 bytes)
//   VAPID_SUBJECT      contact URI, e.g. "mailto:admin@bwrmaps.com"

// ── base64url helpers ─────────────────────────────────────────────────────────
function b64urlToBytes(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  const pad = s.length % 4 ? 4 - (s.length % 4) : 0;
  s += '='.repeat(pad);
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64url(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function concatBytes(...arrs) {
  const total = arrs.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrs) { out.set(a, off); off += a.length; }
  return out;
}

const enc = new TextEncoder();

// ── VAPID JWT (ES256) ─────────────────────────────────────────────────────────
async function importVapidPrivateKey(env) {
  const pub = b64urlToBytes(env.VAPID_PUBLIC_KEY);   // 0x04 || X(32) || Y(32)
  const priv = b64urlToBytes(env.VAPID_PRIVATE_KEY); // d(32)
  const jwk = {
    kty: 'EC',
    crv: 'P-256',
    x: bytesToB64url(pub.slice(1, 33)),
    y: bytesToB64url(pub.slice(33, 65)),
    d: bytesToB64url(priv),
    ext: true,
  };
  return crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
}

/** Builds a VAPID JWT for the given push-service audience (its origin). */
export async function buildVapidJwt(env, audience) {
  const header = bytesToB64url(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const payload = bytesToB64url(enc.encode(JSON.stringify({
    aud: audience,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: env.VAPID_SUBJECT || 'mailto:admin@bwrmaps.com',
  })));
  const unsigned = `${header}.${payload}`;
  const key = await importVapidPrivateKey(env);
  // WebCrypto ECDSA returns raw r||s (64 bytes) — exactly the JOSE signature form.
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(unsigned));
  return `${unsigned}.${bytesToB64url(new Uint8Array(sig))}`;
}

// ── Payload encryption (RFC 8291, aes128gcm) ──────────────────────────────────
async function hkdf(salt, ikm, info, length) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, length * 8);
  return new Uint8Array(bits);
}

/**
 * Encrypts `payloadStr` for a subscription's client keys, returning the
 * aes128gcm request body (header block || single GCM record).
 */
export async function encryptPayload(payloadStr, p256dhB64, authB64) {
  const uaPublic = b64urlToBytes(p256dhB64); // client public key, 65 bytes
  const authSecret = b64urlToBytes(authB64); // 16 bytes
  const plaintext = enc.encode(payloadStr);

  // Ephemeral (server) ECDH keypair for this message.
  const eph = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', eph.publicKey)); // 65 bytes

  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  // ECDH deriveBits returns the raw shared X coordinate (32 bytes) = ecdh_secret.
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, eph.privateKey, 256));

  // IKM = HKDF(salt=auth_secret, ikm=ecdh_secret, info="WebPush: info"\0 || ua || as)
  const keyInfo = concatBytes(enc.encode('WebPush: info\0'), uaPublic, asPublic);
  const ikm = await hkdf(authSecret, ecdhSecret, keyInfo, 32);

  // aes128gcm content encoding.
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);

  // Single record: plaintext || 0x02 delimiter (last-record marker), no padding.
  const record = concatBytes(plaintext, new Uint8Array([0x02]));
  const aesKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, tagLength: 128 }, aesKey, record)
  );

  // Header: salt(16) | rs(4, big-endian) | idlen(1) | keyid(as_public, 65).
  const header = new Uint8Array(16 + 4 + 1 + asPublic.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096, false); // record size
  header[20] = asPublic.length;
  header.set(asPublic, 21);

  return concatBytes(header, ciphertext);
}

/**
 * Sends one push message. Returns { gone: true } on 404/410 (subscription is
 * dead → caller should delete it), otherwise { ok, status }. Never throws for a
 * bad-status response; network errors reject and are caught by the caller.
 * @param {import('./kv.js').Env} env
 * @param {{ endpoint: string, keys: { p256dh: string, auth: string } }} subscription
 * @param {object} payloadObj
 */
export async function sendPush(env, subscription, payloadObj) {
  const audience = new URL(subscription.endpoint).origin;
  const jwt = await buildVapidJwt(env, audience);
  const body = await encryptPayload(JSON.stringify(payloadObj), subscription.keys.p256dh, subscription.keys.auth);

  const res = await fetch(subscription.endpoint, {
    method: 'POST',
    headers: {
      'Authorization': `vapid t=${jwt}, k=${env.VAPID_PUBLIC_KEY}`,
      'Content-Type': 'application/octet-stream',
      'Content-Encoding': 'aes128gcm',
      'TTL': '86400',
      'Urgency': 'normal',
    },
    body,
  });

  if (res.status === 404 || res.status === 410) return { gone: true };
  return { ok: res.ok, status: res.status };
}
