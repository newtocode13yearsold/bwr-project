// One-shot, idempotent patcher: adds the social-share image (og:image /
// twitter:image) to every shareable HTML page and upgrades the Twitter card to
// the large "summary_large_image" format. Safe to re-run — pages that already
// carry og:image are skipped.
//
//   node scripts/add-og-image-meta.mjs
//
// Pairs with scripts/make-og-image.mjs (which produces public/og-image.png).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PUB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const IMG = 'https://bwrmaps.com/og-image.png';
const ALT = "BWR — la carte des forêts de l'Oise, à pied ou à vélo";
const SITE = 'BWR';

const imageTags = [
  `  <meta property="og:image" content="${IMG}" />`,
  `  <meta property="og:image:width" content="1200" />`,
  `  <meta property="og:image:height" content="630" />`,
  `  <meta property="og:image:type" content="image/png" />`,
  `  <meta property="og:image:alt" content="${ALT}" />`,
  `  <meta name="twitter:image" content="${IMG}" />`,
].join('\n');

// Pages that currently have NO Open Graph block at all — give them a full one.
// title = social title (falls back to <title>); desc extracted from the page's
// meta description when present, else this fallback.
const cfg = {
  'best-tours.html': { url: '/best-tours', title: 'Les meilleures balades en forêt de Compiègne — BWR' },
  'forum.html': { url: '/forum', title: "Forum de la communauté BWR — forêts de l'Oise" },
  'leaderboard.html': { url: '/leaderboard', title: "Classement BWR — forêts de l'Oise", desc: "Classement de la communauté BWR : signalez l'état des sentiers et grimpez dans le classement des forêts de l'Oise." },
  'news.html': { url: '/news', title: "Actualités des forêts de l'Oise — BWR" },
  'plans.html': { url: '/plans', title: 'Les plans BWR — Gratuit, Argent & Or' },
  'guide.html': { url: '/guide', title: "Guide d'utilisation BWR — prendre en main l'app" },
  'login.html': { url: '/login', title: "Connexion — BWR, la carte des forêts de l'Oise" },
  'changelog.html': { url: '/changelog', title: 'Changelog — BWR' },
  'legal.html': { url: '/legal', title: 'Mentions légales & confidentialité — BWR' },
  'map.html': { url: '/map', title: "Carte des forêts de l'Oise — BWR" },
  'routes.html': { url: '/routes', title: 'Planifier un trajet — BWR', desc: "Planifiez un itinéraire à pied ou à vélo dans les forêts de l'Oise : boucles ou trajets A→B, difficulté et profil altimétrique." },
  'profile.html': { url: '/profile', title: 'Mon profil — BWR', desc: "Votre profil BWR : statistiques, badges et progression dans les forêts de l'Oise." },
  'quests.html': { url: '/quests', title: 'Quêtes & défis — BWR' },
  'verify.html': { url: '/verify', title: 'Vérification de votre email — BWR', desc: 'Vérification de votre adresse email BWR.' },
  'reset.html': { url: '/reset', title: 'Réinitialiser le mot de passe — BWR', desc: 'Réinitialisez votre mot de passe BWR.' },
  '404.html': { url: '/404', title: 'Page introuvable — BWR' },
};

// Pages that already have an og:title block (index + blog) — only need the image
// tags (+ a Twitter block if missing). Listed so we don't try to add a full OG.
const filesWithOg = [
  'index.html', 'blog.html',
  ...fs.readdirSync(path.join(PUB, 'blog')).filter(f => f.endsWith('.html')).map(f => 'blog/' + f),
];

const targets = [...Object.keys(cfg), ...filesWithOg];

let changed = 0, skipped = 0;
for (const rel of targets) {
  const file = path.join(PUB, rel);
  if (!fs.existsSync(file)) { console.warn('missing', rel); continue; }
  let s = fs.readFileSync(file, 'utf8');

  if (/property="og:image"/.test(s)) { skipped++; continue; }

  // Always upgrade an existing summary card to the large format.
  s = s.replace(/(name="twitter:card"\s+content=")summary(")/, '$1summary_large_image$2');

  const hasOg = /property="og:title"/.test(s);
  const hasTwitter = /name="twitter:card"/.test(s);

  const descMatch = s.match(/<meta\s+name="description"\s+content="([^"]*)"/i);
  const titleMatch = s.match(/<title>([^<]*)<\/title>/i);
  const c = cfg[rel] || {};
  const ogTitle = c.title || (titleMatch ? titleMatch[1].trim() : SITE);
  const ogDesc = (descMatch && descMatch[1]) || c.desc || '';

  const parts = [];

  if (!hasOg) {
    const ogBlock = [
      `  <!-- Open Graph / réseaux sociaux -->`,
      `  <meta property="og:type" content="website" />`,
      c.url ? `  <meta property="og:url" content="https://bwrmaps.com${c.url}" />` : null,
      `  <meta property="og:site_name" content="${SITE}" />`,
      `  <meta property="og:title" content="${ogTitle}" />`,
      ogDesc ? `  <meta property="og:description" content="${ogDesc}" />` : null,
      `  <meta property="og:locale" content="fr_FR" />`,
    ].filter(Boolean).join('\n');
    parts.push(ogBlock);
  }

  parts.push(imageTags);

  if (!hasTwitter) {
    const twBlock = [
      `  <!-- Twitter Card -->`,
      `  <meta name="twitter:card" content="summary_large_image" />`,
      `  <meta name="twitter:title" content="${ogTitle}" />`,
      ogDesc ? `  <meta name="twitter:description" content="${ogDesc}" />` : null,
    ].filter(Boolean).join('\n');
    // twitter:image already lives in imageTags; append card/title/desc.
    parts.push(twBlock);
  }

  const block = '\n' + parts.join('\n\n') + '\n';

  // Insert after canonical link, else after description meta, else after <title>.
  const anchor =
    s.match(/^.*rel="canonical".*$/m) ||
    s.match(/^.*name="description".*$/m) ||
    s.match(/^.*<title>.*<\/title>.*$/m);
  if (!anchor) { console.warn('no anchor in', rel); continue; }
  const idx = anchor.index + anchor[0].length;
  s = s.slice(0, idx) + block + s.slice(idx);

  fs.writeFileSync(file, s);
  changed++;
  console.log('patched', rel);
}
console.log(`\nDone: ${changed} patched, ${skipped} already had og:image.`);
