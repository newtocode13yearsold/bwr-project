#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
//  BWR — campagne Instagram « vid5 → vid15 » (11 reels, un par fonctionnalité)
//
//  Records the self-contained reel page `public/ads/promo-vid.html` once per
//  concept. The page holds all 11 scenarios (CONFIGS keyed 5..15); we just call
//  window.setVariant(n) before pressing play. Same pipeline as make-fun.mjs:
//    1. open the page headlessly in bare mode (no controls/frame),
//    2. render the page's OWN synth music offline to a WAV once (shared bed —
//       Playwright doesn't capture live WebAudio),
//    3. for each concept setVariant(n) → play → let the ~15 s timeline run,
//    4. mux the WAV in and encode a 9:16 MP4, copied into the shared ad drop
//       folder (…/Projet Thomas/add) as BWR-vid<N>-9x16.mp4.
//
//  Usage (a static server must serve /public — the bwr-static preview on :4810;
//  the worker's CSP blocks the reel's inline script, so DON'T use :8787):
//    PROMO_BASE_URL=http://localhost:4810 node scripts/promo/make-vids.mjs
//    node scripts/promo/make-vids.mjs --v=7          # one concept only
//    node scripts/promo/make-vids.mjs --v=5,6,7      # a few
//    node scripts/promo/make-vids.mjs --encode-only  # re-use last recordings
//    node scripts/promo/make-vids.mjs --all-formats  # + 1x1 and 4x5
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
const DROP    = join(__dirname, '..', '..', '..', 'add');   // shared ad folder
const LOOP    = join(OUT_DIR, 'bwr-vid-loop.wav');          // exact synth bed
const BED     = join(OUT_DIR, 'bwr-vid-bed.m4a');           // trimmed/faded bed

const BASE_URL = process.env.PROMO_BASE_URL || 'http://localhost:4810';
const PAGE = '/ads/promo-vid.html?bare=1';

const REEL_MS = 15500;
const AUDIO_SECONDS = 19;
const FINAL_SEC = 15.5;

const VIEWPORT = { width: 540, height: 960 };
const SCALE = 2;

// The campaign is numbered vid5 → vid15 (11 concepts) — see CONFIGS in the page.
const ALL_VIDS = [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];

const args = process.argv.slice(2);
const ENCODE_ONLY = args.includes('--encode-only');
const ALL_FORMATS = args.includes('--all-formats');
const ONLY = (args.find(a => a.startsWith('--only=')) || '').split('=')[1] || null;
const PICK = (args.find(a => a.startsWith('--v=')) || '').split('=')[1] || null;
const VIDS = PICK ? PICK.split(',').map(s => Number(s.trim())).filter(Boolean) : ALL_VIDS;

const bad = VIDS.filter(v => !ALL_VIDS.includes(v));
if (bad.length) { console.error(`❌ unknown concept(s): ${bad.join(', ')} — valid: ${ALL_VIDS.join(', ')}`); process.exit(1); }

const FORMATS = [
  { id: '9x16', w: 1080, h: 1920, mode: 'native'  },
  { id: '1x1',  w: 1080, h: 1080, mode: 'blurpad' },
  { id: '4x5',  w: 1080, h: 1350, mode: 'blurpad' },
];

const master = v => join(OUT_DIR, `bwr-vid${v}-master.webm`);

// ── render the shared music bed once (every concept uses the same track) ──────
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

