#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
//  BWR Instagram TUTORIAL reel generator (with music)
//
//  Sibling of make-ad.mjs, but instead of a punchy sales ad this builds a
//  step-by-step "how to use BWR" tutorial reel: a title card, then numbered
//  steps (Explore → Planifie → Signale → Progresse → Hors-ligne) each shown on
//  the real app with a step badge, and a call-to-action end card — all over the
//  same royalty-free EDM bed used by make-ad.mjs.
//
//  Mirrors make-ad.mjs exactly for auth (mock Gold session + stubbed
//  /api/auth/me — no real credentials) and encoding (9:16, 1:1, 4:5).
//
//  Usage:
//    node scripts/promo/make-tutorial-ad.mjs               # record + music + encode all
//    node scripts/promo/make-tutorial-ad.mjs --encode-only # re-use last recording
//    node scripts/promo/make-tutorial-ad.mjs --only=9x16   # one format only
//
//  Output: scripts/promo/out/bwr-tuto-9x16.mp4 (and 1x1, 4x5)
// ─────────────────────────────────────────────────────────────────────────────

import { chromium } from '@playwright/test';
import ffmpegPath from 'ffmpeg-static';
import { spawn } from 'node:child_process';
import { mkdir, rm, readdir, rename, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { pickVariant } from './variety.mjs';

// Per-run variety: accent palette, shuffled photo subset, rotating copy.
const V = pickVariant('tuto');

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, 'out');
const RAW_DIR = join(__dirname, '.raw-tuto');
const ASSETS = join(__dirname, 'assets');
const MUSIC_FILE = join(ASSETS, 'music', 'edm.mp3');
const BROLL_DIR = join(ASSETS, 'broll');
const MASTER = join(OUT_DIR, 'bwr-tuto-master.webm');
const BED = join(OUT_DIR, 'bwr-tuto-bed.m4a');

const BASE_URL = process.env.PROMO_BASE_URL || 'https://bwr-worker.ciril8596.workers.dev';

const VIEWPORT = { width: 540, height: 960 };
const SCALE = 2;

const args = process.argv.slice(2);
const ENCODE_ONLY = args.includes('--encode-only');
const ONLY = (args.find(a => a.startsWith('--only=')) || '').split('=')[1] || null;

