/* Tiny helpers shared by the "série 3 — simple" reels, on top of reel-kit.js. */
(function () {
  const { $, pop } = Reel;
  window.Simple = {
    // show exactly one .scene
    scene: id => () => document.querySelectorAll('.scene').forEach(el => el.classList.toggle('in', el.id === id)),
    // pop one or more elements (ids, no '#')
    show: (...ids) => () => ids.forEach(id => pop('#' + id)),
    flash: () => pop('#flash'),
    shake: id => () => pop('#' + id, 'shake'),
    cta: () => { document.querySelectorAll('.scene').forEach(el => el.classList.remove('in')); $('#cta').classList.add('in'); },
    reset: () => document.querySelectorAll('.in,.shake').forEach(el => el.classList.remove('in', 'shake')),
    // resolves once every background image on the page has loaded
    ready: () => Promise.all([...document.querySelectorAll('.bg')].map(el => new Promise(r => {
      const m = /url\(["']?([^"')]+)/.exec(el.style.backgroundImage || ''); if (!m) return r();
      const i = new Image(); i.onload = i.onerror = r; i.src = m[1];
    }))),
  };
})();
