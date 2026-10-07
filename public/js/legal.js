/* ──────────────────────────────────────────────────────────────────────────
   Legal page — audience-measurement opt-out.

   The CNIL exempts audience measurement from prior consent only if visitors
   can refuse it. Ticking the box sets the same `bwr_notrack` flag js/track.js
   already honours (and drops the anonymous `bwr_vid`); unticking clears it.
   ────────────────────────────────────────────────────────────────────────── */
(function () {
  var box = document.getElementById('lgNoTrack');
  var status = document.getElementById('lgNoTrackStatus');
  if (!box) return;

  function read() {
    try { return localStorage.getItem('bwr_notrack') === '1'; } catch (_) { return false; }
  }
  function show(off) {
    status.textContent = off
      ? 'Vos visites ne sont plus mesurées sur ce navigateur.'
      : 'Vos visites sont mesurées de façon anonyme.';
  }

  box.checked = read();
  show(box.checked);

  box.addEventListener('change', function () {
    try {
      if (box.checked) {
        localStorage.setItem('bwr_notrack', '1');
        localStorage.removeItem('bwr_vid');
        localStorage.removeItem('bwr_vid_t');
      } else {
        localStorage.removeItem('bwr_notrack');
      }
    } catch (_) {
      status.textContent = 'Impossible d\'enregistrer ce choix : le stockage du navigateur est désactivé.';
      return;
    }
    show(box.checked);
  });
})();
