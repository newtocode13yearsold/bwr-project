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

    successEl.textContent = 'Compte créé ! Tu peux maintenant te connecter.';
    successEl.classList.remove('hidden');
    signupForm.reset();

    // Switch to login tab after 1.5s
    setTimeout(() => {
      tabLogin.click();
      document.getElementById('loginEmail').value = email;
    }, 1500);
  } catch {
    errorEl.textContent = 'Impossible de contacter le serveur.';
    errorEl.classList.remove('hidden');
  }
});
