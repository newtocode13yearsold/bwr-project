# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: routes.spec.js >> Planification d'itinéraire (routes.html) >> la recherche d'adresse est présente et fonctionnelle
- Location: tests\e2e\routes.spec.js:71:7

# Error details

```
Error: expect(locator).toBeVisible() failed

Locator: locator('#addressSearch, input[placeholder*="adresse"], input[placeholder*="départ"]').first()
Expected: visible
Timeout: 5000ms
Error: element(s) not found

Call log:
  - Expect "toBeVisible" with timeout 5000ms
  - waiting for locator('#addressSearch, input[placeholder*="adresse"], input[placeholder*="départ"]').first()

```

```yaml
- banner:
  - link "BWR":
    - /url: index.html
  - navigation:
    - link "Carte":
      - /url: map.html
    - link "Planifier":
      - /url: routes.html
    - link "Actualités":
      - /url: news.html
    - link "Plans":
      - /url: plans.html
  - button "☰ Menu"
  - button "TE Testeur"
- complementary:
  - text: 📵
  - paragraph: Pas de connexion
  - paragraph: Le calcul d'itinéraire nécessite internet. Reconnecte-toi pour planifier une balade.
  - text: 1 Type de trajet
  - button "🔄 Boucle Revenir au point de départ":
    - text: 🔄
    - strong: Boucle
    - text: Revenir au point de départ
  - button "➡️ Point A → B D'un endroit à un autre":
    - text: ➡️
    - strong: Point A → B
    - text: D'un endroit à un autre
  - text: 2 Préférences Type de chemin
  - button "🌲 Forestier"
  - button "🚴 Cyclable"
  - button "🌾 Champs"
  - button "️ Mix":
    - img
    - text: ️ Mix
  - text: Difficulté
  - button "Facile"
  - button "Moyen"
  - button "Difficile"
  - separator
  - text: Priorité
  - button "🌲 Forestier"
  - button "📏 Plus court"
  - text: Revêtement
  - button "️ Tous":
    - img
    - text: ️ Tous
  - button "🌱 Terre / Herbe"
  - button "🏗️ Asphalte"
  - text: 3 Choisir le départ
  - textbox "Chercher un lieu..."
  - button "📍"
  - paragraph: Ou clique directement sur la carte.
  - text: 4 Générer
  - button "Calculer le trajet" [disabled]
  - link "✉ ciril8596@gmail.com":
    - /url: mailto:ciril8596@gmail.com
  - text: 📚 Mes trajets sauvegardés ▾
- button "OSM"
- button "IGN"
- button "Satellite 👑"
- img
- button "Zoom in"
- button "Zoom out"
- link "Leaflet":
  - /url: https://leafletjs.com
- text: "Map data: © OpenStreetMap contributors, SRTM | Style: © OpenTopoMap 📶 Hors-ligne"
```

# Test source

