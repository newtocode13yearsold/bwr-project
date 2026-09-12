import { listItems } from '../kv.js';

// ── Public, SEO-indexable pages (no login) ───────────────────────────────────
// Server-rendered HTML so search engines get real content in the first byte:
//   GET /balade/:slug   — a curated trail ("best tour") as its own crawlable URL
//   GET /r/:token       — a shared saved route (extends the existing share token)
//   GET /sitemap.xml    — the static sitemap with every trail URL injected
//
// These run on the same Worker (no extra cost) and set their own strict CSP +
// security headers (the /public _headers file only covers ASSETS responses).
// The interactive map is progressive enhancement: coords are embedded as a
// non-executable <script type="application/json"> block and drawn by the
// external js/public-route-map.js (CSP script-src 'self'), so the textual
// content (name, stats, description) is fully indexable without JS.

const SITE = 'https://bwrmaps.com';

const DIFF_LABEL = { easy: 'Facile', medium: 'Moyen', hard: 'Difficile' };
const TYPE_LABEL = { foot: 'Pédestre', bike: 'Vélo', mix: 'Mixte', champs: 'Champs' };
const TYPE_EMOJI = { foot: '🌲', bike: '🚴', mix: '🗺️', champs: '🌾' };

/** Escape text for safe interpolation into HTML. */
const esc = (str) => String(str ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

/** Escape a string for embedding inside a <script> JSON block (prevents </script> breakout). */
const jsonForScript = (obj) =>
  JSON.stringify(obj).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');

/** Accent-stripped, kebab-cased slug from a free-text name. */
export function slugify(name) {
  return String(name || 'balade')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')      // strip accents
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'balade';
}

/** Canonical public path for a curated trail: /balade/<name-slug>-<8-hex id prefix>. */
export function trailPath(tour) {
  return `/balade/${slugify(tour.name)}-${String(tour.id).slice(0, 8)}`;
}

/** Security + caching headers shared by every rendered HTML page. */
function htmlHeaders(maxAge = 300) {
  return {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': `public, max-age=${maxAge}`,
    'Content-Security-Policy':
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
      "font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob: https:; connect-src 'self'; " +
      "object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'",
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
  };
}

/**
 * Full HTML document mirroring the blog article chrome (blog.css) so public
 * pages match the site without pulling in nav JS.
 */
function layout({ title, description, canonical, image, jsonLd, headExtra = '', body }) {
  const img = image || `${SITE}/og-image.png`;
  return `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${esc(title)}</title>
  <meta name="description" content="${esc(description)}" />
  <meta name="robots" content="index, follow" />
  <link rel="canonical" href="${esc(canonical)}" />
  <meta name="theme-color" content="#1e4d14" />
  <meta property="og:type" content="article" />
  <meta property="og:url" content="${esc(canonical)}" />
  <meta property="og:site_name" content="BWR" />
  <meta property="og:title" content="${esc(title)}" />
  <meta property="og:description" content="${esc(description)}" />
  <meta property="og:locale" content="fr_FR" />
  <meta property="og:image" content="${esc(img)}" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${esc(title)}" />
  <meta name="twitter:description" content="${esc(description)}" />
  <meta name="twitter:image" content="${esc(img)}" />
  <link rel="manifest" href="/manifest.json" />
  <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
  <link rel="apple-touch-icon" href="/icons/icon-180.png" />
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&family=Fraunces:opsz,wght@9..144,500;9..144,600;9..144,700;9..144,900&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="/css/tokens.css" />
  <link rel="stylesheet" href="/css/blog.css" />
  ${headExtra}
  <script type="application/ld+json">${jsonForScript(jsonLd)}</script>
</head>
<body style="background:var(--surface-1,#fafbf7);margin:0">

  <nav class="blog-nav">
    <div class="blog-nav-inner">
      <a href="/" class="blog-nav-logo">BWR</a>
      <div class="blog-nav-links">
        <a href="/">Accueil</a>
        <a href="/map">Carte</a>
        <a href="/routes">Planifier</a>
        <a href="/best-tours">Balades</a>
        <a href="/blog">Blog</a>
      </div>
      <div class="blog-nav-cta">
        <a href="/login" class="btn-login">Connexion</a>
        <a href="/map" class="btn-app">Voir la carte</a>
      </div>
    </div>
  </nav>

  <main class="article-wrap">
${body}
  </main>

  <footer class="blog-footer">
    <div class="blog-footer-links">
      <a href="/">Accueil</a>
      <a href="/map">Carte</a>
      <a href="/routes">Planifier</a>
      <a href="/best-tours">Balades</a>
      <a href="/blog">Blog</a>
      <a href="/legal">Mentions légales</a>
    </div>
    <p>© 2026 <a href="/">BWR</a> · Balades en forêt de Compiègne · <a href="mailto:thomaslegros71@gmail.com">Contact</a></p>
  </footer>
</body>
</html>`;
}

function statPill(val, label) {
  return `<div class="stat-pill"><span class="stat-pill-val">${esc(val)}</span><span class="stat-pill-label">${esc(label)}</span></div>`;
}

const notFound = () => new Response(
  layout({
    title: 'Page introuvable — BWR',
    description: "Cette balade n'existe pas ou n'est plus disponible.",
    canonical: `${SITE}/best-tours`,
    jsonLd: { '@context': 'https://schema.org', '@type': 'WebPage', name: 'Introuvable' },
    body: `<span class="article-tag">Introuvable</span>
    <h1 class="article-title">Cette page n'existe pas</h1>
    <div class="article-body"><p>Le lien est peut-être expiré. Découvrez plutôt <a href="/best-tours">nos meilleures balades</a> ou <a href="/map">la carte de la forêt</a>.</p></div>`,
  }),
  { status: 404, headers: htmlHeaders(60) }
);

/**
 * Public page dispatcher — GET only. Returns null for anything it doesn't own
 * so the main chain / static assets still handle it.
 * @param {Request} request
 * @param {import('../kv.js').Env} env
 * @param {{ pathname: string }} ctx
 * @returns {Promise<Response|null>}
 */
export async function handlePublicPages(request, env, { pathname }) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return null;

  // ── Dynamic sitemap: static file + one <url> per curated trail ──────────────
  if (pathname === '/sitemap.xml') {
    let baseXml = '';
    try {
      const assetRes = await env.ASSETS.fetch(new Request(`${SITE}/sitemap.xml`));
      if (assetRes.ok) baseXml = await assetRes.text();
    } catch {}

    let trailUrls = '';
    try {
      const tours = await listItems(env, 'besttour:');
      trailUrls = tours.map((t) => {
        const lastmod = (t.updatedAt || t.createdAt || '').slice(0, 10);
        return `  <url>\n    <loc>${SITE}${trailPath(t)}</loc>` +
          (lastmod ? `\n    <lastmod>${lastmod}</lastmod>` : '') +
          `\n    <changefreq>monthly</changefreq>\n    <priority>0.7</priority>\n  </url>`;
      }).join('\n');
    } catch {}

    let xml;
    if (baseXml.includes('</urlset>')) {
      xml = baseXml.replace('</urlset>', `${trailUrls ? '\n  <!-- Balades (générées) -->\n' + trailUrls + '\n' : ''}</urlset>`);
    } else {
      // Fallback if the static asset is missing: emit a minimal valid sitemap.
      xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${trailUrls}\n</urlset>`;
    }

    return new Response(xml, {
      headers: {
        'Content-Type': 'application/xml; charset=utf-8',
        'Cache-Control': 'public, max-age=3600',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  }

  // ── Curated trail page: /balade/<slug>-<8hex> ───────────────────────────────
  if (pathname.startsWith('/balade/')) {
    const slug = decodeURIComponent(pathname.slice('/balade/'.length).replace(/\/$/, ''));
    const m = slug.match(/-([0-9a-f]{8})$/);
    if (!m) return notFound();
    const idPrefix = m[1];

    const tours = await listItems(env, 'besttour:');
    const tour = tours.find((t) => String(t.id).slice(0, 8) === idPrefix);
    if (!tour) return notFound();

    // Redirect to the canonical slug if the name-part drifted (e.g. renamed tour).
    const canonicalPath = trailPath(tour);
    if (pathname !== canonicalPath) {
      return Response.redirect(`${SITE}${canonicalPath}`, 301);
    }

    return renderTrail(tour);
  }

  // ── Shared route page: /r/<token> ───────────────────────────────────────────
  if (pathname.startsWith('/r/')) {
    const token = decodeURIComponent(pathname.slice('/r/'.length).replace(/\/$/, ''));
    if (!token || !/^[a-z0-9]+$/i.test(token)) return notFound();

    const refRaw = await env.BWR_KV.get(`routeshare:${token}`);
    if (!refRaw) return notFound();
    let ref;
    try { ref = JSON.parse(refRaw); } catch { return notFound(); }

    const routeRaw = await env.BWR_KV.get(`savedroute:${ref.userId}:${ref.routeId}`);
    if (!routeRaw) return notFound();
    const route = JSON.parse(routeRaw);

    return renderRoute(route, token);
  }

  return null;
}

// ── Renderers ────────────────────────────────────────────────────────────────

function renderTrail(tour) {
  const canonical = `${SITE}${trailPath(tour)}`;
  const diff = DIFF_LABEL[tour.difficulty] || tour.difficulty || 'Facile';
  const typeLabel = `${TYPE_EMOJI[tour.type] || '🌲'} ${TYPE_LABEL[tour.type] || tour.type || 'Pédestre'}`;
  const image = tour.imageDataUri || tour.imageUrl || '';
  const km = tour.distance ? `${tour.distance} km` : null;

  const title = `${tour.name} — Balade en forêt de Compiègne | BWR`;
  const description = (tour.description || `Balade ${diff.toLowerCase()} de ${km || ''} en forêt de Compiègne : tracé, niveau et point de départ. Planifiez votre sortie à pied ou à vélo avec BWR.`).slice(0, 300);

  const planUrl = tour.startAddress
    ? `/routes?start=${encodeURIComponent(tour.startAddress)}`
    : `/routes`;

  const heroImg = image
    ? `<div class="article-hero-img" style="padding:0;overflow:hidden"><img src="${esc(image)}" alt="${esc(tour.name)}" style="width:100%;height:100%;object-fit:cover" /></div>`
    : `<div class="article-hero-img" style="background:linear-gradient(135deg,#133b18,#3f7a2a)">${esc(TYPE_EMOJI[tour.type] || '🌲')}</div>`;

  const pills =
    (km ? statPill(km, 'Distance') : '') +
    statPill(diff, 'Niveau') +
    statPill(TYPE_LABEL[tour.type] || 'Pédestre', 'Type');

  const startBlock = tour.startAddress
    ? `<div class="info-box"><div class="info-box-title">🚗 Départ conseillé</div>${esc(tour.startAddress)}</div>`
    : '';

  const extBtn = tour.externalUrl
    ? `<a class="btn-cta-secondary" href="${esc(tour.externalUrl)}" target="_blank" rel="noopener">Voir le tracé détaillé</a>`
    : '';

  const jsonLd = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'Accueil', item: `${SITE}/` },
          { '@type': 'ListItem', position: 2, name: 'Meilleures balades', item: `${SITE}/best-tours` },
          { '@type': 'ListItem', position: 3, name: tour.name, item: canonical },
        ],
      },
      {
        '@type': 'TouristTrip',
        name: tour.name,
        description: description,
        url: canonical,
        ...(image ? { image } : {}),
        touristType: TYPE_LABEL[tour.type] || 'Randonnée',
        subjectOf: { '@type': 'Place', name: 'Forêt de Compiègne', address: { '@type': 'PostalAddress', addressRegion: 'Oise', addressCountry: 'FR' } },
      },
    ],
  };

  const body = `    <nav class="breadcrumb" aria-label="Fil d'Ariane">
      <a href="/">Accueil</a>
      <span class="breadcrumb-sep">›</span>
      <a href="/best-tours">Balades</a>
      <span class="breadcrumb-sep">›</span>
      <span>${esc(tour.name)}</span>
    </nav>

    <span class="article-tag">Balade en forêt de Compiègne</span>
    <h1 class="article-title">${esc(tour.name)}</h1>

    <div class="article-meta">
      <span>${esc(typeLabel)}</span>
      <span>⛰️ ${esc(diff)}</span>
      ${km ? `<span>📏 ${esc(km)}</span>` : ''}
    </div>

    ${heroImg}

    <div class="article-body">
      <div class="stat-pills">${pills}</div>

      <a class="balade-link" href="${planUrl}">
        <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76"/></svg>
        Planifier ce trajet dans BWR
      </a>

      ${tour.description ? `<p>${esc(tour.description).replace(/\n/g, '<br/>')}</p>` : ''}
      ${startBlock}
    </div>

    <div class="article-cta">
      <h2>Préparez votre sortie avec BWR</h2>
      <p>Carte interactive, planificateur de boucles et état des chemins en temps réel dans la forêt de Compiègne.</p>
      <div class="article-cta-btns">
        <a href="/map" class="btn-cta-primary">Ouvrir la carte →</a>
        <a href="${planUrl}" class="btn-cta-secondary">Planifier un itinéraire</a>
        ${extBtn}
      </div>
    </div>`;

  return new Response(
    layout({ title, description, canonical, image, jsonLd, body }),
    { headers: htmlHeaders(300) }
  );
}

function renderRoute(route, token) {
  const canonical = `${SITE}/r/${token}`;
  const km = ((route.meters || 0) / 1000).toFixed(1);
  const diff = DIFF_LABEL[route.difficulty] || 'Facile';
  const typeLabel = `${TYPE_EMOJI[route.pathType] || '🌲'} ${TYPE_LABEL[route.pathType] || 'Pédestre'}`;
  const modeLabel = route.mode === 'loop' ? '🔄 Boucle' : '➡️ Aller simple';
  const mins = Math.round((route.seconds || 0) / 60);
  const durLabel = mins >= 60 ? `${Math.floor(mins / 60)}h${String(mins % 60).padStart(2, '0')}` : `${mins} min`;

  const name = route.name || 'Trajet en forêt';
  const title = `${name} — ${km} km en forêt de Compiègne | BWR`;
  const description = `Itinéraire ${route.mode === 'loop' ? 'en boucle' : ''} de ${km} km (${diff.toLowerCase()}, ${TYPE_LABEL[route.pathType] || 'pédestre'}) dans la forêt de Compiègne. Tracé partagé avec BWR — carte et planificateur d'itinéraires.`.replace(/\s+/g, ' ').slice(0, 300);

  // Coords embedded as non-executable JSON; drawn by js/public-route-map.js.
  const mapData = {
    coords: Array.isArray(route.coords) ? route.coords : [],
    difficulty: route.difficulty || 'easy',
    name,
  };

  const jsonLd = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'Accueil', item: `${SITE}/` },
          { '@type': 'ListItem', position: 2, name: 'Trajets partagés', item: `${SITE}/best-tours` },
          { '@type': 'ListItem', position: 3, name, item: canonical },
        ],
      },
      {
        '@type': 'TouristTrip',
        name,
        description,
        url: canonical,
        subjectOf: { '@type': 'Place', name: 'Forêt de Compiègne', address: { '@type': 'PostalAddress', addressRegion: 'Oise', addressCountry: 'FR' } },
      },
    ],
  };

  const headExtra = `<link rel="stylesheet" href="/lib/leaflet.css" />
  <style>
    #bwr-map { height: 460px; width: 100%; border-radius: 14px; overflow: hidden; margin: 8px 0 4px; z-index: 0; }
    .bwr-map-attr { font-size: 11px; color: var(--text-muted, #6b7280); margin-bottom: 18px; }
  </style>`;

  const body = `    <nav class="breadcrumb" aria-label="Fil d'Ariane">
      <a href="/">Accueil</a>
      <span class="breadcrumb-sep">›</span>
      <a href="/best-tours">Balades</a>
      <span class="breadcrumb-sep">›</span>
      <span>${esc(name)}</span>
    </nav>

    <span class="article-tag">Trajet partagé</span>
    <h1 class="article-title">${esc(name)}</h1>

    <div class="article-meta">
      <span>${esc(modeLabel)}</span>
      <span>${esc(typeLabel)}</span>
      <span>⛰️ ${esc(diff)}</span>
    </div>

    <div class="article-body">
      <div class="stat-pills">
        ${statPill(`${km} km`, 'Distance')}
        ${statPill(durLabel, 'Durée estimée')}
        ${statPill(diff, 'Niveau')}
      </div>

      <div id="bwr-map" role="img" aria-label="Carte du trajet ${esc(name)}"></div>
      <p class="bwr-map-attr">Carte : © OpenStreetMap · SRTM · OpenTopoMap</p>

      <p>Ce tracé de <strong>${esc(km)} km</strong> a été partagé depuis BWR, la carte des forêts de l'Oise à pied et à vélo. Ouvrez-le dans le planificateur pour le suivre en direct sur votre téléphone, l'exporter en GPX ou l'adapter à votre point de départ.</p>

      <a class="balade-link" href="/routes?share=${esc(token)}">
        <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76"/></svg>
        Ouvrir ce trajet dans le planificateur
      </a>
    </div>

    <div class="article-cta">
      <h2>Explorez la forêt de Compiègne avec BWR</h2>
      <p>Planificateur de boucles, état des chemins en temps réel et suivi GPS hors-ligne.</p>
      <div class="article-cta-btns">
        <a href="/map" class="btn-cta-primary">Ouvrir la carte →</a>
        <a href="/routes" class="btn-cta-secondary">Planifier un itinéraire</a>
      </div>
    </div>

    <script type="application/json" id="bwr-route">${jsonForScript(mapData)}</script>
    <script src="/lib/leaflet.js"></script>
    <script src="/js/public-route-map.js"></script>`;

  return new Response(
    layout({ title, description, canonical, jsonLd, headExtra, body }),
    { headers: htmlHeaders(300) }
  );
}
