#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
//  BWR Instagram reel #5 generator — hype photo-montage + kinetic typography
//  (brand-new style: no map, fast beat-synced b-roll cuts, neon grade)
//
//  Records the self-contained page `public/promo-hype.html` (its own ~22 s
//  timeline), muxes the purchased EDM track, and encodes Instagram-SAFE MP4s
//  (H.264 Main / yuv420p / AAC-LC 44.1 kHz / faststart / stripped metadata —
//  the same conservative spec that Instagram finally accepted for reel #4).
//  Finished 9:16 / 1:1 / 4:5 files are also copied into the "add" folder.
//
//  MUSIC: download the track below and save it as ONE of:
//     scripts/promo/assets/music/edm-hype2.mp3   (or .wav)
//  If missing, the build stops with instructions. The page's live synth is only
//  a local preview — the exported video always uses the file below.
//
//  Usage:
//    PROMO_BASE_URL=http://localhost:8787 node scripts/promo/make-hype.mjs
//    node scripts/promo/make-hype.mjs --encode-only
//    node scripts/promo/make-hype.mjs --only=9x16
//    TRACK_DROP=59 node scripts/promo/make-hype.mjs   # where the track's drop is (s)
//
//  Dev server must be running (page is local-only):  npm run dev:worker
// ─────────────────────────────────────────────────────────────────────────────

import { chromium } from '@playwright/test';
import ffmpegPath from 'ffmpeg-static';
import { spawn } from 'node:child_process';
import { mkdir, rm, readdir, rename, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, 'out');
const RAW_DIR = join(__dirname, '.raw-hype');
const ASSETS  = join(__dirname, 'assets');
// Purchased EDM track — accept .mp3 or .wav (NCS downloads offer both).
const MUSIC_CANDIDATES = [
  join(ASSETS, 'music', 'edm-hype2.mp3'),
  join(ASSETS, 'music', 'edm-hype2.wav'),
  join(ASSETS, 'music', 'edm-hype2.flac'),
];
const MUSIC_FILE = MUSIC_CANDIDATES.find(existsSync) || MUSIC_CANDIDATES[0];
const MASTER = join(OUT_DIR, 'bwr-hype-master.webm');
const BED    = join(OUT_DIR, 'bwr-hype-bed.m4a');

// Where the finished reels are also delivered (Instagram-ready files).
const ADD_DIR = 'C:/Users/TOM/Documents/Projet Thomas/add';

const BASE_URL = process.env.PROMO_BASE_URL || 'http://localhost:8787';
const PAGE = '/promo-hype.html?bare=1';

// Page timeline length (kept in sync with TOTAL in promo-hype.html).
const REEL_MS = 22500;

// The visual "drop" (flash + first hard cut + title slam) lands at ~3.75 s.
const REEL_DROP = Number(process.env.DROP_AT || 3.75);
// Where the drop sits inside the purchased track (seconds). Set once you know it
// (this script prints an energy scan hint). 0 = play the track from the top.
const TRACK_DROP = Number(process.env.TRACK_DROP || 0);

const VIEWPORT = { width: 540, height: 960 };
const SCALE = 2;

const args = process.argv.slice(2);
const ENCODE_ONLY = args.includes('--encode-only');
// --silent : render with a silent audio track (no EDM file needed). Upload the
// result to Instagram and add a famous song from IG's in-app music library,
// lining its drop up with the ~3.75 s visual drop.
const SILENT = args.includes('--silent');
const ONLY = (args.find(a => a.startsWith('--only=')) || '').split('=')[1] || null;

const FORMATS = [
  { id: '9x16', w: 1080, h: 1920, mode: 'native' },
  { id: '1x1',  w: 1080, h: 1080, mode: 'blurpad' },
  { id: '4x5',  w: 1080, h: 1350, mode: 'blurpad' },
];

// ── record the self-contained reel page (no cursor — headless) ───────────────
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
  // let the b-roll photos decode before the montage starts
  await page.waitForTimeout(1200);

  await page.evaluate(() => {
    document.getElementById('gate').style.display = 'none';
    play();
  });
  await page.waitForTimeout(REEL_MS + 1000);

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
  if (!m) return REEL_MS / 1000;
  return (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]);
}

