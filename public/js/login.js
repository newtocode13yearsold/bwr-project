// Redirect if already logged in
const existingToken = localStorage.getItem('bwr_token');
if (existingToken) {
  fetch(`${API_URL}/api/auth/me`, { headers: { Authorization: `Bearer ${existingToken}` } })
    .then(r => { if (r.ok) window.location.href = 'index'; })
    .catch(() => {});
}

// Show a notice if the user was redirected here (e.g. the planner requires an account)
const loginNotice = sessionStorage.getItem('bwr_login_notice');
if (loginNotice) {
  sessionStorage.removeItem('bwr_login_notice');
  const noticeEl = document.getElementById('loginNotice');
  if (noticeEl) {
    noticeEl.textContent = loginNotice;
    noticeEl.classList.remove('hidden');
  }
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

// Open directly on the signup tab when arriving from a "Commencer gratuitement" CTA
// (?signup=1 or #signup) so new visitors land on account creation, not login.
if (/[?&]signup=1/.test(location.search) || location.hash === '#signup') {
  tabSignup.click();
}

// Two-step admin login state. Holds the short-lived challenge the server issues
// once the first password checks out; null means we're on the normal first step.
let pendingChallenge = null;

function showSecondPasswordStep() {
  document.getElementById('secondPwField').classList.remove('hidden');
  document.getElementById('loginEmail').readOnly = true;
  document.getElementById('loginPassword').readOnly = true;
  document.getElementById('loginError').classList.add('hidden');
  const pw2 = document.getElementById('loginPassword2');
  pw2.required = true;
  pw2.value = '';
  pw2.focus();
}

function resetSecondPasswordStep() {
  pendingChallenge = null;
  const pw2 = document.getElementById('loginPassword2');
  pw2.required = false;
  pw2.value = '';
  document.getElementById('secondPwField').classList.add('hidden');
  document.getElementById('loginEmail').readOnly = false;
  const pw = document.getElementById('loginPassword');
  pw.readOnly = false;
  pw.value = '';
  pw.focus();
}

// Login
loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const errorEl = document.getElementById('loginError');
  errorEl.classList.add('hidden');

  const email    = document.getElementById('loginEmail').value.trim();
  const password = document.getElementById('loginPassword').value;
  const pw2El    = document.getElementById('loginPassword2');

  // Two-step admin login: once the server has handed us a challenge, this submit
  // answers it with the second password instead of re-sending the first.
  const body = pendingChallenge
    ? { challenge: pendingChallenge, password2: pw2El.value }
    : { email, password };

  try {
    const res  = await fetch(`${API_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();

    // The main password was right, but this admin account needs a second one.
    if (res.ok && data.secondPassword && data.challenge) {
      pendingChallenge = data.challenge;
      showSecondPasswordStep();
      return;
    }

    if (!res.ok) {
      errorEl.textContent = data.error || 'Erreur de connexion.';
      errorEl.classList.remove('hidden');

      // A wrong second password: stay on the second step while tries remain,
      // otherwise the challenge is burned and we start over from the email.
      if (pendingChallenge) {
        if (data.secondPassword) {
          pw2El.value = '';
          pw2El.focus();
        } else {
          resetSecondPasswordStep();
        }
        return;
      }

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
    const redirect = sessionStorage.getItem('bwr_redirect');
    sessionStorage.removeItem('bwr_redirect');
    // First sign-in right after signup (server `onboarded:false`): go straight
    // to the map — that's where the welcome tour runs — not the home page.
    if (data.user && data.user.onboarded === false) {
      window.location.href = 'map';
      return;
    }
    window.location.href = redirect || 'index';
  } catch {
    errorEl.textContent = 'Impossible de contacter le serveur.';
    errorEl.classList.remove('hidden');
  }
});

// Resend verification panel
const resendPanel    = document.getElementById('resendPanel');
const showResendLink = document.getElementById('showResendLink');
const hideResendLink = document.getElementById('hideResendLink');
const resendBtn      = document.getElementById('resendBtn');
const resendMsg      = document.getElementById('resendMsg');

showResendLink.addEventListener('click', (e) => {
  e.preventDefault();
  loginForm.classList.add('hidden');
  resendPanel.classList.remove('hidden');
  resendMsg.classList.add('hidden');
});

hideResendLink.addEventListener('click', (e) => {
  e.preventDefault();
  resendPanel.classList.add('hidden');
  loginForm.classList.remove('hidden');
});

resendBtn.addEventListener('click', async () => {
  const email = document.getElementById('resendEmail').value.trim();
  if (!email) return;
  resendBtn.disabled = true;
  resendBtn.textContent = 'Envoi…';
  resendMsg.classList.add('hidden');
  try {
    const r = await fetch(`${API_URL}/api/auth/resend-verification`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    const d = await r.json();
    resendMsg.textContent = d.error || d.message || 'Email envoyé.';
    resendMsg.style.color = r.ok ? '#2d6b1f' : '';
    resendMsg.classList.remove('hidden');
  } catch {
    resendMsg.textContent = 'Impossible de contacter le serveur.';
    resendMsg.classList.remove('hidden');
  }
  resendBtn.disabled = false;
  resendBtn.textContent = 'Renvoyer l\'email de vérification';
});

// Forgot-password panel
const forgotPanel    = document.getElementById('forgotPanel');
const showForgotLink = document.getElementById('showForgotLink');
const hideForgotLink = document.getElementById('hideForgotLink');
const forgotBtn      = document.getElementById('forgotBtn');
const forgotMsg      = document.getElementById('forgotMsg');

showForgotLink.addEventListener('click', (e) => {
  e.preventDefault();
  loginForm.classList.add('hidden');
  forgotPanel.classList.remove('hidden');
  forgotMsg.classList.add('hidden');
  // Pre-fill with whatever was typed in the login email field.
  document.getElementById('forgotEmail').value = document.getElementById('loginEmail').value.trim();
});

hideForgotLink.addEventListener('click', (e) => {
  e.preventDefault();
  forgotPanel.classList.add('hidden');
  loginForm.classList.remove('hidden');
});

forgotBtn.addEventListener('click', async () => {
  const email = document.getElementById('forgotEmail').value.trim();
  if (!email) return;
  forgotBtn.disabled = true;
  forgotBtn.textContent = 'Envoi…';
  forgotMsg.classList.add('hidden');
  try {
    const r = await fetch(`${API_URL}/api/auth/forgot-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    const d = await r.json();
    forgotMsg.textContent = d.error || d.message || 'Email envoyé.';
    forgotMsg.style.color = r.ok ? '#2d6b1f' : '';
    forgotMsg.classList.remove('hidden');
  } catch {
    forgotMsg.textContent = 'Impossible de contacter le serveur.';
    forgotMsg.classList.remove('hidden');
  }
  forgotBtn.disabled = false;
  forgotBtn.textContent = 'Envoyer le lien de réinitialisation';
});

