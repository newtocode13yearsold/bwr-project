(async () => {
  const statusEl = document.getElementById('status');
  const token = new URLSearchParams(location.search).get('token');

  if (!token) {
    statusEl.innerHTML = '<p style="color:#ef4444;">Lien invalide.</p><p><a href="login">Retour à la connexion</a></p>';
    return;
  }

  try {
    const res  = await fetch(`${API_URL}/api/auth/verify?token=${encodeURIComponent(token)}`);
    const data = await res.json();

    if (res.ok) {
      statusEl.innerHTML = `
        <p style="font-size:2rem;">✓</p>
        <p style="font-weight:600;color:#22c55e;">${data.message}</p>
        <p style="margin-top:1rem;"><a href="login" class="btn-primary" style="display:inline-block;text-decoration:none;padding:.6rem 1.4rem;border-radius:8px;">Se connecter</a></p>`;
    } else {
      statusEl.innerHTML = `
        <p style="color:#ef4444;">${data.error || 'Lien invalide ou expiré.'}</p>
        <p style="margin-top:1rem;font-size:.9rem;">Le lien de vérification est valable 24 heures. Si le vôtre a expiré, inscrivez-vous à nouveau.</p>
        <p><a href="login">Retour à la connexion</a></p>`;
    }
  } catch {
    statusEl.innerHTML = '<p style="color:#ef4444;">Impossible de contacter le serveur. Réessayez plus tard.</p>';
  }
})();
