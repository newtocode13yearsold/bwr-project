#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
//  BWR Instagram reel #3 generator — "Chaque balade te rapporte des points"
//  (gamification: badges + XP + leaderboard)
//
//  Unlike make-promo.mjs / make-ad.mjs (which stitch a *tour* of several live
//  pages), this records the SELF-CONTAINED reel page `public/promo-defis.html`,
//  which already plays its own ~23 s cinematic timeline. We just:
//    1. open the page headlessly (no screen, NO mouse cursor),
//    2. press ▶, let the timeline run,
//    3. mux in the royalty-free EDM bed (the page's live WebAudio isn't captured
//       by Playwright, so we add the same licensed track make-ad.mjs uses), and
//    4. encode three Instagram-ready MP4s.
//
//  Outputs (WITH music):
//    • 9:16 (1080×1920) — Reels/Stories   → scripts/promo/out/bwr-defis-9x16.mp4
//    • 1:1  (1080×1080) — feed square      → bwr-defis-1x1.mp4
//    • 4:5  (1080×1350) — feed portrait    → bwr-defis-4x5.mp4
//
//  Usage:
//    PROMO_BASE_URL=http://localhost:8787 node scripts/promo/make-defis.mjs
//    node scripts/promo/make-defis.mjs --encode-only   # re-use last recording
//    node scripts/promo/make-defis.mjs --only=9x16      # one format only
//
//  The page is local-only (not deployed), so the dev server must be running:
//    npm run dev:worker      (defaults BASE_URL to http://localhost:8787)
// ─────────────────────────────────────────────────────────────────────────────

import { chromium } from '@playwright/test';
import ffmpegPath from 'ffmpeg-static';
import { spawn } from 'node:child_process';
import { mkdir, rm, readdir, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, 'out');
const RAW_DIR = join(__dirname, '.raw-defis');
const ASSETS  = join(__dirname, 'assets');
const MUSIC_FILE = join(ASSETS, 'music', 'edm.mp3'); // Kevin MacLeod — CC-BY 4.0
const MASTER = join(OUT_DIR, 'bwr-defis-master.webm');
const BED    = join(OUT_DIR, 'bwr-defis-bed.m4a');

// Local-first: the reel page isn't deployed, so default to the dev server.
const BASE_URL = process.env.PROMO_BASE_URL || 'http://localhost:8787';
const PAGE = '/promo-defis.html?bare=1'; // full-bleed capture mode (no controls/frame)

// The page's own timeline length (kept in sync with TOTAL in promo-defis.html).
const REEL_MS = 23000;

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

// ── record the self-contained reel page (no cursor — it's headless) ──────────
async function record() {
  console.log(`▶ recording ${BASE_URL}${PAGE} …`);
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

  const page = await context.newPage();
  await page.goto(PAGE, { waitUntil: 'networkidle', timeout: 30000 });

  // Let the basemap tiles actually paint before the timeline starts, so the
  // opening hook isn't drawn over a blank map.
  await page.waitForSelector('.leaflet-tile-loaded', { timeout: 12000 }).catch(() => {});
  await page.waitForTimeout(900);

  // Skip the "▶ Lancer le reel" gate entirely (it must not appear in the
  // recording) and drive the page's own timeline directly. WebAudio isn't
  // captured by Playwright — we mux the licensed EDM bed in afterwards.
  await page.evaluate(() => {
    document.getElementById('gate').style.display = 'none';
    map.invalidateSize();
    play();
  });
  await page.waitForTimeout(REEL_MS + 1000);

  await context.close(); // finalizes the .webm
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
  if (!m) return REEL_MS / 1000;
  return (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]);
}

// ── music bed (real EDM track, royalty-free, looped/faded/normalized) ────────
async function buildMusic(duration) {
  if (!existsSync(MUSIC_FILE)) {
    throw new Error(
      `music track not found (${MUSIC_FILE}).\n` +
      `   Download a royalty-free EDM track to that path, e.g.:\n` +
      `   curl -L -o "${MUSIC_FILE}" "https://incompetech.com/music/royalty-free/mp3-royaltyfree/Electrodoodle.mp3"`);
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

// ── encode (video + music) ───────────────────────────────────────────────────
async function encode() {
  if (!existsSync(MASTER)) throw new Error(`master not found (${MASTER}) — run without --encode-only first`);
  if (!existsSync(BED)) throw new Error(`music bed not found (${BED})`);
  const targets = ONLY ? FORMATS.filter(f => f.id === ONLY) : FORMATS;
  if (!targets.length) throw new Error(`unknown --only value: ${ONLY}`);

  for (const f of targets) {
    const out = join(OUT_DIR, `bwr-defis-${f.id}.mp4`);
    const common = [
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '20',
      '-pix_fmt', 'yuv420p', '-profile:v', 'high', '-level', '4.0',
      // Standard Rec.709 colour metadata — Instagram/strict validators reject
      // the odd bt470bg tag Chromium's recorder emits.
      '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709',
      '-r', '30', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2',
      '-shortest', '-movflags', '+faststart', out,
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
    console.log('\n✅ Reel #3 (défis) ready in scripts/promo/out/ — bwr-defis-9x16.mp4 drops straight into Instagram.');
  } catch (e) {
    console.error('\n❌ défis reel build failed:', e.message);
    process.exit(1);
  }
})();
