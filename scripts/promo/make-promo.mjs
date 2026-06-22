#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
//  BWR Instagram promo generator
//
//  Records a guided "feature tour" of the LIVE site with Playwright, then
//  encodes it into three Instagram-ready MP4s:
//    • 9:16  (1080×1920) — Reels / Stories
//    • 1:1   (1080×1080) — feed square
//    • 4:5   (1080×1350) — feed portrait
//
//  Inner pages (routes/profile) need auth, so — exactly like tests/e2e —
//  we inject a mock "Gold" session into localStorage and stub /api/auth/me.
//  No real credentials are used or stored.
//
//  Usage:
//    node scripts/promo/make-promo.mjs              # record + encode all
//    node scripts/promo/make-promo.mjs --encode-only  # re-encode last recording
//    node scripts/promo/make-promo.mjs --only=9x16     # one format only
//
//  Output: scripts/promo/out/bwr-promo-9x16.mp4 (and 1x1, 4x5)
// ─────────────────────────────────────────────────────────────────────────────

import { chromium } from '@playwright/test';
import ffmpegPath from 'ffmpeg-static';
import { spawn } from 'node:child_process';
import { mkdir, rm, readdir, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { scenes } from './scenes.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, 'out');
const RAW_DIR = join(__dirname, '.raw');
const MASTER = join(OUT_DIR, 'bwr-promo-master.webm');

const BASE_URL = process.env.PROMO_BASE_URL || 'https://bwr-worker.ciril8596.workers.dev';

// Mobile-layout viewport at 2× density → crisp 1080×1920 master video.
const VIEWPORT = { width: 540, height: 960 };
const SCALE = 2;

const args = process.argv.slice(2);
const ENCODE_ONLY = args.includes('--encode-only');
const ONLY = (args.find(a => a.startsWith('--only=')) || '').split('=')[1] || null;

const FORMATS = [
  { id: '9x16', w: 1080, h: 1920, mode: 'native' }, // master is already 9:16
  { id: '1x1',  w: 1080, h: 1080, mode: 'blurpad' },
  { id: '4x5',  w: 1080, h: 1350, mode: 'blurpad' },
];

const MOCK_USER = {
  id: 'promo-user', name: 'Explorateur BWR', email: 'demo@bwr.app',
  role: 'user', plan: 'gold',
  stats: { routes: 27, km: 184 }, badges: [],
};

const MOCK_WEATHER = {
  current: { temperature_2m: 19, apparent_temperature: 18, weather_code: 1,
             wind_speed_10m: 9, relative_humidity_2m: 62, precipitation_probability: 10 },
  daily: { time: ['2026-06-22','2026-06-23','2026-06-24','2026-06-25'],
           weather_code: [1,2,3,61], temperature_2m_max: [24,25,22,18],
           temperature_2m_min: [13,14,12,11], precipitation_probability_max: [5,10,30,70] },
};

// ── tour helpers passed to each scene ────────────────────────────────────────
const helpers = {
  settle: (ms) => new Promise(r => setTimeout(r, ms)),
  async waitFor(page, sel, timeout = 8000) {
    try { await page.waitForSelector(sel, { timeout }); } catch { /* keep rolling */ }
  },
  async tryClick(page, sel) {
    try {
      const el = page.locator(sel).first();
      if (await el.count() && await el.isVisible()) { await el.click({ timeout: 2000 }); }
    } catch { /* non-fatal — recording must not break on a missing button */ }
  },
  async scrollToTop(page) {
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' }));
  },
  // Smoothly scroll from `from`→`to` (fractions of full scroll height).
  async slowScroll(page, from, to) {
    await page.evaluate(async ({ from, to }) => {
      const max = document.body.scrollHeight - window.innerHeight;
      const start = max * from, end = max * to, steps = 60;
      for (let i = 0; i <= steps; i++) {
        window.scrollTo(0, start + (end - start) * (i / steps));
        await new Promise(r => setTimeout(r, 26));
      }
    }, { from, to });
  },
};

// Branded caption banner injected into the page (baked into the recording).
function captionScript(caption, sub) {
  return ({ caption, sub }) => {
    document.getElementById('__promoCap')?.remove();
    const bar = document.createElement('div');
    bar.id = '__promoCap';
    bar.innerHTML =
      `<div style="font:700 30px/1.15 system-ui,Segoe UI,sans-serif;letter-spacing:-.5px">${caption}</div>` +
      `<div style="font:500 18px/1.3 system-ui,Segoe UI,sans-serif;opacity:.85;margin-top:6px">${sub}</div>`;
    Object.assign(bar.style, {
      position: 'fixed', left: '0', right: '0', bottom: '0', zIndex: '2147483647',
      padding: '22px 28px calc(env(safe-area-inset-bottom,0px) + 26px)',
      color: '#fff', textAlign: 'left', pointerEvents: 'none',
      background: 'linear-gradient(to top, rgba(6,20,12,.92) 0%, rgba(6,20,12,.72) 55%, rgba(6,20,12,0) 100%)',
      textShadow: '0 1px 8px rgba(0,0,0,.5)',
    });
    document.body.appendChild(bar);
  };
}

async function record() {
  console.log(`▶ recording tour of ${BASE_URL} …`);
  await rm(RAW_DIR, { recursive: true, force: true });
  await mkdir(RAW_DIR, { recursive: true });
  await mkdir(OUT_DIR, { recursive: true });

  const browser = await chromium.launch();
  const context = await browser.newContext({
    baseURL: BASE_URL,
    viewport: VIEWPORT,
    deviceScaleFactor: SCALE,
    isMobile: true,
    hasTouch: true,
    locale: 'fr-FR',
    // Playwright captures at CSS-viewport resolution, so the recorded size must
    // equal the viewport (deviceScaleFactor only sharpens the render). ffmpeg
    // then upscales the 9:16 master to 1080-wide for Instagram.
    recordVideo: { dir: RAW_DIR, size: { width: VIEWPORT.width, height: VIEWPORT.height } },
  });

  // Mock auth + weather so premium pages render on the live site (see e2e tests).
  await context.addInitScript((user) => {
    localStorage.setItem('bwr_token', 'promo-mock-token');
    localStorage.setItem('bwr_user', JSON.stringify(user));
  }, MOCK_USER);
  await context.route('**/api/auth/me', r => r.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify(MOCK_USER),
  }));
  await context.route('**open-meteo.com/**', r => r.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify(MOCK_WEATHER),
  }));

  const page = await context.newPage();

  for (const scene of scenes) {
    console.log(`  • scene: ${scene.id}`);
    try {
      await page.goto(scene.url, { waitUntil: 'domcontentloaded', timeout: 25000 });
    } catch (e) {
      console.warn(`    ! navigation slow for ${scene.id}: ${e.message}`);
    }
    await page.evaluate(captionScript(), { caption: scene.caption, sub: scene.sub });
    try { await scene.run(page, helpers); }
    catch (e) { console.warn(`    ! scene ${scene.id} hiccup: ${e.message}`); }
  }

  await context.close(); // finalizes the .webm
  await browser.close();

  // Move the single recorded video to a stable path.
  const files = (await readdir(RAW_DIR)).filter(f => f.endsWith('.webm'));
  if (!files.length) throw new Error('no video was recorded');
  if (existsSync(MASTER)) await rm(MASTER);
  await rename(join(RAW_DIR, files[0]), MASTER);
  await rm(RAW_DIR, { recursive: true, force: true });
  console.log(`✔ master recorded → ${MASTER}`);
}

