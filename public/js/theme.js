/* ── BWR Theme Toggle ─────────────────────────────────────────────────────────
 * Loaded in <head> to prevent FOUC.
 * Priority: localStorage > OS preference > light
 * ────────────────────────────────────────────────────────────────────────── */
(function () {
  function applyTheme(dark) {
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  }

  var saved = localStorage.getItem('bwr_theme');
  var prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  applyTheme(saved === 'dark' || (!saved && prefersDark));

  function updateIcons() {
    var isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    document.querySelectorAll('.theme-toggle-icon').forEach(function (el) {
      el.textContent = isDark ? '☀️' : '🌙';
    });
  }

  window.__bwrToggleTheme = function () {
    var isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    applyTheme(!isDark);
    localStorage.setItem('bwr_theme', !isDark ? 'dark' : 'light');
    updateIcons();
  };

  document.addEventListener('DOMContentLoaded', function () {
    updateIcons();
    var btn = document.getElementById('btnThemeToggle');
    if (btn) btn.addEventListener('click', window.__bwrToggleTheme);
  });
})();
