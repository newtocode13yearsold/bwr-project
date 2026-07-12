#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
//  BWR promo — real-map screenshot capture
//
//  Renders the SAME Leaflet map the app uses (real IGN ortho + OpenTopoMap tiles
//  of the Compiègne forest, real admin path geometry from /api/paths) via
//  scripts/promo/capture-map.html, then screenshots each state into
//  public/ads/img/*.png. Those PNGs are embedded (as served assets) inside the
//  two reels promo-loop.html / promo-grades.html so the phone mockup shows
//  genuine screenshots of the user's map instead of a stylised SVG.
//
//  Inputs (already generated, see README of this task):
//    scripts/promo/out/real-paths.json   — full curated path network (+status)
//    scripts/promo/out/loop-route.json    — a real ~7.3 km graph-router loop
//    scripts/promo/out/loop-route-2.json  — a second, different real loop
//
//  Usage:  node scripts/promo/capture-map.mjs
// ─────────────────────────────────────────────────────────────────────────────
import { chromium } from '@playwright/test';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, 'out');
const IMG = join(__dirname, '..', '..', 'public', 'ads', 'img');
const HARNESS = join(__dirname, 'capture-map.html');

const LEAFLET_CSS = pathToFileURL(join(__dirname, '..', '..', 'node_modules', 'leaflet', 'dist', 'leaflet.css')).href;
const LEAFLET_JS  = pathToFileURL(join(__dirname, '..', '..', 'node_modules', 'leaflet', 'dist', 'leaflet.js')).href;

// Portrait phone-screen aspect (~1:2). deviceScaleFactor 2 → crisp on Instagram.
const VIEWPORT = { width: 600, height: 1180 };

const readJSON = async p => JSON.parse(await readFile(p, 'utf8'));
const centroid = coords => {
  let la = 0, lo = 0; for (const c of coords) { la += c[0]; lo += c[1]; }
  return [la / coords.length, lo / coords.length];
};

async function main() {
  await mkdir(IMG, { recursive: true });
  const paths = await readJSON(join(OUT, 'real-paths.json'));
  const loop1 = await readJSON(join(OUT, 'loop-route.json'));
  const loop2 = await readJSON(join(OUT, 'loop-route-2.json'));

  // grades: only draw the paths near the graded cluster so red/orange are visible
  const gradeStatuses = new Set(['easy', 'medium', 'hard', 'no_bike', 'not_passable']);
  const gradedPaths = paths.filter(p => gradeStatuses.has(p.status) && p.coordinates?.length > 1);

  const html = (await readFile(HARNESS, 'utf8'))
    .replace('LEAFLET_CSS', LEAFLET_CSS)
    .replace('LEAFLET_JS', LEAFLET_JS);
  // Write a resolved copy so file:// <script src> tags actually load (setContent
  // uses an about:blank base and won't fetch external file:// resources).
  const resolved = join(__dirname, '.capture-resolved.html');
  await writeFile(resolved, html);

  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 2, locale: 'fr-FR' });
  const page = await context.newPage();
  await page.goto(pathToFileURL(resolved).href, { waitUntil: 'load' });
  await page.waitForFunction(() => typeof window.render === 'function' && typeof window.L !== 'undefined')
    .catch(async () => { await page.waitForFunction(() => typeof window.render === 'function'); });

  async function shot(name, payload, settle = 1600) {
    await page.evaluate(p => window.render(p), payload);
    // wait until the harness says all tiles have painted (with a hard cap)
    await page.waitForFunction(() => window.__ready === true, null, { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(settle);
    const file = join(IMG, name);
    await page.screenshot({ path: file });
    console.log('✔', name);
  }

  // ── Reel #1 (loop) — satellite ortho, two different real loops from same start ──
  await shot('loop-1.png', {
    base: 'satellite', routes: [{ coords: loop1.coords, color: '#a3e635', weight: 7, halo: true }],
    start: loop1.coords[0], fit: true, fitPad: 0.18,
  });
  await shot('loop-2.png', {
    base: 'satellite', routes: [{ coords: loop2.coords, color: '#a3e635', weight: 7, halo: true }],
    start: loop2.coords[0], fit: true, fitPad: 0.18,
  });
  // an "empty" starting frame (just the start pin on the forest) for the before→after reveal
  await shot('loop-empty.png', {
    base: 'satellite', start: loop1.coords[0],
    center: centroid(loop1.coords), zoom: 14.4,
  });

  // ── Reel #2 (grades) — topo base so the colours pop, full graded network ──
  await shot('grades-all.png', {
    base: 'topo', grade: true, paths: gradedPaths, fit: true, fitPad: 0.02,
  }, 2200);
  // a zoomed detail centred on the SE cluster where green + orange (medium) +
  // red (hard, "Sentier Brunehaut") coexist, so the difficulty contrast is legible
  await shot('grades-zoom.png', {
    base: 'topo', grade: true, gradeWeight: 6, paths: gradedPaths, center: [49.3405, 2.9605], zoom: 13.8,
  }, 2200);

  await browser.close();

  // record what was captured (dimensions) for the reel authors
  await writeFile(join(OUT, 'capture-manifest.json'), JSON.stringify({
    viewport: VIEWPORT, scale: 2,
    loop1: { km: loop1.km, minutes: loop1.minutes },
    loop2: { km: loop2.km, minutes: loop2.minutes },
    images: ['loop-1.png', 'loop-2.png', 'loop-empty.png', 'grades-all.png', 'grades-zoom.png'],
  }, null, 2));
  console.log('\n✅ captures written to public/ads/img/');
}
main().catch(e => { console.error('❌ capture failed:', e); process.exit(1); });
