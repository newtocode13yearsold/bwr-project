#!/usr/bin/env node
// Screenshot the REAL printable roadbook (public/js/route-print.js → _rpBuildDoc)
// for the real 7.3 km loop in scripts/promo/out/loop-route.json, with the real
// curated paths as context and the real named carrefours along it.
//   node scripts/promo/capture-print.mjs   → public/ads/img/print-sheet.png
import { chromium } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const require = createRequire(import.meta.url);
const rp = require(join(ROOT, 'public/js/route-print.js'));

const ctx = {};
vm.runInNewContext(await readFile(join(ROOT, 'public/js/carrefours.js'), 'utf8') + ';this.C=CARREFOURS;', ctx);
const loop = JSON.parse(await readFile(join(__dirname, 'out/loop-route.json'), 'utf8'));
const paths = JSON.parse(await readFile(join(__dirname, 'out/real-paths.json'), 'utf8'));

const route = { coords: loop.coords, meters: loop.km * 1000, seconds: loop.minutes * 60 };
const hits = rp.carrefoursAlongRoute(route.coords, ctx.C);
const b0 = rp._rpBounds(route.coords);
const padLat = Math.max((b0.maxLat - b0.minLat) * 0.18, 0.0015);
const padLon = Math.max((b0.maxLon - b0.minLon) * 0.18, 0.002);
const padded = { minLat: b0.minLat - padLat, maxLat: b0.maxLat + padLat, minLon: b0.minLon - padLon, maxLon: b0.maxLon + padLon };

const html = rp._rpBuildDoc(route, {
  hits, contextPaths: rp._rpContextPaths(paths, padded), color: '#22c55e', isLoop: true,
  title: 'Boucle · 7,3 km', typeLabel: 'Chemin forestier', modeLabel: 'Boucle', diffLabel: 'facile', useTiles: false,
});

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 794, height: 1123 }, deviceScaleFactor: 2 });
await page.setContent(html, { waitUntil: 'load' });
await page.addScriptTag({ path: join(ROOT, 'public/js/icons.js') });
await page.emulateMedia({ media: 'print' });   // hides the on-screen hint, like the real printout
await page.waitForTimeout(500);
await page.screenshot({ path: join(ROOT, 'public/ads/img/print-sheet.png'), fullPage: true });
await browser.close();
console.log('✔ print-sheet.png —', hits.map(h => h.name).join(' · '));
