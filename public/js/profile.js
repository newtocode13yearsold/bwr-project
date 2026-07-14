// profile.js — entry file for the profile page.
// Owns the shared `currentUser` state, the avatar/colour helpers, the badge-toast
// queue, the boot IIFE, the user menu, the small formatting helpers and the
// account forms (name/email, password, logout, RGPD export, delete account).
// Loaded LAST on profile.html (after profile-stats.js, profile-wheel.js and
// profile-plan.js — all `defer`) so the boot IIFE can call every function those
// modules define. The extracted modules reference the shared state / helpers here
// only inside function bodies (call time), so there is no ordering hazard.

let currentUser = null;

const AVATAR_COLORS = [
  { bg: '#1e4d14', fg: '#a3e635', name: 'Forêt' },
  { bg: '#166534', fg: '#86efac', name: 'Sapin' },
  { bg: '#1d4ed8', fg: '#bfdbfe', name: 'Océan' },
  { bg: '#7c3aed', fg: '#ddd6fe', name: 'Violette' },
  { bg: '#b45309', fg: '#fde68a', name: 'Automne' },
  { bg: '#be123c', fg: '#fecdd3', name: 'Framboise' },
  { bg: '#0f766e', fg: '#99f6e4', name: 'Menthe' },
  { bg: '#374151', fg: '#e5e7eb', name: 'Ardoise' },
];

function getAvatarColor(userId) {
  const key = userId ? `bwr_avatar_color_${userId}` : 'bwr_avatar_color';
  const saved = localStorage.getItem(key);
  return saved ? JSON.parse(saved) : AVATAR_COLORS[0];
}

function saveAvatarColor(color, userId) {
  const key = userId ? `bwr_avatar_color_${userId}` : 'bwr_avatar_color';
  localStorage.setItem(key, JSON.stringify(color));
}

function initials(name) {
  return name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);
}

function renderAvatar(user, color) {
  const ring  = document.getElementById('avatarRing');
  const big   = document.getElementById('avatarBig');
  ring.style.borderColor = color.bg;
  big.style.background   = color.bg;
  big.style.color        = color.fg;
  big.textContent        = initials(user.name);

  // NOTE: the small header avatar deliberately keeps the high-contrast CSS
  // default (lime background, dark text) so the initials stay readable on the
  // dark green header. Theming it to a dark-on-dark colour made the letters
  // disappear, so we no longer override its colours here.
}

function buildColorSwatches(user) {
  const container = document.getElementById('colorSwatches');
  const current   = getAvatarColor(user.id);
  container.innerHTML = AVATAR_COLORS.map((c, i) => `
    <button
      class="swatch ${c.bg === current.bg ? 'active' : ''}"
      title="${c.name}"
      data-i="${i}"
      style="background:${c.bg}"
    ></button>
  `).join('');

  container.querySelectorAll('.swatch').forEach(btn => {
    btn.addEventListener('click', () => {
      const color = AVATAR_COLORS[+btn.dataset.i];
      saveAvatarColor(color, user.id);
      renderAvatar(user, color);
      container.querySelectorAll('.swatch').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
  });
}

let _toastQueue = [];
let _toastRunning = false;

function showBadgeToast(badge) {
  _toastQueue.push(badge);
  if (!_toastRunning) _drainToastQueue();
}

function _drainToastQueue() {
  if (!_toastQueue.length) { _toastRunning = false; return; }
  _toastRunning = true;
  const badge = _toastQueue.shift();

  let el = document.getElementById('badgeToast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'badgeToast';
    el.className = 'badge-toast';
    document.body.appendChild(el);
  }
  el.textContent = `🎉 Nouveau badge débloqué : ${badge.icon} ${badge.label}`;
  el.classList.add('show');

  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(_drainToastQueue, 300);
  }, 3200);
}

function showMsg(id, text, type = 'error') {
  const el = document.getElementById(id);
  el.innerHTML = `<div class="${type === 'error' ? 'form-error' : 'form-success'}">${text}</div>`;
  setTimeout(() => { el.innerHTML = ''; }, 5000);
}

