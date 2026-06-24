// ─────────────────────────────────────────────────────────────────────────────
//  Per-run "variety" engine for the BWR promo/ad/tutorial generators.
//
//  Goal: stop every export from looking identical. On each generation this
//  picks — at random — an accent palette, a shuffled subset of the b-roll
//  photos (so the intro montage + transitions differ), and one set of hook /
//  flash / call-to-action copy from rotating pools.
//
//  Usage:
//    import { pickVariant } from './variety.mjs';
//    const V = pickVariant('ad');   // 'ad' | 'tuto' | 'promo'
//    V.accent, V.deep, V.deep2      // colours
//    V.intro                        // array of hook lines (may contain <b>)
//    V.flashes                      // shuffled array of short transition lines
//    V.cta                          // { tag, cta }
//    V.pickBroll(allBroll)          // shuffled subset of the loaded photos
// ─────────────────────────────────────────────────────────────────────────────

// Accent palettes — each still reads as "outdoors" but gives a clearly
// different colour signature from one render to the next.
const PALETTES = [
  { name: 'lime',    accent: '#a3e635', deep: '#1e4d14', deep2: '#0b1a0c' },
  { name: 'emerald', accent: '#22c55e', deep: '#14532d', deep2: '#08160d' },
  { name: 'amber',   accent: '#f59e0b', deep: '#4a3410', deep2: '#1a1206' },
  { name: 'sky',     accent: '#38bdf8', deep: '#0c4a6e', deep2: '#06141f' },
  { name: 'violet',  accent: '#c084fc', deep: '#3b1d63', deep2: '#120a1f' },
];

// Intro hook line-sets, per video kind. Each is an array of on-screen lines;
// <b> wraps the word that gets the accent colour.
const INTRO = {
  ad: [
    ['Marre de tourner', 'en rond en <b>forêt</b> ?', '', 'BWR s’en charge.'],
    ['Et si chaque', 'balade devenait', 'une <b>aventure</b> ?', ''],
    ['La forêt de', 'Compiègne', 'comme tu ne', 'l’as <b>jamais vue</b>'],
    ['Trace. Marche.', 'Pédale. Cours.', '', 'Une seule <b>appli</b>.'],
  ],
  tuto: [
    ['Comment utiliser', '<b>BWR</b>', '', 'en 30 secondes'],
    ['<b>BWR</b> en', '4 étapes', '', 'c’est parti 👇'],
    ['Ta première', 'rando avec', '<b>BWR</b>', ''],
  ],
  promo: [
    ['Tous tes sentiers,', 'une seule <b>appli</b>'],
    ['La carte qui', 'simplifie ta <b>vie</b>'],
  ],
};

// Short full-screen transition captions (shuffled, consumed in order).
const FLASHES = [
  'Tous les sentiers, en un coup d’œil',
  'Vélo, marche ou course ?',
  'Repousse tes limites',
  'La forêt, sans te perdre',
  'Trouve ta prochaine boucle',
  'Hors des sentiers battus',
  'Ta trace, partout avec toi',
];

// End-card call-to-action variants.
const CTAS = [
  { tag: 'Bike · Walk · Run — la carte qui simplifie ta vie', cta: 'Essaie gratuitement →' },
  { tag: 'Toute la forêt de Compiègne dans ta poche 🌲',       cta: 'Commence maintenant →' },
  { tag: 'Trace ta rando en 10 secondes 🥾🚲',                 cta: 'Teste gratuitement →' },
  { tag: 'Maintenant, à toi de jouer 🌲',                      cta: 'Commence gratuitement →' },
];

export function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

export function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function pickVariant(kind = 'ad') {
  const palette = pick(PALETTES);
  return {
    kind,
    palette,
    accent: palette.accent,
    deep: palette.deep,
    deep2: palette.deep2,
    intro: pick(INTRO[kind] || INTRO.ad),
    flashes: shuffle(FLASHES),
    cta: pick(CTAS),
    // Random shuffled subset of the loaded photos (4–6, or fewer if not enough).
    pickBroll(all, min = 4, max = 6) {
      if (!all || !all.length) return [];
      const hi = Math.min(max, all.length);
      const lo = Math.min(min, all.length);
      const n = lo + Math.floor(Math.random() * (hi - lo + 1));
      return shuffle(all).slice(0, n);
    },
    describe() {
      return `palette=${palette.name} · ${this.intro.join(' ').replace(/<\/?b>/g, '')} · cta="${this.cta.cta}"`;
    },
  };
}
