/* Reel « Mamie avait raison » — no signal, 3 % battery, grandma's paper map…
   then the REAL BWR printable roadbook (map + named carrefours). 120 bpm. */
(function () {
  const { $, burst } = Reel;
  const { scene, show, flash, shake, cta, reset, ready } = Simple;
  const imgReady = new Promise(r => { const i = new Image(); i.onload = i.onerror = r; i.src = 'img/print-sheet.png'; });

  Reel.init({
    total: 13500,
    ready: Promise.all([ready(), imgReady]),
    // nostalgic A–F#m–D–E
    music: {
      bpm: 120, vol: 0.45, drumsFromBar: 0, pluckVol: 0.068,
      chords: [[220.0, 277.18, 329.63], [185.0, 220.0, 277.18], [146.83, 185.0, 220.0], [164.81, 207.65, 246.94]],
      tops: [659.25, 554.37, 587.33, 739.99],
      breaks: [[2.4, 2.9]],
    },
    cues: [
      [0, 'hit'], [300, 'stamp'], [800, 'pop'],
      [2400, 'whoosh'], [2600, 'pop'], [3100, 'stamp'],
      [4300, 'riser', 0.6],
      [4900, 'hit'], [4900, 'ding'],
      [5900, 'whoosh'], [6200, 'pop'],
      [7000, 'whoosh'], [7600, 'pop'], [8600, 'pop'],
      [9900, 'hit'], [10400, 'hit'], [10400, 'ding'],
      [11400, 'whoosh'],
    ],
    reset() { reset(); $('#sheet').classList.remove('scroll'); },
    events: [
      [0, scene('s1')], [300, () => { show('c1')(); shake('s1')(); }], [800, show('h1')],
      [2400, scene('s2')], [2600, show('h2')], [3100, show('p2')],
      [4900, () => { scene('s3')(); show('h3')(); flash(); }],
      [5900, scene('s4')], [6200, show('c4')],
      [7000, () => $('#sheet').classList.add('scroll')],
      [7600, show('k1')], [8600, show('k2')],
      [9900, () => { scene('s5')(); show('w1')(); }],
      [10400, () => { show('w2')(); flash(); burst(100, 0.6); }],
      [11400, cta],
    ],
  });
})();
