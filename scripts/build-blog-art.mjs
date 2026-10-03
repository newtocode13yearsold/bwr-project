#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
//  BWR — blog cover illustrations
//
//  Draws one flat "forest landscape" SVG per blog article (layered hills, pines
//  and round trees, a trail) plus a motif that tells the article apart: a P
//  sign for parking, rain, autumn leaves, a bike, a carrefour post, a train,
//  the Chantilly château, the Ermenonville sand dunes…
//
//  The blog cards and the article heroes used to be a line icon on a gradient;
//  these give every guide a real picture in the site's own colours.
//
//  Output:  public/img/blog/<slug>.svg   (1200 × 600, scales with object-fit)
//  Usage:   node scripts/build-blog-art.mjs
//  To add an article: add an entry to SCENES below and re-run.
// ─────────────────────────────────────────────────────────────────────────────
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'img', 'blog');
const W = 1200, H = 600;

// ── Palettes ────────────────────────────────────────────────────────────────
// hills: far → near.  trees: one colour per hill layer (slightly darker).
const PAL = {
  day: {
    sky: ['#bfe0c8', '#f2f7e4'], sun: '#fff6cf',
    hills: ['#a9cf96', '#7fb069', '#4f8a3c', '#2d6b1f'],
    trees: ['#8dbb79', '#5f9a4c', '#3a7a2c', '#1e4d14'],
    path: '#efe3c0', pathEdge: '#d8c79a', ground: '#1e4d14',
  },
  morning: {
    sky: ['#b9d9e3', '#eef6ee'], sun: '#fffbe6',
    hills: ['#a7c8bd', '#7aaa8e', '#4b8a5c', '#24603a'],
    trees: ['#8fb8a6', '#5e9673', '#357048', '#174a2a'],
    path: '#ebe4cc', pathEdge: '#cfc5a2', ground: '#174a2a',
  },
  dawn: {
    sky: ['#f6b98a', '#fde8c8'], sun: '#fff1d0',
    hills: ['#c9a98a', '#8f8a62', '#56713f', '#2d5221'],
    trees: ['#b39577', '#76734f', '#41602f', '#1d3d15'],
    path: '#f1dfbf', pathEdge: '#d9bf92', ground: '#1d3d15',
  },
  autumn: {
    sky: ['#f4cf98', '#fdf0d8'], sun: '#fff3d6',
    hills: ['#e0b27a', '#cf8a45', '#a65a24', '#6e3514'],
    trees: ['#d9a35f', '#c4702c', '#9b3f17', '#5e2810'],
    path: '#f3e2bf', pathEdge: '#dcc08c', ground: '#5e2810',
  },
  rain: {
    sky: ['#8fa4ad', '#cfd9dc'], sun: null,
    hills: ['#9cb0a6', '#738f80', '#4c6d5a', '#2c4a38'],
    trees: ['#879d92', '#5f7b6b', '#3b5a47', '#1d3527'],
    path: '#c9c6b4', pathEdge: '#a9a690', ground: '#1d3527',
  },
  golden: {
    sky: ['#f2d79a', '#fbf1d6'], sun: '#fff5d8',
    hills: ['#c8c48e', '#99a865', '#6a8a43', '#3d6526'],
    trees: ['#b3b37c', '#7f9552', '#527433', '#2a4a1a'],
    path: '#f3e6c4', pathEdge: '#dcc896', ground: '#2a4a1a',
  },
  dusk: {
    sky: ['#9bb6d6', '#f6d9c0'], sun: '#fff0dc',
    hills: ['#9fa9c4', '#7d8fa6', '#4f6a6e', '#2a4a3c'],
    trees: ['#8995b3', '#677c93', '#3e5859', '#1b352b'],
    path: '#e6dccb', pathEdge: '#c7b9a0', ground: '#1b352b',
  },
};

