// profile-tabs.js — the three-tab layout of the profile page
// (Activité / Récompenses / Compte).
// Only one panel is visible at a time. The active tab is mirrored in the URL
// hash (#activite / #recompenses / #compte) so a link can open a given tab and
// the browser's back button walks between tabs.
(function () {
  const tabs = Array.from(document.querySelectorAll('.profile-tab'));
  if (!tabs.length) return;
  const names = tabs.map(t => t.dataset.tab);

  function show(name, focus) {
    if (!names.includes(name)) name = names[0];
    tabs.forEach(tab => {
      const on = tab.dataset.tab === name;
      tab.classList.toggle('active', on);
      tab.setAttribute('aria-selected', on ? 'true' : 'false');
      tab.tabIndex = on ? 0 : -1;
      const panel = document.getElementById(`panel-${tab.dataset.tab}`);
      if (panel) panel.hidden = !on;
      if (on && focus) tab.focus();
    });
  }

  tabs.forEach((tab, i) => {
    tab.addEventListener('click', () => {
      if (location.hash !== `#${tab.dataset.tab}`) history.pushState(null, '', `#${tab.dataset.tab}`);
      show(tab.dataset.tab);
    });
    // Arrow keys move between tabs (WAI-ARIA tabs pattern).
    tab.addEventListener('keydown', e => {
      const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
      if (!step) return;
      e.preventDefault();
      const next = tabs[(i + step + tabs.length) % tabs.length];
      history.replaceState(null, '', `#${next.dataset.tab}`);
      show(next.dataset.tab, true);
    });
  });

  window.addEventListener('popstate', () => show(location.hash.slice(1)));
  show(location.hash.slice(1));
})();
