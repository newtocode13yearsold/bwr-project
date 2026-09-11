#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
//  BWR Instagram reel — "TOUR 2" : full-product presentation, second version.
//
//  Records the self-contained reel page `public/ads/promo-tour2.html` ONCE.
//  Same engine as make-tour.mjs but a distinct hook, feature order, palettes and
//  photos so it reads as a genuinely different ad walking through every feature.
//
//  Output: the shared "add 2" drop folder next to the repo, named `add 2.mp4`
//  (…/Projet Thomas/add 2/add 2.mp4).
//
//  Usage (static server must serve /public — bwr-static preview on :4810; the
//  worker's CSP blocks the reel's inline script, so DON'T use :8787):
//    PROMO_BASE_URL=http://localhost:4810 node scripts/promo/make-tour2.mjs
//    node scripts/promo/make-tour2.mjs --only=9x16      # only the vertical cut
//    node scripts/promo/make-tour2.mjs --encode-only    # re-use the recording
// ─────────────────────────────────────────────────────────────────────────────

import { chromium } from '@playwright/test';
import ffmpegPath from 'ffmpeg-static';
import { spawn } from 'node:child_process';
import { mkdir, rm, readdir, rename, writeFile, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, 'out');
const DROP    = join(__dirname, '..', '..', '..', 'add 2');   // requested drop folder
const DROP_NAME = 'add 2';                                     // requested file name
const LOOP    = join(OUT_DIR, 'bwr-tour2-loop.wav');
const BED     = join(OUT_DIR, 'bwr-tour2-bed.m4a');

const BASE_URL = process.env.PROMO_BASE_URL || 'http://localhost:4810';
const PAGE = '/ads/promo-tour2.html?bare=1';

const REEL_MS = 23000;      // record well past the ~21.4 s reel so the CTA is captured
const AUDIO_SECONDS = 26;
const FINAL_SEC = 23.5;     // final cut length (lead-in + full reel + short tail)

const VIEWPORT = { width: 540, height: 960 };
const SCALE = 2;

const args = process.argv.slice(2);
const ENCODE_ONLY = args.includes('--encode-only');
const ONLY = (args.find(a => a.startsWith('--only=')) || '').split('=')[1] || null;

const FORMATS = [
  { id: '9x16', w: 1080, h: 1920, mode: 'native'  },
  { id: '1x1',  w: 1080, h: 1080, mode: 'blurpad' },
  { id: '4x5',  w: 1080, h: 1350, mode: 'blurpad' },
];

const master = join(OUT_DIR, 'bwr-tour2-master.webm');

