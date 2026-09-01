// Generates a VAPID (P-256) keypair for Web Push in the exact encoding
// worker/webpush.js expects:
//   VAPID_PUBLIC_KEY   base64url of the uncompressed point  0x04 || X(32) || Y(32)  (65 bytes)
//   VAPID_PRIVATE_KEY  base64url of the raw private scalar  d(32)
//
// Usage:  node scripts/gen-vapid.mjs
// Then copy the three lines into .dev.vars (local) and set them as Cloudflare
// secrets for production (see the printed instructions).
import { webcrypto } from 'node:crypto';

const { subtle } = webcrypto;

function b64url(bytes) {
  return Buffer.from(bytes).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const pair = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const jwk = await subtle.exportKey('jwk', pair.privateKey);

const x = Buffer.from(jwk.x.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
const y = Buffer.from(jwk.y.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
const d = Buffer.from(jwk.d.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

const publicKey = b64url(Buffer.concat([Buffer.from([0x04]), x, y])); // 65 bytes
const privateKey = b64url(d);                                          // 32 bytes

console.log('VAPID_PUBLIC_KEY=' + publicKey);
console.log('VAPID_PRIVATE_KEY=' + privateKey);
console.log('VAPID_SUBJECT=mailto:admin@bwrmaps.com');