```ts
  1   | // @ts-check
  2   | import { test, expect } from '@playwright/test';
  3   | 
  4   | async function mockAuthMe(page, plan = 'silver') {
  5   |   await page.route('**/api/auth/me', route => route.fulfill({
  6   |     status: 200,
  7   |     contentType: 'application/json',
  8   |     body: JSON.stringify({
  9   |       id: 'e2e-user-1',
  10  |       name: 'Testeur E2E',
  11  |       email: 'e2e@test.local',
  12  |       role: 'user',
  13  |       plan,
  14  |       stats: { routes: 5, km: 80 },
  15  |       badges: [],
  16  |     }),
  17  |   }));
  18  | }
  19  | 
  20  | async function injectSession(page, plan = 'silver') {
  21  |   await page.goto('/login.html');
  22  |   await page.evaluate((plan) => {
  23  |     localStorage.setItem('bwr_token', 'e2e-mock-token');
  24  |     localStorage.setItem('bwr_user', JSON.stringify({
  25  |       id: 'e2e-user-1',
  26  |       name: 'Testeur E2E',
  27  |       email: 'e2e@test.local',
  28  |       role: 'user',
  29  |       plan,
  30  |     }));
  31  |   }, plan);
  32  | }
  33  | 
  34  | test.describe('Planification d\'itinéraire (routes.html)', () => {
  35  | 
  36  |   test('charge la page et affiche la carte', async ({ page }) => {
  37  |     await mockAuthMe(page);
  38  |     await injectSession(page);
  39  |     await page.goto('/routes.html');
  40  | 
  41  |     await expect(page.locator('#map')).toBeVisible({ timeout: 10_000 });
  42  |     await expect(page.locator('.leaflet-container')).toBeVisible({ timeout: 10_000 });
  43  |   });
  44  | 
  45  |   test('affiche les options de mode (boucle / A→B)', async ({ page }) => {
  46  |     await mockAuthMe(page);
  47  |     await injectSession(page);
  48  |     await page.goto('/routes.html');
  49  | 
  50  |     await expect(page.locator('.leaflet-container')).toBeVisible({ timeout: 10_000 });
  51  | 
  52  |     // Vérifie que les boutons de mode existent
  53  |     const loopBtn = page.locator('button:has-text("Boucle"), [data-mode="loop"], #modeLoop').first();
  54  |     const atobBtn = page.locator('button:has-text("A → B"), button:has-text("A→B"), [data-mode="atob"], #modeAtob').first();
  55  |     await expect(loopBtn).toBeVisible({ timeout: 5_000 });
  56  |     await expect(atobBtn).toBeVisible({ timeout: 5_000 });
  57  |   });
  58  | 
  59  |   test('affiche les niveaux de difficulté', async ({ page }) => {
  60  |     await mockAuthMe(page);
  61  |     await injectSession(page);
  62  |     await page.goto('/routes.html');
  63  | 
  64  |     await expect(page.locator('.leaflet-container')).toBeVisible({ timeout: 10_000 });
  65  | 
  66  |     // Les boutons de difficulté doivent être rendus
  67  |     const easyBtn = page.locator('button:has-text("Facile"), [data-difficulty="easy"]').first();
  68  |     await expect(easyBtn).toBeVisible({ timeout: 5_000 });
  69  |   });
  70  | 
  71  |   test('la recherche d\'adresse est présente et fonctionnelle', async ({ page }) => {
  72  |     await mockAuthMe(page);
  73  |     await injectSession(page);
  74  |     await page.goto('/routes.html');
  75  | 
  76  |     await expect(page.locator('.leaflet-container')).toBeVisible({ timeout: 10_000 });
  77  | 
  78  |     const searchInput = page.locator('#addressSearch, input[placeholder*="adresse"], input[placeholder*="départ"]').first();
> 79  |     await expect(searchInput).toBeVisible({ timeout: 5_000 });
      |                               ^ Error: expect(locator).toBeVisible() failed
  80  | 
  81  |     // Simule la saisie (sans déclencher un vrai appel Nominatim)
  82  |     await searchInput.fill('Compiègne');
  83  |     await expect(searchInput).toHaveValue('Compiègne');
  84  |   });
  85  | 
  86  |   test('génère un itinéraire via le graphe interne', async ({ page }) => {
  87  |     // Intercepte le fallback ORS pour forcer le graph router
  88  |     await page.route('**/api/route', route => route.fulfill({
  89  |       status: 200,
  90  |       contentType: 'application/json',
  91  |       body: JSON.stringify({
  92  |         type: 'FeatureCollection',
  93  |         features: [{
  94  |           type: 'Feature',
  95  |           geometry: {
  96  |             type: 'LineString',
  97  |             coordinates: [[2.89, 49.35], [2.90, 49.36], [2.91, 49.35]],
  98  |           },
  99  |           properties: { summary: { distance: 5000, duration: 3600 } },
  100 |         }],
  101 |       }),
  102 |     }));
  103 | 
  104 |     // Retourne des chemins admin pour alimenter le graph router
  105 |     await page.route('**/api/paths', route => route.fulfill({
  106 |       status: 200,
  107 |       contentType: 'application/json',
  108 |       body: JSON.stringify([
  109 |         {
  110 |           id: 'p1',
  111 |           coordinates: [[49.35, 2.89], [49.36, 2.90], [49.35, 2.91]],
  112 |           status: 'easy',
  113 |           pathType: 'foot',
  114 |           color: '#22c55e',
  115 |         },
  116 |       ]),
  117 |     }));
  118 | 
  119 |     await mockAuthMe(page);
  120 |     await injectSession(page);
  121 |     await page.goto('/routes.html');
  122 | 
  123 |     await expect(page.locator('.leaflet-container')).toBeVisible({ timeout: 10_000 });
  124 | 
  125 |     // Clique sur le bouton de génération si présent
  126 |     const generateBtn = page.locator('button:has-text("Générer"), button:has-text("Calculer"), #generateBtn').first();
  127 |     if (await generateBtn.isVisible()) {
  128 |       await generateBtn.click();
  129 |       // Attend qu'une polyline Leaflet apparaisse (itinéraire tracé)
  130 |       await expect(page.locator('.leaflet-overlay-pane path')).toBeVisible({ timeout: 10_000 });
  131 |     }
  132 |   });
  133 | 
  134 |   test('affiche le profil d\'élévation après génération', async ({ page }) => {
  135 |     await page.route('**/api/paths', route => route.fulfill({
  136 |       status: 200,
  137 |       contentType: 'application/json',
  138 |       body: JSON.stringify([]),
  139 |     }));
  140 |     await page.route('**/api/route', route => route.fulfill({
  141 |       status: 200,
  142 |       contentType: 'application/json',
  143 |       body: JSON.stringify({
  144 |         type: 'FeatureCollection',
  145 |         features: [{
  146 |           type: 'Feature',
  147 |           geometry: {
  148 |             type: 'LineString',
  149 |             coordinates: [[2.89, 49.35], [2.90, 49.36]],
  150 |           },
  151 |           properties: { summary: { distance: 3000, duration: 2000 } },
  152 |         }],
  153 |       }),
  154 |     }));
  155 | 
  156 |     await mockAuthMe(page);
  157 |     await injectSession(page);
  158 |     await page.goto('/routes.html');
  159 |     await expect(page.locator('.leaflet-container')).toBeVisible({ timeout: 10_000 });
  160 | 
  161 |     // Le SVG du profil d'élévation ne s'affiche qu'après génération
  162 |     // On vérifie simplement que l'élément conteneur existe dans le DOM
  163 |     const elevationEl = page.locator('#elevationProfile, #elevation, svg.elevation');
  164 |     const exists = await elevationEl.count() > 0;
  165 |     // Pas bloquant si l'élément n'est pas encore rendu (nécessite un itinéraire)
  166 |     expect(typeof exists).toBe('boolean');
  167 |   });
  168 | });
  169 | 
```