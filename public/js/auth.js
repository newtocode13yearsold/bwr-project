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
    if (res.ok) {
      const user = await res.json();
      // Refresh the offline cache so the session survives going offline.
      try { localStorage.setItem('bwr_user', JSON.stringify(user)); } catch (_) {}
      return user;
    }
    // 401 = token genuinely invalid/expired → log out for real.
    if (res.status === 401) { clearSession(); return null; }
    // Server unreachable (503 from the service worker while offline) or a
    // transient 5xx → keep the cached session so the app still works offline.
    return getCachedUser();
  } catch {
    // Network failure → offline. Trust the cached session.
    return getCachedUser();
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

// Redirects to login if not authenticated, or if requiredRole is set and user doesn't have it.
// `notice` (optional) is shown on the login page to explain why the user was redirected.
async function requireAuth(requiredRole = null, notice = null) {
  const user = await fetchCurrentUser();
  if (!user) {
    sessionStorage.setItem('bwr_redirect', window.location.href);
    if (notice) sessionStorage.setItem('bwr_login_notice', notice);
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

// ── Activity tracking ───────────────────────────────────────────────────────
// Page views are NOT tracked: anonymous visits could be search-engine bots and
// only inflated the admin counts. The admin panel now counts real logins and new
// accounts only — those are recorded server-side in the worker (recordAuthEvent),
// so there is nothing to send from the browser.
