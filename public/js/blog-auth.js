/* blog-auth.js — reflect the signed-in state in the blog nav.
   Blog pages are public (crawlable) so they don't run the app's auth
   stack, which left the "Connexion" button showing even for a logged-in
   visitor. This tiny script reads the cached user and, when present,
   swaps that button for a link to the profile. No network call. */
(function () {
  try {
    var cached = localStorage.getItem('bwr_user');
    if (!cached) return;
    var user = JSON.parse(cached);
    if (!user) return;

    var first = (user.name && user.name.split(' ')[0]) || 'Profil';
    var icon = '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-3px;margin-right:4px"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/></svg>';

    var loginBtn = document.querySelector('.blog-nav-cta .btn-login');
    if (loginBtn) {
      loginBtn.href = '/profile';
      loginBtn.innerHTML = icon + first;
    }
  } catch (e) { /* localStorage unavailable — leave the login button as-is */ }
})();
