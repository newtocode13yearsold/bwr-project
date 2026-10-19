#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
//  BWR Instagram reels — série 2 (chat / types / replay / kinetic)
//
//  Each reel is a public/ads/promo-<slug>.html page built on public/ads/js/reel-kit.js
//  (absolute-time timeline + WebAudio music AND sound effects). For each slug:
//    1. render the page's own music + sfx offline → WAV (renderMusicWav),
//    2. render the video FRAME BY FRAME: the page's clock is frozen
//       (Playwright fake clock for setTimeout/rAF/performance.now, and every
//       CSS animation/transition is paused and seeked by hand), advanced exactly
//       1/30 s, screenshotted, repeat. Real-time screencast only managed ~8 fps
//       at 1080p and drifted ~150 ms behind the audio; this is smooth 30 fps
//       and frame 0 == audio 0, so every "pop"/"hit" lands on its visual,
//    3. mux + encode a 1080×1920 MP4 (+ 1x1 / 4x5 blur-pad with --all),
//       copied into ../add/ as BWR-pub-<slug>-<fmt>.mp4.
//
//  Needs the STATIC server on :4810 (launch config "bwr-static"):
//    node scripts/promo/make-reels2.mjs                 # all four, 9x16
//    node scripts/promo/make-reels2.mjs --reel=chat     # one reel (or a,b,c)
//    node scripts/promo/make-reels2.mjs --reel=simple   # série 3: attente/devine/doigt/excuses
//    node scripts/promo/make-reels2.mjs --reel=s4       # série 4: raccourci/avis/papier/classement
//    node scripts/promo/make-reels2.mjs --all           # + 1x1 and 4x5
//    node scripts/promo/make-reels2.mjs --encode-only   # reuse last renders
// ─────────────────────────────────────────────────────────────────────────────
import { chromium } from '@playwright/test';
import ffmpegPath from 'ffmpeg-static';
import { spawn } from 'node:child_process';
import { mkdir, writeFile, readFile, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, 'out');
const DROP = join(__dirname, '..', '..', '..', 'add');
const BASE_URL = process.env.PROMO_BASE_URL || 'http://localhost:4810';
const VIEWPORT = { width: 1080, height: 1920 };   // native 1080p (layout is cqh-based)
const FPS = 30;

const args = process.argv.slice(2);
const arg = k => (args.find(a => a.startsWith(`--${k}=`)) || '').split('=')[1];
const ENCODE_ONLY = args.includes('--encode-only');
const SETS = { simple: ['attente', 'devine', 'doigt', 'excuses'], s4: ['raccourci', 'avis', 'papier', 'classement'] };
const SLUGS = arg('reel') ? arg('reel').split(',').flatMap(s => SETS[s] || [s]) : ['chat', 'types', 'replay', 'kinetic'];
const FORMATS = [
  { id: '9x16', w: 1080, h: 1920, mode: 'native' },
  ...(args.includes('--all') ? [
    { id: '1x1', w: 1080, h: 1080, mode: 'blurpad' },
    { id: '4x5', w: 1080, h: 1350, mode: 'blurpad' },
  ] : []),
];

const f = (slug, ext) => join(OUT, `bwr-${slug}.${ext}`);

function ffmpeg(a, stdin = false) {
  const p = spawn(ffmpegPath, a, { stdio: [stdin ? 'pipe' : 'ignore', 'ignore', 'pipe'] });
  let err = ''; p.stderr.on('data', d => { err += d; });
  p.done = new Promise((resolve, reject) => p.on('close', c => c === 0 ? resolve() : reject(new Error(err.slice(-1500)))));
  return p;
}