function ff(filterArgs, out) {
  return new Promise((resolve, reject) => {
    const a = [
      '-y', '-i', MASTER,
      ...filterArgs,
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '20',
      '-pix_fmt', 'yuv420p', '-profile:v', 'high', '-level', '4.0',
      '-r', '30', '-movflags', '+faststart', '-an', out,
    ];
    const p = spawn(ffmpegPath, a, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', d => { err += d; });
    p.on('close', code => code === 0 ? resolve() : reject(new Error(err.slice(-1200))));
  });
}

async function encode() {
  if (!existsSync(MASTER)) throw new Error(`master not found (${MASTER}) — run without --encode-only first`);
  const targets = ONLY ? FORMATS.filter(f => f.id === ONLY) : FORMATS;
  if (!targets.length) throw new Error(`unknown --only value: ${ONLY}`);

  for (const f of targets) {
    const out = join(OUT_DIR, `bwr-promo-${f.id}.mp4`);
    let vf;
    if (f.mode === 'native') {
      vf = ['-vf', `scale=${f.w}:${f.h}:flags=lanczos`];
    } else {
      // Fit the whole phone frame, fill the bars with a blurred zoom of itself.
      vf = ['-filter_complex',
        `[0:v]split=2[bg][fg];` +
        `[bg]scale=${f.w}:${f.h}:force_original_aspect_ratio=increase,crop=${f.w}:${f.h},` +
        `gblur=sigma=22,eq=brightness=-0.12:saturation=1.05[bgb];` +
        `[fg]scale=${f.w}:${f.h}:force_original_aspect_ratio=decrease:flags=lanczos[fgs];` +
        `[bgb][fgs]overlay=(W-w)/2:(H-h)/2`];
    }
    process.stdout.write(`▶ encoding ${f.id} (${f.w}×${f.h}) … `);
    await ff(vf, out);
    console.log('done →', out);
  }
}

(async () => {
  try {
    if (!ENCODE_ONLY) await record();
    await encode();
    console.log('\n✅ Promo videos ready in scripts/promo/out/ — drop them straight into Instagram.');
  } catch (e) {
    console.error('\n❌ promo failed:', e.message);
    process.exit(1);
  }
})();