// ── Boot ──────────────────────────────────────────────────────────────────────
(async () => {
  currentUser = await requireAuth();
  if (!currentUser) return;

  // One-time migration: km previously counted from route generation are invalid.
  // Reset local and server km to 0 so only GPS-tracked km count going forward.
  if (!localStorage.getItem('bwr_km_gps_only_v1')) {
    localStorage.setItem('bwr_km_total', '0');
    if (getToken()) {
      await fetch(`${API_URL}/api/auth/stats`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeader() },
        body: JSON.stringify({ resetKm: true }),
      }).catch(() => {});
    }
    localStorage.setItem('bwr_km_gps_only_v1', '1');
    // Reload user data after reset so the page shows fresh stats
    const res = await fetch(`${API_URL}/api/auth/me`, { headers: authHeader() });
    if (res.ok) currentUser = await res.json();
  }

  initUserMenu();
  populatePage(currentUser);
  buildColorSwatches(currentUser);
  renderAvatar(currentUser, getAvatarColor(currentUser.id));
  renderActivityStats();
})();

function initUserMenu() {
  const menuEl = document.getElementById('userMenu');
  const ini    = initials(currentUser.name);
  menuEl.innerHTML = `
    <button class="user-btn" id="userBtn">
      <div class="user-avatar">${ini}</div>
      <span class="btn-label">${currentUser.name.split(' ')[0]}</span>
    </button>
    <div class="user-dropdown hidden" id="userDropdown">
      <span class="dropdown-name">${currentUser.name}</span>
      <a href="/">🏠 Accueil</a>
      <a href="map">🗺 Voir la carte</a>
      <a href="routes">🧭 Planifier un trajet</a>
      ${currentUser.role === 'admin' ? '<a href="admin">🗺 Carte admin</a><a href="admin-panel">⚙️ Panneau admin</a>' : ''}
      <button class="dropdown-logout" id="btnLogout">Se déconnecter</button>
    </div>
  `;
  document.getElementById('userBtn').addEventListener('click', () =>
    document.getElementById('userDropdown').classList.toggle('hidden'));
  document.getElementById('btnLogout').addEventListener('click', logout);
  document.addEventListener('click', e => {
    if (!menuEl.contains(e.target)) document.getElementById('userDropdown')?.classList.add('hidden');
  });
}

// ── Small helpers ─────────────────────────────────────────────────────────────
function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// Distance formatter — French decimal comma, max 1 decimal ("6,5 km", "8 km")
function fmtKm(n) {
  return `${(n || 0).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} km`;
}

// UTC date key 'YYYY-MM-DD' from epoch-ms (matches server dailyLog keys, avoids TZ drift)
function utcDayKey(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

// Midnight-UTC epoch ms for "today"
function todayUtcMs() {
  const n = new Date();
  return Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate());
}