async function render(browser, slug) {
  const page = await (await browser.newContext({ baseURL: BASE_URL, viewport: VIEWPORT, deviceScaleFactor: 1, locale: 'fr-FR' })).newPage();
  await page.goto(`/ads/promo-${slug}.html`);
  await page.evaluate(() => { document.body.classList.add('bare'); document.getElementById('gate').style.display = 'none'; });
  await page.waitForFunction(() => window.__reelReady === true, null, { timeout: 30000 });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(600);

  // 1 — music + sfx from the page's own WebAudio graph
  const total = await page.evaluate(() => TOTAL);
  const b64 = await page.evaluate(s => window.renderMusicWav(s), total / 1000 + 0.6);
  await writeFile(f(slug, 'wav'), Buffer.from(b64, 'base64'));

  // 2 — freeze time. JS timers/rAF/performance.now → Playwright fake clock;
  //     CSS animations + transitions → paused, then seeked to (now − birth).
  await page.clock.install({ time: 0 });
  await page.clock.pauseAt(1000);                 // otherwise the fake clock keeps flowing in real time
  await page.evaluate(() => {
    const born = new WeakMap();
    window.__now = 0;
    window.__seek = () => {
      for (const a of document.getAnimations()) {
        let b = born.get(a);
        if (b === undefined) { b = window.__now; born.set(a, b); a.pause(); }
        a.currentTime = window.__now - b;
      }
    };
    window.__seek();
  });

  const enc = ffmpeg(['-y', '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'mjpeg', '-i', '-',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '12', '-pix_fmt', 'yuv420p', f(slug, 'master.mp4')], true);

  await page.evaluate(() => { play(); });
  const frames = Math.ceil(total / 1000 * FPS);
  const step = 1000 / FPS;
  for (let i = 0; i < frames; i++) {
    if (i > 0) await page.clock.runFor(step);
    await page.evaluate(t => { window.__now = t; window.__seek(); }, i * step);
    const jpg = await page.screenshot({ type: 'jpeg', quality: 93 });
    if (!enc.stdin.write(jpg)) await new Promise(r => enc.stdin.once('drain', r));
    if (i % 60 === 0) process.stdout.write(`\r  ${slug}: frame ${i}/${frames}`);
  }
  enc.stdin.end();
  await enc.done;
  await page.context().close();
  await writeFile(f(slug, 'json'), JSON.stringify({ total }));
  console.log(`\r✔ ${slug} rendered (${frames} frames, ${(total / 1000).toFixed(1)} s)      `);
}

async function encode(slug) {
  const { total } = JSON.parse(await readFile(f(slug, 'json'), 'utf8'));
  const dur = total / 1000;
  for (const fm of FORMATS) {
    const out = join(OUT, `bwr-${slug}-${fm.id}.mp4`);
    const vf = fm.mode === 'native'
      ? `[0:v]scale=${fm.w}:${fm.h}:flags=lanczos[v]`
      : `[0:v]split=2[bg][fg];[bg]scale=${fm.w}:${fm.h}:force_original_aspect_ratio=increase,crop=${fm.w}:${fm.h},` +
        `gblur=sigma=22,eq=brightness=-0.12[bgb];[fg]scale=${fm.w}:${fm.h}:force_original_aspect_ratio=decrease:flags=lanczos[fgs];` +
        `[bgb][fgs]overlay=(W-w)/2:(H-h)/2[v]`;
    process.stdout.write(`▶ ${slug} ${fm.id} … `);
    await ffmpeg([
      '-y', '-i', f(slug, 'master.mp4'), '-i', f(slug, 'wav'),
      '-filter_complex', `${vf};[1:a]afade=t=out:st=${(dur - 1).toFixed(2)}:d=1,loudnorm=I=-14:TP=-1.5:LRA=11[a]`,
      '-map', '[v]', '-map', '[a]', '-t', dur.toFixed(2), '-r', String(FPS),
      '-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-pix_fmt', 'yuv420p', '-profile:v', 'high',
      '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709',
      '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-movflags', '+faststart', out,
    ]).done;
    await mkdir(DROP, { recursive: true });
    const drop = join(DROP, `BWR-pub-${slug}-${fm.id}.mp4`);
    await copyFile(out, drop);
    console.log('→', drop);
  }
}

(async () => {
  try {
    await mkdir(OUT, { recursive: true });
    if (!ENCODE_ONLY) {
      const browser = await chromium.launch();
      for (const s of SLUGS) await render(browser, s);
      await browser.close();
    }
    for (const s of SLUGS) {
      if (!existsSync(f(s, 'master.mp4'))) throw new Error(`${s}: no master — run without --encode-only`);
      await encode(s);
    }
    console.log('\n✅ Reels prêts dans ../add/');
  } catch (e) {
    console.error('\n❌ build failed:', e.message);
    process.exit(1);
  }
})();
