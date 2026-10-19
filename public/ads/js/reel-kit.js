/* ─────────────────────────────────────────────────────────────────────────────
   BWR reel kit — shared engine for the "série 2" Instagram reels
   (promo-chat / promo-types / promo-replay / promo-kinetic).

   A reel page defines its scenes, then calls:

     Reel.init({
       total: 15000,                       // ms — whole timeline incl. CTA
       music: { bpm, chords, tops, drumsFromBar, breaks:[[s,e]], riserAt },
       cues:  [[ms,'pop'|'ding'|'whoosh'|'hit'|'riser'|'clap'], …],
       reset(){ … },                       // put every element back to frame 0
       events: [[ms, fn], …],              // absolute-time scene changes
       ready: Promise                      // optional: assets that must load first
     });

   Timing is ABSOLUTE (ms from play start), so the offline-rendered music + sound
   effects (renderMusicWav) line up with the recorded video frame-for-frame once
   scripts/promo/make-reels2.mjs trims the recording to the play() call.

   Exposes the globals the render pipeline expects: play(), TOTAL,
   renderMusicWav(seconds), __reelReady.
   ───────────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';
  const $ = s => document.querySelector(s);
  const qs = new URLSearchParams(location.search);
  if (qs.has('bare')) document.body.classList.add('bare');

  let cfg = null, timers = [], audioCtx = null, musicMaster = null;

  // ── music + sfx graph (works for live AudioContext and OfflineAudioContext) ──
  function buildGraph(ac, t0, dur, m, cues) {
    const master = ac.createGain();
    const vol = m.vol || 0.5;
    master.gain.setValueAtTime(0, t0);
    master.gain.linearRampToValueAtTime(vol, t0 + (m.fadeIn ?? 0.6));
    master.gain.setValueAtTime(vol, t0 + dur - 1.6);
    master.gain.linearRampToValueAtTime(0, t0 + dur);

    const delay = ac.createDelay(1.0); delay.delayTime.value = 0.19;
    const fb = ac.createGain(); fb.gain.value = 0.24;
    const wet = ac.createGain(); wet.gain.value = 0.18;
    delay.connect(fb); fb.connect(delay); delay.connect(wet); wet.connect(master);

    const nbuf = ac.createBuffer(1, Math.ceil(ac.sampleRate * 2.5), ac.sampleRate);
    const nd = nbuf.getChannelData(0); for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;

    const inBreak = s => (m.breaks || []).some(([a, b]) => s - t0 >= a && s - t0 < b);

    function tone(f, s, d, gain, type = 'sine', dest = master, send = true) {
      const o = ac.createOscillator(); o.type = type; o.frequency.value = f;
      const g = ac.createGain();
      g.gain.setValueAtTime(0, s); g.gain.linearRampToValueAtTime(gain, s + 0.006);
      g.gain.exponentialRampToValueAtTime(0.0001, s + d);
      o.connect(g); g.connect(dest); if (send) g.connect(delay);
      o.start(s); o.stop(s + d + 0.05);
    }
    function pluck(f, s, d, gain) { tone(f, s, d, gain, 'sine'); tone(f * 1.004, s, d, gain * 0.45, 'triangle', master, false); }
    function pad(freqs, s, d) {
      freqs.forEach(f => {
        const o = ac.createOscillator(); o.type = 'sawtooth'; o.frequency.value = f / 2;
        const lp = ac.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = m.padCutoff || 900;
        const g = ac.createGain(); const pv = m.padVol ?? 0.02;
        g.gain.setValueAtTime(0, s); g.gain.linearRampToValueAtTime(pv, s + 0.4);
        g.gain.setValueAtTime(pv, Math.max(s + 0.4, s + d - 0.4)); g.gain.linearRampToValueAtTime(0, s + d);
        o.connect(lp); lp.connect(g); g.connect(master); o.start(s); o.stop(s + d + 0.06);
      });
    }
    function noise(s, d, gain, type, freq, q) {
      const src = ac.createBufferSource(); src.buffer = nbuf;
      const f = ac.createBiquadFilter(); f.type = type; f.frequency.value = freq; if (q) f.Q.value = q;
      const g = ac.createGain(); g.gain.setValueAtTime(0, s); g.gain.linearRampToValueAtTime(gain, s + 0.004);
      g.gain.exponentialRampToValueAtTime(0.0001, s + d);
      src.connect(f); f.connect(g); g.connect(master); src.start(s); src.stop(s + d + 0.02);
      return f;
    }
    function kick(s, gain = 0.17) {
      const o = ac.createOscillator(); o.type = 'sine';
      o.frequency.setValueAtTime(150, s); o.frequency.exponentialRampToValueAtTime(46, s + 0.12);
      const g = ac.createGain(); g.gain.setValueAtTime(0, s); g.gain.linearRampToValueAtTime(gain, s + 0.006);
      g.gain.exponentialRampToValueAtTime(0.0001, s + 0.24); o.connect(g); g.connect(master); o.start(s); o.stop(s + 0.3);
    }

    // sound effects, placed at the same absolute times as the visual events
    const SFX = {
      pop(s)    { tone(880, s, 0.09, 0.16, 'sine', master, false); tone(1320, s + 0.035, 0.08, 0.1, 'sine', master, false); },
      ding(s)   { tone(1568, s, 0.5, 0.12, 'sine'); tone(2093, s + 0.08, 0.6, 0.09, 'sine'); },
      whoosh(s) { const f = noise(s, 0.45, 0.14, 'bandpass', 600, 0.8);
                  f.frequency.setValueAtTime(400, s); f.frequency.exponentialRampToValueAtTime(3800, s + 0.4); },
      hit(s)    { kick(s, 0.3); noise(s, 0.22, 0.12, 'highpass', 2500); tone(55, s, 0.5, 0.18, 'sine', master, false); },
      clap(s)   { noise(s, 0.14, 0.14, 'bandpass', 1500, 0.7); },
      tick(s)   { tone(2400, s, 0.03, 0.06, 'square', master, false); },
      // christmas extras
      jingle(s) { [0, .05, .1, .16, .23].forEach((o, i) => { noise(s + o, 0.09, 0.07, 'highpass', 7800);
                  tone([3136, 3520, 3951, 4186, 3729][i], s + o, 0.18, 0.025, 'sine', master, false); }); },
      sparkle(s){ [1568, 1976, 2349, 3136].forEach((fr, i) => tone(fr, s + i * 0.06, 0.45, 0.07, 'sine')); },
      stamp(s)  { kick(s, 0.32); noise(s, 0.12, 0.2, 'lowpass', 900); },
      roll(s, d = 1.5) { for (let t = 0; t < d; t += 0.045) noise(s + t, 0.06, 0.03 + 0.09 * t / d, 'bandpass', 1700, 0.8); },
      riser(s, d = 2) {
        const src = ac.createBufferSource(); src.buffer = nbuf;
        const f = ac.createBiquadFilter(); f.type = 'bandpass'; f.Q.value = 1.2;
        f.frequency.setValueAtTime(300, s); f.frequency.exponentialRampToValueAtTime(6000, s + d);
        const g = ac.createGain(); g.gain.setValueAtTime(0.0001, s); g.gain.exponentialRampToValueAtTime(0.16, s + d);
        g.gain.linearRampToValueAtTime(0, s + d + 0.02);
        src.connect(f); f.connect(g); g.connect(master); src.start(s); src.stop(s + d + 0.05);
      },
    };
    (cues || []).forEach(([ms, kind, arg]) => { const s = t0 + ms / 1000; if (SFX[kind] && s < t0 + dur) SFX[kind](s, arg); });

    // the bed: pad + arpeggio + drums, chord per bar
    const beat = 60 / m.bpm, bars = Math.ceil(dur / (4 * beat)) + 1;
    const arpPat = m.arp || [0, 2, 1, 3, 0, 2, 1, 3];
    for (let bar = 0; bar < bars; bar++) {
      const bs = t0 + bar * 4 * beat; const ch = m.chords[bar % m.chords.length];
      const notes = [ch[0], ch[1], ch[2], ch[2] * 2];
      if (!inBreak(bs)) pad(ch, bs, 4 * beat);
      for (let i = 0; i < 8; i++) {
        const s = bs + i * 0.5 * beat; if (inBreak(s)) continue;
        pluck(notes[arpPat[i]] * (m.octave || 1), s, 0.6 * beat, m.pluckVol ?? 0.07);
      }
      if (bar >= (m.drumsFromBar ?? 1)) {
        for (let q = 0; q < 4; q++) {
          const s = bs + q * beat; if (inBreak(s)) continue;
          kick(s);
          noise(s + 0.5 * beat, 0.05, q % 2 ? 0.05 : 0.03, 'highpass', 7200);
          if (q === 1 || q === 3) noise(s, 0.13, 0.11, 'bandpass', 1500, 0.7);
        }
      }
      if (m.tops && bar > 1 && !inBreak(bs)) pluck(m.tops[bar % m.tops.length], bs, 1.4 * beat, 0.05);
      // sleigh bells: a shaker on every 8th (accent on the off-beat)
      if (m.bells && bar >= (m.bellsFromBar ?? 0)) {
        for (let i = 0; i < 8; i++) {
          const s = bs + i * 0.5 * beat; if (inBreak(s)) continue;
          noise(s, 0.07, i % 2 ? 0.05 : 0.028, 'highpass', 8200);
          if (i % 2) tone(5274, s, 0.05, 0.008, 'triangle', master, false);
        }
      }
    }
    // a lead melody, written as [beat, freq, lengthInBeats] from the top of the track
    // (a glockenspiel-ish voice: fundamental + bright partials)
    (m.melody || []).forEach(([b, fr, len]) => {
      const s = t0 + b * beat; if (s >= t0 + dur || inBreak(s)) return;
      const d = Math.max(0.25, len * beat * 0.95), v = m.melVol ?? 0.07;
      tone(fr, s, d, v, 'sine'); tone(fr * 2, s, d * 0.5, v * 0.28, 'sine', master, false);
      tone(fr * 3.01, s, d * 0.25, v * 0.12, 'sine', master, false);
    });
    return master;
  }

  function startMusic() {
    stopMusic();
    const AC = window.AudioContext || window.webkitAudioContext; if (!AC || !cfg.music) return;
    audioCtx = new AC();
    musicMaster = buildGraph(audioCtx, audioCtx.currentTime + 0.05, cfg.total / 1000 + 0.6, cfg.music, cfg.cues);
    musicMaster.connect(audioCtx.destination);
  }
  function stopMusic() { if (audioCtx) { try { audioCtx.close(); } catch (e) {} } audioCtx = null; musicMaster = null; }

  window.renderMusicWav = async function (seconds) {
    const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext; if (!OAC) return null;
    seconds = seconds || cfg.total / 1000 + 0.6;
    const sr = 44100, oac = new OAC(2, Math.ceil(sr * seconds), sr);
    buildGraph(oac, 0, seconds, cfg.music, cfg.cues).connect(oac.destination);
    return wavBase64(await oac.startRendering());
  };
  function wavBase64(buf) {
    const nc = buf.numberOfChannels, len = buf.length, sr = buf.sampleRate, ba = nc * 2, dl = len * ba;
    const ab = new ArrayBuffer(44 + dl), dv = new DataView(ab);
    const w = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
    w(0, 'RIFF'); dv.setUint32(4, 36 + dl, true); w(8, 'WAVE'); w(12, 'fmt ');
    dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, nc, true);
    dv.setUint32(24, sr, true); dv.setUint32(28, sr * ba, true); dv.setUint16(32, ba, true);
    dv.setUint16(34, 16, true); w(36, 'data'); dv.setUint32(40, dl, true);
    const ch = []; for (let c = 0; c < nc; c++) ch.push(buf.getChannelData(c));
    let off = 44;
    for (let i = 0; i < len; i++) for (let c = 0; c < nc; c++) {
      const s = Math.max(-1, Math.min(1, ch[c][i])); dv.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true); off += 2;
    }
    let bin = ''; const bytes = new Uint8Array(ab);
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }

  // ── confetti ─────────────────────────────────────────────────────────────────
  let cv, cx, parts = [], rafOn = false;
  function burst(n = 90, y = 0.42, cols) {
    if (!cv) return;
    cv.width = cv.clientWidth * 2; cv.height = cv.clientHeight * 2;
    cols = cols || ['#a3e635', '#ffe14d', '#fb923c', '#22d3ee', '#f43f5e', '#ffffff'];
    for (let i = 0; i < n; i++) parts.push({
      x: cv.width * (0.3 + Math.random() * 0.4), y: cv.height * y,
      vx: (Math.random() - 0.5) * 16, vy: -8 - Math.random() * 13, g: 0.32 + Math.random() * 0.12,
      s: 6 + Math.random() * 8, rot: Math.random() * 6.28, vr: (Math.random() - 0.5) * 0.4,
      col: cols[i % cols.length], life: 1,
    });
    if (!rafOn) { rafOn = true; tick(); }
  }
  function tick() {
    cx.clearRect(0, 0, cv.width, cv.height); let alive = false;
    for (const p of parts) {
      if (p.life <= 0) continue; alive = true;
      p.vy += p.g; p.x += p.vx; p.y += p.vy; p.rot += p.vr; p.life -= 0.007;
      cx.save(); cx.globalAlpha = Math.max(0, p.life); cx.translate(p.x, p.y); cx.rotate(p.rot);
      cx.fillStyle = p.col; cx.fillRect(-p.s / 2, -p.s / 2, p.s, p.s * 1.6); cx.restore();
    }
    if (alive) requestAnimationFrame(tick); else { rafOn = false; parts = []; cx.clearRect(0, 0, cv.width, cv.height); }
  }

  // ── timeline ────────────────────────────────────────────────────────────────
  function clearTimers() { timers.forEach(clearTimeout); timers = []; }
  function play() {
    clearTimers(); parts = [];
    cfg.reset && cfg.reset();
    const prog = $('#prog'); const start = performance.now();
    if (prog) {
      prog.style.width = '0';
      const step = () => {
        const p = Math.min(1, (performance.now() - start) / cfg.total); prog.style.width = (p * 100) + '%';
        if (p < 1 && timers.length) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    }
    cfg.events.forEach(([ms, fn]) => timers.push(setTimeout(fn, ms)));
    timers.push(setTimeout(() => {}, cfg.total));
    return new Promise(r => timers.push(setTimeout(r, cfg.total)));
  }

  // ── christmas helpers ───────────────────────────────────────────────────────
  // falling snow as CSS animations (so the frame-by-frame renderer can seek it);
  // seeded, so every render of a reel snows exactly the same way
  function snow(box, n = 70, seed = 7) {
    box = typeof box === 'string' ? $(box) : box; if (!box) return;
    let r = seed; const rnd = () => ((r = (r * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < n; i++) {
      const f = document.createElement('i'); f.className = 'flake';
      const sz = 0.35 + rnd() * 0.9, dur = 5 + rnd() * 6;
      f.style.cssText = `left:${rnd() * 100}%;width:${sz}cqh;height:${sz}cqh;opacity:${0.35 + rnd() * 0.6};` +
        `--dx:${(rnd() - 0.5) * 14}cqh;animation-duration:${dur}s;animation-delay:${-rnd() * dur}s`;
      box.appendChild(f);
    }
  }
  // the "Jingle Bells" chorus (public domain), 8 bars in G: bars 1–4 then 13–16
  // so it resolves home. → melody [beat, freq, len]; `k` transposes (e.g. 0.891 = F).
  function jingleBells(k = 1, from = 0) {
    const B = 493.88, D = 587.33, G = 392, A = 440, C = 523.25;
    const n = [[0, B, 1], [1, B, 1], [2, B, 2], [4, B, 1], [5, B, 1], [6, B, 2],
      [8, B, 1], [9, D, 1], [10, G, 1.5], [11.5, A, .5], [12, B, 4],
      [16, C, 1], [17, C, 1], [18, C, 1.5], [19.5, C, .5], [20, C, 1], [21, B, 1], [22, B, 1], [23, B, .5], [23.5, B, .5],
      [24, D, 1], [25, D, 1], [26, C, 1], [27, A, 1], [28, G, 4]];
    return n.map(([b, f, l]) => [b + from, f * k, l]);
  }
  // matching chords (one per bar): G G G G C G D G
  const JB_CHORDS = k => [[196, 246.94, 293.66], [196, 246.94, 293.66], [196, 246.94, 293.66], [196, 246.94, 293.66],
    [164.81, 196, 261.63], [196, 246.94, 293.66], [146.83, 185, 220], [196, 246.94, 293.66]]
    .map(c => c.map(f => f * k));

  window.Reel = {
    $, burst, snow, jingleBells, JB_CHORDS,
    // restart a CSS animation class on an element
    pop(el, cls = 'in') { el = typeof el === 'string' ? $(el) : el; el.classList.remove(cls); void el.offsetWidth; el.classList.add(cls); },
    init(c) {
      cfg = c;
      window.TOTAL = c.total;
      window.play = play;
      cv = $('#confetti'); cx = cv && cv.getContext('2d');
      window.__reelReady = false;
      Promise.resolve(c.ready).then(() => { c.reset && c.reset(); window.__reelReady = true; });
      const go = () => { const g = $('#gate'); if (g) g.style.display = 'none'; startMusic(); play(); };
      $('#playBtn')?.addEventListener('click', go);
      $('#replay')?.addEventListener('click', go);
      $('#fs')?.addEventListener('click', () => {
        const s = $('#stage'); if (!document.fullscreenElement) s.requestFullscreen?.(); else document.exitFullscreen?.();
      });
    },
  };
})();
