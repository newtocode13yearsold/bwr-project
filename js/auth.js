// Shared auth helpers used by all pages

function getToken() {
  return localStorage.getItem('bwr_token');
}

function setSession(token, user) {
  localStorage.setItem('bwr_token', token);
  localStorage.setItem('bwr_user', JSON.stringify(user));
}

function clearSession() {
  localStorage.removeItem('bwr_token');
  localStorage.removeItem('bwr_user');
}

function getCachedUser() {
  const raw = localStorage.getItem('bwr_user');
  return raw ? JSON.parse(raw) : null;
}

async function fetchCurrentUser() {
  const token = getToken();
  if (!token) return null;
  try {
    const res = await fetch(`${API_URL}/api/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) { clearSession(); return null; }
    return await res.json();
  } catch {
    return null;
  }
}

async function logout() {
  const token = getToken();
  if (token) {
    await fetch(`${API_URL}/api/auth/logout`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    }).catch(() => {});
  }
  clearSession();
  window.location.href = 'login';
}

// Redirects to login if not authenticated, or if requiredRole is set and user doesn't have it
async function requireAuth(requiredRole = null) {
  const user = await fetchCurrentUser();
  if (!user) {
    sessionStorage.setItem('bwr_redirect', window.location.href);
    window.location.href = 'login';
    return null;
  }
  if (requiredRole && user.role !== requiredRole) {
    alert('Accès réservé à l\'administrateur.');
    window.location.href = 'map';
    return null;
  }
  return user;
}

function authHeader() {
  return { Authorization: `Bearer ${getToken()}` };
}
