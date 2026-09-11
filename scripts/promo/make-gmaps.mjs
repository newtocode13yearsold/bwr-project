#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
//  BWR Instagram reel — "GPS" (le gag Google Maps → la vraie carte graduée)
//
//  Records the self-contained reel page `public/ads/promo-gmaps.html`, which
//  plays its own ~15 s motion-graphics timeline: a forest photo + a car-GPS
//  banner freaking out ("Demi-tour sur 300 m… Recalcul"), then BWR's REAL
//  colour-graded map (a genuine screenshot) pops in and saves the day. Steps
//  mirror make-grades.mjs / make-fresh.mjs:
//    1. open the page headlessly in bare mode (no controls/frame),
//    2. render the page's OWN synth music offline to a WAV (Playwright doesn't
//       capture live WebAudio, so we ask the page via window.renderMusicWav()),
//    3. press play, let the timeline run, and
//    4. mux the WAV in and encode Instagram-ready MP4s, copied into the shared
//       ad drop folder (…/Projet Thomas/add) as BWR-pub-gmaps-*.mp4.
//
//  Usage (a server must serve /public — the bwr-static preview on :4810 works;
//  the worker's CSP blocks the reel's inline script, so DON'T use :8787):
//    PROMO_BASE_URL=http://localhost:4810 node scripts/promo/make-gmaps.mjs
//    node scripts/promo/make-gmaps.mjs --encode-only   # re-use last recording
//    node scripts/promo/make-gmaps.mjs --only=9x16       # one format only
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
const FEED = process.argv.includes('--feed');
const SUF = FEED ? '-feed' : '';
const RAW_DIR = join(__dirname, '.raw-gmaps' + SUF);
const MASTER = join(OUT_DIR, 'bwr-gmaps' + SUF + '-master.webm');
const LOOP   = join(OUT_DIR, 'bwr-gmaps-loop.wav'); // exact synth bed from the page
const BED    = join(OUT_DIR, 'bwr-gmaps-bed.m4a');  // trimmed/faded/normalized bed
const DROP   = join(__dirname, '..', '..', '..', 'add');

const BASE_URL = process.env.PROMO_BASE_URL || 'http://localhost:4810';
const PAGE = '/ads/promo-gmaps.html?bare=1';

const REEL_MS = 15500;
const AUDIO_SECONDS = 19;
const FINAL_SEC = 15.5;

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

// ── record the self-contained reel page (no cursor — it's headless) ──────────
async function record() {
  console.log(`▶ recording ${BASE_URL}${PAGE} …`);
  await rm(RAW_DIR, { recursive: true, force: true });
  await mkdir(RAW_DIR, { recursive: true });
  await mkdir(OUT_DIR, { recursive: true });

  const browser = await chromium.launch();
  const ctxOpts = {
    baseURL: BASE_URL, viewport: VIEWPORT, deviceScaleFactor: SCALE,
    isMobile: true, hasTouch: true, locale: 'fr-FR',
  };

  // PASS 1 — render the page's OWN music bed offline → WAV.
  {
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

  // PASS 2 — record the reel. Hide the gate, let the first frame paint, then play.
  const context = await browser.newContext({
    ...ctxOpts,
    recordVideo: { dir: RAW_DIR, size: { width: VIEWPORT.width, height: VIEWPORT.height } },
  });
  const page = await context.newPage();
  await page.goto(PAGE, { waitUntil: 'domcontentloaded', timeout: 30000 });
  // Force bare mode + hide the gate explicitly (the static `serve` host strips
  // the query string on its clean-URL redirect, so ?bare would never activate).
  await page.evaluate((feed) => {
    document.body.classList.add('bare');
    if (feed) document.body.classList.add('feed');
    const g = document.getElementById('gate'); if (g) g.style.display = 'none';
  }, FEED);
  await page.waitForFunction(() => typeof play === 'function');
  await page.waitForTimeout(1200); // let fonts + the real-map screenshot decode
  await page.evaluate(() => play());
  await page.waitForTimeout(REEL_MS + 1200);

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
  if (!existsSync(MASTER)) throw new Error(`master not found (${MASTER}) — run without --encode-only first`);
  if (!existsSync(BED)) throw new Error(`music bed not found (${BED})`);
  await mkdir(DROP, { recursive: true });
  let targets = ONLY ? FORMATS.filter(f => f.id === ONLY) : FORMATS;
  if (FEED) targets = targets.filter(f => f.id === '9x16'); // feed variant is 9x16 only
  if (!targets.length) throw new Error(`unknown --only value: ${ONLY}`);

  for (const f of targets) {
    const out = join(OUT_DIR, `bwr-gmaps${SUF}-${f.id}.mp4`);
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
    process.stdout.write(`▶ encoding ${f.id}${SUF} (${f.w}×${f.h}) … `);
    await run(a);
    const drop = join(DROP, `BWR-pub-gmaps${SUF}-${f.id}.mp4`);
    await copyFile(out, drop);
    console.log('done →', drop);
  }
}

(async () => {
  try {
    if (!ENCODE_ONLY) await record();
    if (!ENCODE_ONLY || !existsSync(BED)) await buildMusic(FINAL_SEC);
    await encode();
    console.log('\n✅ Reel « GPS » prêt dans ../add/ — BWR-pub-gmaps-9x16.mp4 se poste direct sur Instagram.');
  } catch (e) {
    console.error('\n❌ gmaps reel build failed:', e.message);
    process.exit(1);
  }
})();
