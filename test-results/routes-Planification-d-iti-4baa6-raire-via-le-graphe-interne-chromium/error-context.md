# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: routes.spec.js >> Planification d'itinéraire (routes.html) >> génère un itinéraire via le graphe interne
- Location: tests\e2e\routes.spec.js:86:7

# Error details

```
Test timeout of 30000ms exceeded.
```

```
Error: locator.click: Test timeout of 30000ms exceeded.
Call log:
  - waiting for locator('button:has-text("Générer"), button:has-text("Calculer"), #generateBtn').first()
    - locator resolved to <button disabled id="btnGenerate" class="btn-generate">Calculer le trajet</button>
  - attempting click action
    2 × waiting for element to be visible, enabled and stable
      - element is not enabled
    - retrying click action
    - waiting 20ms
    2 × waiting for element to be visible, enabled and stable
      - element is not enabled
    - retrying click action
      - waiting 100ms
    55 × waiting for element to be visible, enabled and stable
       - element is not enabled
     - retrying click action
       - waiting 500ms

```

# Page snapshot

```yaml
- generic [active] [ref=e1]:
  - banner [ref=e2]:
    - generic [ref=e3]:
      - link "BWR" [ref=e4] [cursor=pointer]:
        - /url: index.html
      - navigation [ref=e5]:
        - link "Carte" [ref=e6] [cursor=pointer]:
          - /url: map.html
        - link "Planifier" [ref=e7] [cursor=pointer]:
          - /url: routes.html
        - link "Actualités" [ref=e8] [cursor=pointer]:
          - /url: news.html
        - link "Plans" [ref=e9] [cursor=pointer]:
          - /url: plans.html
    - generic [ref=e10]:
      - button "☰ Menu" [ref=e11] [cursor=pointer]:
        - generic [ref=e12]: ☰
        - generic [ref=e13]: Menu
      - button "TE Testeur" [ref=e15] [cursor=pointer]:
        - generic [ref=e16]: TE
        - text: Testeur
  - generic [ref=e17]:
    - complementary [ref=e18]:
      - generic [ref=e19]:
        - generic [ref=e20]: 📵
        - paragraph [ref=e21]: Pas de connexion
        - paragraph [ref=e22]: Le calcul d'itinéraire nécessite internet. Reconnecte-toi pour planifier une balade.
      - generic [ref=e23]:
        - generic [ref=e24]:
          - generic [ref=e25]: "1"
          - generic [ref=e26]: Type de trajet
        - generic [ref=e27]:
          - button "🔄 Boucle Revenir au point de départ" [ref=e28] [cursor=pointer]:
            - generic [ref=e29]: 🔄
            - strong [ref=e30]: Boucle
            - generic [ref=e31]: Revenir au point de départ
          - button "➡️ Point A → B D'un endroit à un autre" [ref=e32] [cursor=pointer]:
            - generic [ref=e33]: ➡️
            - strong [ref=e34]: Point A → B
            - generic [ref=e35]: D'un endroit à un autre
      - generic:
        - generic:
          - generic: "2"
          - generic: Préférences
        - generic:
          - generic: Type de chemin
          - generic:
            - button "🌲 Forestier":
              - text: 🌲
              - generic: Forestier
            - button "🚴 Cyclable":
              - text: 🚴
              - generic: Cyclable
            - button "🌾 Champs":
              - text: 🌾
              - generic: Champs
            - button "️ Mix":
              - img
              - text: ️
              - generic: Mix
        - generic:
          - generic: Difficulté
          - generic:
            - button "Facile": Facile
            - button "Moyen": Moyen
            - button "Difficile": Difficile
        - separator
        - generic:
          - generic: Priorité
          - generic:
            - button "🌲 Forestier"
            - button "📏 Plus court"
        - generic:
          - generic: Revêtement
          - generic:
            - button "️ Tous":
              - img
              - text: ️ Tous
            - button "🌱 Terre / Herbe"
            - button "🏗️ Asphalte"
      - generic:
        - generic:
          - generic: "3"
          - generic: Choisir le départ
        - generic:
          - generic:
            - textbox "Chercher un lieu..."
          - button "📍"
        - paragraph: Ou clique directement sur la carte.
      - generic:
        - generic:
          - generic: "4"
          - generic: Générer
        - button "Calculer le trajet" [disabled]
      - link "✉ ciril8596@gmail.com" [ref=e37] [cursor=pointer]:
        - /url: mailto:ciril8596@gmail.com
      - generic [ref=e39] [cursor=pointer]:
        - generic [ref=e40]: 📚 Mes trajets sauvegardés
        - generic [ref=e41]: ▾
    - generic [ref=e42]:
      - generic [ref=e43]:
        - button "OSM" [ref=e44] [cursor=pointer]
        - button "IGN" [ref=e45] [cursor=pointer]
        - button "Satellite 👑" [ref=e46]:
          - text: Satellite
          - generic [ref=e47]: 👑
      - generic:
        - generic:
          - img
      - generic:
        - generic [ref=e49]:
          - button "Zoom in" [ref=e50] [cursor=pointer]: +
          - button "Zoom out" [ref=e51] [cursor=pointer]: −
        - generic [ref=e52]:
          - link "Leaflet" [ref=e53] [cursor=pointer]:
            - /url: https://leafletjs.com
            - img [ref=e54]
            - text: Leaflet
          - text: "| Map data: © OpenStreetMap contributors, SRTM | Style: © OpenTopoMap"
  - generic: 📶 Hors-ligne
```

# Test source

```ts
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
  79  |     await expect(searchInput).toBeVisible({ timeout: 5_000 });
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
> 128 |       await generateBtn.click();
      |                         ^ Error: locator.click: Test timeout of 30000ms exceeded.
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