// ── Form: update name / email ─────────────────────────────────────────────────
document.getElementById('formInfo').addEventListener('submit', async e => {
  e.preventDefault();
  const name        = document.getElementById('inputName').value.trim();
  const email       = document.getElementById('inputEmail').value.trim().toLowerCase();
  if (!name || !email) return showMsg('infoMsg', 'Tous les champs sont obligatoires.');

  const btn = e.target.querySelector('button[type=submit]');
  btn.textContent = 'Enregistrement…';
  btn.disabled = true;

  try {
    const res = await fetch(`${API_URL}/api/auth/profile`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...authHeader() },
      body: JSON.stringify({ name, email }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Erreur serveur');

    // Update cached user
    const cached = getCachedUser();
    setSession(localStorage.getItem('bwr_token'), { ...cached, name, email });
    currentUser.name        = name;
    currentUser.email       = email;
    document.getElementById('heroName').textContent = name;

    showMsg('infoMsg', 'Profil mis à jour avec succès !', 'success');
  } catch (err) {
    showMsg('infoMsg', err.message);
  } finally {
    btn.textContent = 'Enregistrer les modifications';
    btn.disabled = false;
  }
});

// ── Form: change password ─────────────────────────────────────────────────────
document.getElementById('formPassword').addEventListener('submit', async e => {
  e.preventDefault();
  const oldPw     = document.getElementById('inputOldPw').value;
  const newPw     = document.getElementById('inputNewPw').value;
  const confirmPw = document.getElementById('inputConfirmPw').value;

  if (!oldPw || !newPw || !confirmPw) return showMsg('pwMsg', 'Tous les champs sont obligatoires.');
  if (newPw.length < 8)  return showMsg('pwMsg', 'Le nouveau mot de passe doit faire au moins 8 caractères.');
  if (newPw !== confirmPw) return showMsg('pwMsg', 'Les mots de passe ne correspondent pas.');

  const btn = e.target.querySelector('button[type=submit]');
  btn.textContent = 'Modification…';
  btn.disabled = true;

  try {
    const res = await fetch(`${API_URL}/api/auth/password`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...authHeader() },
      body: JSON.stringify({ oldPassword: oldPw, newPassword: newPw }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Erreur serveur');

    e.target.reset();
    showMsg('pwMsg', 'Mot de passe changé avec succès !', 'success');
  } catch (err) {
    showMsg('pwMsg', err.message);
  } finally {
    btn.textContent = 'Changer le mot de passe';
    btn.disabled = false;
  }
});

// ── Logout ────────────────────────────────────────────────────────────────────
document.getElementById('btnLogoutProfile').addEventListener('click', logout);

// ── Focus trap helper ─────────────────────────────────────────────────────────
function trapFocus(container) {
  const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
  function handler(e) {
    const els = [...container.querySelectorAll(FOCUSABLE)];
    if (!els.length) return;
    const first = els[0], last = els[els.length - 1];
    if (e.key === 'Tab') {
      if (e.shiftKey) { if (document.activeElement === first) { e.preventDefault(); last.focus(); } }
      else            { if (document.activeElement === last)  { e.preventDefault(); first.focus(); } }
    }
  }
  container.addEventListener('keydown', handler);
  return () => container.removeEventListener('keydown', handler);
}

// ── Export my data (RGPD — droit d'accès & portabilité) ───────────────────────
document.getElementById('btnExportData').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  const original = btn.innerHTML;
  btn.disabled = true;
  btn.textContent = 'Préparation…';

  try {
    const res = await fetch(`${API_URL}/api/auth/export`, { headers: authHeader() });
    if (!res.ok) throw new Error('Export indisponible');

    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `bwr-mes-donnees-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (err) {
    alert('Erreur : ' + err.message);
  } finally {
    btn.disabled = false;
    btn.innerHTML = original;
  }
});

// ── Delete account ────────────────────────────────────────────────────────────
const deleteModal  = document.getElementById('deleteModal');
let _deleteTrigger = null;
let _deleteTrapRelease = null;

function openDeleteModal() {
  deleteModal.classList.remove('hidden');
  _deleteTrapRelease = trapFocus(deleteModal);
  document.getElementById('btnCancelDelete').focus();
}
function closeDeleteModal() {
  deleteModal.classList.add('hidden');
  if (_deleteTrapRelease) { _deleteTrapRelease(); _deleteTrapRelease = null; }
  if (_deleteTrigger) { _deleteTrigger.focus(); _deleteTrigger = null; }
}

document.getElementById('btnDelete').addEventListener('click', e => {
  if (currentUser.role === 'admin') {
    alert('Le compte administrateur ne peut pas être supprimé.');
    return;
  }
  _deleteTrigger = e.currentTarget;
  openDeleteModal();
});
document.getElementById('btnCancelDelete').addEventListener('click', closeDeleteModal);
deleteModal.addEventListener('keydown', e => { if (e.key === 'Escape') closeDeleteModal(); });

document.getElementById('btnConfirmDelete').addEventListener('click', async () => {
  const btn = document.getElementById('btnConfirmDelete');
  btn.textContent = 'Suppression…';
  btn.disabled = true;

  try {
    const res = await fetch(`${API_URL}/api/auth/account`, {
      method: 'DELETE',
      headers: authHeader(),
    });
    if (!res.ok) {
      const d = await res.json();
      throw new Error(d.error || 'Erreur serveur');
    }
    clearSession();
    window.location.href = 'login';
  } catch (err) {
    alert('Erreur : ' + err.message);
    btn.textContent = 'Oui, supprimer';
    btn.disabled = false;
  }
});
