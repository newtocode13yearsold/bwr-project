'use strict';
// Line-icon library (public/js/icons.js): every name the site uses must exist,
// legacy emoji saved in old data must still map to an icon, and no app source
// file may bring emoji back as a UI icon.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ICONS, EMOJI, svg, ic, iconFor, nameFor } = require('../public/js/icons.js');

const PUB = path.join(__dirname, '..', 'public');

describe('icons.js helpers', () => {
  test('svg() returns an outline SVG drawn with currentColor', () => {
    const s = svg('map');
    assert.match(s, /^<svg /);
    assert.match(s, /stroke="currentColor"/);
    assert.equal(svg('no-such-icon'), '');
  });
  test('ic() returns the placeholder the page fills in', () => {
    assert.equal(ic('tree'), '<i class="ic" data-ic="tree" aria-hidden="true"></i>');
  });
  test('nameFor() accepts a name, markup or a legacy emoji', () => {
    assert.equal(nameFor('medal'), 'medal');
    assert.equal(nameFor('<i class="ic" data-ic="owl"></i>'), 'owl');
    assert.equal(nameFor('🦌'), 'deer');
    assert.equal(nameFor('⛰️'), 'mountain'); // emoji + variation selector
    assert.equal(nameFor('pas une icône'), null);
  });
  test('iconFor() leaves unknown values untouched', () => {
    assert.match(iconFor('🍀'), /data-ic="clover"/);
    assert.equal(iconFor('texte'), 'texte');
  });
  test('every legacy emoji maps to an icon that exists', () => {
    for (const [emoji, name] of Object.entries(EMOJI)) {
      assert.ok(ICONS[name], `${emoji} → "${name}" is not in ICONS`);
    }
  });
});

describe('icon names used by the site', () => {
  const files = [];
  (function walk(d) {
    for (const f of fs.readdirSync(d)) {
      const p = path.join(d, f);
      if (fs.statSync(p).isDirectory()) { if (!['lib', 'ads', 'img', 'icons', 'fonts'].includes(f)) walk(p); }
      else if (/\.(html|js)$/.test(f) && f !== 'icons.js') files.push(p);
    }
  })(PUB);
  files.push(path.join(__dirname, '..', 'worker', 'handlers', 'publicpages.js'));

  test('every data-ic="…" refers to a defined icon', () => {
    const missing = [];
    for (const f of files) {
      const t = fs.readFileSync(f, 'utf8');
      for (const m of t.matchAll(/data-ic=["']([a-z-]+)["']/g)) {
        if (!ICONS[m[1]]) missing.push(`${path.relative(PUB, f)}: ${m[1]}`);
      }
    }
    assert.deepEqual(missing, []);
  });

  test('app pages and scripts carry no emoji', () => {
    const re = /\p{Extended_Pictographic}/u;
    const offenders = [];
    for (const f of files) {
      if (/promo/.test(path.basename(f))) continue; // ad/promo render sources
      fs.readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
        if (re.test(line.replace(/[©®™↔]/g, ''))) offenders.push(`${path.relative(PUB, f)}:${i + 1}`);
      });
    }
    assert.deepEqual(offenders, []);
  });
});
