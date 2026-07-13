/* ── BWR Web Push client ───────────────────────────────────────────────────────
 * Thin wrapper around the browser Push API, used by the profile "Alertes
 * obstacles" toggle. Depends on globals from config.js (API_URL) and auth.js
 * (authHeader). Loaded before profile-plan.js on profile.html.
 *
 *   const st = await BWRPush.status();   // { supported, subscribed, permission }
 *   await BWRPush.enable();              // ask permission + register subscription
 *   await BWRPush.disable();             // unsubscribe locally + server-side
 * ──────────────────────────────────────────────────────────────────────────── */
(function (global) {
  'use strict';

  const SUPPORTED = 'serviceWorker' in navigator &&
                    'PushManager'   in window &&
                    'Notification'  in window;

  // VAPID application server key: base64url → Uint8Array (subscribe() wants bytes).
  function urlB64ToUint8Array(base64) {
    const padding = '='.repeat((4 - (base64.length % 4)) % 4);
    const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(b64);
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }

  const getReg = () => navigator.serviceWorker.ready;

  async function status() {
    if (!SUPPORTED) return { supported: false, subscribed: false, permission: 'denied' };
    const reg = await getReg();
    const sub = await reg.pushManager.getSubscription();
    return { supported: true, subscribed: !!sub, permission: Notification.permission };
  }

  async function enable() {
    if (!SUPPORTED) throw new Error('Notifications non supportées sur cet appareil.');

    const perm = await Notification.requestPermission();
    if (perm !== 'granted') throw new Error('Autorisation refusée dans le navigateur.');

    const keyRes = await fetch(`${API_URL}/api/push/vapid-public-key`);
    const { key } = await keyRes.json().catch(() => ({}));
    if (!key) throw new Error('Service de notifications indisponible.');

    const reg = await getReg();
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlB64ToUint8Array(key),
      });
    }

    const res = await fetch(`${API_URL}/api/push/subscribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeader() },
      body: JSON.stringify({ subscription: sub.toJSON() }),
    });
    if (!res.ok) {
      const { error } = await res.json().catch(() => ({}));
      throw new Error(error || 'Enregistrement impossible.');
    }
    return true;
  }

  async function disable() {
    if (!SUPPORTED) return true;
    const reg = await getReg();
    const sub = await reg.pushManager.getSubscription();
    const endpoint = sub && sub.endpoint;
    if (sub) await sub.unsubscribe();
    await fetch(`${API_URL}/api/push/unsubscribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeader() },
      body: JSON.stringify({ endpoint }),
    }).catch(() => {});
    return true;
  }

  global.BWRPush = { SUPPORTED, status, enable, disable };
})(window);
