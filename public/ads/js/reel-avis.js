/* Reel « Les chemins ont des avis » — 3 funny trail reviews (5★ / 2★ / 4★) over the
   real graded map, then the full real map with all 446 graded paths. 120 bpm. */
(function () {
  const { burst } = Reel;
  const { scene, show, flash, cta, reset, ready } = Simple;

  Reel.init({
    total: 13500,
    ready: ready(),
    // warm F–C–Dm–Bb
    music: {
      bpm: 120, vol: 0.45, drumsFromBar: 0, pluckVol: 0.068,
      chords: [[174.61, 220.0, 261.63], [130.81, 164.81, 196.0], [146.83, 174.61, 220.0], [116.54, 146.83, 174.61]],
      tops: [698.46, 659.25, 587.33, 523.25],
      breaks: [[7.0, 7.5]],
    },
    cues: [
      [0, 'hit'], [300, 'pop'], [700, 'pop'],
      [2600, 'whoosh'], [3000, 'stamp'], [3200, 'sparkle'],
      [4400, 'stamp'], [5800, 'stamp'], [6400, 'pop'],
      [7500, 'hit'], [7500, 'ding'],
      [8500, 'whoosh'], [8900, 'pop'],
      [9700, 'pop'], [10400, 'pop'],
      [11300, 'hit'],
    ],
    reset,
    events: [
      [0, scene('s0')], [300, show('c0')], [700, show('h0')],
      [2600, scene('s1')], [3000, show('r1')], [4400, show('r2')], [5800, show('r3')], [6400, show('fn')],
      [7500, () => { scene('s2')(); show('h2')(); flash(); }],
      [8500, scene('s3')], [8900, show('c3')],
      [9700, show('k1')], [10400, show('k2')],
      [11300, cta],
      [11600, () => burst(90, 0.3)],
    ],
  });
})();
