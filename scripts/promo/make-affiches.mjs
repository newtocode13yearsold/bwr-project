#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
//  BWR — campagne affiches A4 (5 visuels prêts à imprimer / à poster)
//
//  Renders `public/ads/affiches-campagne.html` — which holds the 5 affiches as
//  five A4 `.sheet` elements — into downloadable files in the shared ad drop
//  folder (…/Projet Thomas/add):
//    • BWR-affiche-<n>-<slug>.png   2480 × 3508 px  (A4 @ 300 dpi, pour le web,
//                                                    Instagram feed, impression)
//    • BWR-affiche-<n>-<slug>.pdf   A4 vectoriel    (pour l'imprimeur)
//    • BWR-affiches-campagne.pdf    les 5 en un seul PDF de 5 pages
//
//  Usage (a static server must serve /public — the bwr-static preview on :4810):
//    PROMO_BASE_URL=http://localhost:4810 node scripts/promo/make-affiches.mjs
//    node scripts/promo/make-affiches.mjs --a=3     # une seule affiche
//    node scripts/promo/make-affiches.mjs --png     # PNG seulement (plus rapide)
// ─────────────────────────────────────────────────────────────────────────────

import { chromium } from '@playwright/test';
import { mkdir, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, 'out');
const DROP    = join(__dirname, '..', '..', '..', 'add');

const BASE_URL = process.env.PROMO_BASE_URL || 'http://localhost:4810';
const PAGE = '/ads/affiches-campagne.html';

// A4 = 210 × 297 mm. At the CSS 96 dpi that is 793.7 × 1122.5 px, so a device
// scale factor of 96 → 300 dpi (3.125) lands exactly on 2480 × 3508 px.
const DPI_SCALE = 300 / 96;
const VIEWPORT = { width: 820, height: 1160 };

const AFFICHES = [
  { n: 1, slug: 'couleurs',   title: 'La forêt, enfin en couleurs' },
  { n: 2, slug: 'dimanche',   title: 'On fait quoi dimanche ?' },
  { n: 3, slug: 'hors-ligne', title: 'Zéro réseau. Zéro problème.' },
  { n: 4, slug: 'signale',    title: 'Signale. Partage. Évite.' },
  { n: 5, slug: 'gratuit',    title: '100 % gratuit' },
];

const args = process.argv.slice(2);
const PNG_ONLY = args.includes('--png');
const PICK = (args.find(a => a.startsWith('--a=')) || '').split('=')[1] || null;
const TARGETS = PICK
  ? AFFICHES.filter(a => PICK.split(',').map(s => s.trim()).includes(String(a.n)))
  : AFFICHES;

if (!TARGETS.length) { console.error(`❌ unknown --a value: ${PICK} — valid: 1..5`); process.exit(1); }

// Isolate one affiche in the page (same code path as the on-screen toolbar), so
// the element screenshot and the PDF both see exactly one A4 sheet.
async function showOnly(page, n) {
  await page.evaluate((num) => {
    document.body.classList.toggle('solo', num !== 0);
    document.querySelectorAll('.sheet').forEach((s) => {
      s.classList.toggle('show', String(s.dataset.affiche) === String(num));
    });
  }, n);
  // Let the layout settle and the map screenshot decode before we capture.
  await page.waitForTimeout(350);
}

(async () => {
  try {
    await mkdir(OUT_DIR, { recursive: true });
    await mkdir(DROP, { recursive: true });

    const browser = await chromium.launch();
    const context = await browser.newContext({
      baseURL: BASE_URL, viewport: VIEWPORT, deviceScaleFactor: DPI_SCALE, locale: 'fr-FR',
    });
    const page = await context.newPage();
    console.log(`▶ rendering ${BASE_URL}${PAGE} …`);
    await page.goto(PAGE, { waitUntil: 'networkidle', timeout: 45000 });
    // The on-screen toolbar is sticky, so it would sit on top of the first sheet
    // and land inside the element screenshot. Hide it for the whole capture run.
    await page.evaluate(() => document.body.classList.add('capturing'));
    // Web fonts + the real-map screenshots must be in before anything is captured.
    await page.evaluate(() => document.fonts && document.fonts.ready);
    await page.waitForFunction(
      () => Array.from(document.images).every(i => i.complete && i.naturalWidth > 0),
      null, { timeout: 30000 },
    );
    await page.waitForTimeout(500);

    for (const a of TARGETS) {
      await showOnly(page, a.n);
      const sheet = page.locator(`.sheet[data-affiche="${a.n}"]`);

      const png = join(OUT_DIR, `bwr-affiche-${a.n}-${a.slug}.png`);
      await sheet.screenshot({ path: png, scale: 'device' });
      const pngDrop = join(DROP, `BWR-affiche-${a.n}-${a.slug}.png`);
      await copyFile(png, pngDrop);
      const box = await sheet.boundingBox();
      console.log(`✔ affiche ${a.n} « ${a.title} » → ${pngDrop}  (${Math.round((box?.width || 0) * DPI_SCALE)}×${Math.round((box?.height || 0) * DPI_SCALE)} px)`);

      if (!PNG_ONLY) {
        const pdf = join(OUT_DIR, `bwr-affiche-${a.n}-${a.slug}.pdf`);
        await page.pdf({ path: pdf, format: 'A4', printBackground: true, preferCSSPageSize: true });
        await copyFile(pdf, join(DROP, `BWR-affiche-${a.n}-${a.slug}.pdf`));
        console.log(`  ↳ PDF → ${join(DROP, `BWR-affiche-${a.n}-${a.slug}.pdf`)}`);
      }
    }

    // One 5-page PDF with the whole campaign (only when nothing was filtered out).
    if (!PNG_ONLY && TARGETS.length === AFFICHES.length) {
      await showOnly(page, 0);
      const all = join(OUT_DIR, 'bwr-affiches-campagne.pdf');
      await page.pdf({ path: all, format: 'A4', printBackground: true, preferCSSPageSize: true });
      await copyFile(all, join(DROP, 'BWR-affiches-campagne.pdf'));
      console.log(`✔ les 5 affiches en un PDF → ${join(DROP, 'BWR-affiches-campagne.pdf')}`);
    }

    await browser.close();
    console.log('\n✅ Affiches prêtes dans ../add/ — PNG 300 dpi pour le web, PDF A4 pour l’imprimeur.');
  } catch (e) {
    console.error('\n❌ affiches build failed:', e.message);
    process.exit(1);
  }
})();
