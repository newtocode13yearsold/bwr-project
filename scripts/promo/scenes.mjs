// Scene definitions for the BWR Instagram promo reel.
// Each scene navigates to a page on the live site, then runs a short
// scripted "tour" (scroll + a couple of safe interactions). Captions are
// injected as an on-screen banner so they get baked into the recording.
//
// To add/reorder scenes, just edit this array — make-promo.mjs consumes it.

export const scenes = [
  {
    id: 'home',
    url: '/index.html',
    caption: 'BWR — la carte qui simplifie ta vie',
    sub: 'Bike · Walk · Run',
    async run(page, h) {
      await h.settle(1500);
      await h.slowScroll(page, 0.0, 0.45);   // hero
      await h.settle(700);
      await h.slowScroll(page, 0.45, 0.9);    // features carousel + CTAs
      await h.settle(700);
      await h.scrollToTop(page);
      await h.settle(600);
    },
  },
  {
    id: 'map',
    url: '/map.html',
    caption: 'Tous les sentiers de Compiègne',
    sub: 'Carte interactive · état des chemins en temps réel',
    async run(page, h) {
      await h.waitFor(page, '.leaflet-container', 12000);
      await h.settle(2500);                   // let tiles + paths render
      await h.tryClick(page, '.leaflet-control-zoom-in');
      await h.settle(1800);
      await h.tryClick(page, '.leaflet-control-zoom-in');
      await h.settle(2200);
    },
  },
  {
    id: 'routes',
    url: '/routes.html',
    caption: 'Planifie ton itinéraire en 3 clics',
    sub: 'Boucle ou A→B · facile à difficile · GPX & Strava',
    auth: true,
    async run(page, h) {
      await h.settle(1600);
      // Pick a priority / difficulty if the buttons are present.
      await h.tryClick(page, '#priorityGroup .seg-btn, #priorityGroup button, #priorityGroup .opt');
      await h.settle(1100);
      await h.tryClick(page, '#surfaceGroup .seg-btn, #surfaceGroup button, #surfaceGroup .opt');
      await h.settle(1100);
      await h.slowScroll(page, 0.0, 0.6);
      await h.settle(900);
      await h.slowScroll(page, 0.6, 1.0);
      await h.settle(900);
    },
  },
  {
    id: 'profile',
    url: '/profile.html',
    caption: 'Badges, défis & roue de la chance',
    sub: 'Suis ta progression · météo · objectifs',
    auth: true,
    weather: true,
    async run(page, h) {
      await h.settle(1800);
      await h.slowScroll(page, 0.0, 0.5);
      await h.settle(800);
      // Spin the wheel for a little motion, if available.
      await h.tryClick(page, '#wheelSpinBtn');
      await h.settle(2600);
      await h.slowScroll(page, 0.5, 1.0);
      await h.settle(900);
    },
  },
];