const FORMATS = [
  { id: '9x16', w: 1080, h: 1920, mode: 'native' },
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

// ── tour helpers ─────────────────────────────────────────────────────────────
const helpers = {
  settle: (ms) => new Promise(r => setTimeout(r, ms)),
  async waitFor(page, sel, timeout = 8000) {
    try { await page.waitForSelector(sel, { timeout }); } catch { /* keep rolling */ }
  },
  async tryClick(page, sel) {
    try {
      const el = page.locator(sel).first();
      if (await el.count() && await el.isVisible()) { await el.click({ timeout: 2000 }); }
    } catch { /* non-fatal */ }
  },
  async slowScroll(page, from, to, ms = 1100) {
    await page.evaluate(async ({ from, to, ms }) => {
      const max = document.body.scrollHeight - window.innerHeight;
      const start = max * from, end = max * to, steps = Math.max(20, Math.round(ms / 22));
      for (let i = 0; i <= steps; i++) {
        window.scrollTo(0, start + (end - start) * (i / steps));
        await new Promise(r => setTimeout(r, ms / steps));
      }
    }, { from, to, ms });
  },
  // Tutorial caption: a numbered step badge + title + subtitle, slides up.
  async step(page, n, total, title, sub = '') {
    await page.evaluate(({ n, total, title, sub, accent }) => {
      document.getElementById('__tutCap')?.remove();
      const bar = document.createElement('div');
      bar.id = '__tutCap';
      const badge = n
        ? `<div style="display:inline-block;font:800 15px/1 system-ui,Segoe UI,sans-serif;` +
          `letter-spacing:.5px;color:#06140c;background:${accent};padding:7px 13px;border-radius:999px;` +
          `margin-bottom:12px;box-shadow:0 6px 18px ${accent}59">ÉTAPE ${n}/${total}</div>`
        : '';
      bar.innerHTML =
        badge +
        `<div style="font:800 34px/1.1 system-ui,Segoe UI,sans-serif;letter-spacing:-.6px">${title}</div>` +
        (sub ? `<div style="font:600 19px/1.3 system-ui,Segoe UI,sans-serif;opacity:.9;margin-top:8px">${sub}</div>` : '');
      Object.assign(bar.style, {
        position: 'fixed', left: '0', right: '0', bottom: '0', zIndex: '2147483647',
        padding: '26px 26px calc(env(safe-area-inset-bottom,0px) + 32px)',
        color: '#fff', textAlign: 'left', pointerEvents: 'none',
        background: 'linear-gradient(to top, rgba(6,20,12,.95) 0%, rgba(6,20,12,.72) 58%, rgba(6,20,12,0) 100%)',
        textShadow: '0 2px 10px rgba(0,0,0,.55)',
        transform: 'translateY(26px)', opacity: '0',
        transition: 'transform .45s cubic-bezier(.2,.8,.2,1), opacity .45s ease',
      });
      document.body.appendChild(bar);
      requestAnimationFrame(() => { bar.style.transform = 'translateY(0)'; bar.style.opacity = '1'; });
    }, { n, total, title, sub, accent: V.accent });
  },
  // Cinematic b-roll INTRO with the tutorial title.
  async introMontage(page, imgs, lines, accent = '#a3e635') {
    await page.evaluate(({ imgs, lines, accent }) => {
      const ov = document.createElement('div');
      ov.id = '__tutIntro';
      ov.innerHTML =
        imgs.map((src, i) =>
          `<div class="sl" style="background-image:url('${src}');animation-delay:${i * 1.4}s"></div>`).join('') +
        `<div class="scrim"></div>` +
        `<div class="hk">` +
          lines.map((t, i) => `<div class="hl" style="transition-delay:${0.25 + i * 0.22}s">${t}</div>`).join('') +
        `</div>`;
      Object.assign(ov.style, { position: 'fixed', inset: '0', zIndex: '2147483647', background: '#050d06', overflow: 'hidden' });
      document.body.appendChild(ov);
      const dur = imgs.length * 1.4;
      const st = document.createElement('style');
      st.textContent =
        `#__tutIntro .sl{position:absolute;inset:0;background-size:cover;background-position:center;` +
        `opacity:0;will-change:transform,opacity;animation:tutKB ${dur}s linear infinite,tutFade ${dur}s ease-in-out infinite}` +
        `@keyframes tutKB{0%{transform:scale(1.04)}100%{transform:scale(1.16)}}` +
        `@keyframes tutFade{0%{opacity:0}4%{opacity:1}${(1.4 / dur * 100 - 4).toFixed(1)}%{opacity:1}${(1.4 / dur * 100).toFixed(1)}%{opacity:0}100%{opacity:0}}` +
        `#__tutIntro .scrim{position:absolute;inset:0;background:linear-gradient(to top,rgba(5,13,6,.85),rgba(5,13,6,.25) 55%,rgba(5,13,6,.55))}` +
        `#__tutIntro .hk{position:absolute;inset:0;display:flex;flex-direction:column;justify-content:center;` +
        `align-items:center;gap:10px;padding:0 42px;text-align:center;color:#fff;font-family:system-ui,Segoe UI,sans-serif}` +
        `#__tutIntro .hl{font:800 42px/1.12 system-ui;letter-spacing:-.8px;text-shadow:0 3px 16px rgba(0,0,0,.6);` +
        `opacity:0;transform:translateY(18px);transition:opacity .55s ease,transform .55s cubic-bezier(.2,.8,.2,1)}` +
        `#__tutIntro .hl.in{opacity:1;transform:none}#__tutIntro .hl b{color:${accent}}`;
      document.head.appendChild(st);
      ov.querySelectorAll('.sl').forEach((el, i) => {
        el.style.animationDelay = `${-(dur - i * 1.4)}s, ${-(dur - i * 1.4)}s`;
      });
      requestAnimationFrame(() => ov.querySelectorAll('.hl').forEach(el => el.classList.add('in')));
    }, { imgs, lines, accent });
  },
  async removeIntro(page) {
    await page.evaluate(() => {
      const ov = document.getElementById('__tutIntro');
      if (!ov) return;
      ov.style.transition = 'opacity .45s ease';
      ov.style.opacity = '0';
      setTimeout(() => ov.remove(), 470);
    });
  },
  async brollFlash(page, src, caption = '', ms = 1400) {
    await page.evaluate(({ src, caption }) => {
      const ov = document.createElement('div');
      ov.id = '__tutFlash';
      ov.innerHTML =
        `<div class="img" style="background-image:url('${src}')"></div>` +
        `<div class="scrim"></div>` +
        (caption ? `<div class="cap">${caption}</div>` : '');
      Object.assign(ov.style, { position: 'fixed', inset: '0', zIndex: '2147483646', background: '#050d06', overflow: 'hidden', opacity: '0', transition: 'opacity .3s ease' });
      document.body.appendChild(ov);
      const st = document.createElement('style');
      st.textContent =
        `#__tutFlash .img{position:absolute;inset:0;background-size:cover;background-position:center;` +
        `animation:tutFlashKB 2s ease-out forwards}` +
        `@keyframes tutFlashKB{0%{transform:scale(1.12)}100%{transform:scale(1.0)}}` +
        `#__tutFlash .scrim{position:absolute;inset:0;background:linear-gradient(to top,rgba(5,13,6,.8),rgba(5,13,6,.15) 60%)}` +
        `#__tutFlash .cap{position:absolute;left:0;right:0;bottom:0;padding:24px 28px 36px;color:#fff;` +
        `font:800 30px/1.15 system-ui,Segoe UI,sans-serif;letter-spacing:-.5px;text-align:left;text-shadow:0 2px 12px rgba(0,0,0,.6)}`;
      document.head.appendChild(st);
      requestAnimationFrame(() => { ov.style.opacity = '1'; });
    }, { src, caption });
    await new Promise(r => setTimeout(r, ms));
    await page.evaluate(() => {
      const ov = document.getElementById('__tutFlash');
      if (!ov) return;
      ov.style.opacity = '0';
      setTimeout(() => ov.remove(), 320);
    });
  },
  async endCard(page, opts = {}) {
    await page.evaluate(({ accent, deep, deep2, tag, cta }) => {
      document.getElementById('__tutCap')?.remove();
      const ov = document.createElement('div');
      ov.id = '__tutCTA';
      ov.innerHTML =
        '<div class="logo">' +
          '<svg width="86" height="86" viewBox="0 0 64 64" style="filter:drop-shadow(0 6px 18px rgba(0,0,0,.4))">' +
          `<rect width="64" height="64" rx="14" fill="${deep}"/>` +
          `<polygon points="32,7 42,25 37,25 46,40 36,40 41,53 23,53 28,40 18,40 27,25 22,25" fill="${accent}"/>` +
          '</svg></div>' +
        '<div class="brand">BWR</div>' +
        `<div class="tag">${tag}</div>` +
        `<div class="cta">${cta}</div>` +
        '<div class="url">bwr-worker.ciril8596.workers.dev</div>';
      Object.assign(ov.style, {
        position: 'fixed', inset: '0', zIndex: '2147483647', display: 'flex',
        flexDirection: 'column', justifyContent: 'center', alignItems: 'center',
        gap: '0', textAlign: 'center', fontFamily: 'system-ui,Segoe UI,sans-serif',
        background: `radial-gradient(120% 80% at 50% 35%, ${deep} 0%, ${deep2} 72%, #050d06 100%)`,
        color: '#fff',
      });
      document.body.appendChild(ov);
      const st = document.createElement('style');
      st.textContent =
        '#__tutCTA>*{opacity:0;transform:translateY(16px);' +
        'transition:opacity .5s ease,transform .5s cubic-bezier(.2,.8,.2,1)}' +
        '#__tutCTA .brand{font:900 64px/1 system-ui;letter-spacing:1px;margin-top:18px}' +
        '#__tutCTA .tag{font:600 21px/1.35 system-ui;opacity:.92;margin-top:14px;max-width:420px;padding:0 30px}' +
        `#__tutCTA .cta{font:800 26px/1 system-ui;margin-top:34px;background:${accent};color:#06140c;` +
        `padding:16px 30px;border-radius:999px;box-shadow:0 10px 30px ${accent}59}` +
        '#__tutCTA .url{font:600 18px/1 system-ui;opacity:.8;margin-top:22px;letter-spacing:.3px}' +
        '#__tutCTA .in{opacity:1;transform:none}';
      document.head.appendChild(st);
      const kids = [...ov.children];
      kids.forEach((el, i) => setTimeout(() => el.classList.add('in'), 120 + i * 220));
    }, {
      accent: opts.accent || '#a3e635', deep: opts.deep || '#1e4d14', deep2: opts.deep2 || '#0b1a0c',
      tag: opts.tag || 'Maintenant, à toi de jouer 🌲',
      cta: opts.cta || 'Commence gratuitement →',
    });
  },
};

// ── tutorial scene script ─────────────────────────────────────────────────────
async function runTour(page, allBroll) {
  const h = helpers;
  // Shuffled random subset of the loaded photos → different intro + flashes each run.
  const broll = V.pickBroll(allBroll);
  const b = (i) => broll[i % broll.length];
  const N = 5; // number of steps

  // 0) INTRO — title card.
  await page.goto('/index.html', { waitUntil: 'domcontentloaded', timeout: 25000 });
  await h.settle(300);
  await h.introMontage(page, broll, V.intro, V.accent);
  await h.settle(Math.max(4200, broll.length * 1400));
  await h.removeIntro(page);
  await h.settle(400);

  // 1) MAP — explore the trails.
  await page.goto('/map.html', { waitUntil: 'domcontentloaded', timeout: 25000 });
  await h.waitFor(page, '.leaflet-container', 12000);
  await h.settle(1400);
  await h.step(page, 1, N, 'Explore la carte', 'Tous les chemins, colorés par difficulté');
  await h.tryClick(page, '.leaflet-control-zoom-in');
  await h.settle(1100);
  await h.tryClick(page, '.leaflet-control-zoom-in');
  await h.settle(1500);

  await h.brollFlash(page, b(0), 'À pied ou à vélo ?', 1300);

  // 2) ROUTES — plan a trip.
  await page.goto('/routes.html', { waitUntil: 'domcontentloaded', timeout: 25000 });
  await h.settle(1000);
  await h.step(page, 2, N, 'Planifie ton trajet', 'Une distance → une boucle sur mesure');
  await h.tryClick(page, '.mode-card[data-mode="loop"]');
  await h.settle(900);
  await h.tryClick(page, '.qs-chip[data-km="8"]');
  await h.settle(900);
  await h.slowScroll(page, 0.0, 0.55, 1100);
  await h.step(page, 2, N, 'Dénivelé + export GPX', 'Emporte ta trace dans Garmin ou Strava');
  await h.settle(1400);
  await h.slowScroll(page, 0.55, 1.0, 1000);
  await h.settle(700);

  await h.brollFlash(page, b(1), 'Un obstacle sur le chemin ?', 1300);

  // 3) MAP again — report a hazard.
  await page.goto('/map.html', { waitUntil: 'domcontentloaded', timeout: 25000 });
  await h.waitFor(page, '.leaflet-container', 12000);
  await h.settle(1300);
  await h.step(page, 3, N, 'Signale un obstacle', 'Arbre tombé, inondation… préviens la communauté');
  await h.settle(1900);

  await h.brollFlash(page, b(2), 'Repousse tes limites', 1300);

  // 4) PROFILE — progression.
  await page.goto('/profile.html', { waitUntil: 'domcontentloaded', timeout: 25000 });
  await h.settle(1200);
  await h.step(page, 4, N, 'Suis ta progression', 'Kilomètres, badges & objectifs');
  await h.slowScroll(page, 0.0, 0.5, 1000);
  await h.tryClick(page, '#wheelSpinBtn');
  await h.settle(1800);
  await h.slowScroll(page, 0.5, 1.0, 1000);
  await h.settle(700);

  // 5) Offline — final step (b-roll card, no dedicated page needed).
  await h.brollFlash(page, b(3), '', 200); // brief darken
  await h.step(page, 5, N, 'Pars sans réseau', 'Installe l’app + cartes hors-ligne');
  await h.settle(2200);

  // 6) END CARD.
  await h.endCard(page, { accent: V.accent, deep: V.deep, deep2: V.deep2, tag: V.cta.tag, cta: V.cta.cta });
  await h.settle(3200);
}

async function loadBroll() {
  if (!existsSync(BROLL_DIR)) return [];
  const files = (await readdir(BROLL_DIR)).filter(f => /\.(jpe?g|png)$/i.test(f)).sort();
  const out = [];
  for (const f of files) {
    const buf = await readFile(join(BROLL_DIR, f));
    const mime = /\.png$/i.test(f) ? 'image/png' : 'image/jpeg';
    out.push(`data:${mime};base64,${buf.toString('base64')}`);
  }
  return out;
}

async function record() {
  console.log(`▶ recording tutorial reel of ${BASE_URL} …`);
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
    recordVideo: { dir: RAW_DIR, size: { width: VIEWPORT.width, height: VIEWPORT.height } },
  });

  await context.addInitScript((user) => {
    localStorage.setItem('bwr_token', 'promo-mock-token');
    localStorage.setItem('bwr_user', JSON.stringify(user));
    // Make sure the in-app onboarding tour never auto-pops during recording.
    localStorage.setItem('bwr_tutorial_seen', '1');
  }, MOCK_USER);
  await context.route('**/api/auth/me', r => r.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify(MOCK_USER),
  }));
  await context.route('**open-meteo.com/**', r => r.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify(MOCK_WEATHER),
  }));

  const broll = await loadBroll();
  console.log(`  • ${broll.length} b-roll image(s) loaded`);
  console.log(`  • variant → ${V.describe()}`);
  const page = await context.newPage();
  try { await runTour(page, broll); }
  catch (e) { console.warn(`  ! tour hiccup: ${e.message}`); }

  await context.close();
  await browser.close();

  const files = (await readdir(RAW_DIR)).filter(f => f.endsWith('.webm'));
  if (!files.length) throw new Error('no video was recorded');
  if (existsSync(MASTER)) await rm(MASTER);
  await rename(join(RAW_DIR, files[0]), MASTER);
  await rm(RAW_DIR, { recursive: true, force: true });
  console.log(`✔ master recorded → ${MASTER}`);
}