// Password visibility toggles
document.querySelectorAll('.pw-eye').forEach(btn => {
  btn.addEventListener('click', () => {
    const input = document.getElementById(btn.dataset.target);
    const showing = btn.classList.toggle('visible');
    input.type = showing ? 'text' : 'password';
    btn.setAttribute('aria-label', showing ? 'Masquer le mot de passe' : 'Afficher le mot de passe');
  });
});

// Sign up
signupForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const errorEl   = document.getElementById('signupError');
  const successEl = document.getElementById('signupSuccess');
  errorEl.classList.add('hidden');
  successEl.classList.add('hidden');

  const name     = document.getElementById('signupName').value.trim();
  const username = document.getElementById('signupUsername').value.trim();
  const email    = document.getElementById('signupEmail').value.trim();
  const password = document.getElementById('signupPassword').value;

  if (!/^(?=.*[A-Z])(?=.*[0-9])(?=.*[^A-Za-z0-9]).{8,}$/.test(password)) {
    errorEl.textContent = 'Le mot de passe doit faire au moins 8 caractères et contenir une majuscule, un chiffre et un caractère spécial.';
    errorEl.classList.remove('hidden');
    return;
  }

  try {
    const res  = await fetch(`${API_URL}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, username, email, password }),
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
    // Account is created — lock the form so the fields can't be filled in
    // again: hide every field + the submit button, keep only the message.
    Array.from(signupForm.children).forEach(el => {
      if (el !== successEl) el.classList.add('hidden');
    });
    signupForm.querySelectorAll('input, button').forEach(el => { el.disabled = true; });
  } catch {
    errorEl.textContent = 'Impossible de contacter le serveur.';
    errorEl.classList.remove('hidden');
  }
});
