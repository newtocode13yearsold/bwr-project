// Generates the social-share image (Open Graph / Twitter card) for BWR.
//
//   node scripts/make-og-image.mjs
//
// Renders a branded 1200x630 card with Playwright (real font rendering) and
// writes public/og-image.png. Re-run whenever the branding or tagline changes.
// This is the ONE image every social platform (WhatsApp, Messenger, iMessage,
// Facebook, Discord, LinkedIn, X) shows when a bwrmaps.com link is shared.

import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, '..', 'public', 'og-image.png');

// Same palette as favicon.svg / icons/icon.svg and the app difficulty colours.
const GREEN_BG = '#123a0c';
const GREEN_BG2 = '#1e4d14';
const LEAF = '#22c55e';

const html = `<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@500;600;700;800;900&family=Fraunces:opsz,wght@9..144,600;9..144,700;9..144,900&display=swap" rel="stylesheet">
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  html,body { width:1200px; height:630px; }
  body {
    font-family:'Inter',sans-serif;
    color:#fff;
    background:
      radial-gradient(1100px 700px at 80% -10%, rgba(34,197,94,.28), transparent 60%),
      radial-gradient(900px 600px at 8% 115%, rgba(34,197,94,.20), transparent 55%),
      linear-gradient(150deg, ${GREEN_BG2} 0%, ${GREEN_BG} 100%);
    position:relative; overflow:hidden;
  }
  /* Topographic contour lines — evokes a trail map without needing real data */
  .topo { position:absolute; inset:0; opacity:.16; }
  .frame { position:absolute; inset:36px; border:2px solid rgba(255,255,255,.14); border-radius:28px; }
  .wrap { position:absolute; inset:0; padding:92px 96px; display:flex; flex-direction:column; justify-content:space-between; }

  .top { display:flex; align-items:center; gap:26px; }
  .logo { width:96px; height:96px; border-radius:24px; background:${GREEN_BG2};
    box-shadow:0 12px 34px rgba(0,0,0,.35), inset 0 0 0 2px rgba(255,255,255,.10);
    display:flex; align-items:center; justify-content:center; }
  .wordmark { font-family:'Inter'; font-weight:900; font-size:60px; letter-spacing:-2px; line-height:1; }
  .wordmark span { color:${LEAF}; }
  .kicker { font-weight:700; font-size:20px; letter-spacing:3px; text-transform:uppercase;
    color:rgba(255,255,255,.72); margin-top:6px; }

  h1 { font-family:'Fraunces',serif; font-weight:700; font-size:72px; line-height:1.04;
    letter-spacing:-1px; max-width:940px; }
  h1 em { font-style:normal; color:${LEAF}; }
  .sub { font-size:27px; font-weight:500; color:rgba(255,255,255,.86); margin-top:22px; max-width:880px; line-height:1.35; }

  .bottom { display:flex; align-items:center; justify-content:space-between; }
  .legend { display:flex; gap:30px; }
  .chip { display:flex; align-items:center; gap:11px; font-size:22px; font-weight:600; color:rgba(255,255,255,.9); }
  .dot { width:18px; height:18px; border-radius:50%; box-shadow:0 0 0 4px rgba(255,255,255,.08); }
  .url { font-size:28px; font-weight:800; letter-spacing:.5px; }
  .url b { color:${LEAF}; }
</style></head>
<body>
  <svg class="topo" viewBox="0 0 1200 630" preserveAspectRatio="none" fill="none" stroke="#22c55e" stroke-width="2">
    <path d="M-40 120 C 240 40, 520 210, 820 120 S 1300 200, 1300 130"/>
    <path d="M-40 210 C 260 130, 560 300, 860 210 S 1320 290, 1320 220"/>
    <path d="M-40 300 C 280 220, 600 390, 900 300 S 1340 380, 1340 310"/>
    <path d="M-40 400 C 300 320, 640 480, 940 400 S 1360 470, 1360 410"/>
    <path d="M-40 500 C 320 430, 680 570, 980 500 S 1380 560, 1380 510"/>
    <path d="M-40 590 C 340 520, 700 650, 1010 590 S 1400 640, 1400 600"/>
  </svg>
  <div class="frame"></div>
  <div class="wrap">
    <div class="top">
      <div class="logo">
        <svg width="60" height="60" viewBox="0 0 512 512">
          <polygon points="256,60 340,200 300,200 370,320 290,320 330,420 182,420 222,320 142,320 212,200 172,200" fill="${LEAF}"/>
        </svg>
      </div>
      <div>
        <div class="wordmark">B<span>W</span>R</div>
        <div class="kicker">Balades en forêt de Compiègne</div>
      </div>
    </div>

    <div>
      <h1>La carte des <em>forêts de l'Oise</em>, à pied ou à vélo.</h1>
      <div class="sub">Compiègne, Laigue, Halatte, Chantilly, Ermenonville — sentiers vérifiés, état des chemins en temps réel et itinéraires sur mesure.</div>
    </div>

    <div class="bottom">
      <div class="legend">
        <div class="chip"><span class="dot" style="background:#22c55e"></span>Facile</div>
        <div class="chip"><span class="dot" style="background:#f97316"></span>Moyen</div>
        <div class="chip"><span class="dot" style="background:#ef4444"></span>Difficile</div>
      </div>
      <div class="url"><b>bwrmaps</b>.com</div>
    </div>
  </div>
</body></html>`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
await page.setContent(html, { waitUntil: 'networkidle' });
await page.evaluate(() => document.fonts.ready);
await page.waitForTimeout(300);
await page.screenshot({ path: OUT, type: 'png' });
await browser.close();
console.log('Wrote', OUT);