// ── ffmpeg plumbing ──────────────────────────────────────────────────────────
function run(a) {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegPath, a, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', d => { err += d; });
    p.on('close', code => code === 0 ? resolve(err) : reject(new Error(err.slice(-1500))));
  });
}

async function masterDuration() {
  let err = '';
  try { await run(['-i', MASTER]); } catch (e) { err = e.message; }
  const m = err.match(/Duration:\s*(\d+):(\d+):(\d+\.\d+)/);
  if (!m) return 30;
  return (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]);
}

async function buildMusic(duration) {
  if (!existsSync(MUSIC_FILE)) {
    throw new Error(`music track not found (${MUSIC_FILE}).`);
  }
  const fadeStart = Math.max(0, duration - 2.2);
  console.log(`▶ preparing ${duration.toFixed(1)}s EDM bed …`);
  await run([
    '-y', '-stream_loop', '-1', '-i', MUSIC_FILE,
    '-t', String(duration),
    '-af', `afade=t=in:st=0:d=0.5,afade=t=out:st=${fadeStart}:d=2.2,loudnorm=I=-14:TP=-1.0:LRA=11`,
    '-c:a', 'aac', '-b:a', '192k', BED,
  ]);
  console.log(`✔ music bed → ${BED}`);
}

async function encode() {
  if (!existsSync(MASTER)) throw new Error(`master not found (${MASTER}) — run without --encode-only first`);
  if (!existsSync(BED)) throw new Error(`music bed not found (${BED})`);
  const targets = ONLY ? FORMATS.filter(f => f.id === ONLY) : FORMATS;
  if (!targets.length) throw new Error(`unknown --only value: ${ONLY}`);

  for (const f of targets) {
    const out = join(OUT_DIR, `bwr-tuto-${f.id}.mp4`);
    const common = [
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '20',
      '-pix_fmt', 'yuv420p', '-profile:v', 'high', '-level', '4.0',
      '-r', '30', '-c:a', 'aac', '-b:a', '192k', '-shortest',
      '-movflags', '+faststart', out,
    ];
    let a;
    if (f.mode === 'native') {
      a = ['-y', '-i', MASTER, '-i', BED,
        '-vf', `scale=${f.w}:${f.h}:flags=lanczos`,
        '-map', '0:v', '-map', '1:a', ...common];
    } else {
      a = ['-y', '-i', MASTER, '-i', BED,
        '-filter_complex',
        `[0:v]split=2[bg][fg];` +
        `[bg]scale=${f.w}:${f.h}:force_original_aspect_ratio=increase,crop=${f.w}:${f.h},` +
        `gblur=sigma=22,eq=brightness=-0.12:saturation=1.05[bgb];` +
        `[fg]scale=${f.w}:${f.h}:force_original_aspect_ratio=decrease:flags=lanczos[fgs];` +
        `[bgb][fgs]overlay=(W-w)/2:(H-h)/2[v]`,
        '-map', '[v]', '-map', '1:a', ...common];
    }
    process.stdout.write(`▶ encoding ${f.id} (${f.w}×${f.h}) … `);
    await run(a);
    console.log('done →', out);
  }
}

(async () => {
  try {
    if (!ENCODE_ONLY) await record();
    const duration = await masterDuration();
    if (!ENCODE_ONLY || !existsSync(BED)) await buildMusic(duration);
    await encode();
    console.log('\n✅ BWR tutorial reels (with music) ready in scripts/promo/out/ — bwr-tuto-*.mp4');
  } catch (e) {
    console.error('\n❌ tutorial build failed:', e.message);
    process.exit(1);
  }
})();
