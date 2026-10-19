#!/usr/bin/env node
// Quick QA for a reel: play it headlessly and grab frames at given times into a
// contact sheet (scripts/promo/out/frames-<slug>.png).
//   node scripts/promo/reel-frames.mjs chat 1000 3000 8000 12000 15000
import { chromium } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdir } from 'node:fs/promises';

const __dirname = dirname(fileURLToPath(import.meta.url));
const [slug, ...times] = process.argv.slice(2);
const BASE = process.env.PROMO_BASE_URL || 'http://localhost:4810';
const out = join(__dirname, 'out');
await mkdir(out, { recursive: true });

const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 360, height: 640 }, deviceScaleFactor: 1 })).newPage();
await page.goto(`${BASE}/ads/promo-${slug}.html`);
await page.evaluate(() => { document.body.classList.add('bare'); document.getElementById('gate').style.display = 'none'; });
await page.waitForFunction(() => window.__reelReady === true, null, { timeout: 20000 });
await page.waitForTimeout(500);
const t0 = Date.now();
await page.evaluate(() => { play(); });
const shots = [];
for (const t of times.map(Number)) {
  const wait = t - (Date.now() - t0); if (wait > 0) await page.waitForTimeout(wait);
  shots.push({ t, buf: await page.screenshot({ type: 'jpeg', quality: 80 }) });
}
// stitch the frames side by side in the browser itself (no image deps needed)
const sheet = await browser.newPage({ viewport: { width: 370 * shots.length, height: 670 } });
await sheet.setContent(`<body style="margin:0;background:#222;display:flex;gap:10px;font:bold 18px sans-serif;color:#ff0">${
  shots.map(s => `<div style="position:relative"><img src="data:image/jpeg;base64,${s.buf.toString('base64')}"><span style="position:absolute;left:6px;top:6px;background:#000">${s.t}</span></div>`).join('')}</body>`);
await sheet.screenshot({ path: join(out, `frames-${slug}.png`), fullPage: true });
await browser.close();
console.log('✔', join(out, `frames-${slug}.png`));