// ── record one concept ────────────────────────────────────────────────────────
async function recordVid(browser, ctxOpts, v) {
  const RAW = join(__dirname, `.raw-vid-${v}`);
  await rm(RAW, { recursive: true, force: true });
  await mkdir(RAW, { recursive: true });

  const context = await browser.newContext({
    ...ctxOpts,
    recordVideo: { dir: RAW, size: { width: VIEWPORT.width, height: VIEWPORT.height } },
  });
  const page = await context.newPage();
  await page.goto(PAGE, { waitUntil: 'domcontentloaded', timeout: 30000 });
  // The static `serve` host strips the query string on its clean-URL redirect,
  // so force bare mode + the concept via evaluate rather than trusting the URL.
  await page.evaluate((n) => {
    document.body.classList.add('bare');
    const g = document.getElementById('gate'); if (g) g.style.display = 'none';
    window.setVariant(n);
  }, v);
  await page.waitForFunction(() => typeof play === 'function');
  // Give the b-roll photo + the real-map screenshot time to decode before play.
  await page.waitForTimeout(1500);
  await page.evaluate(() => play());
  await page.waitForTimeout(REEL_MS + 1200);

  await context.close(); // finalizes the .webm
  const files = (await readdir(RAW)).filter(f => f.endsWith('.webm'));
  if (!files.length) throw new Error(`vid${v}: no video recorded`);
  if (existsSync(master(v))) await rm(master(v));
  await rename(join(RAW, files[0]), master(v));
  await rm(RAW, { recursive: true, force: true });
  console.log(`✔ vid${v} recorded → ${master(v)}`);
}

async function recordAll() {
  console.log(`▶ recording ${BASE_URL}${PAGE} — vid ${VIDS.join(', ')} …`);
  await mkdir(OUT_DIR, { recursive: true });
  const browser = await chromium.launch();
  const ctxOpts = {
    baseURL: BASE_URL, viewport: VIEWPORT, deviceScaleFactor: SCALE,
    isMobile: true, hasTouch: true, locale: 'fr-FR',
  };
  await renderMusic(browser, ctxOpts);
  for (const v of VIDS) await recordVid(browser, ctxOpts, v);
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

async function encodeVid(v) {
  const M = master(v);
  if (!existsSync(M)) throw new Error(`master not found (${M}) — run without --encode-only first`);
  const targets = ONLY ? FORMATS.filter(f => f.id === ONLY)
                : ALL_FORMATS ? FORMATS
                : FORMATS.filter(f => f.id === '9x16');
  if (!targets.length) throw new Error(`unknown --only value: ${ONLY}`);

  for (const f of targets) {
    const out = join(OUT_DIR, `bwr-vid${v}-${f.id}.mp4`);
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
      a = ['-y', '-i', M, '-i', BED,
        '-vf', `scale=${f.w}:${f.h}:flags=lanczos`,
        '-map', '0:v', '-map', '1:a', ...common];
    } else {
      a = ['-y', '-i', M, '-i', BED,
        '-filter_complex',
        `[0:v]split=2[bg][fg];` +
        `[bg]scale=${f.w}:${f.h}:force_original_aspect_ratio=increase,crop=${f.w}:${f.h},` +
        `gblur=sigma=22,eq=brightness=-0.12:saturation=1.05[bgb];` +
        `[fg]scale=${f.w}:${f.h}:force_original_aspect_ratio=decrease:flags=lanczos[fgs];` +
        `[bgb][fgs]overlay=(W-w)/2:(H-h)/2[v]`,
        '-map', '[v]', '-map', '1:a', ...common];
    }
    process.stdout.write(`▶ encoding vid${v} ${f.id} (${f.w}×${f.h}) … `);
    await run(a);
    await mkdir(DROP, { recursive: true });
    const drop = join(DROP, `BWR-vid${v}-${f.id}.mp4`);
    await copyFile(out, drop);
    console.log('done →', drop);
  }
}

(async () => {
  try {
    if (!ENCODE_ONLY) await recordAll();
    if (!ENCODE_ONLY || !existsSync(BED)) await buildMusic(FINAL_SEC);
    for (const v of VIDS) await encodeVid(v);
    console.log(`\n✅ Campagne prête dans ../add/ — BWR-vid${VIDS[0]}…vid${VIDS[VIDS.length - 1]}-9x16.mp4`);
  } catch (e) {
    console.error('\n❌ campaign reels build failed:', e.message);
    process.exit(1);
  }
})();