// ── Tiny deterministic RNG (so a re-run draws the exact same picture) ────────
function rngFor(seed) {
  let h = 2166136261;
  for (const c of seed) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); }
  return () => {
    h += 0x6D2B79F5; let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const r1 = n => Math.round(n * 10) / 10;

// ── Hills ───────────────────────────────────────────────────────────────────
function hillPoints(rand, baseY, amp, step = 150) {
  const pts = [];
  for (let x = -step; x <= W + step; x += step) pts.push([x, baseY + (rand() - 0.5) * 2 * amp]);
  return pts;
}
function smoothPath(pts) {
  // Catmull-Rom → cubic Bézier through every point.
  let d = `M${r1(pts[0][0])},${r1(pts[0][1])}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2;
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += ` C${r1(c1[0])},${r1(c1[1])} ${r1(c2[0])},${r1(c2[1])} ${r1(p2[0])},${r1(p2[1])}`;
  }
  return d;
}
function hill(pts, fill) {
  return `<path d="${smoothPath(pts)} L${W + 200},${H + 10} L-200,${H + 10} Z" fill="${fill}"/>`;
}
function yAt(pts, x) {
  for (let i = 0; i < pts.length - 1; i++) {
    const [x0, y0] = pts[i], [x1, y1] = pts[i + 1];
    if (x >= x0 && x <= x1) {
      // cosine interpolation ≈ the smooth curve
      const t = (1 - Math.cos(((x - x0) / (x1 - x0)) * Math.PI)) / 2;
      return y0 + (y1 - y0) * t;
    }
  }
  return pts[pts.length - 1][1];
}

// ── Trees ───────────────────────────────────────────────────────────────────
function pine(x, y, h, fill) {
  const w = h * 0.42, tiers = 3;
  let s = `<rect x="${r1(x - h * 0.025)}" y="${r1(y - h * 0.16)}" width="${r1(h * 0.05)}" height="${r1(h * 0.18)}" fill="${fill}"/>`;
  for (let i = 0; i < tiers; i++) {
    const top = y - h + i * h * 0.24, base = top + h * 0.5, half = w * (0.55 + i * 0.22);
    s += `<path d="M${r1(x)},${r1(top)} L${r1(x + half)},${r1(base)} L${r1(x - half)},${r1(base)} Z" fill="${fill}"/>`;
  }
  return s;
}
function roundTree(x, y, h, fill, rand) {
  const r = h * 0.3;
  let s = `<rect x="${r1(x - h * 0.035)}" y="${r1(y - h * 0.42)}" width="${r1(h * 0.07)}" height="${r1(h * 0.44)}" fill="${fill}"/>`;
  s += `<circle cx="${r1(x)}" cy="${r1(y - h * 0.62)}" r="${r1(r)}" fill="${fill}"/>`;
  s += `<circle cx="${r1(x - r * 0.6)}" cy="${r1(y - h * 0.5)}" r="${r1(r * 0.72)}" fill="${fill}"/>`;
  s += `<circle cx="${r1(x + r * 0.62)}" cy="${r1(y - h * 0.52)}" r="${r1(r * 0.7 + rand() * r * 0.1)}" fill="${fill}"/>`;
  return s;
}
function treeRow(rand, pts, { fill, count, hMin, hMax, pineRatio = 0.5, avoid = [] }) {
  let s = '';
  for (let i = 0; i < count; i++) {
    const x = (i + 0.2 + rand() * 0.6) * (W / count);
    if (avoid.some(([a, b]) => x > a && x < b)) continue;
    const y = yAt(pts, x) + 4, h = hMin + rand() * (hMax - hMin);
    s += rand() < pineRatio ? pine(x, y, h, fill) : roundTree(x, y, h, fill, rand);
  }
  return s;
}

// ── Trail ───────────────────────────────────────────────────────────────────
function trail({ x0 = 600, w0 = 210, xh = 640, yh = 380, sway = 160, fill, edge }) {
  // Centre line: cubic from the bottom edge up to the horizon point.
  const P = [[x0, H + 20], [x0 + sway, H - 90], [xh - sway * 0.8, yh + 70], [xh, yh]];
  const at = t => {
    const m = 1 - t;
    return [0, 1].map(k => m * m * m * P[0][k] + 3 * m * m * t * P[1][k] + 3 * m * t * t * P[2][k] + t * t * t * P[3][k]);
  };
  const L = [], R = [];
  for (let i = 0; i <= 40; i++) {
    const t = i / 40, [x, y] = at(t), w = (w0 * (1 - t) ** 1.6 + 3) / 2;
    L.push([x - w, y]); R.push([x + w, y]);
  }
  const poly = [...L, ...R.reverse()].map(([x, y]) => `${r1(x)},${r1(y)}`).join(' ');
  return { svg: `<polygon points="${poly}" fill="${fill}" stroke="${edge}" stroke-width="3" stroke-linejoin="round"/>`, at };
}

// ── Motifs ──────────────────────────────────────────────────────────────────
const M = {
  parkingSign: (x, y) => `
    <ellipse cx="${x - 60}" cy="${y + 8}" rx="190" ry="26" fill="#d9d3bf" opacity="0.9"/>
    <rect x="${x - 6}" y="${y - 210}" width="12" height="215" rx="3" fill="#5b6470"/>
    <rect x="${x - 58}" y="${y - 300}" width="116" height="116" rx="18" fill="#2563eb" stroke="#fff" stroke-width="7"/>
    <text x="${x}" y="${y - 207}" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-weight="700" font-size="92" fill="#fff">P</text>`,
  signpost: (x, y) => `
    <rect x="${x - 8}" y="${y - 230}" width="16" height="235" rx="4" fill="#7a5530"/>
    <path d="M${x + 6},${y - 215} h120 l26,22 l-26,22 h-120 z" fill="#c8954f" stroke="#7a5530" stroke-width="4"/>
    <path d="M${x - 6},${y - 160} h-110 l-26,20 l26,20 h110 z" fill="#c8954f" stroke="#7a5530" stroke-width="4"/>
    <rect x="${x + 22}" y="${y - 200}" width="80" height="7" rx="3" fill="#7a5530" opacity="0.55"/>
    <rect x="${x - 98}" y="${y - 144}" width="70" height="7" rx="3" fill="#7a5530" opacity="0.55"/>`,
  carrefourPost: (x, y) => `
    <rect x="${x - 10}" y="${y - 250}" width="20" height="255" fill="#f4f1e8" stroke="#9a9484" stroke-width="3"/>
    <path d="M${x - 22},${y - 250} L${x},${y - 280} L${x + 22},${y - 250} Z" fill="#b23a2c"/>
    <rect x="${x - 70}" y="${y - 225}" width="140" height="30" rx="4" fill="#f4f1e8" stroke="#9a9484" stroke-width="3"/>
    <rect x="${x - 70}" y="${y - 185}" width="140" height="30" rx="4" fill="#f4f1e8" stroke="#9a9484" stroke-width="3"/>
    <rect x="${x - 54}" y="${y - 214}" width="108" height="8" rx="3" fill="#b23a2c" opacity="0.8"/>
    <rect x="${x - 54}" y="${y - 174}" width="108" height="8" rx="3" fill="#b23a2c" opacity="0.8"/>`,
  bike: (x, y, s = 1, col = '#1d2a1f') => `
    <g transform="translate(${x} ${y}) scale(${s})" fill="none" stroke="${col}" stroke-width="7" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="-62" cy="0" r="40"/><circle cx="62" cy="0" r="40"/>
      <path d="M-62,0 L-18,-62 L40,-62 L62,0 M-18,-62 L8,0 L40,-62 M8,0 L-62,0 M-26,-78 L-6,-78 M40,-62 L32,-88 L52,-92"/>
    </g>`,
  footprints: (at, ts, col) => ts.map((t, i) => {
    const [x, y] = at(t), s = 1 - t * 0.85, dx = (i % 2 ? 14 : -14) * s;
    return `<ellipse cx="${r1(x + dx)}" cy="${r1(y)}" rx="${r1(9 * s)}" ry="${r1(15 * s)}" fill="${col}" opacity="0.55"/>`;
  }).join(''),
  paws: (at, ts, col) => ts.map((t, i) => {
    const [x, y] = at(t), s = 1.15 - t, dx = (i % 2 ? 16 : -16) * s;
    const cx = x + dx;
    return `<g fill="${col}" opacity="0.6"><ellipse cx="${r1(cx)}" cy="${r1(y)}" rx="${r1(11 * s)}" ry="${r1(9 * s)}"/>`
      + [-10, -3.5, 3.5, 10].map((o, k) => `<circle cx="${r1(cx + o * s)}" cy="${r1(y - (k % 3 ? 14 : 10) * s)}" r="${r1(3.6 * s)}"/>`).join('') + '</g>';
  }).join(''),
  pond: (cx, cy, rx, ry) => `
    <ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="url(#water)"/>
    <g stroke="#ffffff" stroke-width="4" stroke-linecap="round" opacity="0.55">
      <path d="M${cx - rx * 0.5},${cy - ry * 0.2} h${rx * 0.35}"/><path d="M${cx + rx * 0.05},${cy + ry * 0.15} h${rx * 0.45}"/><path d="M${cx - rx * 0.25},${cy + ry * 0.45} h${rx * 0.3}"/>
    </g>`,
  picnic: (x, y) => {
    let s = `<g transform="translate(${x} ${y}) skewX(-28) scale(1 0.42)">`;
    for (let i = 0; i < 6; i++) for (let j = 0; j < 6; j++) s += `<rect x="${i * 40 - 120}" y="${j * 40 - 120}" width="40" height="40" fill="${(i + j) % 2 ? '#f4ece0' : '#d24b3a'}"/>`;
    s += `</g><rect x="${x + 30}" y="${y - 52}" width="74" height="46" rx="8" fill="#b9874a"/><path d="M${x + 40},${y - 52} q27,-34 54,0" fill="none" stroke="#8a6234" stroke-width="7"/>`;
    return s;
  },
  train: (y) => {
    let s = `<rect x="-20" y="${y + 18}" width="${W + 40}" height="8" fill="#5b5148"/>`;
    for (let x = -10; x < W + 20; x += 34) s += `<rect x="${x}" y="${y + 16}" width="16" height="12" fill="#7a6d5f"/>`;
    const cars = [[150, 250, '#2d6b8a'], [410, 250, '#2d6b8a'], [670, 210, '#1f4f6b']];
    for (const [x, w, c] of cars) {
      s += `<rect x="${x}" y="${y - 70}" width="${w}" height="80" rx="16" fill="${c}"/>`;
      s += `<rect x="${x}" y="${y - 26}" width="${w}" height="10" fill="#e9d36b"/>`;
      for (let k = 18; k < w - 40; k += 52) s += `<rect x="${x + k}" y="${y - 58}" width="36" height="24" rx="5" fill="#d6ecf5"/>`;
      s += `<circle cx="${x + 40}" cy="${y + 12}" r="11" fill="#2a2a2a"/><circle cx="${x + w - 40}" cy="${y + 12}" r="11" fill="#2a2a2a"/>`;
    }
    return s;
  },
  chateau: (x, y, c) => `
    <g fill="${c}">
      <rect x="${x - 230}" y="${y - 80}" width="460" height="80"/>
      <rect x="${x - 250}" y="${y - 130}" width="60" height="130"/><path d="M${x - 256},${y - 130} L${x - 220},${y - 185} L${x - 184},${y - 130} Z"/>
      <rect x="${x + 190}" y="${y - 130}" width="60" height="130"/><path d="M${x + 184},${y - 130} L${x + 220},${y - 185} L${x + 256},${y - 130} Z"/>
      <rect x="${x - 60}" y="${y - 150}" width="120" height="150"/><path d="M${x - 70},${y - 150} Q${x},${y - 235} ${x + 70},${y - 150} Z"/>
      <rect x="${x - 4}" y="${y - 262}" width="8" height="40"/>
      <rect x="${x - 150}" y="${y - 105}" width="40" height="105"/><path d="M${x - 156},${y - 105} L${x - 130},${y - 140} L${x - 104},${y - 105} Z"/>
      <rect x="${x + 110}" y="${y - 105}" width="40" height="105"/><path d="M${x + 104},${y - 105} L${x + 130},${y - 140} L${x + 156},${y - 105} Z"/>
    </g>
    <rect x="${x - 300}" y="${y}" width="600" height="22" fill="#9cc2cf" opacity="0.85"/>`,
  dunes: (rand) => {
    const a = hillPoints(rand, 455, 30, 220), b = hillPoints(rand, 505, 26, 260);
    let pines = '';
    for (const [x, h] of [[250, 120], [330, 90], [900, 140], [985, 100], [560, 70]]) pines += pine(x, yAt(a, x) + 6, h, '#3d5a26');
    return hill(a, '#e8cf98') + pines + hill(b, '#dcb977')
      + `<path d="M120,470 q90,-30 180,-4" stroke="#c9a463" stroke-width="5" fill="none" opacity="0.6"/>`
      + `<path d="M760,520 q110,-34 220,-6" stroke="#c09a58" stroke-width="5" fill="none" opacity="0.6"/>`;
  },
  rain: (rand) => {
    let s = '<g stroke="#e8f0f2" stroke-width="3" stroke-linecap="round" opacity="0.55">';
    for (let i = 0; i < 90; i++) {
      const x = rand() * (W + 200) - 100, y = rand() * H * 0.95, l = 26 + rand() * 18;
      s += `<path d="M${r1(x)},${r1(y)} l${r1(-l * 0.35)},${r1(l)}"/>`;
    }
    return s + '</g>';
  },
  stormClouds: () => `
    <g fill="#6f838c" opacity="0.9"><ellipse cx="260" cy="110" rx="190" ry="60"/><ellipse cx="380" cy="80" rx="130" ry="62"/><ellipse cx="170" cy="92" rx="100" ry="48"/></g>
    <g fill="#7f939b" opacity="0.85"><ellipse cx="880" cy="130" rx="220" ry="58"/><ellipse cx="1000" cy="96" rx="140" ry="60"/><ellipse cx="760" cy="112" rx="110" ry="46"/></g>`,
  leaves: (rand) => {
    const cols = ['#d9622b', '#e8a33a', '#b8401c', '#f0c05a'];
    let s = '';
    for (let i = 0; i < 26; i++) {
      const x = rand() * W, y = 40 + rand() * 420, a = rand() * 360, k = 0.7 + rand() * 0.8;
      s += `<path transform="translate(${r1(x)} ${r1(y)}) rotate(${r1(a)}) scale(${r1(k)})" d="M0,-14 C10,-8 10,8 0,14 C-10,8 -10,-8 0,-14 Z" fill="${cols[i % 4]}"/>`;
    }
    return s;
  },
  clouds: (rand, n = 3, col = '#ffffff') => {
    let s = `<g fill="${col}" opacity="0.8">`;
    for (let i = 0; i < n; i++) {
      const x = 120 + rand() * (W - 240), y = 60 + rand() * 90, k = 0.7 + rand() * 0.6;
      s += `<g transform="translate(${r1(x)} ${r1(y)}) scale(${r1(k)})"><ellipse cx="0" cy="0" rx="80" ry="24"/><ellipse cx="-30" cy="-14" rx="40" ry="26"/><ellipse cx="22" cy="-18" rx="46" ry="30"/></g>`;
    }
    return s + '</g>';
  },
  // Soft band of morning mist (fades in and out vertically, no hard edges).
  mist: (y, op = 0.35) => `<rect x="0" y="${y - 30}" width="${W}" height="110" fill="url(#mist)" opacity="${op * 2}"/>`,
  flags: (at, ts) => ts.map(t => {
    const [x, y] = at(t), s = 1.9 - t * 1.6;
    return `<rect x="${r1(x + 34 * s)}" y="${r1(y - 70 * s)}" width="${r1(4 * s)}" height="${r1(70 * s)}" fill="#5b4a3a"/><path d="M${r1(x + 38 * s)},${r1(y - 70 * s)} l${r1(34 * s)},${r1(11 * s)} l${r1(-34 * s)},${r1(11 * s)} z" fill="#e2552f"/>`;
  }).join(''),
};

// ── Scene builder ───────────────────────────────────────────────────────────
function scene(slug, o) {
  const rand = rngFor(slug), p = PAL[o.palette || 'day'];
  const horizon = o.horizon ?? 330;
  let s = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid slice" role="img" aria-label="${o.label}">`;
  s += `<defs><linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${p.sky[0]}"/><stop offset="1" stop-color="${p.sky[1]}"/></linearGradient>`
    + `<radialGradient id="glow"><stop offset="0" stop-color="${p.sun || '#fff'}" stop-opacity="0.9"/><stop offset="1" stop-color="${p.sun || '#fff'}" stop-opacity="0"/></radialGradient>`
     + `<linearGradient id="mist" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset="0.5" stop-color="#fff" stop-opacity="0.6"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>`
    + `<linearGradient id="water" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#9fcbd8"/><stop offset="1" stop-color="#5f98ab"/></linearGradient></defs>`;
  s += `<rect width="${W}" height="${H}" fill="url(#sky)"/>`;
  if (p.sun && o.sun !== false) {
    const [sx, sy, sr] = o.sunAt || [880, 150, 58];
    s += `<circle cx="${sx}" cy="${sy}" r="${sr * 2.6}" fill="url(#glow)"/><circle cx="${sx}" cy="${sy}" r="${sr}" fill="${p.sun}"/>`;
  }
  if (o.stormClouds) s += M.stormClouds();
  else if (o.clouds !== 0) s += M.clouds(rand, o.clouds ?? 2);

  // Four hill layers, far → near, each carrying its own row of trees.
  const ys = o.hillY || [horizon - 40, horizon + 10, horizon + 70, horizon + 150];
  const amps = o.hillAmp || [34, 30, 26, 22];
  const layers = ys.map((y, i) => hillPoints(rand, y, amps[i]));
  const treeH = [[38, 58], [56, 86], [86, 128], [140, 200]];
  const counts = o.treeCounts || [26, 18, 11, 0];
  for (let i = 0; i < 4; i++) {
    if (o.beforeLayer?.[i]) s += o.beforeLayer[i](layers);
    s += hill(layers[i], p.hills[i]);
    if (counts[i]) s += treeRow(rand, layers[i], { fill: p.trees[i], count: counts[i], hMin: treeH[i][0], hMax: treeH[i][1], pineRatio: o.pineRatio ?? 0.5, avoid: o.avoid?.[i] || [] });
    if (i === 1 && o.mist) s += M.mist(ys[1] - 6, o.mist);
  }

  let at = null;
  if (o.trail !== false) {
    const t = trail({ fill: p.path, edge: p.pathEdge, ...(o.trailOpts || {}) });
    s += t.svg; at = t.at;
  }
  if (o.motif) s += o.motif({ rand, layers, at, p });

  // Framing trees on both edges, in the nearest colour.
  if (o.frame !== false) {
    s += pine(40, H + 40, 330, p.ground) + roundTree(150, H + 30, 230, p.ground, rand);
    s += pine(1170, H + 40, 350, p.ground) + roundTree(1060, H + 30, 210, p.ground, rand);
  }
  if (o.overlay) s += o.overlay({ rand });
  return s + '</svg>\n';
}

// ── One entry per article ───────────────────────────────────────────────────
const SCENES = {
  'ou-se-garer': { label: 'Parking à l\'orée de la forêt', motif: () => M.parkingSign(880, 520) },
  'plus-beaux-endroits': {
    label: 'Étang entouré d\'arbres', palette: 'morning', trail: false, sunAt: [620, 170, 60],
    motif: () => M.pond(600, 470, 330, 58) + M.clouds(rngFor('pbe2'), 0),
    treeCounts: [26, 18, 9, 0],
  },
  'petite-randonnee-facile': {
    label: 'Sentier facile entre les collines', hillAmp: [20, 18, 16, 14],
    motif: ({ at, p }) => M.footprints(at, [0.12, 0.2, 0.28, 0.36, 0.44, 0.52, 0.6], p.pathEdge),
  },
  'avec-chien': {
    label: 'Traces de pattes sur un chemin forestier',
    motif: ({ at }) => M.paws(at, [0.1, 0.19, 0.28, 0.37, 0.46, 0.55], '#7a5a3a'),
  },
  'quand-il-pleut': {
    label: 'Forêt sous la pluie', palette: 'rain', stormClouds: true, clouds: 0,
    motif: ({ at }) => [0.15, 0.4].map(t => { const [x, y] = at(t); return `<ellipse cx="${r1(x - 10)}" cy="${r1(y)}" rx="${r1(70 * (1 - t))}" ry="${r1(12 * (1 - t))}" fill="#9fb8c2" opacity="0.8"/>`; }).join(''),
    overlay: ({ rand }) => M.rain(rand),
  },
  'top-5-boucles-vtt': {
    label: 'Piste de VTT dans les collines', hillAmp: [50, 46, 40, 26], palette: 'day',
    trailOpts: { sway: 260, w0: 180 },
    motif: ({ at }) => { const [x, y] = at(0.3); return M.bike(x + 10, y - 44, 0.7); },
  },
  'randonnees-pedestre': { label: 'Panneau de randonnée au bord du sentier', motif: () => M.signpost(860, 540) },
  'balades-famille': { label: 'Pique-nique en lisière de forêt', palette: 'golden', trailOpts: { x0: 420, sway: 120 }, motif: () => M.picnic(820, 520) },
  'trail-running': {
    label: 'Single-track au lever du jour', palette: 'dawn', sunAt: [300, 300, 70], hillAmp: [44, 40, 34, 24],
    trailOpts: { sway: 240, w0: 150, xh: 760, yh: 360 },
    motif: ({ at }) => M.flags(at, [0.2, 0.45, 0.7]),
  },
  'carrefours-foret': {
    label: 'Poteau de carrefour forestier',
    motif: ({ p }) => {
      // A second path crossing the first one.
      const cross = `<path d="M-40,520 C300,470 900,470 1240,505 L1240,540 C900,505 300,505 -40,560 Z" fill="${p.path}" stroke="${p.pathEdge}" stroke-width="3"/>`;
      return cross + M.carrefourPost(760, 520);
    },
  },
  'depuis-gare-compiegne': {
    label: 'Train longeant la forêt', treeCounts: [26, 18, 0, 0], trail: false,
    beforeLayer: { 2: () => M.train(400) },
  },
  'foret-automne': {
    label: 'Forêt aux couleurs d\'automne', palette: 'autumn', pineRatio: 0.15,
    overlay: ({ rand }) => M.leaves(rand),
  },
  'foret-laigue': {
    label: 'Étang brumeux en forêt de Laigue', palette: 'morning', trail: false, mist: 0.4, pineRatio: 0.8, sunAt: [300, 160, 50],
    motif: () => M.pond(640, 480, 420, 62),
  },
  'foret-halatte': {
    label: 'Lever de soleil sur la forêt d\'Halatte', palette: 'dawn', sunAt: [600, 300, 92], mist: 0.3, clouds: 1,
    trailOpts: { xh: 600, yh: 400 },
  },
  'foret-chantilly': {
    label: 'Château de Chantilly à travers les arbres', palette: 'golden', trail: false, treeCounts: [24, 0, 10, 0],
    beforeLayer: { 1: () => M.chateau(600, 360, '#8a8466') },
    avoid: { 2: [[380, 820]] },
  },
  'foret-ermenonville': {
    label: 'Mer de sable et pins d\'Ermenonville', palette: 'golden', trail: false, pineRatio: 1, treeCounts: [20, 14, 0, 0],
    hillY: [300, 350, 440, 560], motif: ({ rand }) => M.dunes(rand),
  },
  'foret-hez-froidmont': {
    label: 'Vue depuis les hauteurs de Hez-Froidmont', palette: 'dusk', hillY: [300, 350, 410, 470], hillAmp: [24, 30, 36, 40],
    treeCounts: [30, 20, 12, 0], trailOpts: { xh: 560, yh: 420, sway: 120 },
  },
  // Fallback cover for a curated trail page (/balade/:slug) without a photo.
  'balade': { label: 'Sentier en forêt de Compiègne', trailOpts: { sway: 200 } },
};

mkdirSync(OUT, { recursive: true });
for (const [slug, o] of Object.entries(SCENES)) {
  writeFileSync(join(OUT, `${slug}.svg`), scene(slug, o));
}
console.log(`✓ ${Object.keys(SCENES).length} illustrations → ${OUT}`);
