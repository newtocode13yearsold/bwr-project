// Password-reset page: reads the ?token= from the email link, lets the user pick
// a new password, and posts to /api/auth/reset-password.
(() => {
  const token     = new URLSearchParams(location.search).get('token');
  const form      = document.getElementById('resetForm');
  const errorEl   = document.getElementById('resetError');
  const statusEl  = document.getElementById('resetStatus');

  // No token in the URL → the link is malformed.
  if (!token) {
    form.classList.add('hidden');
    statusEl.classList.remove('hidden');
    statusEl.innerHTML = `
      <p style="color:#ef4444;">Lien invalide.</p>
      <p style="margin-top:1rem;"><a href="login">Retour à la connexion</a></p>`;
    return;
  }

  // Password visibility toggle (matches login page behaviour).
  document.querySelectorAll('.pw-eye').forEach(btn => {
    btn.addEventListener('click', () => {
      const input = document.getElementById(btn.dataset.target);
      const showing = btn.classList.toggle('visible');
      input.type = showing ? 'text' : 'password';
      btn.setAttribute('aria-label', showing ? 'Masquer le mot de passe' : 'Afficher le mot de passe');
    });
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorEl.classList.add('hidden');

    const password = document.getElementById('resetPassword').value;
    if (password.length < 8) {
      errorEl.textContent = 'Le mot de passe doit faire au moins 8 caractères.';
      errorEl.classList.remove('hidden');
      return;
    }

    const btn = form.querySelector('button[type="submit"]');
    btn.disabled = true;
    btn.textContent = 'Réinitialisation…';

    try {
      const res  = await fetch(`${API_URL}/api/auth/reset-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, password }),
      });
      const data = await res.json();

      if (!res.ok) {
        errorEl.textContent = data.error || 'Lien invalide ou expiré.';
        errorEl.classList.remove('hidden');
        btn.disabled = false;
        btn.textContent = 'Réinitialiser';
        return;
      }

      form.classList.add('hidden');
      statusEl.classList.remove('hidden');
      statusEl.innerHTML = `
        <p style="font-size:2rem;">✓</p>
        <p style="font-weight:600;color:#22c55e;">${data.message}</p>
        <p style="margin-top:1rem;"><a href="login" class="btn-primary" style="display:inline-block;text-decoration:none;padding:.6rem 1.4rem;border-radius:8px;">Se connecter</a></p>`;
    } catch {
      errorEl.textContent = 'Impossible de contacter le serveur. Réessayez plus tard.';
      errorEl.classList.remove('hidden');
      btn.disabled = false;
      btn.textContent = 'Réinitialiser';
    }
  });
})();
