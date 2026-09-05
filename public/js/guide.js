// guide.js — lightweight theme toggle for the guide page (mirrors theme.js behaviour).
// Moved out of an inline <script> in guide.html: the site CSP is `script-src 'self'`
// (no 'unsafe-inline'), so the inline handler was blocked and the toggle never worked.
(function () {
  var btn = document.getElementById('btnGuideTheme');
  function sync() {
    var dark = document.documentElement.getAttribute('data-theme') === 'dark';
    if (btn) btn.textContent = dark ? '☀️' : '🌙';
  }
  if (btn) btn.addEventListener('click', function () {
    var dark = document.documentElement.getAttribute('data-theme') === 'dark';
    var next = dark ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    try { localStorage.setItem('bwr_theme', next); } catch (e) {}
    sync();
  });
  sync();
})();