// ── render the music bed once ─────────────────────────────────────────────────
async function renderMusic(browser, ctxOpts) {
  const audioCtx = await browser.newContext(ctxOpts);
  const ap = await audioCtx.newPage();
  await ap.goto(PAGE, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await ap.waitForFunction(() => typeof window.renderMusicWav === 'function');
  const b64 = await ap.evaluate(s => window.renderMusicWav(s), AUDIO_SECONDS);
  if (!b64) throw new Error('renderMusicWav() returned nothing (OfflineAudioContext unavailable?)');
  await writeFile(LOOP, Buffer.from(b64, 'base64'));
  await audioCtx.close();
  console.log(`✔ music bed rendered → ${LOOP}`);
}

// ── record the reel ────────────────────────────────────────────────────────────
async function recordReel(browser, ctxOpts) {
  const RAW = join(__dirname, '.raw-tour2');
  await rm(RAW, { recursive: true, force: true });
  await mkdir(RAW, { recursive: true });

  const context = await browser.newContext({
    ...ctxOpts,
    recordVideo: { dir: RAW, size: { width: VIEWPORT.width, height: VIEWPORT.height } },
  });
  const page = await context.newPage();
  await page.goto(PAGE, { waitUntil: 'domcontentloaded', timeout: 30000 });
  // The static host strips the query string on its clean-URL redirect, so force
  // bare mode + hide the gate via evaluate rather than trusting the URL.
  await page.evaluate(() => {
    document.body.classList.add('bare');
    const g = document.getElementById('gate'); if (g) g.style.display = 'none';
  });
  await page.waitForFunction(() => typeof play === 'function');
  // The page preloads its images at init; a short settle is enough before play.
  await page.waitForTimeout(1200);
  await page.evaluate(() => play());
  await page.waitForTimeout(REEL_MS + 1200);

  await context.close(); // finalizes the .webm
  const files = (await readdir(RAW)).filter(f => f.endsWith('.webm'));
  if (!files.length) throw new Error('no video recorded');
  if (existsSync(master)) await rm(master);
  await rename(join(RAW, files[0]), master);
  await rm(RAW, { recursive: true, force: true });
  console.log(`✔ reel recorded → ${master}`);
}

async function recordAll() {
  console.log(`▶ recording ${BASE_URL}${PAGE} …`);
  await mkdir(OUT_DIR, { recursive: true });
  const browser = await chromium.launch();
  const ctxOpts = {
    baseURL: BASE_URL, viewport: VIEWPORT, deviceScaleFactor: SCALE,
    isMobile: true, hasTouch: true, locale: 'fr-FR',
  };
  await renderMusic(browser, ctxOpts);
  await recordReel(browser, ctxOpts);
  await browser.close();
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

async function buildMusic(duration) {
  if (!existsSync(LOOP)) throw new Error(`music loop not found (${LOOP}) — run without --encode-only first`);
  const fadeStart = Math.max(0, duration - 2.0);
  console.log(`▶ preparing ${duration.toFixed(1)}s music bed …`);
  await run([
    '-y', '-stream_loop', '-1', '-i', LOOP,
    '-t', String(duration),
    '-af', `afade=t=in:st=0:d=0.5,afade=t=out:st=${fadeStart}:d=2.0,loudnorm=I=-16:TP=-1.5:LRA=11`,
    '-c:a', 'aac', '-b:a', '192k', BED,
  ]);
  console.log(`✔ music bed → ${BED}`);
}

async function encode() {
  if (!existsSync(master)) throw new Error(`master not found (${master}) — run without --encode-only first`);
  const targets = ONLY ? FORMATS.filter(f => f.id === ONLY) : FORMATS.filter(f => f.id === '9x16');
  if (!targets.length) throw new Error(`unknown --only value: ${ONLY}`);

  for (const f of targets) {
    const out = join(OUT_DIR, `bwr-tour2-${f.id}.mp4`);
    const common = [
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '20',
      '-pix_fmt', 'yuv420p', '-profile:v', 'high', '-level', '4.0',
      '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709',
      '-r', '30', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2',
      '-t', String(FINAL_SEC),
      '-shortest', '-movflags', '+faststart', out,
    ];
    let a;
    if (f.mode === 'native') {
      a = ['-y', '-i', master, '-i', BED,
        '-vf', `scale=${f.w}:${f.h}:flags=lanczos`,
        '-map', '0:v', '-map', '1:a', ...common];
    } else {
      a = ['-y', '-i', master, '-i', BED,
        '-filter_complex',
        `[0:v]split=2[bg][fg];` +
        `[bg]scale=${f.w}:${f.h}:force_original_aspect_ratio=increase,crop=${f.w}:${f.h},` +
        `gblur=sigma=22,eq=brightness=-0.12:saturation=1.05[bgb];` +
        `[fg]scale=${f.w}:${f.h}:force_original_aspect_ratio=decrease:flags=lanczos[fgs];` +
        `[bgb][fgs]overlay=(W-w)/2:(H-h)/2[v]`,
        '-map', '[v]', '-map', '1:a', ...common];
    }
    process.stdout.write(`▶ encoding tour2 ${f.id} (${f.w}×${f.h}) … `);
    await run(a);
    await mkdir(DROP, { recursive: true });
    // 9:16 is the requested master → `add 1.mp4`; other formats keep a suffix.
    const dropName = f.id === '9x16' ? `${DROP_NAME}.mp4` : `${DROP_NAME}-${f.id}.mp4`;
    const drop = join(DROP, dropName);
    await copyFile(out, drop);
    console.log('done →', drop);
  }
}

(async () => {
  try {
    if (!ENCODE_ONLY) await recordAll();
    if (!ENCODE_ONLY || !existsSync(BED)) await buildMusic(FINAL_SEC);
    await encode();
    console.log(`\n✅ Reel « présentation complète » prêt dans « add 2 » — ${DROP_NAME}.mp4`);
  } catch (e) {
    console.error('\n❌ tour reel build failed:', e.message);
    process.exit(1);
  }
})();
