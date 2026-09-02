// Primary domain is bwrmaps.com (custom domain on the same Worker that serves the API).
// - localhost / workers.dev deployments call themselves (same-origin) so they never break
//   if the custom domain is mid-migration.
// - everything else (custom domain, *.pages.dev previews) targets the canonical API host.
const API_URL = (function () {
  const h = location.hostname;
  if (h === 'localhost' || h === '127.0.0.1') return '';        // same-origin dev worker
  if (h.endsWith('.workers.dev')) return '';                    // same-origin workers.dev deploy
  return 'https://bwrmaps.com';                                 // canonical API host
})();

// Fallback contact address shown in error messages when the API is unreachable
const CONTACT_EMAIL = 'ciril8596@gmail.com';

// Map starting position: Forêt de Compiègne
const MAP_CENTER = [49.35, 2.90];
const MAP_ZOOM = 13;

// Bounding box of the covered area (Forêt de Compiègne + margin), derived from the
// hardcoded carrefour footprint. The whole forest's OpenStreetMap path network is
// pre-baked into public/data/forest-paths.json (see scripts/build-forest-paths.mjs)
// for this bbox, so route/loop generation inside these bounds needs no live Overpass
// call. A request whose bbox falls outside this box falls back to the network fetch.
const FOREST_BOUNDS = { minLat: 49.28, minLng: 2.74, maxLat: 49.50, maxLng: 3.05 };

const STATUS_COLORS = {
  easy:        '#22c55e',
  medium:      '#f97316',
  hard:        '#ef4444',
  not_passable:'#9ca3af',
  no_bike:     '#6366f1',
};

const STATUS_LABELS = {
  easy:        'Facile',
  medium:      'Moyen',
  hard:        'Difficile',
  not_passable:'Impraticable',
  no_bike:     'Vélo interdit',
};
