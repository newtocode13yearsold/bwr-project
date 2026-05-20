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

function getAvatarColor() {
  const saved = localStorage.getItem('bwr_avatar_color');
  return saved ? JSON.parse(saved) : AVATAR_COLORS[0];
}

function saveAvatarColor(color) {
  localStorage.setItem('bwr_avatar_color', JSON.stringify(color));
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

  // also update header avatar
  const headerAvatar = document.querySelector('.user-avatar');
  if (headerAvatar) {
    headerAvatar.style.background = color.bg;
    headerAvatar.style.color      = color.fg;
  }
}

function buildColorSwatches(user) {
  const container = document.getElementById('colorSwatches');
  const current   = getAvatarColor();
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
      saveAvatarColor(color);
      renderAvatar(user, color);
      container.querySelectorAll('.swatch').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
  });
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

  initUserMenu();
  populatePage(currentUser);
  buildColorSwatches(currentUser);
  renderAvatar(currentUser, getAvatarColor());
  loadPathCount();
})();

function initUserMenu() {
  const menuEl = document.getElementById('userMenu');
  const color  = getAvatarColor();
  const ini    = initials(currentUser.name);
  menuEl.innerHTML = `
    <button class="user-btn" id="userBtn">
      <div class="user-avatar" style="background:${color.bg};color:${color.fg}">${ini}</div>
      ${currentUser.name.split(' ')[0]}
    </button>
    <div class="user-dropdown hidden" id="userDropdown">
      <span class="dropdown-name">${currentUser.name}</span>
      <a href="map.html">Voir la carte</a>
      <a href="routes.html">Planifier un trajet</a>
      ${currentUser.role === 'admin' ? '<a href="admin.html">Admin</a>' : ''}
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

function populatePage(user) {
  document.getElementById('heroName').textContent  = user.name;
  document.getElementById('inputName').value       = user.name;
  document.getElementById('inputEmail').value      = user.email;

  const roleMap = { admin: '👑 Administrateur', free: '🌲 Membre' };
  const roleEl  = document.getElementById('roleBadge');
  roleEl.textContent  = roleMap[user.role] || user.role;
  roleEl.className    = `role-badge role-${user.role}`;

  const since = user.createdAt
    ? new Date(user.createdAt).toLocaleDateString('fr-FR', { year: 'numeric', month: 'long', day: 'numeric' })
    : '';
  if (since) document.getElementById('heroSince').textContent = `Membre depuis le ${since}`;
}

async function loadPathCount() {
  try {
    const res = await fetch(`${API_URL}/api/paths`);
    const paths = await res.json();
    document.getElementById('statPaths').textContent = paths.length;
  } catch {}
  // Routes and km are stored locally per session (no persistent history in the backend)
  const routes = parseInt(localStorage.getItem('bwr_route_count') || '0');
  const km     = parseFloat(localStorage.getItem('bwr_km_total') || '0');
  document.getElementById('statRoutes').textContent = routes;
  document.getElementById('statKm').textContent     = km > 0 ? `${km.toFixed(0)} km` : '—';
}

// ── Form: update name / email ──────────────────────────────────────────────────
document.getElementById('formInfo').addEventListener('submit', async e => {
  e.preventDefault();
  const name  = document.getElementById('inputName').value.trim();
  const email = document.getElementById('inputEmail').value.trim().toLowerCase();
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
    currentUser.name  = name;
    currentUser.email = email;
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
  if (newPw.length < 6)  return showMsg('pwMsg', 'Le nouveau mot de passe doit faire au moins 6 caractères.');
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

// ── Delete account ────────────────────────────────────────────────────────────
const deleteModal  = document.getElementById('deleteModal');
document.getElementById('btnDelete').addEventListener('click', () => {
  if (currentUser.role === 'admin') {
    alert('Le compte administrateur ne peut pas être supprimé.');
    return;
  }
  deleteModal.classList.remove('hidden');
});
document.getElementById('btnCancelDelete').addEventListener('click', () =>
  deleteModal.classList.add('hidden'));

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
    window.location.href = 'login.html';
  } catch (err) {
    alert('Erreur : ' + err.message);
    btn.textContent = 'Oui, supprimer';
    btn.disabled = false;
  }
});
