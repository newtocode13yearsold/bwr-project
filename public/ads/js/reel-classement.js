/* Reel « Le classement de la forêt » — your brother-in-law is 2nd on the BWR weekly
   leaderboard; you grade paths, your points climb, you overtake everyone. Then the
   real "Grand cartographe" quest prize (200 graded paths = 1 month of Pro). 120 bpm. */
(function () {
  const { $, burst } = Reel;
  const { scene, show, flash, shake, cta, reset, ready } = Simple;

  const setPts = v => () => { $('#mpt').textContent = v + (v > 1 ? ' pts' : ' pt'); };
  // "Toi" climbs 0 → 108 pts in 10 ticks
  const climb = Array.from({ length: 10 }, (_, i) => [7700 + i * 160, setPts(Math.round((i + 1) * 10.8))]);
  // move rows to new slots (CSS transition on top) and renumber everyone but "Toi"
  const order = ids => () => ids.forEach((id, i) => {
    const el = $('#' + id); el.style.setProperty('--i', i);
    if (id !== 'b5') el.querySelector('.rk').textContent = i + 1;
  });

  Reel.init({
    total: 14500,
    ready: ready(),
    // punchy Dm–Bb–F–C
    music: {
      bpm: 120, vol: 0.46, drumsFromBar: 0, pluckVol: 0.07,
      chords: [[146.83, 174.61, 220.0], [116.54, 146.83, 174.61], [174.61, 220.0, 261.63], [130.81, 164.81, 196.0]],
      tops: [587.33, 698.46, 659.25, 523.25],
      breaks: [[2.6, 3.1]],
    },
    cues: [
      [0, 'hit'], [300, 'stamp'], [700, 'pop'],
      [2600, 'whoosh'], [2800, 'pop'],
      [4400, 'hit'], [4700, 'pop'],
      [5000, 'pop'], [5150, 'pop'], [5300, 'pop'], [5450, 'pop'], [5700, 'stamp'],
      [6400, 'pop'], [7000, 'pop'],
      ...climb.map(([t]) => [t, 'tick']),
      [9400, 'whoosh'], [9700, 'hit'], [9700, 'ding'],
      [10900, 'hit'], [10900, 'sparkle'],
      [12500, 'whoosh'],
    ],
    reset() {
      reset();
      document.querySelectorAll('.top').forEach(el => el.classList.remove('top'));
      order(['b1', 'b2', 'b3', 'b4', 'b5'])();
      setPts(0)(); $('#mrk').textContent = '—';
    },
    events: [
      [0, () => { scene('s1')(); }], [300, () => { show('c1')(); shake('s1')(); }], [700, show('h1')],
      [2600, scene('s2')], [2800, show('h2')],
      [4400, scene('s3')], [4700, show('c3')],
      [5000, show('b1')], [5150, show('b2')], [5300, show('b3')], [5450, show('b4')], [5700, show('b5')],
      [6400, show('k1')], [7000, show('k2')],
      ...climb,
      [9700, () => { order(['b5', 'b1', 'b2', 'b3', 'b4'])(); $('#b5').classList.add('top'); $('#mrk').textContent = '1'; flash(); burst(80, 0.3); }],
      [10900, () => { scene('s4')(); show('h4')(); flash(); }],
      [12500, cta],
      [12800, () => burst(90, 0.3)],
    ],
  });
})();
