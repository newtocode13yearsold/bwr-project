// Toolbar for public/ads/affiches-campagne.html — screen only, never printed.
// External (not inline) so the page also survives the site CSP, which has no
// 'unsafe-inline'. "Les 5" shows every sheet (Ctrl+P → one 5-page PDF); picking
// a number isolates that affiche (Ctrl+P → that single A4).
(function () {
  var bar = document.querySelector('.bar');
  if (!bar) return;
  var sheets = Array.prototype.slice.call(document.querySelectorAll('.sheet'));
  var btns = Array.prototype.slice.call(bar.querySelectorAll('button[data-n]'));

  function show(n) {
    document.body.classList.toggle('solo', n !== 0);
    sheets.forEach(function (s) {
      s.classList.toggle('show', String(s.dataset.affiche) === String(n));
    });
    btns.forEach(function (b) { b.classList.toggle('on', Number(b.dataset.n) === n); });
    window.scrollTo(0, 0);
  }

  btns.forEach(function (b) {
    b.addEventListener('click', function () { show(Number(b.dataset.n)); });
  });

  var print = document.getElementById('printBtn');
  if (print) print.addEventListener('click', function () { window.print(); });

  // ?a=3 deep-links a single affiche (handy when sharing one to a printer).
  var m = location.search.match(/[?&]a=([1-5])/);
  show(m ? Number(m[1]) : 0);
})();
