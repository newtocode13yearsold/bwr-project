# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: map.spec.js >> Carte (map.html) >> intercepte /api/reports et affiche les marqueurs
- Location: tests\e2e\map.spec.js:69:7

# Error details

```
Error: expect(locator).toBeVisible() failed

Locator: locator('.leaflet-marker-icon').first()
Expected: visible
Timeout: 8000ms
Error: element(s) not found

Call log:
  - Expect "toBeVisible" with timeout 8000ms
  - waiting for locator('.leaflet-marker-icon').first()

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
  - button "⋮ Filtres"
  - button "TE Testeur"
- text: 🔍
- textbox "Chercher un lieu…"
- button "Zoom in"
- button "Zoom out"
- link "Leaflet":
  - /url: https://leafletjs.com
- text: "Map data: ©"
- link "OpenStreetMap":
  - /url: https://www.openstreetmap.org/copyright
- text: contributors,
- link "SRTM":
  - /url: http://viewfinderpanoramas.org
- text: "| Style: ©"
- link "OpenTopoMap":
  - /url: https://opentopomap.org
- text: ✎ Clique sur un chemin pour modifier sa difficulté
- button "✕"
- text: Légende Facile Moyen Difficile Impraticable Vélo interdit
- button "✉ Contact"
- button "📍 Ma position"
```

# Test source

```ts
  1   | // @ts-check
  2   | import { test, expect } from '@playwright/test';
  3   | 
  4   | // Injecte une session valide avant chaque test
  5   | async function injectSession(page, plan = 'free') {
  6   |   await page.goto('/login.html');
  7   |   await page.evaluate((plan) => {
  8   |     localStorage.setItem('bwr_token', 'e2e-mock-token');
  9   |     localStorage.setItem('bwr_user', JSON.stringify({
  10  |       id: 'e2e-user-1',
  11  |       name: 'Testeur E2E',
  12  |       email: 'e2e@test.local',
  13  |       role: 'user',
  14  |       plan,
  15  |     }));
  16  |   }, plan);
  17  | }
  18  | 
  19  | // Intercepte /api/auth/me pour renvoyer un user valide sans vrai token
  20  | async function mockAuthMe(page, plan = 'free') {
  21  |   await page.route('**/api/auth/me', route => route.fulfill({
  22  |     status: 200,
  23  |     contentType: 'application/json',
  24  |     body: JSON.stringify({
  25  |       id: 'e2e-user-1',
  26  |       name: 'Testeur E2E',
  27  |       email: 'e2e@test.local',
  28  |       role: 'user',
  29  |       plan,
  30  |       stats: { routes: 3, km: 42 },
  31  |       badges: [],
  32  |     }),
  33  |   }));
  34  | }
  35  | 
  36  | test.describe('Carte (map.html)', () => {
  37  | 
  38  |   test('charge la carte Leaflet', async ({ page }) => {
  39  |     await mockAuthMe(page);
  40  |     await injectSession(page);
  41  |     await page.goto('/map.html');
  42  | 
  43  |     // La div #map doit exister et Leaflet doit s'être initialisé
  44  |     await expect(page.locator('#map')).toBeVisible({ timeout: 10_000 });
  45  |     // Leaflet ajoute .leaflet-container sur la div
  46  |     await expect(page.locator('.leaflet-container')).toBeVisible({ timeout: 10_000 });
  47  |   });
  48  | 
  49  |   test('affiche le header avec navigation', async ({ page }) => {
  50  |     await mockAuthMe(page);
  51  |     await injectSession(page);
  52  |     await page.goto('/map.html');
  53  | 
  54  |     await expect(page.locator('header.header')).toBeVisible();
  55  |   });
  56  | 
  57  |   test('le panneau de filtres est accessible', async ({ page }) => {
  58  |     await mockAuthMe(page);
  59  |     await injectSession(page);
  60  |     await page.goto('/map.html');
  61  | 
  62  |     await expect(page.locator('.leaflet-container')).toBeVisible({ timeout: 10_000 });
  63  | 
  64  |     // Le filtre de surface doit être présent dans le DOM
  65  |     const filterEl = page.locator('#surfaceFilter, [data-filter], .filter-btn').first();
  66  |     await expect(filterEl).toBeVisible({ timeout: 5_000 });
  67  |   });
  68  | 
  69  |   test('intercepte /api/reports et affiche les marqueurs', async ({ page }) => {
  70  |     await page.route('**/api/reports', route => route.fulfill({
  71  |       status: 200,
  72  |       contentType: 'application/json',
  73  |       body: JSON.stringify([
  74  |         {
  75  |           id: 'r1',
  76  |           lat: 49.35,
  77  |           lng: 2.90,
  78  |           type: 'fallen_tree',
  79  |           description: 'Arbre tombé',
  80  |           createdAt: new Date().toISOString(),
  81  |         },
  82  |       ]),
  83  |     }));
  84  |     await mockAuthMe(page);
  85  |     await injectSession(page);
  86  |     await page.goto('/map.html');
  87  | 
  88  |     await expect(page.locator('.leaflet-container')).toBeVisible({ timeout: 10_000 });
  89  |     // Au moins un marqueur Leaflet doit être rendu
> 90  |     await expect(page.locator('.leaflet-marker-icon').first()).toBeVisible({ timeout: 8_000 });
      |                                                                ^ Error: expect(locator).toBeVisible() failed
  91  |   });
  92  | });
  93  | 
  94  | test.describe('Signalement de problème', () => {
  95  | 
  96  |   test('le bouton Signaler est présent', async ({ page }) => {
  97  |     await mockAuthMe(page);
  98  |     await injectSession(page);
  99  |     await page.goto('/map.html');
  100 | 
  101 |     await expect(page.locator('.leaflet-container')).toBeVisible({ timeout: 10_000 });
  102 | 
  103 |     const btn = page.locator('button:has-text("Signaler"), #reportBtn, [id*="report"]').first();
  104 |     await expect(btn).toBeVisible({ timeout: 5_000 });
  105 |   });
  106 | });
  107 | 
```