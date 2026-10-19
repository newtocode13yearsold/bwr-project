/* Reel « Le raccourci » — the friend who "knows a shortcut", 2 h of detour, then
   the real BWR A→B route on the real forest. 116 bpm, cuts on the beat-ish. */
(function () {
  const { burst } = Reel;
  const { scene, show, flash, shake, cta, reset, ready } = Simple;

  Reel.init({
    total: 13000,
    ready: ready(),
    // cheeky Em–C–G–D; a short break before the punchline
    music: {
      bpm: 116, vol: 0.46, drumsFromBar: 0, pluckVol: 0.07,
      chords: [[164.81, 196.0, 246.94], [130.81, 164.81, 196.0], [196.0, 246.94, 293.66], [146.83, 185.0, 220.0]],
      tops: [659.25, 523.25, 587.33, 739.99],
      breaks: [[5.6, 6.2]],
    },
    cues: [
      [0, 'hit'], [300, 'pop'], [700, 'pop'],
      [2600, 'hit'], [2600, 'whoosh'],
      [3100, 'stamp'], [3800, 'stamp'], [4500, 'stamp'],
      [5200, 'riser', 1.0],
      [6200, 'hit'], [6200, 'ding'],
      [7300, 'whoosh'], [7700, 'pop'],
      [8500, 'pop'], [9100, 'pop'], [9800, 'clap'],
      [10800, 'hit'],
    ],
    reset,
    events: [
      [0, scene('s1')], [300, show('c1')], [700, show('h1')],
      [2600, () => { scene('s2')(); show('c2')(); shake('s2')(); }],
      [3100, show('l1')], [3800, show('l2')], [4500, show('l3')],
      [6200, () => { scene('s3')(); show('h3')(); flash(); }],
      [7300, scene('s4')], [7700, show('c4')],
      [8500, show('k1')], [9100, show('k2')], [9800, show('k3')],
      [10800, cta],
      [11100, () => burst(90, 0.3)],
    ],
  });
})();
