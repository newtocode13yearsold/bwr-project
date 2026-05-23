// Change this to your Cloudflare Worker URL after deploying
const API_URL = 'https://bwr-worker.ciril8596.workers.dev';

// Map starting position: Forêt de Compiègne
const MAP_CENTER = [49.35, 2.90];
const MAP_ZOOM = 13;

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
