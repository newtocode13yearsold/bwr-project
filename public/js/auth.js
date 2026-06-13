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

// ── Persistent anonymous visitor ID (survives sessions, never changes per device) ──
function getVisitorId() {
  let id = localStorage.getItem('bwr_visitor_id');
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem('bwr_visitor_id', id);
  }
  return id;
}

// ── Page-visit tracking ────────────────────────────────────────────────────
(function trackPageVisit() {
  try {
    // Deduplicate: only ping once per page per device per 30 min (across all tabs)
    const dedupKey = 'bwr_visited_' + location.pathname;
    const last = parseInt(localStorage.getItem(dedupKey) || '0', 10);
    if (Date.now() - last < 30 * 60 * 1000) return;
    localStorage.setItem(dedupKey, String(Date.now()));
    const startTime = Date.now();
    const token   = getToken();
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    fetch(`${API_URL}/api/analytics/visit`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ page: location.pathname, visitorId: getVisitorId() }),
    }).then(r => r.json()).then(data => {
      if (!data.visitKey) return;
      window.addEventListener('pagehide', () => {
        navigator.sendBeacon(
          `${API_URL}/api/analytics/visit/duration`,
          new Blob([JSON.stringify({ visitKey: data.visitKey, duration: Date.now() - startTime })], { type: 'application/json' })
        );
      });
    }).catch(() => {});
  } catch (_) {}
})();
