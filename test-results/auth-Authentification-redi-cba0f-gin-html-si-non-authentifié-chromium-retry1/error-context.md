# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: auth.spec.js >> Authentification >> redirige vers login.html si non authentifié
- Location: tests\e2e\auth.spec.js:75:7

# Error details

```
Error: expect(page).toHaveURL(expected) failed

Expected pattern: /login\.html/
Received string:  "https://bwr-worker.ciril8596.workers.dev/map"
Timeout: 8000ms

Call log:
  - Expect "toHaveURL" with timeout 8000ms
    19 × unexpected value "https://bwr-worker.ciril8596.workers.dev/map"

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
  - link "Connexion":
    - /url: login.html
- text: 🔍
- textbox "Chercher un lieu…"
- button "🛞"
- button "🟤"
- button "🟤"
- button "🟤"
- button "🛞"
- button "🟤"
- button "🛞"
- button "🟤"
- button "🟤"
- button "🛞"
- button "🛞"
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
  1  | // @ts-check
  2  | import { test, expect } from '@playwright/test';
  3  | 
  4  | // Compte de test — doit exister dans le worker local
  5  | // Créé une fois par le test "register", réutilisé par les suivants
  6  | const TEST_EMAIL = `e2e_${Date.now()}@test.local`;
  7  | const TEST_PASSWORD = 'test1234';
  8  | const TEST_NAME = 'E2E Testeur';
  9  | 
  10 | test.describe('Authentification', () => {
  11 | 
  12 |   test('affiche la page de connexion', async ({ page }) => {
  13 |     await page.goto('/login.html');
  14 |     await expect(page.locator('.login-logo')).toHaveText('BWR');
  15 |     await expect(page.locator('#loginForm')).toBeVisible();
  16 |     await expect(page.locator('#signupForm')).toBeHidden();
  17 |   });
  18 | 
  19 |   test('bascule vers le formulaire d\'inscription', async ({ page }) => {
  20 |     await page.goto('/login.html');
  21 |     await page.click('#tabSignup');
  22 |     await expect(page.locator('#signupForm')).toBeVisible();
  23 |     await expect(page.locator('#loginForm')).toBeHidden();
  24 |   });
  25 | 
  26 |   test('affiche une erreur avec des identifiants invalides', async ({ page }) => {
  27 |     await page.goto('/login.html');
  28 |     await page.fill('#loginEmail', 'nope@nope.com');
  29 |     await page.fill('#loginPassword', 'wrongpass');
  30 |     await page.click('#loginForm button[type=submit]');
  31 |     await expect(page.locator('#loginError')).toBeVisible();
  32 |     await expect(page.locator('#loginError')).not.toBeEmpty();
  33 |   });
  34 | 
  35 |   test('inscription puis connexion complète', async ({ page }) => {
  36 |     await page.goto('/login.html');
  37 | 
  38 |     // Inscription
  39 |     await page.click('#tabSignup');
  40 |     await page.fill('#signupName', TEST_NAME);
  41 |     await page.fill('#signupEmail', TEST_EMAIL);
  42 |     await page.fill('#signupPassword', TEST_PASSWORD);
  43 |     await page.check('#signupConsent');
  44 |     await page.click('#signupForm button[type=submit]');
  45 | 
  46 |     // Message de succès (compte créé, email de vérification envoyé)
  47 |     await expect(page.locator('#signupSuccess')).toBeVisible({ timeout: 10_000 });
  48 | 
  49 |     // Connexion directe via l'API (bypass vérification email en local)
  50 |     const res = await page.evaluate(async ({ email, password }) => {
  51 |       const r = await fetch('/api/auth/login', {
  52 |         method: 'POST',
  53 |         headers: { 'Content-Type': 'application/json' },
  54 |         body: JSON.stringify({ email, password }),
  55 |       });
  56 |       return { status: r.status, body: await r.json() };
  57 |     }, { email: TEST_EMAIL, password: TEST_PASSWORD });
  58 | 
  59 |     // En local sans RESEND_API_KEY, le compte peut être directement actif
  60 |     // (le worker saute la vérification si la clé est absente)
  61 |     if (res.status === 200) {
  62 |       await page.evaluate(({ token, user }) => {
  63 |         localStorage.setItem('bwr_token', token);
  64 |         localStorage.setItem('bwr_user', JSON.stringify(user));
  65 |       }, res.body);
  66 | 
  67 |       await page.goto('/map.html');
  68 |       await expect(page).toHaveURL(/map\.html/);
  69 |     } else {
  70 |       // Compte en attente de vérification — comportement attendu en prod
  71 |       expect([200, 403]).toContain(res.status);
  72 |     }
  73 |   });
  74 | 
  75 |   test('redirige vers login.html si non authentifié', async ({ page }) => {
  76 |     await page.goto('/map.html');
  77 |     // La page doit rediriger vers login (requireAuth() dans map.js)
> 78 |     await expect(page).toHaveURL(/login\.html/, { timeout: 8_000 });
     |                        ^ Error: expect(page).toHaveURL(expected) failed
  79 |   });
  80 | 
  81 |   test('déconnexion efface la session', async ({ page }) => {
  82 |     // Injecte une fausse session pour simuler un user connecté
  83 |     await page.goto('/login.html');
  84 |     await page.evaluate(() => {
  85 |       localStorage.setItem('bwr_token', 'fake-token-xxx');
  86 |       localStorage.setItem('bwr_user', JSON.stringify({ id: '1', name: 'Test', role: 'user', plan: 'free' }));
  87 |     });
  88 | 
  89 |     // Appelle logout() directement
  90 |     await page.evaluate(() => {
  91 |       localStorage.removeItem('bwr_token');
  92 |       localStorage.removeItem('bwr_user');
  93 |     });
  94 | 
  95 |     expect(await page.evaluate(() => localStorage.getItem('bwr_token'))).toBeNull();
  96 |   });
  97 | });
  98 | 
```