// ── music bed (purchased EDM track, drop aligned onto the visual drop) ───────
async function buildMusic(duration) {
  if (SILENT) {
    console.log(`▶ preparing ${duration.toFixed(1)}s SILENT audio bed (add music in Instagram) …`);
    await run([
      '-y', '-f', 'lavfi', '-i', `anullsrc=r=44100:cl=stereo`,
      '-t', String(duration), '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', BED,
    ]);
    console.log(`✔ silent bed → ${BED}`);
    return;
  }
  if (!existsSync(MUSIC_FILE)) {
    throw new Error(
      `EDM track not found. Save the downloaded track as ONE of:\n` +
      MUSIC_CANDIDATES.map(f => `   • ${f}`).join('\n') + `\n` +
      `   then re-run this command. (See the reel notes for which track.)`);
  }
  const startAt = Math.max(0, TRACK_DROP - REEL_DROP);
  const fadeStart = Math.max(0, duration - 2.2);
  console.log(`▶ preparing ${duration.toFixed(1)}s EDM bed from ${MUSIC_FILE} (drop@${REEL_DROP}s, track-in ${startAt.toFixed(2)}s) …`);
  await run([
    '-y', '-ss', String(startAt), '-stream_loop', '-1', '-i', MUSIC_FILE,
    // -vn drops any embedded cover-art stream (breaks the .m4a muxer otherwise).
    '-vn', '-t', String(duration),
    '-af', `afade=t=in:st=0:d=0.4,afade=t=out:st=${fadeStart}:d=2.2,loudnorm=I=-14:TP=-1.0:LRA=11`,
    '-c:a', 'aac', '-b:a', '160k', '-ar', '44100', BED,
  ]);
  console.log(`✔ music bed → ${BED}`);
}

// Find where the initial black lead-in ends (Playwright records a black gap
// before play() runs). Trimming there makes play-time == video-time, so the
// drop reliably lands at REEL_DROP (3.75 s) no matter the network timing.
async function firstBlackEnd() {
  let err = '';
  try { err = await run(['-i', MASTER, '-vf', 'blackdetect=d=0.15:pic_th=0.96', '-an', '-f', 'null', '-']); }
  catch (e) { err = e.message; }
  const m = err.match(/black_start:0(?:\.0+)?\s+black_end:(\d+(?:\.\d+)?)/);
  const t = m ? parseFloat(m[1]) : 0;
  console.log(`▶ black lead-in ends at ${t.toFixed(2)}s → trimming there`);
  return t;
}

// ── encode (Instagram-safe: H.264 Main / yuv420p / AAC 44.1k / faststart) ────
async function encode(trimStart = 0, outDur = REEL_MS / 1000) {
  if (!existsSync(MASTER)) throw new Error(`master not found (${MASTER}) — run without --encode-only first`);
  if (!existsSync(BED)) throw new Error(`music bed not found (${BED})`);
  await mkdir(ADD_DIR, { recursive: true }).catch(() => {});
  const targets = ONLY ? FORMATS.filter(f => f.id === ONLY) : FORMATS;
  if (!targets.length) throw new Error(`unknown --only value: ${ONLY}`);

  for (const f of targets) {
    const out = join(OUT_DIR, `bwr-hype-${f.id}.mp4`);
    const common = [
      '-t', String(outDur),
      '-map_metadata', '-1',
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '21',
      '-profile:v', 'main', '-level', '4.0', '-pix_fmt', 'yuv420p',
      '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709',
      '-r', '30', '-g', '60', '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-ac', '2',
      '-shortest', '-movflags', '+faststart', '-f', 'mp4', out,
    ];
    let a;
    if (f.mode === 'native') {
      a = ['-y', '-ss', String(trimStart), '-i', MASTER, '-i', BED,
        '-vf', `scale=${f.w}:${f.h}:flags=lanczos,format=yuv420p`,
        '-map', '0:v:0', '-map', '1:a:0', ...common];
    } else {
      a = ['-y', '-ss', String(trimStart), '-i', MASTER, '-i', BED,
        '-filter_complex',
        `[0:v]split=2[bg][fg];` +
        `[bg]scale=${f.w}:${f.h}:force_original_aspect_ratio=increase,crop=${f.w}:${f.h},` +
        `gblur=sigma=22,eq=brightness=-0.12:saturation=1.05[bgb];` +
        `[fg]scale=${f.w}:${f.h}:force_original_aspect_ratio=decrease:flags=lanczos[fgs];` +
        `[bgb][fgs]overlay=(W-w)/2:(H-h)/2,format=yuv420p[v]`,
        '-map', '[v]', '-map', '1:a:0', ...common];
    }
    process.stdout.write(`▶ encoding ${f.id} (${f.w}×${f.h}) … `);
    await run(a);
    const dest = join(ADD_DIR, `BWR-pub-hype-${f.id}.mp4`);
    await copyFile(out, dest).catch(e => console.warn(`(could not copy to add: ${e.message})`));
    console.log('done →', out, '\n   ↳ copied →', dest);
  }
}

(async () => {
  try {
    if (!ENCODE_ONLY) await record();
    const outDur = REEL_MS / 1000;
    const trimStart = await firstBlackEnd();
    if (!ENCODE_ONLY || !existsSync(BED)) await buildMusic(outDur);
    await encode(trimStart, outDur);
    console.log('\n✅ Reel #5 (hype montage) ready — files in scripts/promo/out/ and in the "add" folder.');
  } catch (e) {
    console.error('\n❌ hype reel build failed:', e.message);
    process.exit(1);
  }
})();
