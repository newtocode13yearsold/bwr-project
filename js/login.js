// Redirect if already logged in
const existingToken = localStorage.getItem('bwr_token');
if (existingToken) {
  fetch(`${API_URL}/api/auth/me`, { headers: { Authorization: `Bearer ${existingToken}` } })
    .then(r => { if (r.ok) window.location.href = 'map.html'; })
    .catch(() => {});
}

// Tab switching
const tabLogin  = document.getElementById('tabLogin');
const tabSignup = document.getElementById('tabSignup');
const loginForm  = document.getElementById('loginForm');
const signupForm = document.getElementById('signupForm');

tabLogin.addEventListener('click', () => {
  tabLogin.classList.add('active');
  tabSignup.classList.remove('active');
  loginForm.classList.remove('hidden');
  signupForm.classList.add('hidden');
});

tabSignup.addEventListener('click', () => {
  tabSignup.classList.add('active');
  tabLogin.classList.remove('active');
  signupForm.classList.remove('hidden');
  loginForm.classList.add('hidden');
});

// Login
loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const errorEl = document.getElementById('loginError');
  errorEl.classList.add('hidden');

  const email    = document.getElementById('loginEmail').value.trim();
  const password = document.getElementById('loginPassword').value;

  try {
    const res  = await fetch(`${API_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const data = await res.json();

    if (!res.ok) {
      errorEl.textContent = data.error || 'Erreur de connexion.';
      errorEl.classList.remove('hidden');

      if (data.unverified) {
        const resendBtn = document.createElement('button');
        resendBtn.type = 'button';
        resendBtn.textContent = 'Renvoyer l\'email de vérification';
        resendBtn.className = 'btn-secondary';
        resendBtn.style.marginTop = '.5rem';
        resendBtn.onclick = async () => {
          resendBtn.disabled = true;
          resendBtn.textContent = 'Envoi…';
          try {
            const r = await fetch(`${API_URL}/api/auth/resend-verification`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ email }),
            });
            const d = await r.json();
            resendBtn.textContent = d.error || d.message || 'Email envoyé.';
          } catch {
            resendBtn.textContent = 'Erreur — réessayez.';
            resendBtn.disabled = false;
          }
        };
        errorEl.appendChild(document.createElement('br'));
        errorEl.appendChild(resendBtn);
      }

      return;
    }

    localStorage.setItem('bwr_token', data.token);
    localStorage.setItem('bwr_user', JSON.stringify(data.user));
    window.location.href = 'map.html';
  } catch {
    errorEl.textContent = 'Impossible de contacter le serveur.';
    errorEl.classList.remove('hidden');
  }
});

// Sign up
signupForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const errorEl   = document.getElementById('signupError');
  const successEl = document.getElementById('signupSuccess');
  errorEl.classList.add('hidden');
  successEl.classList.add('hidden');

  const name     = document.getElementById('signupName').value.trim();
  const email    = document.getElementById('signupEmail').value.trim();
  const password = document.getElementById('signupPassword').value;

  try {
    const res  = await fetch(`${API_URL}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, email, password }),
    });
    const data = await res.json();

    if (!res.ok) {
      errorEl.textContent = data.error || 'Erreur lors de la création du compte.';
      errorEl.classList.remove('hidden');
      return;
    }

    successEl.textContent = data.message || 'Un email de vérification a été envoyé. Vérifiez votre boîte mail pour activer votre compte.';
    successEl.classList.remove('hidden');
    signupForm.reset();
  } catch {
    errorEl.textContent = 'Impossible de contacter le serveur.';
    errorEl.classList.remove('hidden');
  }
});
