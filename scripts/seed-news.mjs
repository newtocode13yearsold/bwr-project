/**
 * Seeds the Actualités feed with a batch of curated Oise / forêt de Compiègne news.
 *
 * Writes `news:{uuid}` items straight into production KV via the Cloudflare API
 * (same auth pattern as scripts/cleanup-visits.mjs — reuses the wrangler oauth token).
 *
 * Usage:
 *   node scripts/seed-news.mjs            # dry run — prints what WOULD be written
 *   node scripts/seed-news.mjs --commit   # actually write the 20 items to prod KV
 *
 * Categories must match NEWS_CATEGORIES in worker/handlers/content.js:
 *   foret | evenement | faune | securite | travaux | app
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';

const ACCOUNT = 'd91c4dcc15204cd85b1b26853203ff31';
const NS      = 'da878110f87d4dc6975a6bf3e44cd7ed';

const COMMIT = process.argv.includes('--commit');

// ── Content ─────────────────────────────────────────────────────────────────
// Each entry: { title, category, content, url?, urlLabel?, daysAgo }
// `daysAgo` spreads createdAt so the feed reads like a real timeline.
const ITEMS = [
  {
    title: 'La forêt de Compiègne fête ses allées cavalières restaurées',
    category: 'foret',
    daysAgo: 1,
    content: "L'ONF vient d'achever la remise en état de plusieurs allées cavalières historiques du massif. Les tracés rectilignes dessinés au XVIIe siècle retrouvent un revêtement stabilisé, plus agréable pour la marche comme pour le vélo.",
    url: 'https://www.onf.fr/onf/forets-de-france/+/1a1::foret-de-compiegne.html',
    urlLabel: "En savoir plus sur l'ONF",
  },
  {
    title: 'Brame du cerf : la saison démarre autour des Beaux-Monts',
    category: 'faune',
    daysAgo: 3,
    content: "De mi-septembre à mi-octobre, le brame résonne à la tombée du jour. Restez sur les sentiers, gardez le silence et n'approchez pas les animaux : la période est aussi celle de tous les dangers pour la faune. Les meilleurs points d'écoute se situent vers les Beaux-Monts.",
  },
  {
    title: 'Nouvelle boucle balisée de 8 km au départ de Vieux-Moulin',
    category: 'evenement',
    daysAgo: 5,
    content: "Une boucle familiale de 8 km vient d'être balisée au départ du village de Vieux-Moulin. Dénivelé doux, points de vue sur les étangs de Saint-Pierre : un itinéraire idéal pour une demi-journée. Le tracé est déjà planifiable dans BWR.",
    url: 'https://bwrmaps.com/routes',
    urlLabel: 'Planifier la boucle',
  },
  {
    title: 'Tempête : chutes de branches signalées secteur Saint-Jean-aux-Bois',
    category: 'securite',
    daysAgo: 2,
    content: "Après les coups de vent de la semaine, plusieurs branches et un arbre sont tombés en travers des chemins près de Saint-Jean-aux-Bois. Prudence sur ce secteur. Signalez tout obstacle via le bouton « Signaler un problème » de la carte.",
    url: 'https://bwrmaps.com/map',
    urlLabel: 'Voir la carte',
  },
  {
    title: 'Travaux forestiers : le carrefour du Puits du Roi fermé 2 semaines',
    category: 'travaux',
    daysAgo: 4,
    content: "Une coupe d'entretien impose la fermeture temporaire des accès autour du carrefour du Puits du Roi. Des déviations sont fléchées sur place. Merci de respecter la signalisation des bûcherons pour votre sécurité.",
  },
  {
    title: 'BWR passe en application installable (PWA)',
    category: 'app',
    daysAgo: 6,
    content: "Vous pouvez désormais installer BWR sur votre téléphone comme une vraie application : accès hors-ligne aux cartes déjà consultées, ouverture plein écran et lancement depuis l'écran d'accueil. Cherchez le bouton « Installer » dans le menu.",
    url: 'https://bwrmaps.com/',
    urlLabel: "Découvrir l'app",
  },
  {
    title: 'Champignons : rappel des règles de cueillette dans le massif',
    category: 'foret',
    daysAgo: 8,
    content: "La cueillette de loisir est tolérée dans la limite de 5 litres par personne et par jour, hors zones de régénération clôturées. Ne prélevez que ce que vous savez identifier et laissez les spécimens douteux sur place.",
  },
  {
    title: 'Comptage des chauves-souris dans les anciennes carrières',
    category: 'faune',
    daysAgo: 10,
    content: "Le Conservatoire d'espaces naturels mène son comptage hivernal des chiroptères dans les cavités du massif. Plusieurs espèces protégées y hibernent : ces sites restent strictement interdits d'accès de novembre à mars.",
  },
  {
    title: 'Rendez-vous nature : sortie guidée « arbres remarquables »',
    category: 'evenement',
    daysAgo: 12,
    content: "Une sortie gratuite accompagnée par un garde forestier partira du parking du Mont Saint-Marc pour découvrir les chênes et hêtres tricentenaires du massif. Sur inscription, places limitées, chaussures de marche recommandées.",
    url: 'https://www.onf.fr/onf/rendez-vous-en-foret',
    urlLabel: "Voir l'agenda ONF",
  },
  {
    title: 'Sécheresse estivale : niveau de risque incendie relevé',
    category: 'securite',
    daysAgo: 14,
    content: "En raison de la sécheresse, le risque d'incendie est jugé élevé sur l'ensemble du massif. Feux, cigarettes et barbecues sont formellement interdits. En cas de départ de feu, appelez le 18 ou le 112 et éloignez-vous.",
  },
  {
    title: 'Réfection du pont sur le ru de Berne',
    category: 'travaux',
    daysAgo: 16,
    content: "Le petit pont piéton enjambant le ru de Berne sera remplacé courant du mois. Une passerelle provisoire est installée à une centaine de mètres en amont. Les itinéraires BWR passant par ce point seront mis à jour.",
  },
  {
    title: 'Signalement de problèmes : plus de 200 retours en un an',
    category: 'app',
    daysAgo: 18,
    content: "Grâce à vous, la carte collaborative recense désormais plus de 200 signalements traités : arbres tombés, passages boueux, balisage effacé. Chaque signalement aide toute la communauté à mieux préparer ses sorties. Merci !",
    url: 'https://bwrmaps.com/map',
    urlLabel: 'Signaler un problème',
  },
  {
    title: 'Automne : la palette des feuillus au sommet des Beaux-Monts',
    category: 'foret',
    daysAgo: 20,
    content: "C'est la meilleure période pour profiter des couleurs d'automne. Depuis le belvédère des Beaux-Monts, la perspective tracée jusqu'au château de Compiègne offre un panorama flamboyant sur la canopée.",
  },
  {
    title: 'Retour du balbuzard pêcheur au-dessus des étangs',
    category: 'faune',
    daysAgo: 22,
    content: "Des observateurs ont signalé le passage d'un balbuzard pêcheur au-dessus des étangs de Saint-Pierre lors de sa migration. Un rapace spectaculaire, de plus en plus régulier dans l'Oise à la faveur des zones humides restaurées.",
  },
  {
    title: 'Trail des Trois Forêts : les inscriptions sont ouvertes',
    category: 'evenement',
    daysAgo: 24,
    content: "L'édition annuelle du trail reliant les massifs de Compiègne, Laigue et Ourscamp revient. Parcours de 15, 30 et 55 km à travers les plus belles allées. Une partie des bénéfices est reversée à l'entretien des sentiers.",
    url: 'https://bwrmaps.com/best-tours',
    urlLabel: 'Voir les meilleures balades',
  },
  {
    title: 'Chasse en cours : jours et secteurs à éviter',
    category: 'securite',
    daysAgo: 26,
    content: "Des battues sont organisées certains jours de la semaine dans plusieurs parcelles du massif. Les zones concernées sont signalées par des panneaux temporaires. Privilégiez les grandes allées et portez des vêtements visibles.",
  },
  {
    title: 'Entretien des fossés le long de la route Eugénie',
    category: 'travaux',
    daysAgo: 28,
    content: "Des travaux d'hydraulique forestière sont menés le long de la route Eugénie pour limiter les inondations de chemins en hiver. Circulation piétonne maintenue, mais attendez-vous à la présence d'engins en semaine.",
  },
  {
    title: 'Mode sombre et thème clair désormais dans BWR',
    category: 'app',
    daysAgo: 30,
    content: "L'application s'adapte maintenant à vos préférences : basculez entre thème clair et mode sombre d'un simple appui, ou laissez BWR suivre le réglage de votre téléphone. Plus confortable pour préparer vos sorties le soir.",
    url: 'https://bwrmaps.com/',
    urlLabel: 'Essayer',
  },
  {
    title: 'Les mares forestières, refuges de biodiversité restaurés',
    category: 'foret',
    daysAgo: 33,
    content: "Plusieurs mares intra-forestières ont été curées pour rouvrir le milieu. Tritons, libellules et amphibiens y trouvent un habitat précieux. Observez à distance et évitez de piétiner les berges fragiles.",
  },
  {
    title: 'Recensement participatif des fourmilières géantes',
    category: 'faune',
    daysAgo: 36,
    content: "Les fourmis rousses des bois bâtissent des dômes pouvant dépasser un mètre. Un recensement participatif invite les promeneurs à photographier et géolocaliser ces fourmilières, précieuses sentinelles de la santé de la forêt.",
  },
];

// ── Build KV entries ─────────────────────────────────────────────────────────
const now = Date.now();
const bulk = ITEMS.map((it) => {
  const created = new Date(now - (it.daysAgo ?? 0) * 86400000).toISOString();
  const value = {
    id: randomUUID(),
    title: it.title,
    content: it.content || '',
    category: it.category,
    url: it.url || '',
    urlLabel: it.urlLabel || '',
    imageDataUri: '',
    imageUrl: '',
    likes: 0,
    dislikes: 0,
    createdAt: created,
    updatedAt: created,
  };
  return { key: `news:${value.id}`, value: JSON.stringify(value) };
});

if (!COMMIT) {
  console.log(`DRY RUN — ${bulk.length} news items ready to seed (pass --commit to write to prod KV):\n`);
  ITEMS.forEach((it, i) => console.log(`  ${String(i + 1).padStart(2)}. [${it.category}] ${it.title}`));
  console.log('\nNothing written. Re-run with:  node scripts/seed-news.mjs --commit');
  process.exit(0);
}

// ── Auth (wrangler oauth token) ──────────────────────────────────────────────
const configPath = process.env.APPDATA
  ? join(process.env.APPDATA, 'xdg.config', '.wrangler', 'config', 'default.toml')
  : join(process.env.HOME, '.wrangler', 'config', 'default.toml');

const toml  = readFileSync(configPath, 'utf-8');
const TOKEN = toml.match(/oauth_token\s*=\s*"([^"]+)"/)?.[1];
if (!TOKEN) { console.error('No oauth_token found in', configPath); process.exit(1); }

const BASE = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/storage/kv/namespaces/${NS}`;
const res = await fetch(`${BASE}/bulk`, {
  method:  'PUT',
  headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
  body:    JSON.stringify(bulk),
}).then((r) => r.json());

if (res.success) {
  console.log(`Seeded ${bulk.length} news items into production KV ✅`);
} else {
  console.error('Failed:', JSON.stringify(res.errors || res, null, 2));
  process.exit(1);
}
